import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { Topbar } from "./Shell";
import { can } from "../../shared/permissions";
import { parseOperativesClient } from "../lib/materials-parser";
import {
  classifyOperativeRows, summariseRows, OPERATIVE_IMPORT_COLUMNS,
  type OperativeImportRow, type ClassifiedRow,
} from "../../shared/operatives-import";
import type { CurrentUser } from "../../shared/types";

const MAX_ROWS = 500;

// Three example rows for the downloadable template. Company must match an
// approved supplier — these are illustrative; the user replaces them.
const TEMPLATE_ROWS: string[][] = [
  ["Joe", "Bloggs", "07700 900001", "joe.bloggs@example.com", "PowerGrid Projects", "Roofer", "Jane Bloggs 07700 900111"],
  ["Amara", "Okafor", "07700 900002", "amara.okafor@example.com", "PowerGrid Projects", "Electrician", "Sam Okafor 07700 900222"],
  ["Liam", "Murphy", "07700 900003", "liam.murphy@example.com", "PowerGrid Projects", "Scaffolder", "Mary Murphy 07700 900333"],
];

function csvEscape(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function toCsv(headers: string[], rows: string[][]): string {
  return [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n");
}
function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export function OperativesBulkUpload({ me }: { me: CurrentUser | null }) {
  const navigate = useNavigate();
  const canEdit = can(me?.role, "delivery.edit");

  // Validation context, loaded once: approved-supplier names + existing mobiles.
  const [companies, setCompanies] = useState<Set<string> | null>(null);
  const [existing, setExisting] = useState<Map<string, { id: string; name: string }> | null>(null);
  const [ctxErr, setCtxErr] = useState<string | null>(null);

  const [templateOpen, setTemplateOpen] = useState(false);
  const [rawRows, setRawRows] = useState<OperativeImportRow[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importErr, setImportErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!canEdit) return;
    Promise.all([api.listSuppliers(), api.operatives()])
      .then(([sup, ops]) => {
        setCompanies(new Set(sup.map((s) => s.name.toLowerCase())));
        const m = new Map<string, { id: string; name: string }>();
        for (const o of ops) {
          const n = (o as { phone_norm?: string | null }).phone_norm;
          if (n && !m.has(n)) m.set(n, { id: o.id, name: o.name });
        }
        setExisting(m);
      })
      .catch((e) => setCtxErr(e instanceof Error ? e.message : "Couldn't load suppliers / register"));
  }, [canEdit]);

  // Re-classify whenever the parsed rows or the (async) context change.
  const classified = useMemo<ClassifiedRow[] | null>(
    () => (rawRows && companies && existing ? classifyOperativeRows(rawRows, { companies, existingByMobile: existing }) : null),
    [rawRows, companies, existing],
  );
  const summary = useMemo(() => (classified ? summariseRows(classified) : null), [classified]);
  const willImport = summary ? summary.newCount + (overwrite ? summary.updateCount : 0) : 0;
  const step = importing ? 3 : classified ? 2 : 1;

  async function handleFile(f: File | undefined | null) {
    if (!f) return;
    setParsing(true); setParseErr(null); setRawRows(null); setOverwrite(false); setImportErr(null); setFileName(f.name);
    try {
      const parsed = await parseOperativesClient(f);
      if (parsed.length === 0) {
        setParseErr("No rows found. The file needs a header row with first_name, last_name, mobile, email, company, trade and emergency_contact columns.");
      } else if (parsed.length > MAX_ROWS) {
        setParseErr(`That file has ${parsed.length} rows — the limit is ${MAX_ROWS}. Split it and upload in batches.`);
      } else {
        setRawRows(parsed);
      }
    } catch {
      setParseErr("Couldn't read that file — upload a .csv or .xlsx using the template columns.");
    } finally {
      setParsing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function doImport() {
    if (!rawRows || willImport === 0) return;
    setImporting(true); setImportErr(null);
    try {
      const r = await api.bulkImportOperatives(rawRows, overwrite);
      const parts = [`${r.added} added`];
      if (r.updated) parts.push(`${r.updated} updated`);
      parts.push(`${r.skipped} skipped`);
      navigate("/operatives", { state: { flash: parts.join(", ") + "." } });
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : "Import failed");
      setImporting(false);
    }
  }

  function downloadTemplate() {
    downloadCsv("operatives_template.csv", toCsv([...OPERATIVE_IMPORT_COLUMNS], TEMPLATE_ROWS));
  }
  function downloadErrorRows() {
    if (!classified) return;
    const errs = classified.filter((r) => r.status === "error");
    const rows = errs.map((r) => [r.first_name, r.last_name, r.mobile, r.email, r.company, r.trade, r.emergency_contact, r.result]);
    downloadCsv("operatives_errors_to_fix.csv", toCsv([...OPERATIVE_IMPORT_COLUMNS, "error"], rows));
  }

  if (!me) return <main><div className="empty" style={{ padding: 40 }}>Loading…</div></main>;
  if (!canEdit) {
    return (
      <>
        <Topbar crumbs={<Link to="/operatives">‹ Operatives</Link>} title="Bulk upload operatives" />
        <main><div className="flash error">You don't have permission to add operatives.</div></main>
      </>
    );
  }

  return (
    <>
      <Topbar crumbs={<Link to="/operatives">‹ Operatives</Link>} title="Bulk upload operatives" />
      <main className="bulk-wrap">
        {/* Step indicator */}
        <ol className="bulk-steps">
          {["Download template", "Upload & review", "Import"].map((label, i) => {
            const n = i + 1;
            const state = n < step ? "done" : n === step ? "current" : "todo";
            return (
              <li key={label} className={`bulk-step ${state}`}>
                <span className="bulk-step-n">{state === "done" ? "✓" : n}</span>
                <span className="bulk-step-l">{label}</span>
              </li>
            );
          })}
        </ol>

        {ctxErr && <div className="flash error">{ctxErr}</div>}

        {/* 1 · Template (collapsible, collapsed by default) */}
        <div className="card">
          <div className="bulk-tmpl-hd" onClick={() => setTemplateOpen((o) => !o)} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setTemplateOpen((o) => !o); } }}
            aria-expanded={templateOpen}>
            <span className="bulk-caret">{templateOpen ? "▾" : "▸"}</span>
            <h2 style={{ margin: 0 }}>Download the template</h2>
            <span className="grow" />
            <button type="button" className="accent" onClick={(e) => { e.stopPropagation(); downloadTemplate(); }}>↓ Download .csv template</button>
          </div>
          {templateOpen && (
            <div className="card-bd">
              <p className="muted" style={{ marginTop: 0 }}>One operative per row. Columns (all required):</p>
              <ul className="bulk-cols">
                <li><code>first_name</code>, <code>last_name</code> — their name</li>
                <li><code>mobile</code> — UK mobile; it's the match key for site sign-ins and dedupe</li>
                <li><code>email</code> — a valid address</li>
                <li><code>company</code> — must match an <Link to="/suppliers">approved supplier</Link> exactly</li>
                <li><code>trade</code> — e.g. Roofer, Electrician</li>
                <li><code>emergency_contact</code> — name &amp; number</li>
              </ul>
              <p className="muted" style={{ marginBottom: 0, fontSize: 12.5 }}>Qualification cards (CSCS etc.) aren't imported here — operatives add those from their profile link after.</p>
            </div>
          )}
        </div>

        {/* 2 · Upload */}
        <div className="card card-padded">
          <h2 style={{ marginTop: 0 }}>Upload &amp; review</h2>
          {parseErr && <div className="flash error">{parseErr}</div>}
          <div
            className={`dropzone bulk-dropzone${dragOver ? " drag" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files?.[0]); }}
          >
            <input ref={fileRef} type="file" accept=".csv,.xlsx" hidden onChange={(e) => handleFile(e.target.files?.[0])} />
            <div className="bulk-drop-inner">
              <div className="bulk-drop-title">{parsing ? `Reading ${fileName}…` : "Drag a .csv or .xlsx here"}</div>
              <div className="muted" style={{ fontSize: 12.5 }}>or</div>
              <button type="button" className="accent" disabled={parsing} onClick={() => fileRef.current?.click()}>Browse files</button>
              <div className="muted" style={{ fontSize: 12 }}>Up to {MAX_ROWS} operatives per file{fileName && !parsing && classified ? ` · loaded ${fileName}` : ""}</div>
            </div>
          </div>
        </div>

        {/* 3 · Review */}
        {classified && summary && (
          <div className="card">
            <div className="card-hd"><h2>Review</h2><span className="grow" /><span className="muted" style={{ fontSize: 12 }}>{classified.length} row{classified.length === 1 ? "" : "s"} from {fileName}</span></div>
            <div className="card-bd">
              {/* Summary bar */}
              <div className="bulk-summary">
                <span><span className="bulk-dot new" /> <strong>{summary.newCount}</strong> ready</span>
                <span className="bulk-sep">·</span>
                <span><span className="bulk-dot update" /> <strong>{summary.updateCount}</strong> will update an existing operative</span>
                <span className="bulk-sep">·</span>
                <span><span className="bulk-dot error" /> <strong>{summary.errorCount}</strong> need fixing</span>
              </div>

              {/* Overwrite confirmation */}
              {summary.updateCount > 0 && (
                <label className="bulk-overwrite">
                  <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
                  <span>Update {summary.updateCount} existing operative{summary.updateCount === 1 ? "" : "s"} with the new details</span>
                </label>
              )}

              {importErr && <div className="flash error" style={{ marginTop: 12 }}>{importErr}</div>}

              {/* Preview table */}
              <div className="bulk-table-scroll">
                <table className="bulk-table">
                  <thead>
                    <tr>
                      <th style={{ width: 28 }} />
                      <th>First name</th><th>Last name</th><th>Mobile</th><th>Email</th><th>Company</th><th>Trade</th><th>Emergency contact</th><th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {classified.map((r, i) => (
                      <tr key={i} className={r.status === "error" ? "bulk-row-err" : undefined}>
                        <td><span className={`bulk-dot ${r.status === "update" ? "update" : r.status}`} title={r.result} /></td>
                        <td className={r.field === "first_name" ? "bulk-cell-bad" : undefined}>{r.first_name || <span className="muted">—</span>}</td>
                        <td className={r.field === "last_name" ? "bulk-cell-bad" : undefined}>{r.last_name || <span className="muted">—</span>}</td>
                        <td className={r.field === "mobile" ? "bulk-cell-bad" : undefined}>{r.mobile || <span className="muted">—</span>}</td>
                        <td className={r.field === "email" ? "bulk-cell-bad" : undefined}>{r.email || <span className="muted">—</span>}</td>
                        <td className={r.field === "company" ? "bulk-cell-bad" : undefined}>{r.company || <span className="muted">—</span>}</td>
                        <td className={r.field === "trade" ? "bulk-cell-bad" : undefined}>{r.trade || <span className="muted">—</span>}</td>
                        <td className={r.field === "emergency_contact" ? "bulk-cell-bad" : undefined}>{r.emergency_contact || <span className="muted">—</span>}</td>
                        <td><ResultCell r={r} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Rules & notes */}
              <details className="bulk-rules">
                <summary>Upload rules &amp; notes</summary>
                <ul>
                  <li>Keep the header row as-is — one operative per row.</li>
                  <li>Operatives are matched on <strong>mobile</strong>; an existing match is skipped unless you tick the update box.</li>
                  <li>A duplicate mobile <em>within the file</em> is treated as an error.</li>
                  <li>Company must already exist as an approved supplier — add it first if it's missing.</li>
                  <li>Up to {MAX_ROWS} rows · .csv or .xlsx.</li>
                </ul>
              </details>

              {/* Actions */}
              <div className="bulk-actions">
                <button className="accent" disabled={importing || willImport === 0} onClick={doImport}>
                  {importing ? "Importing…"
                    : overwrite && summary.updateCount > 0
                      ? `Import ${summary.newCount} new + ${summary.updateCount} update${summary.updateCount === 1 ? "" : "s"}`
                      : `Import ${summary.newCount} operative${summary.newCount === 1 ? "" : "s"}`}
                </button>
                {summary.errorCount > 0 && (
                  <button className="ghost" onClick={downloadErrorRows}>↓ Download error rows to fix</button>
                )}
                <Link className="btn ghost" to="/operatives">Cancel</Link>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  );
}

/** Result column: green New / amber Updates existing / red reason. Unknown
 *  company offers a quick link to add the supplier. */
function ResultCell({ r }: { r: ClassifiedRow }) {
  if (r.status === "new") return <span style={{ color: "var(--success)", fontWeight: 600 }}>New</span>;
  if (r.status === "update") return <span style={{ color: "var(--warn)", fontWeight: 600 }}>Updates existing</span>;
  return (
    <span style={{ color: "var(--danger)", fontWeight: 600 }}>
      {r.result}
      {r.result === "Unknown company" && <> · <Link to="/suppliers" style={{ fontWeight: 500 }}>Add supplier</Link></>}
    </span>
  );
}
