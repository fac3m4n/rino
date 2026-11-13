export type Theme = "light" | "dark";
export const THEME_PREFERENCE_KEY = "rino.theme.v1";

export function preferredTheme(): Theme {
  try {
    return localStorage.getItem(THEME_PREFERENCE_KEY) === "dark"
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#111827" : "#f6f7fb");
}

export function selectTheme(theme: Theme) {
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_PREFERENCE_KEY, theme);
  } catch {
    // A display preference must never block the application or wallet session.
  }
}
