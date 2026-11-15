export function Brand({
  compact = false,
  href = "/",
}: {
  compact?: boolean;
  href?: string;
}) {
  return (
    <a
      className={`brand${compact ? " brand--compact" : ""}`}
      href={href}
      aria-label="Rino home"
    >
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="6 3 28 25" fill="none">
          <path
            className="brand-body"
            d="M6 28V17L16 10H27L34 18L29 28H20L16 22L11 28Z"
            fill="currentColor"
          />
          <path d="M27 10L31 3L32 14ZM14 10L16 6L20 10Z" fill="currentColor" />
          <circle
            cx="27"
            cy="18"
            r="1.4"
            style={{ fill: "var(--brand-eye, var(--surface))" }}
          />
        </svg>
      </span>
      <span className="brand-name">ЯINO</span>
    </a>
  );
}
