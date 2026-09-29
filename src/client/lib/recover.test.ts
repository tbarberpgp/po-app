// Tests for the two "this tab is holding something stale" detectors.
//
//   npm test
//
// The case that matters is the one that used to be wrong: the handler in
// main.tsx matched a bare "Failed to fetch", which is what every dropped
// request produces. On site mobile data that meant one lost API call reloaded
// the whole app out from under whoever was mid-edit. Only a genuine failed
// module load may reload the page.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isChunkLoadError, isAccessLoginResponse } from "./recover";

describe("isChunkLoadError", () => {
  test("recognises a failed dynamic import in every engine's wording", () => {
    // Chrome/Edge, Safari and Firefox each phrase this differently, and the
    // Dashboard chunk (Recharts, ~126KB gzipped) is the one that hits it.
    for (const msg of [
      "Failed to fetch dynamically imported module: https://po-app.tbarber.workers.dev/assets/Dashboard-D6DyJtbE.js",
      "Importing a module script failed.",
      "error loading dynamically imported module: /assets/pdf-Y4YPUwDk.js",
    ]) {
      assert.equal(isChunkLoadError(msg), true, msg);
    }
  });

  test("a dropped request is NOT a stale chunk", () => {
    // The regression. These are ordinary weak-signal failures; reloading on
    // them loses unsaved work and fixes nothing.
    for (const msg of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Load failed",
      "The network connection was lost.",
    ]) {
      assert.equal(isChunkLoadError(msg), false, msg);
    }
  });
});

describe("isAccessLoginResponse", () => {
  const origin = "https://po-app.tbarber.workers.dev";
  const res = (url: string, contentType: string) =>
    ({ url, headers: new Headers({ "content-type": contentType }) }) as Response;

  // isAccessLoginResponse reads window.location.origin; give it one.
  const withWindow = (fn: () => void) => {
    const g = globalThis as { window?: unknown };
    const had = "window" in g;
    g.window = { location: { origin } };
    try { fn(); } finally { if (!had) delete g.window; }
  };

  test("our own JSON is not a login page", () => {
    withWindow(() => {
      assert.equal(isAccessLoginResponse(res(`${origin}/api/me`, "application/json")), false);
    });
  });

  test("a response that came back from another origin is Access", () => {
    withWindow(() => {
      const bounced = res("https://powergrid.cloudflareaccess.com/cdn-cgi/access/login/po-app", "text/html");
      assert.equal(isAccessLoginResponse(bounced), true);
    });
  });

  test("HTML from our own origin is Access too — the worker only answers JSON", () => {
    // Access can also serve its form in place, and the SPA fallback in
    // wrangler.toml means an unmatched path returns index.html. Either way an
    // /api/* call that produced HTML never reached a route handler.
    withWindow(() => {
      assert.equal(isAccessLoginResponse(res(`${origin}/api/me`, "text/html; charset=utf-8")), true);
    });
  });
});
