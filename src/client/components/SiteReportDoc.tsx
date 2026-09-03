import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, fmtDate } from "../lib/api";
import { type ReportSections } from "../lib/report-pdf";

type FullReport = Awaited<ReturnType<typeof api.getSiteReport>>;

/** WMO weather code → emoji. */
function wxIcon(code: number): string {
  if (code === 0) return "☀️";
  if (code <= 2) return "🌤️";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if (code >= 51 && code <= 57) return "🌦️";
  if (code >= 61 && code <= 67) return "🌧️";
  if (code >= 71 && code <= 77) return "🌨️";
  if (code >= 80 && code <= 82) return "🌦️";
  if (code >= 85 && code <= 86) return "🌨️";
  if (code >= 95) return "⛈️";
  return "🌥️";
}
const dow = (iso: string, fmt: "short" | "narrow") => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: fmt });

/**
 * The site report rendered as a branded document (per the Site-Report handoff):
 * masthead, headline stat strip, sectioned cards, navy look-ahead block and a
 * supervisor sign-off. "Edit for client" makes text editable and lets sections /
 * photos be hidden; "PDF" prints (so the export matches the on-screen preview).
 * Edits tailor the exported copy only — they aren't saved.
 */
export function SiteReportDoc({ report, busy, onEmail, onClose, onSaved }: {
  report: FullReport; busy?: boolean; onEmail: () => void; onClose: () => void; onSaved?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  // Seed hidden sections from the saved report so a client-tailored copy stays
  // hidden across reloads and in the exported PDF.
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try { return new Set<string>((JSON.parse(report.data_json || "{}").hidden_sections ?? []) as string[]); } catch { return new Set(); }
  });
  const [hiddenPhotos, setHiddenPhotos] = useState<Set<number>>(new Set());
  const [pdfBusy, setPdfBusy] = useState(false);
  // Photo picker: choose which of the period's site photos appear on the report.
  const [picker, setPicker] = useState<Array<{ id: number; url: string; caption: string; taken_on?: string }> | null>(null); // null = closed
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [pSaving, setPSaving] = useState(false);
  const docRef = useRef<HTMLDivElement>(null); // read edited text back out of the DOM on save
  const [saving, setSaving] = useState(false);
  // Line-level edits: which original bullets were removed, and how many blank
  // lines were added per section (both applied by what we render, so the DOM
  // read-back on save picks up exactly the lines that remain).
  const [removedLines, setRemovedLines] = useState<Set<string>>(new Set());
  const [extraLines, setExtraLines] = useState<Record<string, number>>({});
  // Free-form sections the editor added (title + bullet lines) and per-photo
  // caption overrides — both controlled by state and written on save.
  const [custom, setCustom] = useState<Array<{ title: string; items: string[] }>>(() => {
    try { return (JSON.parse(report.data_json || "{}").custom_sections ?? []) as Array<{ title: string; items: string[] }>; } catch { return []; }
  });
  const [photoCaps, setPhotoCaps] = useState<Record<number, string>>({});
  // Per-day labour-level overrides (index → typed count) — the QR register
  // misses people, so the weekly chart must be correctable before it goes out.
  const [labourDayEdits, setLabourDayEdits] = useState<Record<number, string>>({});
  // Re-seed edit state whenever the drawer switches to a different report (the
  // lazy useState initialisers only run once, on first mount).
  useEffect(() => {
    setLabourDayEdits({});
    try {
      const d = JSON.parse(report.data_json || "{}");
      setHidden(new Set<string>((d.hidden_sections ?? []) as string[]));
      setCustom((d.custom_sections ?? []) as Array<{ title: string; items: string[] }>);
    } catch { setHidden(new Set()); setCustom([]); }
    setRemovedLines(new Set()); setExtraLines({}); setPhotoCaps({}); setHiddenPhotos(new Set()); setEditing(false);
  }, [report.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const removeLine = (field: string, i: number) => setRemovedLines((s) => { const n = new Set(s); n.add(`${field}:${i}`); return n; });
  const addLine = (field: string) => setExtraLines((s) => ({ ...s, [field]: (s[field] ?? 0) + 1 }));
  const addCustomSection = () => setCustom((c) => [...c, { title: "New section", items: [""] }]);
  const removeCustomSection = (ci: number) => setCustom((c) => c.filter((_, i) => i !== ci));
  const setCustomTitle = (ci: number, title: string) => setCustom((c) => c.map((x, i) => (i === ci ? { ...x, title } : x)));
  const setCustomLine = (ci: number, li: number, v: string) => setCustom((c) => c.map((x, i) => (i === ci ? { ...x, items: x.items.map((t, j) => (j === li ? v : t)) } : x)));
  const addCustomLine = (ci: number) => setCustom((c) => c.map((x, i) => (i === ci ? { ...x, items: [...x.items, ""] } : x)));
  const removeCustomLine = (ci: number, li: number) => setCustom((c) => c.map((x, i) => (i === ci ? { ...x, items: x.items.filter((_, j) => j !== li) } : x)));
  // Persist the "Edit for client" changes — reads the edited headline / bullets /
  // look-ahead back from the DOM and writes them to the report's data_json.
  async function saveReport() {
    const root = docRef.current;
    if (!root) return;
    const next = JSON.parse(report.data_json || "{}") as Record<string, unknown>;
    const hl = root.querySelector("[data-headline]");
    if (hl) next.headline = (hl.textContent || "").trim();
    const byField: Record<string, string[]> = {};
    root.querySelectorAll<HTMLElement>("[data-field]").forEach((el) => {
      const f = el.dataset.field;
      if (!f) return;
      (byField[f] ||= []).push((el.textContent || "").trim());
    });
    for (const f of ["progress", "labour", "blockers", "deliveries", "hse", "plant", "lookahead"]) {
      if (byField[f]) next[f] = byField[f].filter((x) => x.length > 0);
    }
    // Free-form sections the editor added (title + non-empty lines).
    next.custom_sections = custom
      .map((cs) => ({ title: (cs.title || "").trim(), items: cs.items.map((t) => t.trim()).filter(Boolean) }))
      .filter((cs) => cs.title || cs.items.length);
    // Corrected labour levels (per-day counts on the weekly chart).
    if (Array.isArray(next.labour_days) && Object.keys(labourDayEdits).length) {
      next.labour_days = (next.labour_days as Array<{ date: string; count: number }>).map((d, i) =>
        i in labourDayEdits ? { ...d, count: Math.max(0, Math.round(Number(labourDayEdits[i]) || 0)) } : d);
    }
    // Persist which sections are hidden. Apply per-photo caption overrides, then
    // drop any photos hidden in edit mode (caps first so indices still line up).
    next.hidden_sections = [...hidden];
    if (Array.isArray(next.photos)) {
      let ph = next.photos as Array<{ url: string; caption?: string }>;
      if (Object.keys(photoCaps).length) ph = ph.map((p, i) => (i in photoCaps ? { ...p, caption: photoCaps[i] } : p));
      if (hiddenPhotos.size) ph = ph.filter((_, i) => !hiddenPhotos.has(i));
      next.photos = ph;
    }
    setSaving(true);
    try {
      await api.saveReport(report.id, next);
      setHiddenPhotos(new Set()); setRemovedLines(new Set()); setExtraLines({}); setPhotoCaps({}); setLabourDayEdits({});
      setEditing(false); onSaved?.();
    }
    catch (e) { window.alert("Couldn't save: " + (e instanceof Error ? e.message : "error")); }
    finally { setSaving(false); }
  }
  async function openPhotos() {
    const cur = ((): Array<{ url: string; caption?: string }> => { try { return (JSON.parse(report.data_json || "{}").photos ?? []) as Array<{ url: string; caption?: string }>; } catch { return []; } })();
    setChosen(new Set(cur.map((p) => p.url)));
    try {
      const pool = await api.listReportPhotos(report.id);
      const poolUrls = new Set(pool.map((p) => p.url));
      const extra = cur.filter((p) => !poolUrls.has(p.url)).map((p, i) => ({ id: -1 - i, url: p.url, caption: p.caption || "", taken_on: undefined }));
      setPicker([...pool, ...extra]);
    } catch { setPicker(cur.map((p, i) => ({ id: -1 - i, url: p.url, caption: p.caption || "" }))); }
  }
  async function savePhotos() {
    if (!picker) return;
    setPSaving(true);
    try {
      const photos = picker.filter((p) => chosen.has(p.url)).map((p) => ({ url: p.url, caption: p.caption || "" }));
      await api.saveReportPhotos(report.id, photos);
      setPicker(null);
      onSaved?.();
    } catch (e) { window.alert("Couldn't save photos: " + (e instanceof Error ? e.message : "error")); }
    finally { setPSaving(false); }
  }

  const s = JSON.parse(report.data_json || "{}") as ReportSections;
  const daily = report.period_type === "daily";
  const dateStr = daily ? fmtDate(report.period_start) : `${fmtDate(report.period_start)} – ${fmtDate(report.period_end)}`;
  // Header: project name leads, with a small eyebrow + a meta line (code · prog · reporter).
  const projName = report.project_id ? (report.project_name || report.project_code || "Project") : "Portfolio roll-up";
  const reporter = report.generated_by && report.generated_by !== "cron" ? `Reported by ${report.generated_by}` : null;
  const metaBits = [
    report.project_id ? report.project_code : null,
    s.programme ? `Day ${s.programme.day} of ${s.programme.total_days}` : null,
    reporter,
  ].filter(Boolean).join("  ·  ");
  const photos = (s.photos ?? []).filter((_, i) => !hiddenPhotos.has(i));

  // "Quiet day": a routine daily report with nothing to flag — no blockers,
  // deliveries or safety events. Renders a green summary banner + a single
  // "all clear" card instead of a string of empty sections.
  const noBlockers = (s.blockers?.length ?? 0) === 0;
  const noDeliveries = ((s.deliveries_detail?.length ?? 0) + (s.deliveries ?? []).length) === 0;
  const safetyClear = !s.safety || (!s.safety.incidents && !s.safety.near_misses);
  const quiet = daily && noBlockers && noDeliveries && safetyClear;
  const allClear = [
    "No delays or blockers",
    "No deliveries scheduled",
    "No safety incidents or near misses",
    s.weather ? "No weather impact" : null,
    !s.safety?.rams_outstanding ? "RAMS up to date" : null,
    (s.plant?.length ?? 0) > 0 ? `Plant unchanged (${s.plant!.length} item${s.plant!.length === 1 ? "" : "s"})` : null,
  ].filter((x): x is string => !!x);

  const toggleHide = (k: string) => setHidden((h) => { const n = new Set(h); n.has(k) ? n.delete(k) : n.add(k); return n; });
  // Condensed file/print name, e.g. "26002 Daily report 21 Jun 2026" (code + period + date).
  const shortLabel = report.project_id ? (report.project_code ?? "Project") : "Portfolio";
  const docName = `${shortLabel} ${daily ? "Daily" : "Weekly"} report ${fmtDate(report.period_start)}`;

  // PDF export = the server-rendered PDF (Cloudflare Browser Rendering), which is
  // a clean A4 document with repeating table headers, proper page breaks and no
  // browser print chrome (date / URL / page-number headers). Saves any open edits
  // first so the PDF reflects them, then downloads the file. Falls back to the
  // browser print dialog if the server PDF is unavailable.
  async function downloadPdf() {
    if (editing) await saveReport();
    setPdfBusy(true);
    try {
      // Retry on a transient Browser-Rendering 503 (its session limit). We do NOT
      // fall back to window.print(): the report renders inside a fixed-position
      // drawer, which browsers repeat on every printed page (the "double the first
      // page" bug). Better to ask the user to retry than hand them a broken PDF.
      let res: Response | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        res = await fetch(`/api/site-reports/${report.id}/pdf`, { credentials: "include" });
        if (res.ok) break;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1200));
      }
      if (!res || !res.ok) {
        window.alert("Couldn't build the PDF just now — the report renderer was busy. Please try again in a few seconds.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${docName}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch {
      window.alert("Couldn't download the PDF. Please try again in a few seconds.");
    } finally { setPdfBusy(false); }
  }

  function Section({ k, title, icon, meta, children }: { k: string; title: string; icon: string; meta?: ReactNode; children: ReactNode }) {
    if (hidden.has(k) && !editing) return null;
    return (
      <section className={`rd-card${hidden.has(k) ? " rd-sechidden" : ""}`}>
        {editing && <button className="rd-secdel" onClick={() => toggleHide(k)} title={hidden.has(k) ? "Show in report" : "Hide from report"}>{hidden.has(k) ? "+" : "✕"}</button>}
        <div className="rd-ch"><span className="rd-ic" aria-hidden>{icon}</span><h2>{title}</h2>{meta != null && <span className="rd-meta">{meta}</span>}</div>
        <div className="rd-cb">{children}</div>
      </section>
    );
  }
  const Bullets = ({ items, tick, field }: { items: string[]; tick?: boolean; field?: string }) => (
    <div className="rd-list">
      {items.map((t, i) => (field && removedLines.has(`${field}:${i}`)) ? null : (
        <div className="rd-li" key={i}>
          <span className={tick ? "rd-tick" : "rd-dot"} aria-hidden>{tick ? "✓" : ""}</span>
          <div className="rd-litxt" contentEditable={editing} suppressContentEditableWarning data-field={field} data-idx={i}>{t}</div>
          {editing && field && <button className="rd-linedel" onClick={() => removeLine(field, i)} title="Remove this line">✕</button>}
        </div>
      ))}
      {editing && field && Array.from({ length: extraLines[field] ?? 0 }).map((_, j) => (
        <div className="rd-li" key={`x${j}`}>
          <span className={tick ? "rd-tick" : "rd-dot"} aria-hidden>{tick ? "✓" : ""}</span>
          <div className="rd-litxt" contentEditable suppressContentEditableWarning data-field={field} data-idx={`x${j}`} style={{ minWidth: 40 }} />
        </div>
      ))}
      {editing && field && <button className="rd-addline" onClick={() => addLine(field)}>+ Add line</button>}
    </div>
  );

  return (
    <div className="report-doc" ref={docRef}>
      <button className="rd-x" onClick={onClose} aria-label="Close" title="Close">✕</button>

      {editing && (
        <div className="rd-editbar">Editing — click any text to change it. Use <b>+ Add line</b> / the line <b>✕</b> to add or remove points, <b>+ Add section</b> for a new section, and the section <b>✕</b> to hide one. Add captions under photos. <b>Save</b> to keep it all (edits flow into the PDF and emails).</div>
      )}

      {/* Masthead — project name leads, with an eyebrow + meta line + actions. */}
      <div className="rd-mast">
        <img className="rd-printlogo" src="/logo.png" alt="PGP" />
        <div className="rd-eyebrow">{daily ? "Daily report" : "Weekly report"} · {dateStr}</div>
        <h1 contentEditable={false}>{projName}</h1>
        {metaBits && <div className="rd-sub">{metaBits}</div>}
        <div className="rd-actions">
          <span className="rd-wa">● Auto from WhatsApp</span>
          <span className="grow" />
          <button className="btn ghost sm" onClick={openPhotos}>🖼 Photos</button>
          <button className={`btn ghost sm${editing ? " active" : ""}`} onClick={() => (editing ? saveReport() : setEditing(true))} disabled={saving}>{editing ? (saving ? "Saving…" : "💾 Save") : "✎ Edit"}</button>
          {editing && <button className="btn ghost sm" onClick={() => { setEditing(false); setRemovedLines(new Set()); setExtraLines({}); setPhotoCaps({}); setHiddenPhotos(new Set()); setHidden(new Set((() => { try { return (JSON.parse(report.data_json || "{}").hidden_sections ?? []) as string[]; } catch { return []; } })())); setCustom((() => { try { return (JSON.parse(report.data_json || "{}").custom_sections ?? []) as Array<{ title: string; items: string[] }>; } catch { return []; } })()); }} disabled={saving}>Cancel</button>}
          <button className="btn ghost sm" onClick={downloadPdf} disabled={pdfBusy}>{pdfBusy ? "Generating…" : "↓ PDF"}</button>
          <button className="btn ghost sm" disabled={busy} onClick={async () => {
            const to = window.prompt("Send a test copy (with the PDF attached) to:", "");
            if (!to || !to.includes("@")) return;
            try { await api.sendSiteReport(report.id, [to.trim()]); window.alert(`Test report sent to ${to.trim()}.`); }
            catch (e) { window.alert("Couldn't send: " + (e instanceof Error ? e.message : "error")); }
          }}>✈ Test</button>
          <button className="btn sm" disabled={busy} onClick={onEmail} style={{ background: "var(--accent)", color: "var(--accent-fg)", borderColor: "var(--accent)" }}>✉ Email</button>
        </div>
      </div>

      {/* Headline stat strip */}
      <div className="rd-strip">
        <div className="rd-sc"><div className="l">Weather</div><div className="v">{s.weather_days?.[0] ? `${s.weather_days[0].max}°` : "—"}</div><div className="s">{s.weather || "No data"}</div></div>
        <div className="rd-sc"><div className="l">On site</div><div className="v">{s.attendance?.on_site ?? s.labour_count ?? "—"}</div><div className="s">{s.attendance ? `${s.attendance.companies} ${s.attendance.companies === 1 ? "company" : "companies"}` : "on site"}</div></div>
        <div className="rd-sc"><div className="l">Progress</div><div className={`v${s.programme ? " ok" : ""}`}>{s.programme ? `${s.programme.pct_overall}%` : (s.progress ?? []).length}</div><div className="s">{s.programme ? "complete overall" : "notes logged"}</div></div>
        <div className="rd-sc"><div className="l">Delays</div><div className={`v${(s.blockers ?? []).length ? " warn" : " ok"}`}>{(s.blockers ?? []).length}</div><div className="s">{(s.blockers ?? []).length ? "to resolve" : "none"}</div></div>
      </div>

      {quiet ? (
        <div className="rd-quiet">
          <span className="rd-qcheck" aria-hidden>✓</span>
          <div>
            <div className="rd-qhead">Quiet day — routine progress, nothing to flag.</div>
            <div className="rd-qsub">{[
              s.attendance ? `${s.attendance.on_site} on site` : (s.labour_count ? `${s.labour_count} on site` : null),
              s.weather || null,
              "No delays, deliveries or safety issues reported",
            ].filter(Boolean).join("  ·  ")}</div>
          </div>
        </div>
      ) : (
        <p className="rd-headline" contentEditable={editing} suppressContentEditableWarning data-headline="1">{s.headline}</p>
      )}

      {(s.weather || (s.weather_days?.length ?? 0) > 0) && (
        <Section k="weather" title="Weather" icon="⛅" meta={(s.weather_days?.length ?? 0) > 1 ? s.weather : undefined}>
          {(s.weather_days?.length ?? 0) > 1 ? (
            <div className="rd-wxdays">
              {s.weather_days!.map((d, i) => (
                <div className="rd-wxd" key={i}>
                  <div className="dd">{dow(d.date, "short")}</div>
                  <div className="ic">{wxIcon(d.code)}</div>
                  <div className="dn">{d.max}° <span className="muted">{d.min}°</span></div>
                  {d.precip >= 0.5 && <div className="muted" style={{ fontSize: 10 }}>{d.precip}mm</div>}
                </div>
              ))}
            </div>
          ) : (s.weather_days?.length ?? 0) === 1 ? (
            <div className="rd-wx"><span className="rd-wxic">{wxIcon(s.weather_days![0].code)}</span><span className="rd-wxtemp">{s.weather_days![0].max}°</span><span className="rd-wxbig">{s.weather}</span></div>
          ) : (
            <div className="rd-wxbig">{s.weather}</div>
          )}
        </Section>
      )}
      {((s.labour ?? []).length > 0 || (s.labour_days ?? []).length > 0 || s.attendance) && (
        <Section k="labour" title="Labour & plant on site" icon="👷" meta={s.attendance ? `${s.attendance.on_site} on site · ${s.attendance.companies} ${s.attendance.companies === 1 ? "company" : "companies"}` : (s.labour_count || undefined)}>
          {(s.labour_days?.length ?? 0) >= 2 && (() => {
            const eff = s.labour_days!.map((d, i) =>
              i in labourDayEdits ? Math.max(0, Math.round(Number(labourDayEdits[i]) || 0)) : d.count);
            const max = Math.max(1, ...eff);
            return (
              <div className="rd-bars">
                {s.labour_days!.map((d, i) => (
                  <div className="rd-bar" key={i}>
                    {editing ? (
                      <input
                        value={labourDayEdits[i] ?? String(d.count)}
                        onChange={(e) => setLabourDayEdits((p) => ({ ...p, [i]: e.target.value.replace(/[^0-9]/g, "") }))}
                        inputMode="numeric"
                        aria-label={`Operatives on ${d.date}`}
                        style={{ width: 34, textAlign: "center", fontSize: 11, padding: "2px 2px", border: "1px solid var(--accent)", borderRadius: 5, marginBottom: 2 }}
                      />
                    ) : (
                      <span className="n">{eff[i] || ""}</span>
                    )}
                    <i style={{ height: `${Math.round((eff[i] / max) * 100)}%` }} />
                    <span className="d">{dow(d.date, "narrow")}</span>
                  </div>
                ))}
              </div>
            );
          })()}
          {(s.labour_table?.length ?? 0) > 0 ? (() => {
            // Shifts nobody signed out of contribute no hours (see labourTable).
            // Mark the rows they affect and say so under the table, so a partial
            // figure reads as partial instead of as the whole week's labour.
            const missing = s.labour_table!.reduce((a, r) => a + (r.missing_signouts ?? 0), 0);
            return (
              <>
                <table className="rep-table" style={{ marginTop: 8 }}>
                  <thead><tr><th>Company</th><th>Trade</th><th className="num">No.</th><th className="num">Hours</th></tr></thead>
                  <tbody>
                    {s.labour_table!.map((r, i) => (
                      <tr key={i}>
                        <td>{r.company}</td>
                        <td className="muted">{r.trade || "—"}</td>
                        <td className="num">{r.count}</td>
                        <td className="num">
                          {r.hours > 0 ? r.hours.toFixed(1) : "—"}
                          {(r.missing_signouts ?? 0) > 0 && <span className="muted" title={`${r.missing_signouts} shift${r.missing_signouts === 1 ? "" : "s"} with no sign-out recorded`}>*</span>}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td><strong>Total</strong></td>
                      <td />
                      <td className="num"><strong>{s.labour_table!.reduce((a, r) => a + r.count, 0)}</strong></td>
                      <td className="num"><strong>{(() => { const h = s.labour_table!.reduce((a, r) => a + r.hours, 0); return h > 0 ? h.toFixed(1) : "—"; })()}</strong></td>
                    </tr>
                  </tbody>
                </table>
                {missing > 0 && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    * {missing} shift{missing === 1 ? "" : "s"} had no sign-out recorded, so {missing === 1 ? "its" : "their"} hours
                    are not included. Correcting the sign-out {missing === 1 ? "time" : "times"} on the project's Operations tab
                    and regenerating will complete the figure.
                  </div>
                )}
              </>
            );
          })() : (s.labour ?? []).length > 0 ? <Bullets items={s.labour} field="labour" /> : null}
          {s.attendance && (s.attendance.first_in || s.attendance.last_out || (s.attendance.inductions ?? 0) > 0 || (s.attendance.visitors ?? 0) > 0) && (
            <div className="muted" style={{ fontSize: 12.5, marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
              {[
                s.attendance.first_in ? `First in ${s.attendance.first_in}` : "",
                s.attendance.last_out ? `Last out ${s.attendance.last_out}` : "",
                (s.attendance.visitors ?? 0) > 0 ? `Visitors ${s.attendance.visitors}` : "",
                (s.attendance.inductions ?? 0) > 0 ? `Inductions today ${s.attendance.inductions}` : "",
              ].filter(Boolean).join("  ·  ")}
            </div>
          )}
        </Section>
      )}
      {(s.plant ?? []).length > 0 && (
        <Section k="plant" title="Plant on site" icon="🚜" meta={`${s.plant!.length}`}><Bullets items={s.plant!} field="plant" /></Section>
      )}
      {(s.progress ?? []).length > 0 && (
        <Section k="progress" title={daily ? "Progress today" : "Progress this week"} icon="🛠"><Bullets items={s.progress} tick field="progress" /></Section>
      )}
      {(s.blockers ?? []).length > 0 && (
        <Section k="blockers" title="Delays & blockers" icon="⚠"><Bullets items={s.blockers} field="blockers" /></Section>
      )}
      {((s.deliveries_detail?.length ?? 0) > 0 || (s.deliveries ?? []).length > 0) && (
        <Section k="deliveries" title="Deliveries & materials" icon="📦" meta={(s.deliveries_detail?.length ?? 0) > 0 ? `${s.deliveries_detail!.length} received` : undefined}>
          {(s.deliveries_detail?.length ?? 0) > 0 ? (
            <div className="rd-list">
              {s.deliveries_detail!.map((d, i) => (
                <div className="rd-li" key={i} style={{ alignItems: "flex-start" }}>
                  <span className="rd-dot" aria-hidden />
                  <div className="rd-litxt">
                    <div><strong>{d.supplier || "Delivery"}</strong>{d.description ? ` — ${d.description}` : ""}</div>
                    {(d.po_number || d.status) && (
                      <div className="muted" style={{ fontSize: 12, marginTop: 2, display: "flex", alignItems: "center", gap: 8 }}>
                        {d.po_number ? <span>{d.po_number}</span> : null}
                        <span className={`stock-status ${d.status === "received" ? "ok" : d.status === "rejected" ? "short" : "none"}`}>{d.status}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : <Bullets items={s.deliveries} field="deliveries" />}
        </Section>
      )}
      {quiet ? (
        <Section k="allclear" title="Nothing else to report" icon="✅" meta="All clear">
          <div className="rd-allclear">
            {allClear.map((t, i) => (
              <div className="rd-aci" key={i}><span className="rd-actick" aria-hidden>✓</span><span>{t}</span></div>
            ))}
          </div>
        </Section>
      ) : (() => {
        const sf = s.safety;
        if ((s.hse ?? []).length === 0 && !sf) return null;
        return (
          <Section k="hse" title="Safety & compliance" icon="🦺">
            {sf && (
              <div className="rd-sgrid">
                <div className="rd-sbox"><span className={`n ${sf.incidents ? "bad" : "ok"}`}>{sf.incidents}</span><span className="lab2">Incidents</span></div>
                <div className="rd-sbox"><span className={`n ${sf.near_misses ? "warn" : "ok"}`}>{sf.near_misses}</span><span className="lab2">Near misses</span></div>
                <div className="rd-sbox"><span className="n ok">{sf.toolbox_talks}</span><span className="lab2">Toolbox talks</span></div>
                {typeof sf.rams_outstanding === "number" && (
                  <div className="rd-sbox"><span className={`n ${sf.rams_outstanding ? "warn" : "ok"}`}>{sf.rams_outstanding}</span><span className="lab2">RAMS outstanding</span></div>
                )}
              </div>
            )}
            {(s.hse ?? []).length > 0 && <Bullets items={s.hse} field="hse" />}
          </Section>
        );
      })()}
      {photos.length > 0 && (
        <Section k="photos" title="Photos" icon="📷" meta={`${photos.length}`}>
          <div className="rd-gal">
            {(s.photos ?? []).map((p, i) => hiddenPhotos.has(i) && !editing ? null : (
              <figure className={`rd-ph${hiddenPhotos.has(i) ? " rd-sechidden" : ""}`} key={i}>
                {editing && <button className="rd-phdel" onClick={() => setHiddenPhotos((h) => { const n = new Set(h); n.has(i) ? n.delete(i) : n.add(i); return n; })} title={hiddenPhotos.has(i) ? "Show" : "Hide"}>{hiddenPhotos.has(i) ? "+" : "✕"}</button>}
                <a href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt={p.caption || "Site photo"} /></a>
                {editing ? (
                  <input
                    className="rd-capedit"
                    value={photoCaps[i] ?? p.caption ?? ""}
                    onChange={(e) => setPhotoCaps((c) => ({ ...c, [i]: e.target.value }))}
                    placeholder="Add a caption / context…"
                  />
                ) : p.caption ? <figcaption className="rd-aicap">{p.caption}</figcaption> : null}
              </figure>
            ))}
          </div>
        </Section>
      )}
      {(s.lookahead ?? []).length > 0 && !(hidden.has("look") && !editing) && (
        <section className={`rd-card rd-look${hidden.has("look") ? " rd-sechidden" : ""}`}>
          {editing && <button className="rd-secdel" onClick={() => toggleHide("look")}>{hidden.has("look") ? "+" : "✕"}</button>}
          <div className="rd-ch"><span className="rd-ic" aria-hidden>→</span><h2>{daily ? "Tomorrow" : "Next week"}</h2></div>
          <div className="rd-cb">
            {s.lookahead.map((t, i) => (
              <div className="rd-litem" key={i}><span className="rd-dotb" aria-hidden /><span contentEditable={editing} suppressContentEditableWarning data-field="lookahead" data-idx={i}>{t}</span></div>
            ))}
          </div>
        </section>
      )}

      {/* Free-form sections added in "Edit for client" — controlled inputs while
          editing, plain cards when viewing / exporting. */}
      {editing ? (
        <>
          {custom.map((cs, ci) => (
            <section className="rd-card" key={ci}>
              <button className="rd-secdel" onClick={() => removeCustomSection(ci)} title="Remove this section">✕</button>
              <div className="rd-ch">
                <span className="rd-ic" aria-hidden>＋</span>
                <input className="rd-secttitle" value={cs.title} onChange={(e) => setCustomTitle(ci, e.target.value)} placeholder="Section title" />
              </div>
              <div className="rd-cb">
                <div className="rd-list">
                  {cs.items.map((t, li) => (
                    <div className="rd-li" key={li}>
                      <span className="rd-dot" aria-hidden />
                      <input className="rd-lineinput" value={t} onChange={(e) => setCustomLine(ci, li, e.target.value)} placeholder="Line…" />
                      <button className="rd-linedel" onClick={() => removeCustomLine(ci, li)} title="Remove line">✕</button>
                    </div>
                  ))}
                  <button className="rd-addline" onClick={() => addCustomLine(ci)}>+ Add line</button>
                </div>
              </div>
            </section>
          ))}
          <button className="rd-addsec" onClick={addCustomSection}>+ Add section</button>
        </>
      ) : (
        (s.custom_sections ?? []).map((cs, ci) => (cs.title || (cs.items ?? []).length) ? (
          <section className="rd-card" key={ci}>
            <div className="rd-ch"><span className="rd-ic" aria-hidden>•</span><h2>{cs.title}</h2></div>
            <div className="rd-cb"><div className="rd-list">
              {(cs.items ?? []).map((t, li) => (
                <div className="rd-li" key={li}><span className="rd-dot" aria-hidden /><div className="rd-litxt">{t}</div></div>
              ))}
            </div></div>
          </section>
        ) : null)
      )}

      {/* Supervisor sign-off */}
      <div className="rd-signoff">
        <div className="rd-av">{(report.generated_by || "PG").slice(0, 2).toUpperCase()}</div>
        <div className="grow">
          <div style={{ fontWeight: 600, fontSize: 13 }} contentEditable={editing} suppressContentEditableWarning>{report.generated_by || "Site supervisor"}</div>
          <div className="muted" style={{ fontSize: 12 }}>Reviewed &amp; signed off · {fmtDate(report.generated_at)}</div>
        </div>
        <span className="pill">{daily ? "Daily" : "Weekly"}</span>
      </div>

      <div className="rd-foot">PowerGrid Projects Ltd · auto-generated from site WhatsApp updates{s.weather ? " · weather via Open-Meteo" : ""}</div>

      {picker && (
        <div className="rd-pick-scrim" onClick={() => !pSaving && setPicker(null)}>
          <div className="rd-pick-modal" onClick={(e) => e.stopPropagation()}>
            <div className="rd-pick-hd">
              <div>
                <strong>Choose photos for this report</strong>
                <div className="muted" style={{ fontSize: 12 }}>{chosen.size} selected · {picker.length} from this {daily ? "day" : "week"} · tap to add/remove</div>
              </div>
              <span className="grow" />
              <button className="btn ghost sm" disabled={pSaving} onClick={() => setChosen(new Set(picker.map((p) => p.url)))}>Select all</button>
              <button className="btn ghost sm" disabled={pSaving} onClick={() => setChosen(new Set())}>Select none</button>
              <button className="btn ghost sm" onClick={() => setPicker(null)} disabled={pSaving}>Cancel</button>
              <button className="btn sm" onClick={savePhotos} disabled={pSaving} style={{ background: "var(--accent)", color: "var(--accent-fg)", borderColor: "var(--accent)" }}>{pSaving ? "Saving…" : "Save"}</button>
            </div>
            {picker.length === 0 ? (
              <div className="empty in-card"><p className="muted">No site photos found for this {daily ? "day" : "week"}.</p></div>
            ) : (
              <div className="rd-pick-body">
                {(() => {
                  // Group by the day the photo was taken (newest day first) so
                  // 80+ thumbnails read as a week, not a wall.
                  const groups = new Map<string, typeof picker>();
                  for (const p of picker) {
                    const k = p.taken_on ? p.taken_on.slice(0, 10) : "";
                    if (!groups.has(k)) groups.set(k, []);
                    groups.get(k)!.push(p);
                  }
                  const days = [...groups.keys()].sort((a, b) => (b || "").localeCompare(a || ""));
                  const label = (k: string) => {
                    if (!k) return "Already on the report";
                    const d = new Date(k + "T00:00:00");
                    return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
                  };
                  return days.map((k) => (
                    <div key={k || "existing"}>
                      <div className="rd-pick-day">{label(k)} · {groups.get(k)!.length}</div>
                      <div className="rd-pick-grid">
                        {groups.get(k)!.map((p) => {
                          const on = chosen.has(p.url);
                          return (
                            <figure key={p.url} className={`rd-pick${on ? " on" : ""}`} onClick={() => setChosen((c) => { const n = new Set(c); n.has(p.url) ? n.delete(p.url) : n.add(p.url); return n; })}>
                              <img src={p.url} alt={p.caption || "Site photo"} loading="lazy" />
                              <span className="rd-pick-tick">{on ? "✓" : ""}</span>
                              <a className="rd-pick-zoom" href={p.url} target="_blank" rel="noreferrer" title="Open full size" onClick={(e) => e.stopPropagation()}>⤢</a>
                              {p.caption && <figcaption>{p.caption}</figcaption>}
                            </figure>
                          );
                        })}
                      </div>
                    </div>
                  ));
                })()}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
