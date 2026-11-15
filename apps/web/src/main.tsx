// Adapted from the pinned official create-near-app 10.0.0 vite-react entry point.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./tokens.css";
import "./brand.css";
import "./styles.css";
import { applyTheme, preferredTheme } from "./theme";
applyTheme(preferredTheme());
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
