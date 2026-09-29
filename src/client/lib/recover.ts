/**
 * The two ways a loaded tab can be left holding something stale, and the one
 * safe way out of each: reload.
 *
 *  - A deploy re-hashes Vite's code-split chunks, so a tab that still has the
 *    old index.html asks for a chunk that no longer exists.
 *  - A Cloudflare Access session lapses, so /api/* stops answering with our
 *    JSON and starts answering with Access's own login page.
 *
 * Both recover by navigating: the fresh document pulls the new bundle, and a
 * top-level navigation is the only thing Access will redirect to its PIN form
 * (it can't redirect a fetch — see `accessLoginResponse` below). Both must
 * also refuse to do it twice in a row, or a failure that a reload can't fix
 * becomes an endless reload.
 */

/**
 * Navigate once, at most, per `key` per 15 seconds. Returns false when the
 * guard swallowed it, so the caller can fall back to showing an error rather
 * than assuming the page is about to disappear.
 *
 * 15s because a reload on site data can take a good few seconds to come back;
 * the old 10s could let a slow phone start its second reload before the first
 * had finished painting.
 */
export function navigateOnce(key: string, to?: string): boolean {
  const storeKey = `recover.${key}`;
  try {
    const last = Number(sessionStorage.getItem(storeKey) ?? 0);
    if (Date.now() - last < 15_000) return false;
    sessionStorage.setItem(storeKey, String(Date.now()));
  } catch {
    // Private mode / storage disabled: without the guard we can't promise we
    // won't loop, so don't navigate at all — the caller shows an error instead.
    return false;
  }
  if (to) window.location.assign(to);
  else window.location.reload();
  return true;
}

/**
 * Is this a failed dynamic import — i.e. a chunk that isn't there any more?
 *
 * Deliberately does NOT match a bare "Failed to fetch". That string is what
 * every dropped request produces, and on site mobile data they are constant:
 * matching it meant one flaky API call reloaded the whole page out from under
 * whoever was typing. Only the module-loading wording, which each engine spells
 * its own way, means a stale chunk.
 */
export function isChunkLoadError(message: string): boolean {
  return /dynamically imported module|importing a module script failed|error loading dynamically imported module/i.test(
    message,
  );
}

/**
 * Did Cloudflare Access answer this request instead of our worker?
 *
 * Access can't send a fetch to its PIN form — a cross-origin redirect to
 * <team>.cloudflareaccess.com either lands us on a response from another
 * origin or is refused outright. So an /api/* call whose response came back
 * from somewhere else, or came back as HTML, means the session has lapsed:
 * the request never reached the worker, which only ever answers JSON.
 */
export function isAccessLoginResponse(res: Response): boolean {
  try {
    if (res.url && new URL(res.url).origin !== window.location.origin) return true;
  } catch {
    /* relative or unparseable URL — fall through to the content type */
  }
  return (res.headers.get("content-type") ?? "").includes("text/html");
}

/**
 * Send the browser back through Access to sign in again, landing back on the
 * page the user was already looking at. A top-level navigation is what Access
 * intercepts, and it returns the user to the same URL after the PIN, so the
 * round trip costs them one email instead of a dead screen.
 */
export function reauthenticate(): boolean {
  return navigateOnce("access-reauth", window.location.href);
}
