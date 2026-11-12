//! Fixed provider selection and direct WASI 0.2.2 HTTP adapter.
use crate::WorkerError;
use std::io::Read;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Provider {
    pub id: &'static str,
    pub url: &'static str,
}
pub const PROVIDERS: [Provider; 2] = [
    Provider {
        id: "publicnode",
        url: "https://ethereum-sepolia-rpc.publicnode.com",
    },
    Provider {
        id: "alchemy",
        url: "https://eth-sepolia.g.alchemy.com",
    },
];
/// A runtime credential is a single bounded ASCII path segment, never a URL.
/// Invalid or missing credentials use a fixed error without secret diagnostics.
pub fn alchemy_path(key: &str) -> Result<String, WorkerError> {
    if !(8..=128).contains(&key.len())
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(WorkerError::Rpc);
    }
    Ok(format!("/v2/{key}"))
}
pub struct RpcResponse {
    pub status: u16,
    pub body: Box<dyn Read>,
}
/// Production adapters must bound every request by an absolute 10-second deadline.
/// The consumer limits streamed reads to MAX_RPC_BYTES+1, before JSON allocation.
/// Test adapters use the same fixed provider identities with synthetic responses.
pub trait RpcTransport {
    fn post(&self, provider: Provider, request: &[u8]) -> Result<RpcResponse, WorkerError>;
}
pub struct WasiTransport;
pub const REQUEST_TIMEOUT_NS: u64 = 10_000_000_000;
#[derive(Clone, Copy)]
pub struct Deadline(u64);
impl Deadline {
    pub fn new(now: u64) -> Result<Self, WorkerError> {
        now.checked_add(REQUEST_TIMEOUT_NS)
            .map(Self)
            .ok_or(WorkerError::Timeout)
    }
    pub fn remaining_ns(self, now: u64) -> Result<u64, WorkerError> {
        self.0
            .checked_sub(now)
            .filter(|v| *v > 0)
            .ok_or(WorkerError::Timeout)
    }
}
#[cfg(not(target_os = "wasi"))]
impl RpcTransport for WasiTransport {
    fn post(&self, _: Provider, _: &[u8]) -> Result<RpcResponse, WorkerError> {
        Err(WorkerError::Unavailable)
    }
}

