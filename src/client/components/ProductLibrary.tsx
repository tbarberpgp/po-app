import { useEffect, useMemo, useState } from "react";
import { api, fmtMoney } from "../lib/api";
import { Topbar } from "./Shell";
import { can } from "../../shared/permissions";
import { buildProductCode } from "../../shared/types";
import type { CurrentUser, Element, Product, ProductSupplier, ResourceType } from "../../shared/types";

type Suggestion = Awaited<ReturnType<typeof api.productSuggestions>>[number];
type Tab = "library" | "suggestions";

export function ProductLibrary({ me }: { me: CurrentUser | null }) {
  const [tab, setTab] = useState<Tab>("library");
  const [products, setProducts] = useState<Product[]>([]);
  const [elements, setElements] = useState<Element[]>([]);
  const [resourceTypes, setResourceTypes] = useState<ResourceType[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const canManage = can(me?.role, "approvers.manage"); // admin+

  function refresh() {
    api.listProducts().then(setProducts).catch((e) => setErr(e.message));
    api.listElements().then(setElements).catch((e) => setErr(e.message));
    api.listResourceTypes().then(setResourceTypes).catch((e) => setErr(e.message));
    api.productSuggestions().then(setSuggestions).catch(() => {});
  }
  useEffect(refresh, []);

  // Duplicate detection: normalise + group products by name+manufacturer.
  const duplicateGroups = useMemo(() => {
    const map = new Map<string, number[]>();
    const norm = (s: string | null | undefined) =>
      (s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
    for (const p of products) {
      const key = `${norm(p.description)}::${norm(p.manufacturer)}`;
      const arr = map.get(key) ?? [];
      arr.push(p.id);
      map.set(key, arr);
    }
    const dupIds = new Set<number>();
    for (const ids of map.values()) if (ids.length > 1) ids.forEach((i) => dupIds.add(i));
    return dupIds;
  }, [products]);

  const unlinkedSuggestionCount = suggestions.filter((s) => s.linked_product_id == null).length;

  return (
    <>
      <Topbar
        crumbs="Master data"
        title="Product library"
        actions={
          <>
            <div className="theme-toggle" style={{ marginRight: 8 }}>
              <button type="button" className={tab === "library" ? "active" : ""} onClick={() => setTab("library")}>Library</button>
              <button type="button" className={tab === "suggestions" ? "active" : ""} onClick={() => setTab("suggestions")}>
                Suggestions{unlinkedSuggestionCount > 0 ? ` · ${unlinkedSuggestionCount}` : ""}
              </button>
            </div>
            {canManage && tab === "library" && (
              <button className="accent" onClick={() => setShowAdd(true)}>+ New product</button>
            )}
          </>
        }
      />
      <main>
        {err && <div className="flash error">{err}</div>}

        {tab === "library" ? (
          <LibraryTab
            products={products}
            elements={elements}
            resourceTypes={resourceTypes}
            duplicateIds={duplicateGroups}
            canManage={canManage}
            showAdd={showAdd}
            setShowAdd={setShowAdd}
            onChanged={refresh}
          />
        ) : (
          <SuggestionsTab
            suggestions={suggestions}
            products={products}
            elements={elements}
            canManage={canManage}
            onChanged={refresh}
          />
        )}
      </main>
    </>
  );
}

/* ── Library tab ───────────────────────────────────────────────────────── */

function LibraryTab({
  products, elements, resourceTypes, duplicateIds, canManage, showAdd, setShowAdd, onChanged,
}: {
  products: Product[];
  elements: Element[];
  resourceTypes: ResourceType[];
  duplicateIds: Set<number>;
  canManage: boolean;
  showAdd: boolean;
  setShowAdd: (v: boolean) => void;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [elementFilter, setElementFilter] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const visible = products
    .filter((p) => !elementFilter || p.element_code === elementFilter)
    .filter((p) => !filter || (p.description + (p.manufacturer ?? "") + (p.supplier ?? "")).toLowerCase().includes(filter.toLowerCase()));

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <input style={{ maxWidth: 320 }} placeholder="Filter by description / manufacturer / supplier…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <select value={elementFilter} onChange={(e) => setElementFilter(e.target.value)}>
          <option value="">All elements</option>
          {elements.map((e) => <option key={e.code} value={e.code}>{e.code} · {e.name}</option>)}
        </select>
        <div className="grow" />
        <div className="muted">{products.length} products · {duplicateIds.size > 0 && <span className="badge unpriced">{duplicateIds.size} possible duplicates</span>}</div>
      </div>

      {showAdd && canManage && (
        <ProductForm
          elements={elements}
          resourceTypes={resourceTypes}
          onCancel={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); onChanged(); }}
        />
      )}

      <div className="card">
        <div className="card-hd">
          <h2 style={{ flex: 1 }}>Master products</h2>
          <span className="pill">{products.length}</span>
        </div>
        {products.length === 0 ? (
          <div style={{ padding: 32 }}>
            <div className="empty">
              No products yet. {canManage ? "Click + New product to add the first one, or check the Suggestions tab to lift items from existing projects." : "An admin can add products from the master library page."}
            </div>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 56 }}></th>
                <th>Code</th>
                <th>Element</th>
                <th>Description</th>
                <th>Manufacturer</th>
                <th>Supplier</th>
                <th>Unit</th>
                <th className="num">Unit cost</th>
                <th>Res</th>
                <th className="num">Uses</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) =>
                editingId === p.id ? (
                  <ProductForm
                    key={p.id}
                    asRow
                    initial={p}
                    elements={elements}
                    resourceTypes={resourceTypes}
                    onCancel={() => setEditingId(null)}
                    onSaved={() => { setEditingId(null); onChanged(); }}
                  />
                ) : (
                  <>
                    <tr key={p.id}>
                      <td>
                        <button
                          className="expand-btn"
                          onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
                          title={expandedId === p.id ? "Collapse" : "Show alternate suppliers"}
                          aria-expanded={expandedId === p.id}
                        >
                          <span className="expand-triangle">{expandedId === p.id ? "▾" : "▸"}</span>
                          {p.alternate_supplier_count > 0 && (
                            <span className="expand-count">+{p.alternate_supplier_count}</span>
                          )}
                        </button>
                      </td>
                      <td><span className="badge" style={{ fontFamily: "ui-monospace, monospace" }}>{p.product_code}</span></td>
                      <td className="muted">{p.element_code} · {p.element_name.replace(/^[A-Za-z]+ - /, "")}</td>
                      <td>
                        {p.description}
                        {duplicateIds.has(p.id) && <span className="badge unpriced" style={{ marginLeft: 6 }}>possible duplicate</span>}
                      </td>
                      <td className="muted">{p.manufacturer ?? "—"}</td>
                      <td className="muted">
                        {p.supplier ?? "—"}
                        {p.supplier && p.manufacturer && p.supplier === p.manufacturer && (
                          <span className="muted" style={{ fontSize: 11, marginLeft: 4 }} title="Same as manufacturer">↩</span>
                        )}
                      </td>
                      <td>{p.unit ?? ""}</td>
                      <td className="num">{p.unit_cost != null ? fmtMoney(p.unit_cost) : <span className="muted">—</span>}</td>
                      <td>{p.default_resource ?? "M"}</td>
                      <td className="num">{p.usage_count}</td>
                      <td>
                        {canManage && (
                          <>
                            <button className="ghost tiny" onClick={() => setEditingId(p.id)}>Edit</button>{" "}
                            <button className="ghost tiny" onClick={async () => {
                              if (!confirm(`Delete product "${p.product_code} ${p.description}"? Linked project materials will be unlinked but kept.`)) return;
                              await api.removeProduct(p.id);
                              onChanged();
                            }}>×</button>
                          </>
                        )}
                      </td>
                    </tr>
                    {expandedId === p.id && (
                      <tr>
                        <td colSpan={11} style={{ background: "var(--card-2)", padding: 0 }}>
                          <AlternateSuppliersPanel product={p} canManage={canManage} onChanged={onChanged} />
                        </td>
                      </tr>
                    )}
                  </>
                ),
              )}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/* ── Product add/edit form (used both standalone and as a table row) ──── */

