//! Bounded Preview 2 runner. No ambient filesystem, environment, or network capabilities.
use anyhow::{Context, Result, ensure};
use std::{path::Path, time::Duration};
use wasmtime::{
    Config, Engine, Store, StoreLimits, StoreLimitsBuilder,
    component::{Component, Linker, ResourceTable},
};
use wasmtime_wasi::{
    WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView,
    clocks::{HostMonotonicClock, HostWallClock},
    p2::pipe::{MemoryInputPipe, MemoryOutputPipe},
};
use wasmtime_wasi_http::{WasiHttpCtx, WasiHttpCtxView, WasiHttpHooks, WasiHttpView};
pub mod transport;
pub use transport::{Adapter, LocalSandbox};

pub struct Runner {
    engine: Engine,
    component: Component,
}
#[derive(Debug)]
pub struct RunOutput {
    pub http_stream_bytes_read: u64,
    pub blocked_http_writes: u64,
    pub trailer_wait_subscriptions: u64,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_success: bool,
    pub resources_before: usize,
    pub resources_after: usize,
    pub http_resources_after: usize,
    pub simultaneous_ready_lists: Vec<Vec<u32>>,
    pub poll_ready_lists: Vec<Vec<u32>>,
    pub resource_kinds_after: Vec<String>,
    pub elapsed: Duration,
    pub mode: &'static str,
}
struct State {
    http_requests_started: u64,
    http_stream_bytes_read: u64,
    blocked_http_writes: u64,
    trailer_wait_subscriptions: u64,
    #[cfg(feature = "test-hooks")]
    observe_boundary: bool,
    simultaneous_ready_lists: Vec<Vec<u32>>,
    poll_ready_lists: Vec<Vec<u32>>,
    ctx: WasiCtx,
    http: WasiHttpCtx,
    table: ResourceTable,
    hooks: Box<dyn WasiHttpHooks>,
    limits: StoreLimits,
}
impl WasiView for State {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.ctx,
            table: &mut self.table,
        }
    }
}
impl WasiHttpView for State {
    fn http(&mut self) -> WasiHttpCtxView<'_> {
        WasiHttpCtxView {
            ctx: &mut self.http,
            table: &mut self.table,
            hooks: self.hooks.as_mut(),
        }
    }
}
struct LocalWall(u64);
impl HostWallClock for LocalWall {
    fn resolution(&self) -> Duration {
        Duration::from_secs(1)
    }
    fn now(&self) -> Duration {
        Duration::from_secs(self.0)
    }
}
/// Tokio-aligned monotonic time also permits deterministic paused-clock host tests.
struct Monotonic(tokio::time::Instant);
impl HostMonotonicClock for Monotonic {
    fn resolution(&self) -> u64 {
        1
    }
    fn now(&self) -> u64 {
        self.0.elapsed().as_nanos().try_into().unwrap_or(u64::MAX)
    }
}
impl Runner {
    pub fn new(module: impl AsRef<Path>) -> Result<Self> {
        let mut cfg = Config::new();
        cfg.consume_fuel(true);
        let engine = Engine::new(&cfg)?;
        let component = Component::from_file(&engine, module)?;
        Ok(Self { engine, component })
    }
    pub async fn run(&self, input: &[u8], adapter: Adapter) -> Result<RunOutput> {
        let (now, mode) = match &adapter {
            Adapter::Production => (None, "Production"),
            Adapter::LocalSandbox(c) => (Some(c.owned_near_unix_seconds), "LocalSandbox"),
        };
        self.run_inner(
            input,
            now,
            mode,
            Box::new(transport::Hooks::new(adapter)?),
            transport::LOCAL_ALCHEMY_KEY,
        )
        .await
    }
    /// Inject only the explicitly selected, validated production credential.
    pub async fn run_production(&self, input: &[u8], alchemy_key: &str) -> Result<RunOutput> {
        let hooks = transport::Hooks::production(alchemy_key)?;
        self.run_inner(input, None, "Production", Box::new(hooks), alchemy_key)
            .await
    }
    /// Explicit host-integration test seam. Never exposed by Production CLI configuration.
    #[cfg(feature = "test-hooks")]
    pub async fn run_with_hooks(
        &self,
        input: &[u8],
        local_now: Option<u64>,
        mode: &'static str,
        hooks: Box<dyn WasiHttpHooks>,
    ) -> Result<RunOutput> {
        self.run_inner(input, local_now, mode, hooks, transport::LOCAL_ALCHEMY_KEY)
            .await
    }
    async fn run_inner(
        &self,
        input: &[u8],
        local_now: Option<u64>,
        mode: &'static str,
        hooks: Box<dyn WasiHttpHooks>,
        alchemy_key: &str,
    ) -> Result<RunOutput> {
        ensure!(input.len() <= 32769, "host stdin exceeds 32769 bytes");
        let stdout = MemoryOutputPipe::new(16384);
        let stderr = MemoryOutputPipe::new(16384);
        let mut ctx = WasiCtxBuilder::new();
        ctx.env("ALCHEMY_API_KEY", alchemy_key)
            .stdin(MemoryInputPipe::new(input.to_vec()))
            .stdout(stdout.clone())
            .stderr(stderr.clone())
            .monotonic_clock(Monotonic(tokio::time::Instant::now()));
        if let Some(now) = local_now {
            ctx.wall_clock(LocalWall(now));
        }
        let state = State {
            http_requests_started: 0,
            http_stream_bytes_read: 0,
            blocked_http_writes: 0,
            trailer_wait_subscriptions: 0,
            #[cfg(feature = "test-hooks")]
            observe_boundary: mode == "ScriptedBoundary",
            simultaneous_ready_lists: Vec::new(),
            poll_ready_lists: Vec::new(),
            ctx: ctx.build(),
            http: WasiHttpCtx::new(),
            table: ResourceTable::new(),
            hooks,
            limits: StoreLimitsBuilder::new()
                .memory_size(128 * 1024 * 1024)
                .table_elements(10000)
                .instances(20)
                .build(),
        };
        let mut store = Store::new(&self.engine, state);
        store.limiter(|s| &mut s.limits);
        store.set_fuel(2_000_000_000)?;
        let mut linker = Linker::new(&self.engine);
        wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
        wasmtime_wasi_http::p2::add_only_http_to_linker_async(&mut linker)?;
        linker.allow_shadowing(true);
        install_consumed_options_shim(&mut linker)?;
        #[cfg(feature = "test-hooks")]
        install_poll_observer(&mut linker)?;
        let command = wasmtime_wasi::p2::bindings::Command::instantiate_async(
            &mut store,
            &self.component,
            &linker,
        )
        .await?;
        let resources_before = store.data_mut().table.iter_mut().count();
        let start = tokio::time::Instant::now();
        let result = tokio::time::timeout(
            Duration::from_secs(125),
            command.wasi_cli_run().call_run(&mut store),
        )
        .await
        .context("host watchdog expired (not a guest deadline)")??;
        let resources_after = store.data_mut().table.iter_mut().count();
        let http_resources_after = store
            .data_mut()
            .table
            .iter_mut()
            .filter(|(_, v)| is_http(*v))
            .count();
        let resource_kinds_after = store
            .data_mut()
            .table
            .iter_mut()
            .map(|(_, v)| resource_kind(v).to_string())
            .collect();
        Ok(RunOutput {
            http_stream_bytes_read: store.data().http_stream_bytes_read,
            blocked_http_writes: store.data().blocked_http_writes,
            trailer_wait_subscriptions: store.data().trailer_wait_subscriptions,
            simultaneous_ready_lists: store.data().simultaneous_ready_lists.clone(),
            poll_ready_lists: store.data().poll_ready_lists.clone(),
            resource_kinds_after,
            stdout: stdout.contents().to_vec(),
            stderr: stderr.contents().to_vec(),
            exit_success: result.is_ok(),
            resources_before,
            resources_after,
            http_resources_after,
            elapsed: start.elapsed(),
            mode,
        })
    }
}
fn is_http(v: &(dyn std::any::Any + Send)) -> bool {
    use wasmtime_wasi_http::p2::{body::*, types::*};
    v.is::<HostOutgoingRequest>()
        || v.is::<HostIncomingResponse>()
        || v.is::<HostFutureIncomingResponse>()
        || v.is::<HostIncomingBody>()
        || v.is::<HostIncomingBodyStream>()
        || v.is::<HostOutgoingBody>()
        || v.is::<HostFutureTrailers>()
        || v.is::<wasmtime_wasi_http::FieldMap>()
        || v.is::<http::HeaderMap>()
        || v.is::<wasmtime_wasi_http::RequestOptions>()
}

