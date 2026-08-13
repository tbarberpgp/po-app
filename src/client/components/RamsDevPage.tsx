import { useEffect, useRef, useState } from "react";
import { parseRamsDocx } from "../../shared/parse-rams";
import type { RamsBlock, RamsDoc } from "../../shared/rams";
import { RamsReadThrough } from "./RamsReadThrough";

/**
 * Dev-only harness for the RAMS read-through reader. Parses a .docx in the
 * browser (the exact code path the manager upload will use) and renders the
 * operative reader against it — no auth, no storage. Reachable at /rams-dev.
 */
export function RamsDevPage() {
  const [doc, setDoc] = useState<RamsDoc | null>(null);
  const [title, setTitle] = useState("RAMS");
  const [err, setErr] = useState<string | null>(null);
  const [signed, setSigned] = useState<string | null>(null);
  const [freeNav, setFreeNav] = useState(false);
  const urls = useRef<string[]>([]);

  useEffect(() => () => { urls.current.forEach((u) => URL.revokeObjectURL(u)); }, []);

  async function parse(bytes: Uint8Array, name: string) {
    setErr(null); setSigned(null);
    try {
      const { doc, media } = parseRamsDocx(bytes);
      // Rewrite image keys → blob URLs so embedded images render in the demo.
      const map = new Map<string, string>();
      for (const [key, data] of Object.entries(media)) {
        const u = URL.createObjectURL(new Blob([data as unknown as BlobPart]));
        urls.current.push(u); map.set(key, u);
      }
      rewriteImages(doc.sections.flatMap((s) => s.blocks), map);
      setDoc(doc);
      // doc.title is a weak fallback (it can grab a section heading); prefer a
      // clean name for the harness masthead. The real pipeline supplies the title.
      const t = doc.title && !/^\d+[.)]/.test(doc.title) ? doc.title : name.replace(/\.docx$/i, "");
      setTitle(t);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setDoc(null);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    await parse(new Uint8Array(await f.arrayBuffer()), f.name);
  }
  async function loadSample() {
    try {
      const r = await fetch("/rams-sample.docx");
      if (!r.ok) throw new Error(`Sample not found (${r.status}) — drop a .docx instead`);
      await parse(new Uint8Array(await r.arrayBuffer()), "PGP RAMS sample");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  if (doc) {
    return (
      <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 10px", borderBottom: "1px solid var(--border)", flex: "0 0 auto" }}>
          <button className="ghost" onClick={() => setDoc(null)}>← Pick another</button>
          <span className="muted" style={{ fontSize: 12 }}>{doc.sections.length} sections · DEV harness</span>
          <label className="muted" style={{ fontSize: 12, display: "flex", gap: 5, alignItems: "center", marginLeft: "auto", cursor: "pointer" }}>
            <input type="checkbox" checked={freeNav} onChange={(e) => setFreeNav(e.target.checked)} /> free nav
          </label>
          {signed && <span className="pill ok dot">signed ✓</span>}
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <RamsReadThrough
            key={freeNav ? "free" : "gated"} doc={doc} title={title} projectCode="DEMO" freeNav={freeNav}
            onAccept={(sig) => { setSigned(sig); alert(`Captured signature (${Math.round(sig.length / 1024)} KB data URL).`); }}
          />
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 560, margin: "40px auto", padding: 24 }}>
      <h2 style={{ marginTop: 0 }}>RAMS reader — dev harness</h2>
      <p className="muted">Parse a RAMS .docx in the browser and walk the gated read-through + sign-off. Nothing is stored.</p>
      {err && <div className="flash error" style={{ margin: "12px 0" }}>{err}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
        <label className="btn" style={{ cursor: "pointer", textAlign: "center" }}>
          Choose a .docx…
          <input type="file" accept=".docx" onChange={onFile} style={{ display: "none" }} />
        </label>
        <button className="ghost" onClick={loadSample}>Load bundled sample (/rams-sample.docx)</button>
      </div>
    </div>
  );
}

function rewriteImages(blocks: RamsBlock[], map: Map<string, string>) {
  for (const b of blocks) {
    if (b.type === "image") { const u = map.get(b.src); if (u) b.src = u; }
    else if (b.type === "rawPage") rewriteImages(b.blocks, map);
  }
}
