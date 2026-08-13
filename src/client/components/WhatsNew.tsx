import { useEffect } from "react";
import { Topbar } from "./Shell";
import { CHANGELOG, WHATS_NEW_LATEST_ID } from "../lib/whats-new";

/** Product changelog. Visiting marks the latest entry as seen, which clears
 *  the red dot next to "What's new" in the sidebar. */
export function WhatsNew() {
  useEffect(() => {
    try {
      localStorage.setItem("whatsnew.seen", WHATS_NEW_LATEST_ID);
      window.dispatchEvent(new Event("whatsnew-seen"));
    } catch { /* localStorage unavailable — no dot to clear, nothing to do */ }
  }, []);

  return (
    <>
      <Topbar crumbs="Workspace" title="What's new" />
      <main className="guide">
        {CHANGELOG.map((e, i) => (
          <div className="card" key={e.id}>
            <div className="card-bd">
              <div className="wn-date">{e.date}{i === 0 && <span className="wn-latest">Latest</span>}</div>
              <h2 style={{ margin: "2px 0 8px" }}>{e.title}</h2>
              <ul className="wn-list">
                {e.points.map((p, j) => <li key={j}>{p}</li>)}
              </ul>
            </div>
          </div>
        ))}
      </main>
    </>
  );
}