function ProductForm({
  asRow, initial, elements, resourceTypes, onCancel, onSaved,
}: {
  asRow?: boolean;
  initial?: Product;
  elements: Element[];
  resourceTypes: ResourceType[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  // Treat the row as "supplier === manufacturer" when they actually match
  // (or supplier is blank). The user can untick to type a different supplier.
  const startsSameAsMfr =
    !initial ||
    !initial.supplier ||
    (initial.manufacturer && initial.supplier === initial.manufacturer);
  const [sameAsMfr, setSameAsMfr] = useState<boolean>(!!startsSameAsMfr);
  const [form, setForm] = useState({
    element_code: initial?.element_code ?? elements[0]?.code ?? "",
    item_no: initial?.item_no?.toString() ?? "",   // blank → auto-allocate
    variant: initial?.variant ?? "",
    description: initial?.description ?? "",
    manufacturer: initial?.manufacturer ?? "",
    supplier: initial?.supplier ?? "",
    unit: initial?.unit ?? "",
    unit_cost: initial?.unit_cost?.toString() ?? "",
    default_resource: initial?.default_resource ?? "M",
    notes: initial?.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // AI research state
  const [researchQuery, setResearchQuery] = useState("");
  const [researching, setResearching] = useState(false);
  const [researchInfo, setResearchInfo] = useState<{ confidence: string; notes?: string } | null>(null);

  async function research() {
    if (!researchQuery.trim()) return;
    setResearching(true); setErr(null); setResearchInfo(null);
    try {
      const { suggestion } = await api.researchProduct(researchQuery.trim());
      setForm((f) => ({
        ...f,
        // Only overwrite blanks so re-running research doesn't blow away manual edits.
        element_code: f.element_code || suggestion.element_code || f.element_code,
        variant: f.variant || suggestion.variant || "",
        description: f.description || suggestion.description || researchQuery.trim(),
        manufacturer: f.manufacturer || suggestion.manufacturer || "",
        supplier: f.supplier || suggestion.manufacturer || "",
        unit: f.unit || suggestion.unit || "",
        unit_cost:
          f.unit_cost ||
          (suggestion.estimated_unit_cost_gbp && suggestion.estimated_unit_cost_gbp > 0
            ? String(suggestion.estimated_unit_cost_gbp)
            : ""),
        notes: f.notes || suggestion.notes || "",
      }));
      setResearchInfo({ confidence: suggestion.confidence ?? "low", notes: suggestion.notes });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "research failed");
    } finally {
      setResearching(false);
    }
  }

  const previewCode = form.item_no
    ? buildProductCode(form.element_code, Number(form.item_no), form.variant || null)
    : `${form.element_code}.??${form.variant ? "." + form.variant : ""} (auto-allocate)`;

  async function save() {
    setBusy(true); setErr(null);
    try {
      const effectiveSupplier = sameAsMfr
        ? form.manufacturer || null
        : form.supplier || null;
      const payload = {
        element_code: form.element_code,
        item_no: form.item_no ? Number(form.item_no) : undefined,
        variant: form.variant || null,
        description: form.description,
        manufacturer: form.manufacturer || null,
        supplier: effectiveSupplier,
        unit: form.unit || null,
        unit_cost: form.unit_cost ? Number(form.unit_cost) : null,
        default_resource: form.default_resource,
        notes: form.notes || null,
      };
      if (initial) await api.updateProduct(initial.id, payload);
      else await api.addProduct(payload);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  const fields = (
    <>
      {!initial && (
        <div style={{ marginBottom: 16, padding: 12, background: "var(--accent-soft)", border: "1px solid var(--accent)", borderRadius: 8 }}>
          <label style={{ color: "var(--accent-2)" }}>Research with AI</label>
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <input
              value={researchQuery}
              onChange={(e) => setResearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  research();
                }
              }}
              placeholder="e.g. 'Kingspan KS1000 RW 80mm' or 'Rockwool RWA45 100mm slab'"
              style={{ flex: 1 }}
            />
            <button type="button" className="accent" onClick={research} disabled={researching || !researchQuery.trim()}>
              {researching ? "Researching…" : "🔍 Research"}
            </button>
          </div>
          {researchInfo && (
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              Confidence: <b style={{ color: researchInfo.confidence === "high" ? "var(--success)" : researchInfo.confidence === "low" ? "var(--danger)" : "var(--warn)" }}>{researchInfo.confidence}</b>
              {researchInfo.notes && <> · {researchInfo.notes}</>}
              {" "}— review the auto-filled fields below and edit as needed.
            </div>
          )}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 80px 100px 1fr", gap: 12 }}>
        <div>
          <label>Element</label>
          <select value={form.element_code} onChange={(e) => setForm({ ...form, element_code: e.target.value })}>
            {elements.map((el) => <option key={el.code} value={el.code}>{el.code} · {el.name}</option>)}
          </select>
        </div>
        <div>
          <label>Item #</label>
          <input value={form.item_no} onChange={(e) => setForm({ ...form, item_no: e.target.value })} placeholder="auto" />
        </div>
        <div>
          <label>Variant</label>
          <input value={form.variant} onChange={(e) => setForm({ ...form, variant: e.target.value })} placeholder="e.g. KS1000-80" />
        </div>
        <div>
          <label>Code preview</label>
          <input value={previewCode} readOnly style={{ fontFamily: "ui-monospace, monospace" }} />
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <label>Description</label>
        <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="e.g. Kingspan KS1000 RW 80mm" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 100px 120px 80px", gap: 12, marginTop: 12 }}>
        <div>
          <label>Manufacturer</label>
          <input value={form.manufacturer} onChange={(e) => setForm({ ...form, manufacturer: e.target.value })} />
        </div>
        <div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, textTransform: "none", letterSpacing: 0, fontSize: 11 }}>
            <span>Supplier</span>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 4, margin: 0, padding: 0, textTransform: "none", letterSpacing: 0, fontSize: 11, color: "var(--muted)" }}>
              <input
                type="checkbox"
                checked={sameAsMfr}
                onChange={(e) => setSameAsMfr(e.target.checked)}
                style={{ minHeight: 0 }}
              />
              same as manufacturer
            </label>
          </label>
          <input
            value={sameAsMfr ? form.manufacturer : form.supplier}
            onChange={(e) => setForm({ ...form, supplier: e.target.value })}
            readOnly={sameAsMfr}
            placeholder={sameAsMfr ? "—" : "e.g. SIG Roofing"}
          />
        </div>
        <div>
          <label>Unit</label>
          <input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="m², lm, ea…" />
        </div>
        <div>
          <label>Unit cost (£)</label>
          <input type="number" step="0.01" value={form.unit_cost} onChange={(e) => setForm({ ...form, unit_cost: e.target.value })} />
        </div>
        <div>
          <label>Resource</label>
          <select value={form.default_resource} onChange={(e) => setForm({ ...form, default_resource: e.target.value })}>
            {resourceTypes.map((r) => <option key={r.code} value={r.code}>{r.code} · {r.name}</option>)}
          </select>
        </div>
      </div>
      {initial && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Need to compare prices from multiple suppliers (e.g. fixings from different merchants)? Save first,
          then expand the row in the table to add alternate suppliers with their own prices and SKUs.
        </div>
      )}
      {err && <div className="flash error" style={{ marginTop: 12 }}>{err}</div>}
      <div className="row" style={{ marginTop: 16 }}>
        <button className="primary" onClick={save} disabled={busy || !form.description.trim()}>{initial ? "Save" : "Create product"}</button>
        <button className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </>
  );

  if (asRow) {
    return (
      <tr style={{ background: "var(--accent-soft)" }}>
        <td colSpan={10} style={{ padding: 20 }}>{fields}</td>
      </tr>
    );
  }
  return (
    <div className="card">
      <div className="card-hd"><h3>{initial ? "Edit product" : "New product"}</h3></div>
      <div className="card-bd">{fields}</div>
    </div>
  );
}

