import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "../lib/api";

type Msg = { role: "user" | "assistant"; content: string };

const STARTERS = [
  "How do I check in a delivery?",
  "Why is a PO still pending approval?",
  "What can my role do?",
];

/** The helpdesk panel. Opened from the sidebar's "Need help?" button, which
 *  fires a `helpdesk-open` window event — this component renders at the app
 *  root, far from the sidebar in the tree.
 *
 *  The conversation lives here in the browser — the server is stateless and
 *  only sees what we send — so closing the tab clears it. */
export function HelpdeskWidget() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [msgs, busy, open]);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("helpdesk-open", onOpen);
    return () => window.removeEventListener("helpdesk-open", onOpen);
  }, []);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    const next: Msg[] = [...msgs, { role: "user", content: q }];
    setMsgs(next);
    setDraft("");
    setErr(null);
    setBusy(true);
    try {
      const { reply } = await api.helpdeskChat(next, pathname);
      setMsgs([...next, { role: "assistant", content: reply }]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <section className="hd-panel" role="dialog" aria-label="Helpdesk">
      <header className="hd-head">
        <strong>Helpdesk</strong>
        <span className="hd-sub">AI assistant — can look things up, can't change anything</span>
        {msgs.length > 0 && <button className="hd-link" onClick={() => { setMsgs([]); setErr(null); }}>New chat</button>}
        <button className="hd-x" onClick={() => setOpen(false)} aria-label="Close helpdesk">×</button>
      </header>
      <div className="hd-body">
        {msgs.length === 0 && (
          <div className="hd-empty">
            <p>Ask how to do something in PGP Projects, or where a purchase order is up to.</p>
            {STARTERS.map((s) => <button key={s} className="hd-chip" onClick={() => send(s)}>{s}</button>)}
          </div>
        )}
        {msgs.map((m, i) => <div key={i} className={`hd-msg ${m.role}`}>{m.content}</div>)}
        {busy && <div className="hd-msg assistant hd-typing">Thinking…</div>}
        {err && <div className="flash error">{err}</div>}
        <div ref={endRef} />
      </div>
      <form className="hd-form" onSubmit={(e) => { e.preventDefault(); void send(draft); }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask a question…"
          maxLength={2000}
          autoFocus
        />
        <button className="btn primary sm" disabled={busy || !draft.trim()}>Send</button>
      </form>
    </section>
  );
}
