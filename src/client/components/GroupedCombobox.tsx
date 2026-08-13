// Generic grouped, searchable dropdown — the reusable cousin of
// SupplierCombobox. Renders a button that opens a panel with a type-to-filter
// box and options under section headers, with keyboard nav and
// click-outside-to-close. Set `allowCustom` to let the typed text itself be
// committed as the value (for free-text fields like manufacturer/supplier).

import { useEffect, useMemo, useRef, useState } from "react";

export type ComboOption = { value: string; label: string; hint?: string };
export type ComboGroup = { label: string; options: ComboOption[] };

type Flat =
  | { kind: "header"; label: string }
  | { kind: "option"; option: ComboOption }
  | { kind: "empty" }
  | { kind: "custom"; text: string };

export function GroupedCombobox({
  groups,
  value,
  onChange,
  placeholder = "— select —",
  searchPlaceholder = "Type to filter…",
  allowCustom = false,
  ariaLabel,
}: {
  groups: ComboGroup[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  allowCustom?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return groups;
    return groups
      .map((g) => ({
        label: g.label,
        options: g.options.filter((o) =>
          o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q) || (o.hint ?? "").toLowerCase().includes(q)),
      }))
      .filter((g) => g.options.length > 0);
  }, [groups, search]);

  const exactMatch = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return false;
    return groups.some((g) => g.options.some((o) => o.label.toLowerCase() === q || o.value.toLowerCase() === q));
  }, [groups, search]);

  const flat: Flat[] = useMemo(() => {
    const out: Flat[] = [];
    for (const g of filtered) {
      out.push({ kind: "header", label: g.label });
      for (const o of g.options) out.push({ kind: "option", option: o });
    }
    const customable = allowCustom && search.trim().length > 0 && !exactMatch;
    if (filtered.length === 0 && !customable) out.push({ kind: "empty" });
    if (customable) out.push({ kind: "custom", text: search.trim() });
    return out;
  }, [filtered, allowCustom, search, exactMatch]);

  const navIndices = useMemo(
    () => flat.map((f, i) => ((f.kind === "option" || f.kind === "custom") ? i : -1)).filter((i) => i >= 0),
    [flat],
  );

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

  useEffect(() => {
    if (open) {
      setHighlight(navIndices[0] ?? 0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);
  useEffect(() => { setHighlight(navIndices[0] ?? 0); }, [search]);

  function commit(f: Flat) {
    if (f.kind === "option") { onChange(f.option.value); setOpen(false); setSearch(""); }
    else if (f.kind === "custom") { onChange(f.text); setOpen(false); setSearch(""); }
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

  // Label to show on the closed button: the matching option's label, else the
  // raw value (a custom entry), else the placeholder.
  const currentLabel = useMemo(() => {
    for (const g of groups) for (const o of g.options) if (o.value === value) return o.label;
    return value || "";
  }, [groups, value]);

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (!open && (e.key === "ArrowDown" || e.key === "Enter")) { e.preventDefault(); setOpen(true); } }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        style={{
          width: "100%",
          minHeight: 36,
          padding: "8px 12px",
          background: "var(--card)",
          color: currentLabel ? "var(--ink)" : "var(--muted)",
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
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {currentLabel || placeholder}
        </span>
        <span style={{ fontSize: 10, opacity: 0.6, flexShrink: 0 }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            // Right-anchored and free to outgrow the trigger: a narrow table
            // cell (e.g. the Unexpected-spend Assign control) still gets a
            // readable panel, growing leftward into the table where the room is.
            right: 0,
            left: "auto",
            minWidth: "100%",
            width: "max-content",
            maxWidth: "min(460px, calc(100vw - 48px))",
            zIndex: 30,
            background: "var(--card)",
            border: "1px solid var(--line-strong)",
            borderRadius: "var(--radius-md)",
            boxShadow: "0 8px 24px rgba(15, 17, 48, 0.12)",
            maxHeight: 340,
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
            placeholder={searchPlaceholder}
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
                    No matches{search ? ` for “${search}”` : ""}.
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
                    Use “{f.text}”
                  </div>
                );
              }
              const opt = f.option;
              const highlighted = highlight === i;
              return (
                <div
                  key={`o-${opt.value}`}
                  role="option"
                  aria-selected={highlighted || opt.value === value}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => commit(f)}
                  style={{
                    padding: "8px 12px",
                    cursor: "pointer",
                    background: highlighted ? "var(--accent-soft)" : opt.value === value ? "var(--card-2)" : "transparent",
                    fontSize: 13.5,
                  }}
                >
                  {/* Label wraps (SKU strings break anywhere) and the hint sits
                      under it — a long name never squeezes into "MS-B…". */}
                  <div style={{ overflowWrap: "anywhere", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{opt.label}</div>
                  {opt.hint && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 1 }}>{opt.hint}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
