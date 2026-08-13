import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ThemeProvider } from "./lib/theme";
import "./styles.css";

// After a deploy, Vite re-hashes its code-split chunks. A tab that loaded the
// old index.html still references the old chunk hashes; when it lazy-loads one
// (e.g. the materials parser) the fetch fails ("Failed to fetch dynamically
// imported module"). Auto-reload once to pull the fresh bundle. The guard
// prevents a reload loop if the failure is something other than a stale chunk.
function reloadOnStaleChunk() {
  const KEY = "chunk-reload-at";
  const last = Number(sessionStorage.getItem(KEY) ?? 0);
  if (Date.now() - last < 10_000) return; // already reloaded recently — don't loop
  sessionStorage.setItem(KEY, String(Date.now()));
  window.location.reload();
}
// Vite's own preload helper fires this for failed dynamic imports.
window.addEventListener("vite:preloadError", (e) => { e.preventDefault(); reloadOnStaleChunk(); });
// Belt-and-braces: catch the raw dynamic-import failure too.
window.addEventListener("unhandledrejection", (e) => {
  const msg = String((e.reason && (e.reason.message || e.reason)) ?? "");
  if (/dynamically imported module|importing a module script failed|Failed to fetch/i.test(msg)) {
    reloadOnStaleChunk();
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
);
