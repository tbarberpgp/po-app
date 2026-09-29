import { Component, type ErrorInfo, type ReactNode } from "react";
import { isChunkLoadError, navigateOnce } from "../lib/recover";

/**
 * Catches anything a screen throws while rendering — including a lazy import
 * that never arrived.
 *
 * Without this, a chunk that fails to download (the Dashboard drags in Recharts,
 * which is the heaviest of them) takes the whole React tree down with it and
 * leaves a white screen: no message, no way back, nothing to tell anyone. On a
 * site connection that is the difference between "slow" and "broken".
 *
 * `resetKey` is the route. Changing it clears the error, so navigating
 * somewhere else gets a working app back without a reload.
 */
export class ScreenBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { error: Error | null; shownFor: string }
> {
  state = { error: null as Error | null, shownFor: "" };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { error: Error | null; shownFor: string },
  ) {
    if (state.error && state.shownFor !== props.resetKey) return { error: null, shownFor: props.resetKey };
    if (!state.error && state.shownFor !== props.resetKey) return { shownFor: props.resetKey };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("screen failed to render", error, info.componentStack);
    // A missing chunk is usually just a stale tab after a deploy, and a reload
    // fixes it outright. Only once, though — if it comes back the message below
    // is the honest answer, because reloading again won't help.
    if (isChunkLoadError(error.message)) navigateOnce("stale-chunk");
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    return (
      <main>
        <div className="empty" style={{ padding: 40, display: "grid", gap: 12, justifyItems: "center" }}>
          <strong>This page didn't load.</strong>
          <span style={{ maxWidth: 420, textAlign: "center" }}>
            {offline
              ? "You appear to be offline. Reconnect and try again."
              : isChunkLoadError(error.message)
                ? "Part of the app didn't download — usually a weak signal, or a new version just went out."
                : error.message}
          </span>
          <button onClick={() => window.location.reload()}>Try again</button>
        </div>
      </main>
    );
  }
}