#[cfg(target_os = "wasi")]
mod wasi_http {
    use super::*;
    use std::io;
    use wasi::{
        clocks::monotonic_clock as clock,
        http::{
            outgoing_handler,
            types::{
                Headers, IncomingBody, Method, OutgoingBody, OutgoingRequest, RequestOptions,
                Scheme,
            },
        },
        io::{
            poll::{poll, Pollable},
            streams::{InputStream, StreamError},
        },
    };
    fn check(d: Deadline) -> Result<(), WorkerError> {
        d.remaining_ns(clock::now()).map(|_| ())
    }
    fn wait(ready: &Pollable, d: Deadline) -> Result<(), WorkerError> {
        check(d)?;
        let timer = clock::subscribe_instant(d.0);
        poll(&[ready, &timer]);
        // Deadline wins even when the stream and timer become ready together.
        check(d)
    }
    fn io_error(e: WorkerError) -> io::Error {
        io::Error::new(
            if e == WorkerError::Timeout {
                io::ErrorKind::TimedOut
            } else {
                io::ErrorKind::Other
            },
            e.code(),
        )
    }
    // Field order is significant: stream children must drop before incoming-body.
    struct Body {
        stream: Option<InputStream>,
        body: Option<IncomingBody>,
        deadline: Deadline,
    }
    impl Read for Body {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if buf.is_empty() || self.stream.is_none() {
                return Ok(0);
            }
            loop {
                check(self.deadline).map_err(io_error)?;
                let stream = self
                    .stream
                    .as_ref()
                    .ok_or_else(|| io_error(WorkerError::Io))?;
                match stream.read(buf.len() as u64) {
                    Ok(bytes) if bytes.is_empty() => {
                        let ready = stream.subscribe();
                        wait(&ready, self.deadline).map_err(io_error)?;
                    }
                    Ok(bytes) => {
                        check(self.deadline).map_err(io_error)?;
                        if bytes.len() > buf.len() {
                            return Err(io_error(WorkerError::Io));
                        }
                        buf[..bytes.len()].copy_from_slice(&bytes);
                        return Ok(bytes.len());
                    }
                    Err(StreamError::Closed) => {
                        // Release the stream child before consuming its parent. Wait for
                        // trailers to distinguish a successful EOF from HTTP body failure.
                        drop(self.stream.take());
                        let body = self.body.take().ok_or_else(|| io_error(WorkerError::Io))?;
                        let trailers = IncomingBody::finish(body);
                        loop {
                            check(self.deadline).map_err(io_error)?;
                            if let Some(result) = trailers.get() {
                                let fields = result
                                    .map_err(|_| io_error(WorkerError::Io))?
                                    .map_err(|_| io_error(WorkerError::Io))?;
                                drop(fields);
                                return Ok(0);
                            }
                            let ready = trailers.subscribe();
                            wait(&ready, self.deadline).map_err(io_error)?;
                        }
                    }
                    Err(_) => return Err(io_error(WorkerError::Io)),
                }
            }
        }
    }
    impl RpcTransport for WasiTransport {
        fn post(&self, provider: Provider, bytes: &[u8]) -> Result<RpcResponse, WorkerError> {
            let index = PROVIDERS
                .iter()
                .position(|p| *p == provider)
                .ok_or(WorkerError::Rpc)?;
            let deadline = Deadline::new(clock::now())?;
            // Authority/path come only from the compiled configuration, never a URL parser
            // over caller input. HTTPS uses the default port, without redirect handling.
            let (authority, path) = match index {
                0 => ("ethereum-sepolia-rpc.publicnode.com", "/".to_owned()),
                1 => (
                    "eth-sepolia.g.alchemy.com",
                    alchemy_path(&std::env::var("ALCHEMY_API_KEY").map_err(|_| WorkerError::Rpc)?)?,
                ),
                _ => return Err(WorkerError::Rpc),
            };
            let headers = Headers::new();
            headers
                .set(&"content-type".into(), &[b"application/json".to_vec()])
                .map_err(|_| WorkerError::Http)?;
            let request = OutgoingRequest::new(headers);
            request
                .set_method(&Method::Post)
                .map_err(|_| WorkerError::Http)?;
            request
                .set_scheme(Some(&Scheme::Https))
                .map_err(|_| WorkerError::Http)?;
            request
                .set_authority(Some(authority))
                .map_err(|_| WorkerError::Http)?;
            request
                .set_path_with_query(Some(&path))
                .map_err(|_| WorkerError::Http)?;
            let body = request.body().map_err(|_| WorkerError::Http)?;
            let stream = body.write().map_err(|_| WorkerError::Http)?;
            let options = RequestOptions::new();
            let remaining = deadline.remaining_ns(clock::now())?;
            options
                .set_connect_timeout(Some(remaining))
                .map_err(|_| WorkerError::Http)?;
            options
                .set_first_byte_timeout(Some(remaining))
                .map_err(|_| WorkerError::Http)?;
            options
                .set_between_bytes_timeout(Some(remaining))
                .map_err(|_| WorkerError::Http)?;
            let response =
                outgoing_handler::handle(request, Some(options)).map_err(|_| WorkerError::Http)?;
            // No blocking write/flush: each readiness wait competes with the SAME timer.
            let mut written = 0;
            while written < bytes.len() {
                check(deadline)?;
                let available = stream.check_write().map_err(|_| WorkerError::Http)?;
                if available == 0 {
                    let ready = stream.subscribe();
                    wait(&ready, deadline)?;
                    continue;
                }
                let n = (available.min((bytes.len() - written) as u64)) as usize;
                stream
                    .write(&bytes[written..written + n])
                    .map_err(|_| WorkerError::Http)?;
                written += n;
            }
            stream.flush().map_err(|_| WorkerError::Http)?;
            loop {
                check(deadline)?;
                if stream.check_write().map_err(|_| WorkerError::Http)? > 0 {
                    break;
                }
                let ready = stream.subscribe();
                wait(&ready, deadline)?;
            }
            drop(stream);
            OutgoingBody::finish(body, None).map_err(|_| WorkerError::Http)?;
            let incoming = loop {
                check(deadline)?;
                if let Some(result) = response.get() {
                    break result
                        .map_err(|_| WorkerError::Http)?
                        .map_err(|_| WorkerError::Http)?;
                }
                let ready = response.subscribe();
                wait(&ready, deadline)?;
            };
            check(deadline)?;
            drop(response);
            let status = incoming.status();
            if status != 200 {
                return Ok(RpcResponse {
                    status,
                    body: Box::new(io::empty()),
                });
            }
            let body = incoming.consume().map_err(|_| WorkerError::Http)?;
            let stream = body.stream().map_err(|_| WorkerError::Http)?;
            drop(incoming);
            Ok(RpcResponse {
                status,
                body: Box::new(Body {
                    stream: Some(stream),
                    body: Some(body),
                    deadline,
                }),
            })
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn alchemy_key_has_a_bounded_ascii_segment_and_fixed_route() {
        assert_eq!(
            alchemy_path("Valid_123-key"),
            Ok("/v2/Valid_123-key".into())
        );
        for key in ["a".repeat(8), "Z".repeat(128)] {
            assert_eq!(alchemy_path(&key), Ok(format!("/v2/{key}")));
        }
        for key in [
            "",
            "short",
            "has/slash",
            "query?key",
            "fragment#key",
            "space key",
            "unicodé1",
            "percent%41",
            "a.b-cdef",
            "https://attacker.invalid",
            "line\nfeed",
        ] {
            assert_eq!(
                alchemy_path(key),
                Err(WorkerError::Rpc),
                "invalid shape accepted"
            );
        }
        assert_eq!(alchemy_path(&"a".repeat(129)), Err(WorkerError::Rpc));
    }
    #[test]
    fn one_absolute_deadline_does_not_reset_between_connection_headers_and_chunks() {
        let d = Deadline::new(100).unwrap();
        assert_eq!(d.remaining_ns(100), Ok(10_000_000_000));
        assert_eq!(d.remaining_ns(1_000_000_100), Ok(9_000_000_000));
        assert_eq!(d.remaining_ns(10_000_000_099), Ok(1));
        assert_eq!(d.remaining_ns(10_000_000_100), Err(WorkerError::Timeout));
        assert_eq!(d.remaining_ns(10_000_000_101), Err(WorkerError::Timeout));
        assert!(Deadline::new(u64::MAX).is_err());
    }
}