/* ── Suggestions tab — distinct material rows across projects ────────── */

function SuggestionsTab({
  suggestions, products, elements, canManage, onChanged,
}: {
  suggestions: Suggestion[];
  products: Product[];
  elements: Element[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [promoting, setPromoting] = useState<Suggestion | null>(null);
  const [linkingId, setLinkingId] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);

  const unlinkedSuggestions = useMemo(
    () => suggestions.filter((s) => s.linked_product_id == null),
    [suggestions],
  );
  const allUnlinkedSelected = unlinkedSuggestions.length > 0 &&
    unlinkedSuggestions.every((s) => selected.has(s.key));

  function toggleOne(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => {
      if (allUnlinkedSelected) return new Set();
      return new Set(unlinkedSuggestions.map((s) => s.key));
    });
  }

  async function linkExisting(s: Suggestion, productId: number) {
    setBusy(true); setErr(null);
    try {
      await api.linkMaterialsToProduct(productId, s.material_ids);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "link failed");
    } finally {
      setBusy(false);
    }
  }

  const selectedSuggestions = useMemo(
    () => suggestions.filter((s) => selected.has(s.key) && s.linked_product_id == null),
    [suggestions, selected],
  );

  return (
    <>
      {canManage && selectedSuggestions.length > 0 && (
        <div className="card card-padded" style={{ position: "sticky", top: 84, zIndex: 5, marginBottom: 12, borderColor: "var(--accent)", background: "var(--accent-soft)" }}>
          <div className="row">
            <div className="grow">
              <b>{selectedSuggestions.length} item{selectedSuggestions.length === 1 ? "" : "s"} selected</b>
              <span className="muted" style={{ marginLeft: 8 }}>· Promote them all to the master library in one pass</span>
            </div>
            <button className="ghost" onClick={() => setSelected(new Set())}>Clear</button>
            <button className="accent" onClick={() => setBulkOpen(true)}>Promote {selectedSuggestions.length} selected →</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-hd">
          <h2 style={{ flex: 1 }}>Suggestions from projects</h2>
          <span className="muted" style={{ fontSize: 12 }}>
            {suggestions.length} distinct items across all active project snapshots
          </span>
        </div>
        <div className="card-bd">
          <p className="muted" style={{ marginTop: 0 }}>
            Materials appearing in your projects, grouped by normalised name + manufacturer so
            duplicates collapse into one row. Promote any of these to the master library to
            give it a permanent product code, or link to an existing product. Tick the
            checkboxes to bulk-promote.
          </p>
        </div>
        {err && <div style={{ padding: "0 20px 12px" }}><div className="flash error">{err}</div></div>}
        {suggestions.length === 0 ? (
          <div style={{ padding: 32 }}>
            <div className="empty">No project materials uploaded yet — upload a pricing xlsx on any project and they'll show up here.</div>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  {canManage && unlinkedSuggestions.length > 0 && (
                    <input
                      type="checkbox"
                      checked={allUnlinkedSelected}
                      onChange={toggleAll}
                      title="Select all unlinked"
                    />
                  )}
                </th>
                <th>Description</th>
                <th>Manufacturer</th>
                <th>Type</th>
                <th className="num">In # projects</th>
                <th className="num">Occurrences</th>
                <th className="num">Avg unit cost</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {suggestions.map((s) => (
                <tr key={s.key} style={s.linked_product_id ? { opacity: 0.55 } : undefined}>
                  <td>
                    {canManage && !s.linked_product_id && (
                      <input
                        type="checkbox"
                        checked={selected.has(s.key)}
                        onChange={() => toggleOne(s.key)}
                      />
                    )}
                  </td>
                  <td>{s.sample_description}</td>
                  <td className="muted">{s.manufacturer ?? "—"}</td>
                  <td className="muted">{s.type}</td>
                  <td className="num">{s.project_codes.length}</td>
                  <td className="num">{s.occurrences}</td>
                  <td className="num">{s.avg_unit_cost != null ? fmtMoney(s.avg_unit_cost) : <span className="muted">—</span>}</td>
                  <td>
                    {s.linked_product_id ? (
                      <span className="badge approved">linked</span>
                    ) : (
                      <span className="badge draft">unlinked</span>
                    )}
                  </td>
                  <td>
                    {canManage && !s.linked_product_id && (
                      <button className="ghost tiny" onClick={() => setPromoting(s)}>Promote →</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {bulkOpen && (
        <BulkPromoteModal
          suggestions={selectedSuggestions}
          elements={elements}
          onClose={() => setBulkOpen(false)}
          onDone={() => {
            setBulkOpen(false);
            setSelected(new Set());
            onChanged();
          }}
        />
      )}

      {promoting && (
        <div className="card">
          <div className="card-hd">
            <h3 style={{ flex: 1 }}>Promote to master library</h3>
            <button className="ghost tiny" onClick={() => setPromoting(null)}>Close</button>
          </div>
          <div className="card-bd">
            <p className="muted" style={{ marginTop: 0 }}>
              <b>{promoting.sample_description}</b>{promoting.manufacturer ? ` — ${promoting.manufacturer}` : ""}
              <br />
              Found in <b>{promoting.project_codes.length}</b> project(s):{" "}
              <span className="muted">{promoting.project_codes.join(", ")}</span>
            </p>
            <div className="row" style={{ marginTop: 12 }}>
              <div className="grow">
                <label>Link to an existing product</label>
                <div className="row" style={{ marginTop: 4 }}>
                  <select value={linkingId} onChange={(e) => setLinkingId(e.target.value ? Number(e.target.value) : "")}>
                    <option value="">— pick existing —</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.product_code} — {p.description}</option>
                    ))}
                  </select>
                  <button
                    disabled={!linkingId || busy}
                    onClick={() => linkingId && linkExisting(promoting, linkingId)}
                  >
                    Link
                  </button>
                </div>
              </div>
            </div>
            <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
              <div className="eyebrow">Or create a new product</div>
              <PromoteToNewProduct
                suggestion={promoting}
                elements={elements}
                onCreated={async (productId) => {
                  await api.linkMaterialsToProduct(productId, promoting.material_ids);
                  setPromoting(null);
                  onChanged();
                }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function PromoteToNewProduct({
  suggestion, elements, onCreated,
}: {
  suggestion: Suggestion;
  elements: Element[];
  onCreated: (productId: number) => void;
}) {
  const guessedElement = useMemo(() => guessElementFor(suggestion.type, elements), [elements, suggestion.type]);

  const [element, setElement] = useState(guessedElement);
  const [variant, setVariant] = useState("");
  const [manufacturer, setManufacturer] = useState(suggestion.manufacturer ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    setBusy(true); setErr(null);
    try {
      const res = await api.addProduct({
        element_code: element,
        variant: variant || null,
        description: suggestion.sample_description,
        manufacturer: manufacturer.trim() || null,
        supplier: manufacturer.trim() || null,
        unit_cost: suggestion.avg_unit_cost ?? undefined,
        default_resource: "M",
      });
      onCreated(res.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr auto", gap: 12, marginTop: 8 }}>
        <div>
          <label>Element</label>
          <select value={element} onChange={(e) => setElement(e.target.value)}>
            {elements.map((el) => <option key={el.code} value={el.code}>{el.code} · {el.name}</option>)}
          </select>
        </div>
        <div>
          <label>Variant (optional)</label>
          <input value={variant} onChange={(e) => setVariant(e.target.value)} placeholder="80mm, ANTH, KS1000-80…" />
        </div>
        <div>
          <label>Manufacturer</label>
          <input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} placeholder="e.g. Kingspan" />
        </div>
        <div style={{ alignSelf: "end" }}>
          <button className="accent" onClick={create} disabled={busy || !element}>Create &amp; link</button>
        </div>
      </div>
      {err && <div className="flash error" style={{ marginTop: 12 }}>{err}</div>}
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Item number will be auto-allocated within the chosen element. {suggestion.material_ids.length} project material row(s) will be linked to this product.
      </div>
    </>
  );
}

/* ── Alternate suppliers panel (expand row to manage) ─────────────────── */

function AlternateSuppliersPanel({
  product, canManage, onChanged,
}: {
  product: Product;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<ProductSupplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  function reload() {
    setLoading(true);
    api.listProductSuppliers(product.id)
      .then(setRows)
      .catch((e) => setErr(e instanceof Error ? e.message : "load failed"))
      .finally(() => setLoading(false));
  }
  useEffect(reload, [product.id]);

  return (
    <div style={{ padding: 20 }}>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="grow">
          <h3 style={{ margin: 0, fontSize: 14 }}>Alternate suppliers for {product.product_code}</h3>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            Add suppliers where this product is also available, each with their own price and SKU.
            The primary supplier is <b>{product.supplier ?? product.manufacturer ?? "—"}</b> at{" "}
            <b>{product.unit_cost != null ? fmtMoney(product.unit_cost) : "—"}</b>.
          </div>
        </div>
        {canManage && !adding && (
          <button className="accent tiny" onClick={() => setAdding(true)}>+ Add supplier</button>
        )}
      </div>

      {err && <div className="flash error">{err}</div>}

      {adding && (
        <AlternateSupplierForm
          productId={product.id}
          onCancel={() => setAdding(false)}
          onSaved={() => { setAdding(false); reload(); onChanged(); }}
        />
      )}

      {loading ? (
        <div className="muted">Loading suppliers…</div>
      ) : rows.length === 0 && !adding ? (
        <div className="muted" style={{ fontSize: 13 }}>
          No alternate suppliers yet.{" "}
          {canManage && "Click + Add supplier above to add one — useful when the same product is stocked by multiple merchants at different prices."}
        </div>
      ) : (
        <table style={{ background: "var(--card)" }}>
          <thead>
            <tr>
              <th>Supplier</th>
              <th>SKU</th>
              <th className="num">Unit cost</th>
              <th className="num">vs. primary</th>
              <th className="num">Lead time</th>
              <th>Notes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <AlternateSupplierRow
                key={r.id}
                row={r}
                productId={product.id}
                primaryCost={product.unit_cost}
                canManage={canManage}
                onChanged={() => { reload(); onChanged(); }}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AlternateSupplierForm({
  productId, onCancel, onSaved,
}: {
  productId: number;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    supplier_name: "",
    unit_cost: "",
    supplier_sku: "",
    lead_time_days: "",
    notes: "",
    is_preferred: false,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true); setErr(null);
    try {
      await api.addProductSupplier(productId, {
        supplier_name: form.supplier_name.trim(),
        unit_cost: form.unit_cost ? Number(form.unit_cost) : null,
        supplier_sku: form.supplier_sku.trim() || null,
        lead_time_days: form.lead_time_days ? Number(form.lead_time_days) : null,
        notes: form.notes.trim() || null,
        is_preferred: form.is_preferred,
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 12, background: "var(--card)" }}>
      <div className="card-bd">
        {err && <div className="flash error">{err}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 120px 110px auto", gap: 12 }}>
          <div>
            <label>Supplier name</label>
            <input value={form.supplier_name} onChange={(e) => setForm({ ...form, supplier_name: e.target.value })} placeholder="e.g. SIG Roofing" />
          </div>
          <div>
            <label>Their SKU (optional)</label>
            <input value={form.supplier_sku} onChange={(e) => setForm({ ...form, supplier_sku: e.target.value })} placeholder="e.g. SIG-9924" />
          </div>
          <div>
            <label>Unit cost (£)</label>
            <input type="number" step="0.01" className="num" value={form.unit_cost} onChange={(e) => setForm({ ...form, unit_cost: e.target.value })} />
          </div>
          <div>
            <label>Lead time (days)</label>
            <input type="number" className="num" value={form.lead_time_days} onChange={(e) => setForm({ ...form, lead_time_days: e.target.value })} />
          </div>
          <div style={{ alignSelf: "end" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, textTransform: "none", letterSpacing: 0 }}>
              <input type="checkbox" checked={form.is_preferred} onChange={(e) => setForm({ ...form, is_preferred: e.target.checked })} style={{ minHeight: 0 }} />
              Prefer over primary
            </label>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <label>Notes</label>
          <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="e.g. 5% trade discount at 100+, MOQ 50" />
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={save} disabled={busy || !form.supplier_name.trim()}>Save supplier</button>
          <button className="ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function AlternateSupplierRow({
  row, productId, primaryCost, canManage, onChanged,
}: {
  row: ProductSupplier;
  productId: number;
  primaryCost: number | null;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    supplier_name: row.supplier_name,
    unit_cost: row.unit_cost?.toString() ?? "",
    supplier_sku: row.supplier_sku ?? "",
    lead_time_days: row.lead_time_days?.toString() ?? "",
    notes: row.notes ?? "",
    is_preferred: row.is_preferred,
  });
  const [busy, setBusy] = useState(false);

  const delta = primaryCost != null && row.unit_cost != null ? row.unit_cost - primaryCost : null;
  const deltaPct = primaryCost != null && primaryCost > 0 && row.unit_cost != null
    ? ((row.unit_cost - primaryCost) / primaryCost) * 100
    : null;

  async function save() {
    setBusy(true);
    try {
      await api.updateProductSupplier(productId, row.id, {
        supplier_name: form.supplier_name.trim(),
        unit_cost: form.unit_cost ? Number(form.unit_cost) : null,
        supplier_sku: form.supplier_sku.trim() || null,
        lead_time_days: form.lead_time_days ? Number(form.lead_time_days) : null,
        notes: form.notes.trim() || null,
        is_preferred: form.is_preferred,
      });
      setEditing(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <tr style={{ background: "var(--accent-soft)" }}>
        <td><input value={form.supplier_name} onChange={(e) => setForm({ ...form, supplier_name: e.target.value })} /></td>
        <td><input value={form.supplier_sku} onChange={(e) => setForm({ ...form, supplier_sku: e.target.value })} /></td>
        <td><input type="number" step="0.01" className="num" value={form.unit_cost} onChange={(e) => setForm({ ...form, unit_cost: e.target.value })} /></td>
        <td className="muted num">—</td>
        <td><input type="number" className="num" value={form.lead_time_days} onChange={(e) => setForm({ ...form, lead_time_days: e.target.value })} /></td>
        <td>
          <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, marginTop: 6, textTransform: "none", letterSpacing: 0 }}>
            <input type="checkbox" checked={form.is_preferred} onChange={(e) => setForm({ ...form, is_preferred: e.target.checked })} style={{ minHeight: 0 }} />
            Preferred
          </label>
        </td>
        <td>
          <button className="primary tiny" disabled={busy} onClick={save}>Save</button>{" "}
          <button className="ghost tiny" onClick={() => setEditing(false)}>Cancel</button>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td>
        {row.supplier_name}
        {row.is_preferred && <span className="badge approved" style={{ marginLeft: 6, fontSize: 10 }}>preferred</span>}
      </td>
      <td className="muted" style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{row.supplier_sku ?? "—"}</td>
      <td className="num">{row.unit_cost != null ? fmtMoney(row.unit_cost) : <span className="muted">—</span>}</td>
      <td className="num">
        {delta == null ? (
          <span className="muted">—</span>
        ) : delta === 0 ? (
          <span className="muted">±0</span>
        ) : (
          <span style={{ color: delta < 0 ? "var(--success)" : "var(--warn)", fontSize: 12 }}>
            {delta > 0 ? "+" : ""}{fmtMoney(delta)}
            {deltaPct != null && <span className="muted" style={{ marginLeft: 4 }}>({deltaPct > 0 ? "+" : ""}{deltaPct.toFixed(1)}%)</span>}
          </span>
        )}
      </td>
      <td className="num">{row.lead_time_days != null ? `${row.lead_time_days}d` : <span className="muted">—</span>}</td>
      <td className="muted" style={{ fontSize: 12 }}>{row.notes ?? "—"}</td>
      <td>
        {canManage && (
          <>
            <button className="ghost tiny" onClick={() => setEditing(true)}>Edit</button>{" "}
            <button className="ghost tiny" onClick={async () => {
              if (!confirm(`Remove ${row.supplier_name} as a supplier for this product?`)) return;
              await api.removeProductSupplier(productId, row.id);
              onChanged();
            }}>×</button>
          </>
        )}
      </td>
    </tr>
  );
}

function guessElementFor(materialType: string, elements: Element[]): string {
  const t = materialType.toLowerCase();
  const guess = elements.find((e) =>
    e.name.toLowerCase().includes(t) || t.includes(e.name.toLowerCase().split(" - ")[0]),
  );
  return guess?.code ?? elements[0]?.code ?? "";
}

/* ── Bulk promote modal ─────────────────────────────────────────────────── */

type BulkRow = {
  suggestion: Suggestion;
  element_code: string;
  variant: string;
  manufacturer: string;
  status: "pending" | "creating" | "done" | "error";
  error?: string;
  product_code?: string;
};

function BulkPromoteModal({
  suggestions, elements, onClose, onDone,
}: {
  suggestions: Suggestion[];
  elements: Element[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [rows, setRows] = useState<BulkRow[]>(() =>
    suggestions.map((s) => ({
      suggestion: s,
      element_code: guessElementFor(s.type, elements),
      variant: "",
      manufacturer: s.manufacturer ?? "",
      status: "pending",
    })),
  );
  const [running, setRunning] = useState(false);
  const [finishedCount, setFinishedCount] = useState(0);

  function update(idx: number, patch: Partial<BulkRow>) {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  async function runAll() {
    setRunning(true);
    setFinishedCount(0);
    let done = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.status === "done") { done += 1; setFinishedCount(done); continue; }
      update(i, { status: "creating", error: undefined });
      try {
        const product = await api.addProduct({
          element_code: r.element_code,
          variant: r.variant.trim() || null,
          description: r.suggestion.sample_description,
          manufacturer: r.manufacturer.trim() || null,
          supplier: r.manufacturer.trim() || null,
          unit_cost: r.suggestion.avg_unit_cost ?? undefined,
          default_resource: "M",
        });
        await api.linkMaterialsToProduct(product.id, r.suggestion.material_ids);
        const code = `${r.element_code}.${String(product.item_no).padStart(2, "0")}${product.variant ? "." + product.variant : ""}`;
        update(i, { status: "done", product_code: code });
      } catch (e) {
        update(i, { status: "error", error: e instanceof Error ? e.message : "failed" });
      }
      done += 1;
      setFinishedCount(done);
    }
    setRunning(false);
  }

  const allDone = rows.every((r) => r.status === "done");
  const anyErrors = rows.some((r) => r.status === "error");

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 100,
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "60px 20px", overflowY: "auto",
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !running) onClose(); }}
    >
      <div className="card" style={{ width: "100%", maxWidth: 1100, margin: 0 }}>
        <div className="card-hd">
          <h2 style={{ flex: 1 }}>Promote {rows.length} items</h2>
          <button className="ghost" onClick={onClose} disabled={running}>Close</button>
        </div>
        <div className="card-bd">
          <p className="muted" style={{ marginTop: 0 }}>
            Review the element, variant and manufacturer for each item, then run them through.
            Item numbers are auto-allocated within each element. Linked project materials will
            update automatically.
          </p>
          {running && (
            <div className="flash info">
              Working… {finishedCount} of {rows.length} processed.
            </div>
          )}
          {!running && allDone && (
            <div className="flash success">
              All {rows.length} items processed{anyErrors ? " (with errors — see below)" : "."}
            </div>
          )}

          <table>
            <thead>
              <tr>
                <th style={{ width: 24 }}>#</th>
                <th>Description</th>
                <th style={{ width: 200 }}>Element</th>
                <th style={{ width: 140 }}>Variant</th>
                <th style={{ width: 180 }}>Manufacturer</th>
                <th style={{ width: 130 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr key={r.suggestion.key}>
                  <td className="muted">{idx + 1}</td>
                  <td>
                    {r.suggestion.sample_description}
                    <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                      {r.suggestion.occurrences}× across {r.suggestion.project_codes.length} project{r.suggestion.project_codes.length === 1 ? "" : "s"}
                      {r.suggestion.avg_unit_cost != null && <> · avg {fmtMoney(r.suggestion.avg_unit_cost)}</>}
                    </div>
                  </td>
                  <td>
                    <select
                      value={r.element_code}
                      onChange={(e) => update(idx, { element_code: e.target.value })}
                      disabled={running || r.status === "done"}
                    >
                      {elements.map((el) => (
                        <option key={el.code} value={el.code}>{el.code} · {el.name}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      value={r.variant}
                      onChange={(e) => update(idx, { variant: e.target.value })}
                      placeholder="optional"
                      disabled={running || r.status === "done"}
                    />
                  </td>
                  <td>
                    <input
                      value={r.manufacturer}
                      onChange={(e) => update(idx, { manufacturer: e.target.value })}
                      placeholder="e.g. Kingspan"
                      disabled={running || r.status === "done"}
                    />
                  </td>
                  <td>
                    {r.status === "pending" && <span className="badge draft">pending</span>}
                    {r.status === "creating" && <span className="badge pending dot">creating…</span>}
                    {r.status === "done" && (
                      <span className="badge approved" style={{ fontFamily: "ui-monospace, monospace" }}>
                        ✓ {r.product_code}
                      </span>
                    )}
                    {r.status === "error" && (
                      <span title={r.error} className="badge rejected">error</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-hd" style={{ borderBottom: "none", borderTop: "1px solid var(--line)" }}>
          <div className="grow muted">
            {allDone
              ? `${rows.filter((r) => r.status === "done").length} created, ${rows.filter((r) => r.status === "error").length} failed`
              : `${finishedCount} of ${rows.length} processed`}
          </div>
          {allDone ? (
            <button className="primary" onClick={onDone}>Done</button>
          ) : (
            <>
              <button className="ghost" onClick={onClose} disabled={running}>Cancel</button>
              <button className="accent" onClick={runAll} disabled={running}>
                {running ? "Running…" : "Promote all"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
