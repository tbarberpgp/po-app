import { useEffect, useState } from "react";
import { api, fmtDate } from "../lib/api";

type ReportRow = Awaited<ReturnType<typeof api.listSiteReports>>[number];

const GROUP_WINDOW = 8; // show this many generated-date groups before "Load older"

/** "Today" / "Yesterday" / formatted date for a generated-date group header. */
function groupLabel(d: string): string {
  if (!d || d === "—") return "Undated";
  const today = new Date().toISOString().slice(0, 10);
  const yest = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (d === today) return "Today";
  if (d === yest) return "Yesterday";
  return fmtDate(d);
}

/** Compact relative time, e.g. "2h ago", "3d ago". */
function ago(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (isNaN(t)) return "—";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60); if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 36) return `${h}h ago`;
  const d = Math.round(h / 24); if (d < 14) return `${d}d ago`;
  return `${Math.round(d / 7)}w ago`;
}

/** Reports grouped by the date they cover — collapsible day-sections
 *  (newest open, or all collapsed when newestOpen=false), windowed with a
 *  "Load older" button. Shared by the workspace Reports page and each project's
 *  Reports tab so the two stay identical. Caller owns selection + the row click. */
export function GroupedReports({ rows, selected, onToggleOne, onToggleGroup, onOpen, newestOpen = false, resetKey = "" }: {
  rows: ReportRow[];                       // already filtered; render only when length >= 1
  selected: Set<number>;
  onToggleOne: (id: number) => void;
  onToggleGroup: (ids: number[]) => void;
  onOpen: (id: number) => void;
  newestOpen?: boolean;                    // false = every group collapsed by default
  resetKey?: string;                       // re-collapse + reset the window when this changes
}) {
  const [shownGroups, setShownGroups] = useState(GROUP_WINDOW);
  const [openSet, setOpenSet] = useState<Set<string> | null>(null); // null = default
  useEffect(() => { setShownGroups(GROUP_WINDOW); setOpenSet(null); }, [resetKey]);

  const groupsMap = new Map<string, ReportRow[]>();
  // Group by the date the report COVERS (daily = that day; weekly = its end day),
  // so a row's date matches its header. Falls back to start, then generated date.
  for (const r of rows) { const d = (r.period_end || r.period_start || r.generated_at || "").slice(0, 10) || "—"; (groupsMap.get(d) ?? groupsMap.set(d, []).get(d)!).push(r); }
  const groups = [...groupsMap.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  const shown = groups.slice(0, shownGroups);
  const isOpen = (date: string, idx: number) => (openSet === null ? (newestOpen && idx === 0) : openSet.has(date));
  function toggle(date: string) {
    setOpenSet((prev) => {
      const n = new Set(prev ?? (newestOpen && groups.length ? [groups[0][0]] : []));
      n.has(date) ? n.delete(date) : n.add(date);
      return n;
    });
  }
  const groupSel = (g: ReportRow[]) => g.length > 0 && g.every((r) => selected.has(r.id));

  return (
    <div style={{ padding: "4px 0 2px" }}>
      {shown.map(([date, g], idx) => {
        const dCount = g.filter((r) => r.period_type === "daily").length;
        const wCount = g.filter((r) => r.period_type === "weekly").length;
        const nCount = g.filter((r) => r.update_count === 0).length;
        const opened = isOpen(date, idx);
        return (
          <div key={date} className="rep-group">
            <div className="rep-group-hd" onClick={() => toggle(date)}>
              <span className="rep-group-chev">{opened ? "▾" : "▸"}</span>
              <input type="checkbox" checked={groupSel(g)} onClick={(e) => e.stopPropagation()} onChange={() => onToggleGroup(g.map((r) => r.id))} aria-label={`Select all in ${groupLabel(date)}`} />
              <strong>{groupLabel(date)}</strong>
              <span className="muted rep-group-count">{g.length} report{g.length === 1 ? "" : "s"}</span>
              <span className="grow" />
              {dCount > 0 && <span className="pill rep-pill-daily">{dCount} daily</span>}
              {wCount > 0 && <span className="pill rep-pill-weekly">{wCount} weekly</span>}
              {nCount > 0 && <span className="pill warn">{nCount} no updates</span>}
            </div>
            {opened && (
              <div style={{ overflowX: "auto" }}>
                <table className="rep-table">
                  <tbody>
                    {g.map((r) => (
                      <tr key={r.id} className={`rep-row${selected.has(r.id) ? " sel" : ""}`}>
                        <td style={{ width: 20 }}><input type="checkbox" checked={selected.has(r.id)} onChange={() => onToggleOne(r.id)} aria-label="Select report" /></td>
                        <td onClick={() => onOpen(r.id)}>
                          <span className={`per ${r.period_type}`}>{r.period_type}</span>{" "}
                          <span className="muted">{r.period_type === "daily" ? fmtDate(r.period_start) : `${fmtDate(r.period_start)} – ${fmtDate(r.period_end)}`}</span>
                        </td>
                        <td onClick={() => onOpen(r.id)}>
                          {r.project_id ? <><strong>{r.project_code}</strong> {r.project_name}</> : <em>Portfolio roll-up</em>}
                          {r.from_whatsapp
                            ? <span className="stock-status ok" style={{ marginLeft: 8 }}>WhatsApp</span>
                            : r.update_count > 0 ? <span className="muted" style={{ marginLeft: 8, fontSize: 11.5 }}>✎ manual</span> : null}
                        </td>
                        <td className="num" onClick={() => onOpen(r.id)}>{r.update_count === 0 ? <span className="muted">0</span> : r.update_count >= 20 ? <strong>{r.update_count}</strong> : r.update_count}</td>
                        <td onClick={() => onOpen(r.id)}>{r.update_count === 0 ? <span className="stock-status none">No updates</span> : <span className="stock-status ok">Generated</span>}</td>
                        <td className="muted" onClick={() => onOpen(r.id)} style={{ whiteSpace: "nowrap" }}>{ago(r.generated_at)}</td>
                        <td onClick={() => onOpen(r.id)} style={{ textAlign: "right" }}><span className="rep-chev">›</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
      {groups.length > shownGroups && (
        <div style={{ textAlign: "center", padding: "10px 0 4px" }}>
          <button className="ghost" onClick={() => setShownGroups((n) => n + GROUP_WINDOW)}>Load older · {groups.length - shownGroups} more day{groups.length - shownGroups === 1 ? "" : "s"}</button>
        </div>
      )}
    </div>
  );
}
