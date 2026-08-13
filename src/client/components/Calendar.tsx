// Workspace-level commercial calendar. Shows a month grid with the AfP
// period-end dates plus any scheduled valuation dates across every live
// project, so the team can see the cadence at a glance.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtDate } from "../lib/api";
import { Topbar } from "./Shell";
import type { PortfolioCalendarItem } from "../../shared/types";

export function CalendarPage() {
  const [items, setItems] = useState<PortfolioCalendarItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // Month being displayed (first day of month, local time)
  const [cursor, setCursor] = useState<Date>(() => {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  });

  // Refetch when month changes — pull a window slightly wider than the
  // visible grid so events at month boundaries don't pop on/off.
  useEffect(() => {
    const from = new Date(cursor); from.setDate(1); from.setDate(from.getDate() - 7);
    const to = new Date(cursor); to.setMonth(to.getMonth() + 1); to.setDate(to.getDate() + 7);
    api
      .portfolioCalendar({ from: iso(from), to: iso(to) })
      .then(setItems)
      .catch((e) => setErr(e.message));
  }, [cursor]);

  // Build the 6-week grid: start from Monday on or before the 1st of the month.
  const weeks = useMemo(() => buildMonthGrid(cursor), [cursor]);

  // Group items by yyyy-mm-dd for O(1) lookup
  const byDate = useMemo(() => {
    const m = new Map<string, PortfolioCalendarItem[]>();
    for (const it of items) {
      const key = it.date.slice(0, 10);
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(it);
    }
    return m;
  }, [items]);

  const monthLabel = cursor.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const today = iso(new Date());

  function shift(delta: number) {
    const next = new Date(cursor);
    next.setMonth(next.getMonth() + delta);
    setCursor(next);
  }
  function jumpToday() {
    const d = new Date();
    d.setDate(1);
    setCursor(d);
  }

  return (
    <>
      <Topbar
        crumbs="Workspace"
        title="Calendar"
        actions={
          <>
            <button className="ghost" onClick={() => shift(-1)} aria-label="Previous month">‹</button>
            <button className="ghost" onClick={jumpToday}>Today</button>
            <button className="ghost" onClick={() => shift(1)} aria-label="Next month">›</button>
          </>
        }
      />
      <main>
        {err && <div className="flash error">{err}</div>}

        <div className="card">
          <div className="card-hd">
            <h2 style={{ flex: 1 }}>{monthLabel}</h2>
            <Legend />
          </div>
          <div style={{ padding: 12 }}>
            {/* Weekday header */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 4, marginBottom: 4 }}>
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                <div key={d} className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", padding: "4px 8px" }}>
                  {d}
                </div>
              ))}
            </div>
            {weeks.map((week, wi) => (
              <div key={wi} style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 4, marginBottom: 4 }}>
                {week.map((day) => {
                  const key = iso(day);
                  const evs = byDate.get(key) ?? [];
                  const inMonth = day.getMonth() === cursor.getMonth();
                  const isToday = key === today;
                  return (
                    <div
                      key={key}
                      style={{
                        minHeight: 110,
                        padding: 6,
                        border: "1px solid var(--line)",
                        borderRadius: "var(--radius-md)",
                        background: inMonth ? "var(--card)" : "var(--card-2)",
                        opacity: inMonth ? 1 : 0.55,
                        display: "flex",
                        flexDirection: "column",
                        gap: 3,
                      }}
                    >
                      <div style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        fontSize: 11, fontWeight: 600, color: "var(--ink-2)",
                      }}>
                        {isToday ? (
                          <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 20, height: 20, padding: "0 2px", borderRadius: 999, border: "1.5px solid var(--accent)", color: "var(--accent)" }}>{day.getDate()}</span>
                        ) : <span>{day.getDate()}</span>}
                        {evs.length > 0 && <span className="muted">{evs.length}</span>}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 2, overflow: "hidden" }}>
                        {evs.slice(0, 4).map((it, i) => <EventChip key={i} it={it} />)}
                        {evs.length > 4 && (
                          <div className="muted" style={{ fontSize: 10 }}>+{evs.length - 4} more</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {items.length > 0 && (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-hd"><h3>All events this period</h3></div>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="center">Project</th>
                  <th className="center">Kind</th>
                  <th>Label</th>
                </tr>
              </thead>
              <tbody>
                {[...items].sort((a, b) => a.date.localeCompare(b.date)).map((it, i) => (
                  <tr key={i}>
                    <td>{fmtDate(it.date)}</td>
                    <td className="center">
                      <Link to={`/projects/${it.project_id}`}>{it.project_code}</Link>
                    </td>
                    <td className="center"><KindBadge kind={it.kind} /></td>
                    <td>
                      {it.afp_id ? <Link to={`/applications/${it.afp_id}`}>{it.label}</Link> : it.label}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}

function EventChip({ it }: { it: PortfolioCalendarItem }) {
  const color = colorForKind(it.kind);
  return (
    <div
      title={`${it.project_code} — ${it.label}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        fontSize: 10,
        padding: "2px 5px",
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 3,
        overflow: "hidden",
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
      }}
    >
      <span style={{ fontFamily: "ui-monospace, monospace", color, fontWeight: 600 }}>{it.project_code}</span>
      <span style={{ color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis" }}>{it.label}</span>
    </div>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const color = colorForKind(kind);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600,
      background: `color-mix(in srgb, ${color} 14%, transparent)`,
      color,
    }}>
      {labelForKind(kind)}
    </span>
  );
}

function Legend() {
  const kinds: Array<{ kind: string; label: string }> = [
    { kind: "scheduled-application", label: "Application" },
    { kind: "scheduled-due", label: "Due date" },
    { kind: "scheduled-notice", label: "Notice" },
    { kind: "scheduled-final_payment", label: "Final date for payment" },
    { kind: "afp-period-end", label: "AfP period-end" },
  ];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11 }}>
      {kinds.map((k) => (
        <span key={k.kind} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 8, height: 8, background: colorForKind(k.kind), borderRadius: 999 }} />
          <span className="muted">{k.label}</span>
        </span>
      ))}
    </div>
  );
}

function colorForKind(kind: string): string {
  switch (kind) {
    case "scheduled-application":    return "#16a34a";   // green
    case "scheduled-due":            return "#d97706";   // amber
    case "scheduled-notice":         return "#ee5d2b";   // PGP orange
    case "scheduled-final_payment":  return "var(--navy)";   // navy (theme-aware)
    case "afp-period-end":           return "#0f1130";   // PGP navy
    default: return "#6b7280";
  }
}

function labelForKind(kind: string): string {
  switch (kind) {
    case "scheduled-application":    return "Application";
    case "scheduled-due":            return "Due date";
    case "scheduled-notice":         return "Notice";
    case "scheduled-final_payment":  return "Final date for payment";
    case "afp-period-end":           return "AfP period-end";
    default: return kind;
  }
}

/** Local-date ISO yyyy-mm-dd. Avoid toISOString() which is UTC. */
function iso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Build a 6-row, Mon-anchored grid of Date objects covering the displayed month. */
function buildMonthGrid(monthCursor: Date): Date[][] {
  const first = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1);
  // Monday-first: getDay() is Sun=0..Sat=6 → Mon-anchored offset is (g + 6) % 7
  const startOffset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - startOffset);
  const weeks: Date[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: Date[] = [];
    for (let d = 0; d < 7; d++) {
      const cell = new Date(start);
      cell.setDate(start.getDate() + w * 7 + d);
      row.push(cell);
    }
    weeks.push(row);
  }
  return weeks;
}
