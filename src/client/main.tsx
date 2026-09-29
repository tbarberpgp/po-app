import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ThemeProvider } from "./lib/theme";
import { isChunkLoadError, navigateOnce } from "./lib/recover";
import "./styles.css";

// After a deploy, Vite re-hashes its code-split chunks. A tab that loaded the
// old index.html still references the old chunk hashes; when it lazy-loads one
// (e.g. the materials parser) the fetch fails. Reload once to pull the fresh
// bundle; navigateOnce refuses to do it twice, so a failure a reload can't fix
// doesn't become a loop.
function reloadOnStaleChunk() {
  navigateOnce("stale-chunk");
}
// Vite's own preload helper fires this for failed dynamic imports.
window.addEventListener("vite:preloadError", (e) => { e.preventDefault(); reloadOnStaleChunk(); });
// Belt-and-braces: catch the raw dynamic-import failure too. Matched on the
// module-loading wording only — see isChunkLoadError for why a bare
// "Failed to fetch" must not count.
window.addEventListener("unhandledrejection", (e) => {
  const msg = String((e.reason && (e.reason.message || e.reason)) ?? "");
  if (isChunkLoadError(msg)) reloadOnStaleChunk();
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
