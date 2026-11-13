import { useState } from "react";
import { Moon, Sun } from "lucide-react";
import { preferredTheme, selectTheme, type Theme } from "./theme";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(preferredTheme);
  const next = theme === "light" ? "dark" : "light";
  return (
    <button
      className="theme-toggle"
      aria-label={`Switch to ${next} theme`}
      onClick={() => {
        selectTheme(next);
        setTheme(next);
      }}
    >
      {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
      <span>{theme === "light" ? "Dark" : "Light"}</span>
    </button>
  );
}
