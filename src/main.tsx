import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { isDesktop, preferences } from "./desktop";
import "./index.css";

// Restore the palette before React paints, including direct Showcase navigation.
const theme = preferences.getItem("sparkdash-theme");
if (theme && ["white", "light", "dark", "oled"].includes(theme)) {
  document.documentElement.dataset.theme = theme;
}
const macTitlebar = isDesktop && window.sparkDesktop?.platform === "darwin";
if (macTitlebar) document.documentElement.dataset.desktop = "darwin";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {macTitlebar && <div className="desktop-titlebar" aria-hidden="true">sparkDash</div>}
    <App />
  </StrictMode>,
);