fn resource_kind(v: &(dyn std::any::Any + Send)) -> &'static str {
    use wasmtime_wasi_http::p2::{body::*, types::*};
    macro_rules! classify { ($($t:ty),*) => { $(if v.is::<$t>() {return stringify!($t);})* }; }
    classify!(
        HostOutgoingRequest,
        HostIncomingResponse,
        HostFutureIncomingResponse,
        HostIncomingBody,
        HostIncomingBodyStream,
        HostOutgoingBody,
        HostFutureTrailers,
        wasmtime_wasi_http::FieldMap,
        wasmtime_wasi_http::RequestOptions,
        http::HeaderMap
    );
    classify!(
        wasmtime_wasi_io::streams::DynInputStream,
        wasmtime_wasi_io::streams::DynOutputStream,
        wasmtime_wasi_io::poll::DynPollable
    );
    "unclassified"
}

// Wasmtime 50.0.1 http_impl.rs clones owned request-options without deleting it.
// Delegate all behavior, then release that consumed handle, including failure paths.
fn install_consumed_options_shim(linker: &mut Linker<State>) -> wasmtime::Result<()> {
    use wasmtime::component::Resource;
    use wasmtime_wasi_http::{
        RequestOptions,
        p2::{
            bindings::http::{outgoing_handler::Host, types::ErrorCode},
            types::{HostFutureIncomingResponse, HostOutgoingRequest},
        },
    };
    linker
        .instance("wasi:http/outgoing-handler@0.2.12")?
        .func_wrap(
        "handle",
        |mut store: wasmtime::StoreContextMut<'_, State>,
         (request, options): (
            Resource<HostOutgoingRequest>,
            Option<Resource<RequestOptions>>,
        )|
         -> wasmtime::Result<(Result<Resource<HostFutureIncomingResponse>, ErrorCode>,)> {
            store.data_mut().http_requests_started += 1;
            let owned = options.as_ref().map(|r| r.rep());
            let result = Host::handle(&mut store.data_mut().http(), request, options);
            if let Some(rep) = owned {
                store
                    .data_mut()
                    .table
                    .delete(Resource::<RequestOptions>::new_own(rep))?;
            }
            Ok((match result {
                Ok(r) => Ok(r),
                Err(e) => Err(e.downcast()?),
            },))
        },
    )?;
    Ok(())
}
pub mod gateway;

