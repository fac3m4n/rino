// Original Canvas and Web Animations implementation from the approved Rino design.
// No wallet code, dependencies or chain requests are loaded by the landing.
type Point = readonly [number, number];
type Route = readonly [Point, Point, Point, Point];

function startLandingMotion(): () => void {
  const canvas = document.querySelector<HTMLCanvasElement>("#credit-field");
  const hero = document.querySelector<HTMLElement>(".site-hero");
  const stage = document.querySelector<HTMLElement>(".hero-stage");
  if (!canvas || !hero || !stage) return () => {};
  const context = canvas.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const coarse = matchMedia("(pointer: coarse)");
  const events = new AbortController();
  const animations: Animation[] = [];
  let width = 0,
    height = 0,
    enabled = !reduce.matches,
    visible = true,
    frame = 0,
    time = 0,
    last = 0;
  let pointer = { x: 0, y: 0 };
  const drift = { x: 0, y: 0 };

  // Ethereum collateral enables CREDIT borrowing on NEAR; this is not an ETH bridge.
  function route(v: number): Route {
    const bx = drift.x * 14,
      by = drift.y * 10;
    return [
      [-width * 0.13, height * (0.65 + v * 0.36)],
      [width * 0.29 + bx, height * (0.67 - v * 0.25) + by],
      [width * 0.57 - bx, height * (0.12 + v * 0.24) - by],
      [width * 1.09, height * (0.13 + v * 0.29)],
    ];
  }
  function point(points: Route, t: number) {
    const s = 1 - t;
    return {
      x:
        s * s * s * points[0][0] +
        3 * s * s * t * points[1][0] +
        3 * s * t * t * points[2][0] +
        t * t * t * points[3][0],
      y:
        s * s * s * points[0][1] +
        3 * s * s * t * points[1][1] +
        3 * s * t * t * points[2][1] +
        t * t * t * points[3][1],
    };
  }
  function draw() {
    if (!context) return;
    context.clearRect(0, 0, width, height);
    const lines = coarse.matches ? 48 : 80;
    for (let line = 0; line < lines; line++) {
      const v = line / (lines - 1),
        p = route(v);
      context.beginPath();
      context.moveTo(...p[0]);
      context.bezierCurveTo(...p[1], ...p[2], ...p[3]);
      context.strokeStyle = `rgba(${100 + line},${120 + line},255,${0.2 + v * 0.35})`;
      context.lineWidth = 0.7;
      context.stroke();
    }
    for (let lane = 0; lane < 5; lane++) {
      const p = route(0.12 + lane * 0.18),
        head = (time / 8500 + lane * 0.19) % 1;
      const opacity = Math.min(1, head * 8, (1 - head) * 8) * 0.85;
      context.beginPath();
      for (let step = 0; step <= 15; step++) {
        const t = Math.max(0, head - 0.075 + (step / 15) * 0.075),
          q = point(p, t);
        if (step === 0) context.moveTo(q.x, q.y);
        else context.lineTo(q.x, q.y);
      }
      context.strokeStyle = `rgba(217,226,255,${opacity})`;
      context.lineWidth = lane === 2 ? 1.5 : 1;
      context.stroke();
    }
  }
  function tick(now: number) {
    frame = 0;
    if (!enabled || !visible || document.hidden) {
      last = 0;
      return;
    }
    if (last) time += Math.min(now - last, 50);
    last = now;
    drift.x += (pointer.x - drift.x) * 0.045;
    drift.y += (pointer.y - drift.y) * 0.045;
    draw();
    frame = requestAnimationFrame(tick);
  }
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
  }
  function schedule() {
    if (context && enabled && visible && !document.hidden && !frame)
      frame = requestAnimationFrame(tick);
  }
  function reflectMotion() {
    document.body.dataset.motion =
      enabled && visible && !document.hidden ? "playing" : "paused";
  }
  function resize() {
    if (!context || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    const dpr = Math.min(devicePixelRatio || 1, 1.7);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
    schedule();
  }
  const preferenceChanged = () => {
    enabled = !reduce.matches;
    if (reduce.matches) animations.forEach((animation) => animation.finish());
    time = 0;
    stop();
    draw();
    reflectMotion();
    schedule();
  };
  reduce.addEventListener("change", preferenceChanged);
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  const observer = new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting;
      reflectMotion();
      if (visible) schedule();
      else stop();
    },
    { threshold: 0 },
  );
  observer.observe(hero);
  document.addEventListener(
    "visibilitychange",
    () => {
      reflectMotion();
      if (document.hidden) stop();
      else schedule();
    },
    { signal: events.signal },
  );
  window.addEventListener("pagehide", stop, { signal: events.signal });
  window.addEventListener("pageshow", schedule, { signal: events.signal });
  stage.addEventListener(
    "pointermove",
    (event) => {
      if (coarse.matches || reduce.matches || !enabled) return;
      const rect = stage.getBoundingClientRect();
      pointer = {
        x: (event.clientX - rect.left) / rect.width - 0.5,
        y: (event.clientY - rect.top) / rect.height - 0.5,
      };
    },
    { signal: events.signal },
  );
  stage.addEventListener("pointerleave", () => (pointer = { x: 0, y: 0 }), {
    signal: events.signal,
  });
  reflectMotion();
  resize();
  if (!reduce.matches) {
    document
      .querySelectorAll<HTMLElement>(".hero-line>span")
      .forEach((line, index) =>
        animations.push(
          line.animate(
            [
              { transform: "translateY(108%)", opacity: 0 },
              { transform: "translateY(0)", opacity: 1 },
            ],
            {
              duration: 850,
              delay: 120 + index * 140,
              easing: "cubic-bezier(.2,.7,.15,1)",
              fill: "backwards",
            },
          ),
        ),
      );
  }
  return () => {
    stop();
    events.abort();
    resizeObserver.disconnect();
    observer.disconnect();
    reduce.removeEventListener("change", preferenceChanged);
    animations.forEach((animation) => animation.cancel());
  };
}

const dispose = startLandingMotion();
if (import.meta.hot) import.meta.hot.dispose(dispose);

const imageEvents = new AbortController();
function markUnavailable(target: EventTarget | null) {
  if (!(target instanceof HTMLImageElement)) return;
  target.classList.add("unavailable-image");
  target.closest(".asset-icon")?.classList.add("logo-unavailable");
}
document.addEventListener("error", ({ target }) => markUnavailable(target), {
  capture: true,
  signal: imageEvents.signal,
});
for (const image of document.images)
  if (image.complete && image.naturalWidth === 0) markUnavailable(image);
if (import.meta.hot) import.meta.hot.dispose(() => imageEvents.abort());
