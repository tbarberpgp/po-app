// Searchable supplier picker used on the New PO form. Replaces the native
// <select> + <optgroup> with a combobox that supports type-to-filter,
// keyboard navigation, click-outside-to-close, and clear status badges.
//
// Kept self-contained so other forms can reuse it later if needed.

import { useEffect, useMemo, useRef, useState } from "react";
import type { SupplierStatus } from "../../shared/types";

export type SupplierOption = {
  name: string;
  status: SupplierStatus | "not_in_register";
  priced: number;       // # of priced items in current project's snapshot
  total: number;        // # of any items in current snapshot (priced + library)
};

type Flat =
  | { kind: "header"; label: string }
  | { kind: "option"; option: SupplierOption }
  | { kind: "empty" }
  | { kind: "custom" };

const STATUS_BIT: Record<SupplierStatus | "not_in_register", string> = {
  preferred: "⭐ preferred",
  approved: "approved",
  pending: "pending",
  suspended: "⛔ suspended",
  not_in_register: "not in register",
};

const STATUS_RANK: Record<SupplierStatus | "not_in_register", number> = {
  preferred: 0,
  approved: 1,
  pending: 2,
  not_in_register: 3,
  suspended: 4,
};

export function SupplierCombobox({
  onProject,
  offProject,
  value,
  isCustom,
  onChange,
  onCustom,
}: {
  onProject: SupplierOption[];
  offProject: SupplierOption[];
  value: string;
  isCustom: boolean;
  onChange: (name: string) => void;
  onCustom: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Filter both groups by the search term (case-insensitive substring).
  const filteredOnP = useMemo(() => {
    const q = search.toLowerCase().trim();
    return q ? onProject.filter((s) => s.name.toLowerCase().includes(q)) : onProject;
  }, [onProject, search]);
  const filteredOffP = useMemo(() => {
    const q = search.toLowerCase().trim();
    return q ? offProject.filter((s) => s.name.toLowerCase().includes(q)) : offProject;
  }, [offProject, search]);

  // Flatten so keyboard nav can walk a single linear index.
  const flat: Flat[] = useMemo(() => {
    const out: Flat[] = [];
    if (filteredOnP.length > 0) {
      out.push({ kind: "header", label: `On this project (${filteredOnP.length})` });
      for (const o of filteredOnP) out.push({ kind: "option", option: o });
    }
    if (filteredOffP.length > 0) {
      out.push({ kind: "header", label: `Other approved suppliers (${filteredOffP.length})` });
      for (const o of filteredOffP) out.push({ kind: "option", option: o });
    }
    if (filteredOnP.length === 0 && filteredOffP.length === 0) {
      out.push({ kind: "empty" });
    }
    out.push({ kind: "custom" });
    return out;
  }, [filteredOnP, filteredOffP]);

  // Index of focusable rows (skip headers/empty for arrow nav).
  const navIndices = useMemo(
    () => flat.map((f, i) => ((f.kind === "option" || f.kind === "custom") ? i : -1)).filter((i) => i >= 0),
    [flat],
  );

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Reset/focus when opening; reset highlight when search changes.
  useEffect(() => {
    if (open) {
      setHighlight(navIndices[0] ?? 0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);
  useEffect(() => { setHighlight(navIndices[0] ?? 0); }, [search]);

  function commit(f: Flat) {
    if (f.kind === "option") { onChange(f.option.name); setOpen(false); setSearch(""); }
    else if (f.kind === "custom") { onCustom(); setOpen(false); setSearch(""); }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const pos = navIndices.indexOf(highlight);
      setHighlight(navIndices[Math.min(navIndices.length - 1, pos + 1)] ?? highlight);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const pos = navIndices.indexOf(highlight);
      setHighlight(navIndices[Math.max(0, pos - 1)] ?? highlight);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = flat[highlight];
      if (target) commit(target);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setSearch("");
    }
  }

  const display = isCustom ? "+ Custom supplier" : value || "";
  const placeholderTone = !display;

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (!open && (e.key === "ArrowDown" || e.key === "Enter")) { e.preventDefault(); setOpen(true); } }}
        style={{
          width: "100%",
          minHeight: 36,
          padding: "8px 12px",
          background: "var(--card)",
          color: placeholderTone ? "var(--muted)" : "var(--ink)",
          border: `1px solid ${open ? "var(--accent)" : "var(--line-strong)"}`,
          borderRadius: "var(--radius-md)",
          fontSize: 13.5,
          textAlign: "left",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          cursor: "pointer",
          fontFamily: "inherit",
          boxShadow: open ? "0 0 0 3px var(--accent-soft)" : "none",
          transition: "border-color 120ms, box-shadow 120ms",
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {display || "— select supplier —"}
        </span>
        <span style={{ fontSize: 10, opacity: 0.6, flexShrink: 0 }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 20,
            background: "var(--card)",
            border: "1px solid var(--line-strong)",
            borderRadius: "var(--radius-md)",
            boxShadow: "0 8px 24px rgba(15, 17, 48, 0.12)",
            maxHeight: 380,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type to filter suppliers…"
            style={{
              border: "none",
              borderBottom: "1px solid var(--line)",
              borderRadius: 0,
              padding: "10px 12px",
              fontSize: 13.5,
              outline: "none",
              boxShadow: "none",
              minHeight: 38,
            }}
          />
          <div role="listbox" style={{ overflowY: "auto", flex: 1 }}>
            {flat.map((f, i) => {
              if (f.kind === "header") {
                return (
                  <div
                    key={`h-${i}`}
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "var(--muted)",
                      padding: "8px 12px 4px",
                      background: "var(--card-2)",
                      borderTop: i === 0 ? "none" : "1px solid var(--line)",
                    }}
                  >
                    {f.label}
                  </div>
                );
              }
              if (f.kind === "empty") {
                return (
                  <div key="empty" className="muted" style={{ padding: 14, fontSize: 13 }}>
                    No suppliers match “{search}”. Type a custom name below or check the spelling.
                  </div>
                );
              }
              if (f.kind === "custom") {
                const highlighted = highlight === i;
                return (
                  <div
                    key="custom"
                    role="option"
                    aria-selected={highlighted}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => commit(f)}
                    style={{
                      padding: "10px 12px",
                      cursor: "pointer",
                      borderTop: "1px solid var(--line)",
                      background: highlighted ? "var(--accent-soft)" : "transparent",
                      color: "var(--accent-2)",
                      fontSize: 13,
                      fontWeight: 500,
                    }}
                  >
                    + Other supplier (custom)…
                  </div>
                );
              }
              // option row
              const opt = f.option;
              const highlighted = highlight === i;
              return (
                <div
                  key={`o-${opt.name}`}
                  role="option"
                  aria-selected={highlighted || opt.name === value}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => commit(f)}
                  style={{
                    padding: "8px 12px",
                    cursor: "pointer",
                    background: highlighted ? "var(--accent-soft)" : opt.name === value ? "var(--card-2)" : "transparent",
                    fontSize: 13.5,
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: 10,
                    alignItems: "center",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {opt.name}
                    {opt.priced > 0 && (
                      <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
                        · {opt.priced} priced
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--muted)", whiteSpace: "nowrap" }}>
                    {STATUS_BIT[opt.status]}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Sort comparator used by callers to order suppliers within each group. */
export function compareSuppliers(a: SupplierOption, b: SupplierOption): number {
  if (a.status !== b.status) return STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (a.priced !== b.priced) return b.priced - a.priced;
  return a.name.localeCompare(b.name);
}
