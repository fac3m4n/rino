export function Brand() {
  return (
    <a className="brand" href="#position" aria-label="Rino home">
      <svg viewBox="0 0 40 40" fill="none" aria-hidden="true">
        <path
          d="M6 28V17L16 10H27L34 18L29 28H20L16 22L11 28Z"
          fill="currentColor"
        />
        <path d="M27 10L31 3L32 14ZM14 10L16 6L20 10Z" fill="currentColor" />
        <circle cx="27" cy="18" r="1.4" className="brand-eye" />
      </svg>
      <span aria-hidden="true">ЯINO</span>
    </a>
  );
}