#[cfg(feature = "test-hooks")]
fn install_poll_observer(linker: &mut Linker<State>) -> wasmtime::Result<()> {
    use wasmtime::component::Resource;
    use wasmtime_wasi_io::{bindings::wasi::io::poll::Host, poll::DynPollable};
    linker.instance("wasi:io/poll@0.2.12")?.func_wrap_async(
        "poll",
        |mut store: wasmtime::StoreContextMut<'_, State>,
         (pollables,): (Vec<Resource<DynPollable>>,)| {
            Box::new(async move {
                let reps: Vec<_> = pollables.iter().map(|p| p.rep()).collect();
                let result = Host::poll(&mut store.data_mut().table, pollables).await?;
                if store.data().observe_boundary && result.contains(&1) && reps.len() == 2 {
                    // Test-only scheduler observation: keep virtual time fixed and let the
                    // other same-tick source run. Return the original poll result unchanged.
                    for _ in 0..4 {
                        tokio::task::yield_now().await;
                    }
                    let mut eligible = Vec::new();
                    for (index, rep) in reps.into_iter().enumerate() {
                        if wasmtime_wasi_io::bindings::wasi::io::poll::HostPollable::ready(
                            &mut store.data_mut().table,
                            Resource::<DynPollable>::new_borrow(rep),
                        )
                        .await?
                        {
                            eligible.push(index as u32);
                        }
                    }
                    store.data_mut().simultaneous_ready_lists.push(eligible);
                }
                if store.data().poll_ready_lists.len() < 128 {
                    store.data_mut().poll_ready_lists.push(result.clone());
                }
                Ok((result,))
            })
        },
    )?;
    // Count actual guest binding reads/writes, without changing stream behavior.
    use wasmtime_wasi_io::{
        bindings::wasi::io::streams,
        streams::{DynInputStream, DynOutputStream},
    };
    linker.instance("wasi:io/streams@0.2.12")?.func_wrap(
        "[method]input-stream.read",
        |mut store: wasmtime::StoreContextMut<'_, State>,
         (stream, len): (Resource<DynInputStream>, u64)|
         -> wasmtime::Result<(Result<Vec<u8>, streams::StreamError>,)> {
            let result = streams::HostInputStream::read(&mut store.data_mut().table, stream, len);
            let result = match result {
                Ok(bytes) => {
                    if store.data().http_requests_started > 0 {
                        store.data_mut().http_stream_bytes_read += bytes.len() as u64;
                    }
                    Ok(bytes)
                }
                Err(e) => Err(streams::Host::convert_stream_error(
                    &mut store.data_mut().table,
                    e,
                )?),
            };
            Ok((result,))
        },
    )?;
    linker.instance("wasi:io/streams@0.2.12")?.func_wrap(
        "[method]output-stream.check-write",
        |mut store: wasmtime::StoreContextMut<'_, State>,
         (stream,): (Resource<DynOutputStream>,)|
         -> wasmtime::Result<(Result<u64, streams::StreamError>,)> {
            let result =
                streams::HostOutputStream::check_write(&mut store.data_mut().table, stream);
            let result = match result {
                Ok(n) => {
                    if n == 0 && store.data().http_requests_started > 0 {
                        store.data_mut().blocked_http_writes += 1;
                    }
                    Ok(n)
                }
                Err(e) => Err(streams::Host::convert_stream_error(
                    &mut store.data_mut().table,
                    e,
                )?),
            };
            Ok((result,))
        },
    )?;
    linker.instance("wasi:http/types@0.2.12")?.func_wrap(
        "[method]future-trailers.subscribe",
        |mut store: wasmtime::StoreContextMut<'_, State>,
         (trailers,): (Resource<wasmtime_wasi_http::p2::body::HostFutureTrailers>,)|
         -> wasmtime::Result<(Resource<DynPollable>,)> {
            store.data_mut().trailer_wait_subscriptions += 1;
            Ok((
                wasmtime_wasi_http::p2::bindings::http::types::HostFutureTrailers::subscribe(
                    &mut store.data_mut().http(),
                    trailers,
                )?,
            ))
        },
    )?;
    Ok(())
}
