import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, fmtMoney, fmtQty } from "../lib/api";
import { Topbar } from "./Shell";
import { SupplierCombobox, compareSuppliers, type SupplierOption } from "./SupplierCombobox";
import { SubstituteAction } from "./MaterialSubstitute";
import { can } from "../../shared/permissions";
import type { CurrentUser, MaterialWithCommitment, Supplier, SupplierStatus, Variation } from "../../shared/types";

// Item is "priced for this job" iff total_units > 0 in the Materials sheet (col V).
const isPriced = (m: MaterialWithCommitment) => (m.total_units ?? 0) > 0;
// Order quantities are pack/area units shown to 2dp. Round DOWN (floor) so a
// prefilled allowance can never tip a line over budget; the +1e-6 only absorbs
// binary float drift (e.g. 226.9999998 → 227), it won't round a real fraction up.
const cleanQty = (n: number) => Math.floor((n + 1e-6) * 100) / 100;

// Top section: tickable rows of items priced for this job.
type PricedRow = {
  material: MaterialWithCommitment;
  qty: number;
};

// Bottom section: items added from the wider materials library OR custom freeform.
type AdditionalRow = {
  key: string;
  source: "library" | "custom";
  // library
  type: string;
  material_id: number | null;
  // shared
  item: string;
  manufacturer: string;
  qty: number;
  unit: string;
  unit_cost: number;
  // True when the picked library item IS priced in the BOQ (just under a
  // different supplier). Such a line is a real BOQ draw-down, not an unpriced
  // extra — so it doesn't force approval and shows a different badge.
  priced?: boolean;
};

// Omission (credit) line: a budgeted material you're NOT ordering — used to
// cover a change in materials so the swap doesn't double-count against budget.
// Submitted as a NEGATIVE-qty PO line against the material, which credits its
// committed allowance. Materials-only; no crossover with labour.
type OmissionRow = {
  key: string;
  material_id: number;
  item: string;
  type: string | null;
  manufacturer: string | null;
  qty: number;
  unit: string;
  unit_cost: number;
};

const NO_MFR = "(No manufacturer)";

/** A FULL substitution retargets the whole line to the replacement. A PART
 *  substitution only diverts some of the quantity (the rest stays the original),
 *  so it does NOT retarget the row — the remainder is ordered as the original and
 *  the substituted portion is raised separately. */
function isFullSub(m: MaterialWithCommitment): boolean {
  return !!m.sub_id && !(m.sub_units != null && m.total_units != null && m.sub_units < m.total_units);
}

/** Which supplier a material is actually bought from: once a FULL substitution is
 *  active, its supplier/manufacturer takes over from the original BOQ one — so a
 *  subbed item is grouped, filtered and ordered under the new supplier. */
function effectiveMfr(m: MaterialWithCommitment): string {
  if (isFullSub(m)) return m.sub_supplier?.trim() || m.sub_manufacturer?.trim() || m.manufacturer?.trim() || "";
  return m.manufacturer?.trim() || "";
}

/** The price a PO should be raised at: a FULL substitution's cost wins, then
 *  an applied/approved supplier-quote (live) price, then the BOQ cost. (Pending
 *  quote prices aren't surfaced as live_unit_price, so they don't apply until
 *  approved.) */
function effectiveCost(m: MaterialWithCommitment): number {
  if (isFullSub(m) && m.sub_cost != null) return m.sub_cost;
  if (m.live_unit_price != null) return m.live_unit_price;
  return m.cost ?? 0;
}

// Prelim expenditure is restricted to genuine preliminaries — not arbitrary
// materials. A prelim PO line must be one of these cost types.
const PRELIM_TYPES = [
  "Plant hire",
  "Site management",
  "Welfare / cabins",
  "Scaffolding / access",
  "Temporary works",
  "Fuel / energy",
  "Waste / skips",
  "Security / hoarding",
  "Surveys / testing",
  "PPE / consumables",
  "Other prelim",
];

const newAdditional = (): AdditionalRow => ({
  key: crypto.randomUUID(),
  source: "library",
  type: "",
  material_id: null,
  item: "",
  manufacturer: "",
  qty: 0,
  unit: "",
  unit_cost: 0,
});

export function NewPO() {
  const { id: projectId } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [project, setProject] = useState<Awaited<ReturnType<typeof api.getProject>> | null>(null);
  const [mats, setMats] = useState<MaterialWithCommitment[]>([]);
  const [approvedSuppliers, setApprovedSuppliers] = useState<Supplier[]>([]);
  const [supplier, setSupplier] = useState<string>("");
  const [customSupplier, setCustomSupplier] = useState<string>("");
  // Call-off mode: when ?framework=<id> is present, this PO draws against that
  // framework order — supplier is locked to the framework's supplier.
  const [searchParams] = useSearchParams();
  const frameworkId = searchParams.get("framework");
  const [frameworkPo, setFrameworkPo] = useState<{ id: string; po_number: string; supplier: string } | null>(null);
  useEffect(() => {
    if (!frameworkId) return;
    api.getPO(frameworkId)
      .then((p) => { setFrameworkPo({ id: p.id, po_number: p.po_number, supplier: p.supplier }); setSupplier(p.supplier); })
      .catch(() => {});
  }, [frameworkId]);
  // Call-off draw-down: the framework's own lines + how much of each is still
  // available (framework qty − already called off). The call-off picks from
  // these, not the project BOQ.
  const [calloff, setCalloff] = useState<Awaited<ReturnType<typeof api.calloffLines>> | null>(null);
  const [calloffRows, setCalloffRows] = useState<Map<number, number>>(new Map()); // line index → qty
  useEffect(() => {
    if (!frameworkId) { setCalloff(null); return; }
    api.calloffLines(frameworkId).then(setCalloff).catch(() => setCalloff(null));
  }, [frameworkId]);
  function toggleCalloff(i: number, available: number) {
    setCalloffRows((prev) => {
      const next = new Map(prev);
      if (next.has(i)) next.delete(i); else next.set(i, cleanQty(available));
      return next;
    });
  }
  function setCalloffQty(i: number, qty: number) {
    setCalloffRows((prev) => { const n = new Map(prev); if (n.has(i)) n.set(i, qty); return n; });
  }
  // Call-off toggle (manual): mark this PO as a call-off and optionally pick a
  // framework/blanket order on this project to draw down against.
  const [isFramework, setIsFramework] = useState<boolean>(false);
  const [isCallOff, setIsCallOff] = useState<boolean>(!!frameworkId);
  const [manualFrameworkId, setManualFrameworkId] = useState<string>("");
  const [frameworkOptions, setFrameworkOptions] = useState<Array<{ id: string; po_number: string; supplier: string; project_code?: string; project_id?: string }>>([]);
  const [fwSearch, setFwSearch] = useState("");   // searchable framework picker
  const [fwOpen, setFwOpen] = useState(false);
  useEffect(() => {
    // Every framework on the SITE, not just this block: a grouped site buys the
    // quantity once and calls it off per block, so the framework that serves
    // this order often sits on a sibling contract.
    if (!projectId) return;
    api.groupFrameworks(projectId)
      .then(setFrameworkOptions)
      .catch(() => {});
  }, [projectId]);
  const [notes, setNotes] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [variations, setVariations] = useState<Variation[]>([]);
  const [variationId, setVariationId] = useState<number | null>(null);
  // Pre-set from ?category=prelims (the "Raise prelim expenditure" entry point).
  const [category, setCategory] = useState<"materials" | "prelims">(
    searchParams.get("category") === "prelims" ? "prelims" : "materials",
  );
  const [pricedRows, setPricedRows] = useState<Map<number, PricedRow>>(new Map());
  const [additional, setAdditional] = useState<AdditionalRow[]>([]);
  const [omissions, setOmissions] = useState<OmissionRow[]>([]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [me, setMe] = useState<CurrentUser | null>(null);
  // Substituting a material is a procurement change — same gate as the Materials
  // tab (materials.upload). Shown per priced line so a swap can be made right here
  // when raising the PO, including for a grouped-site block.
  const canSubstitute = can(me?.role, "materials.upload");
  const reloadMats = () => { if (projectId) api.listMaterials(projectId).then(setMats).catch(() => {}); };

  useEffect(() => {
    if (!projectId) return;
    api.getProject(projectId).then(setProject).catch((e) => setErr(e.message));
    api.listMaterials(projectId).then(setMats).catch((e) => setErr(e.message));
    api.listSuppliers().then(setApprovedSuppliers).catch(() => setApprovedSuppliers([]));
    api.listVariations(projectId).then(setVariations).catch(() => setVariations([]));
    api.me().then(setMe).catch(() => setMe(null));
  }, [projectId]);

  // Prefill a single custom additional line from ?item=&qty=&unit= — the "Raise PO"
  // action on the programme's Materials & stock tab lands here with the shortfall
  // pre-entered, so the PM only picks the supplier and confirms the price.
  const prefillItem = searchParams.get("item");
  useEffect(() => {
    if (!prefillItem) return;
    const qty = cleanQty(Number(searchParams.get("qty")) || 0);
    const unit = searchParams.get("unit") || "";
    setAdditional((a) => (a.length ? a : [{ ...newAdditional(), source: "custom", item: prefillItem, qty, unit }]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillItem]);

  // Index approved suppliers by lowercased name for O(1) match.
  const approvedByName = useMemo(() => {
    const m = new Map<string, Supplier>();
    for (const s of approvedSuppliers) m.set(s.name.toLowerCase(), s);
    return m;
  }, [approvedSuppliers]);

  function findApprovedSupplier(name: string): Supplier | null {
    return approvedByName.get(name.trim().toLowerCase()) ?? null;
  }

  // Suppliers shown in the dropdown = union of manufacturers in this project's
  // snapshot AND the org-level approved suppliers register, each tagged with
  // its register status (or "not_in_register" for ad-hoc snapshot manufacturers).
  const suppliers = useMemo(() => {
    const set = new Map<string, { priced: number; total: number }>();
    for (const m of mats) {
      const key = effectiveMfr(m) || NO_MFR;
      const cur = set.get(key) ?? { priced: 0, total: 0 };
      cur.total += 1;
      if (isPriced(m)) cur.priced += 1;
      set.set(key, cur);
    }
    // Make sure approved suppliers also appear even if they have no priced items.
    for (const s of approvedSuppliers) {
      if (!set.has(s.name)) set.set(s.name, { priced: 0, total: 0 });
    }
    return [...set.entries()]
      .map(([name, v]) => {
        const approved = findApprovedSupplier(name);
        const status: SupplierStatus | "not_in_register" = approved?.status ?? "not_in_register";
        return { name, ...v, status, approved };
      })
      .filter((s) => s.name !== NO_MFR || s.priced > 0 || s.total > 0)
      .sort((a, b) => {
        // Preferred first, then by priced count desc, then alphabetical.
        const rank = (s: SupplierStatus | "not_in_register") =>
          s === "preferred" ? 0 : s === "approved" ? 1 : s === "pending" ? 2 : s === "suspended" ? 4 : 3;
        if (a.status !== b.status) return rank(a.status) - rank(b.status);
        if (a.priced !== b.priced) return b.priced - a.priced;
        return a.name.localeCompare(b.name);
      });
  }, [mats, approvedSuppliers, approvedByName]);

  // Prelim expenditure headings come from the project's prelim line items in the
  // materials list (those under a "Preliminaries" element / type). Falls back to
  // the generic list until prelim costs have been added to the materials list.
  const prelimOptions = useMemo(() => {
    const items = mats
      .filter((m) => /prelim/i.test(m.element_name ?? "") || /prelim/i.test(m.type ?? ""))
      .map((m) => m.item.trim())
      .filter(Boolean);
    const uniq = [...new Set(items)];
    return uniq.length ? uniq : PRELIM_TYPES;
  }, [mats]);

  const isCustomSupplier = supplier === "__other__";
  const effectiveSupplier = isCustomSupplier
    ? customSupplier.trim()
    : supplier === NO_MFR
      ? ""
      : supplier;
  const supplierRecord = effectiveSupplier ? findApprovedSupplier(effectiveSupplier) : null;

  // Top section data: priced items (V > 0) for this supplier.
  const pricedForSupplier = useMemo(() => {
    if (!supplier || isCustomSupplier) return [];
    return mats
      .filter(isPriced)
      .filter((m) => (supplier === NO_MFR ? !effectiveMfr(m) : effectiveMfr(m) === supplier))
      .filter((m) => !filter || (m.item + (m.type ?? "")).toLowerCase().includes(filter.toLowerCase()));
  }, [mats, supplier, isCustomSupplier, filter]);

  // The supplier's approved element scope (from the register) — the elements
  // they've been "selected as being able to supply". Empty = no scope set.
  const scopeSet = useMemo(
    () => new Set(supplierRecord?.approved_elements ?? []),
    [supplierRecord],
  );
  const inSupplierScope = (m: MaterialWithCommitment) =>
    scopeSet.size > 0 &&
    ((m.element_code != null && scopeSet.has(m.element_code)) ||
      (m.product_element_code != null && scopeSet.has(m.product_element_code)));

  // Bottom section: everything else this supplier can provide that isn't already
  // in the priced-for-them list above — their own unpriced lines, PLUS anything
  // within their approved element scope badged to another brand (whether or not
  // it's priced under a different supplier). So Alumasc, approved for flashings,
  // can be sent a PO for flashings even though they're priced under Barwell.
  const libraryUnpriced = useMemo(() => {
    if (!supplier || isCustomSupplier) return [];
    if (supplier === NO_MFR) return mats.filter((m) => !isPriced(m) && !effectiveMfr(m));
    return mats.filter((m) => (effectiveMfr(m) === supplier ? !isPriced(m) : inSupplierScope(m)));
  }, [mats, supplier, isCustomSupplier, scopeSet]); // eslint-disable-line react-hooks/exhaustive-deps
  const libraryTypes = useMemo(
    () => [...new Set(libraryUnpriced.map((m) => m.type))].sort(),
    [libraryUnpriced],
  );

  // Reset rows when supplier changes — selections are supplier-scoped.
  useEffect(() => {
    setPricedRows(new Map());
    setAdditional([]);
    setOmissions([]);
    setFilter("");
  }, [supplier]);

  // Materials that can be omitted (credited) to cover a change — anything priced
  // in the BOQ for this job. Cross-supplier is fine: crediting a budgeted line
  // reduces its committed allowance wherever it sits.
  const omittableMaterials = useMemo(
    () => mats.filter(isPriced).slice().sort((a, b) => a.item.localeCompare(b.item)),
    [mats],
  );
  function addOmission(materialIdStr: string) {
    const m = omittableMaterials.find((mm) => String(mm.id) === materialIdStr);
    if (!m) return;
    // Default to crediting back what's already committed for it (the amount a
    // change would otherwise leave double-counted); fall back to the BOQ qty.
    const defQty = (m.committed_qty ?? 0) > 0 ? (m.committed_qty ?? 0) : (m.total_units ?? 0);
    setOmissions((c) => [...c, {
      key: crypto.randomUUID(),
      material_id: m.id,
      item: m.item,
      type: m.type,
      manufacturer: m.manufacturer,
      qty: cleanQty(defQty),
      unit: m.total_units_unit ?? m.pack_unit ?? "ea",
      unit_cost: m.cost ?? 0,
    }]);
  }
  const updateOmission = (key: string, patch: Partial<OmissionRow>) =>
    setOmissions((c) => c.map((o) => (o.key === key ? { ...o, ...patch } : o)));
  const removeOmission = (key: string) => setOmissions((c) => c.filter((o) => o.key !== key));

  function toggleRow(m: MaterialWithCommitment) {
    setPricedRows((prev) => {
      const next = new Map(prev);
      if (next.has(m.id)) {
        next.delete(m.id);
      } else {
        const remaining = Math.max(0, (m.total_units ?? 0) - (m.committed_qty ?? 0));
        next.set(m.id, { material: m, qty: cleanQty(remaining) });
      }
      return next;
    });
  }
  function setPricedQty(id: number, qty: number) {
    setPricedRows((prev) => {
      const next = new Map(prev);
      const row = next.get(id);
      if (row) next.set(id, { ...row, qty });
      return next;
    });
  }
  // Select-all: tick every currently-shown priced item (respects the filter),
  // each at its full remaining quantity. If all shown are already ticked, clears them.
  function toggleAllPriced() {
    setPricedRows((prev) => {
      const shown = pricedForSupplier;
      const allSelected = shown.length > 0 && shown.every((m) => prev.has(m.id));
      const next = new Map(prev);
      if (allSelected) {
        for (const m of shown) next.delete(m.id);
      } else {
        for (const m of shown) {
          if (!next.has(m.id)) {
            const remaining = Math.max(0, (m.total_units ?? 0) - (m.committed_qty ?? 0));
            next.set(m.id, { material: m, qty: cleanQty(remaining) });
          }
        }
      }
      return next;
    });
  }

  function addAdditional() {
    // Prelim POs never draw on the materials library — each line is a free-text
    // prelim cost tagged to a prelim type, so always start in custom mode.
    // Otherwise: if there's no library to pick from (custom supplier, or a
    // supplier with no unpriced items), drop straight into custom-entry mode.
    const startCustom = category === "prelims" || libraryUnpriced.length === 0;
    setAdditional((a) => [
      ...a,
      startCustom
        ? { ...newAdditional(), source: "custom", manufacturer: effectiveSupplier }
        : newAdditional(),
    ]);
  }
  function updateAdditional(key: string, patch: Partial<AdditionalRow>) {
    setAdditional((a) => a.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function removeAdditional(key: string) {
    setAdditional((a) => a.filter((r) => r.key !== key));
  }

  function pickLibraryItem(key: string, materialIdStr: string) {
    if (materialIdStr === "__custom__") {
      updateAdditional(key, {
        source: "custom",
        material_id: null,
        item: "",
        manufacturer: effectiveSupplier,
        unit: "",
        unit_cost: 0,
        priced: false,
      });
      return;
    }
    const m = libraryUnpriced.find((mm) => String(mm.id) === materialIdStr);
    if (!m) return;
    // Honour an active substitution — pick up the replacement's
    // item/manufacturer/unit/cost (the updated price), as the priced rows do.
    const subbed = isFullSub(m);
    updateAdditional(key, {
      source: "library",
      material_id: m.id,
      item: subbed ? (m.sub_item ?? m.item) : m.item,
      manufacturer: subbed ? (m.sub_manufacturer ?? m.sub_supplier ?? m.manufacturer ?? "") : (m.manufacturer ?? ""),
      unit: subbed ? (m.sub_unit ?? m.total_units_unit ?? m.pack_unit ?? "ea") : (m.total_units_unit ?? m.pack_unit ?? "ea"),
      unit_cost: effectiveCost(m),
      priced: isPriced(m),
    });
  }

  // Totals — use the substitution / applied-quote price via effectiveCost().
  const pricedSelected = useMemo(() => [...pricedRows.values()].filter((r) => r.qty > 0), [pricedRows]);
  const pricedTotal = pricedSelected.reduce((s, r) => s + r.qty * effectiveCost(r.material), 0);
  // Prelim lines must also carry a prelim type (so spend is tagged to a real
  // preliminary — plant, management, welfare, …), not left as a blank item.
  const validAdditional = additional.filter(
    (a) => a.item.trim() && a.qty > 0 && (category !== "prelims" || !!a.type),
  );
  const additionalTotal = validAdditional.reduce((s, a) => s + a.qty * a.unit_cost, 0);
  // Omissions are credits — they reduce the order value and free committed budget.
  const validOmissions = omissions.filter((o) => o.qty > 0 && o.material_id != null);
  const omissionTotal = validOmissions.reduce((s, o) => s + o.qty * o.unit_cost, 0);
  const grandTotal = pricedTotal + additionalTotal - omissionTotal;

  // Call-off draw-down selections (framework mode).
  const calloffSelected = calloff
    ? [...calloffRows.entries()].filter(([, q]) => q > 0).map(([i, q]) => ({ line: calloff.lines[i], qty: q }))
    : [];
  const calloffTotal = calloffSelected.reduce((s, r) => s + r.qty * r.line.unit_cost, 0);
  const calloffOver = calloffSelected.some((r) => r.qty - r.line.available_qty > 1e-4);

  // A call-off draws within its framework's existing reservation, so it is NOT
  // measured against the BOQ allowance (the framework already committed that
  // budget). Skip the over-budget check for call-offs — mirrors the server,
  // which skips the BOQ gate for call-offs — so a legitimate call-off isn't
  // wrongly flagged "over committed" just because the framework reserved the item.
  const overBudget = isCallOff ? [] : pricedSelected.filter((r) => {
    const rem = (r.material.total_units ?? 0) - (r.material.committed_qty ?? 0);
    return r.qty - rem > 1e-4;   // tolerance so a full-allowance line isn't flagged on float noise
  });

  const selectedFw = frameworkOptions.find((f) => f.id === manualFrameworkId) ?? null;
  const filteredFw = frameworkOptions.filter((f) =>
    `${f.po_number} ${f.supplier} ${f.project_code ?? ""}`.toLowerCase().includes(fwSearch.trim().toLowerCase()));
  // Frameworks this supplier already holds for the project. When one exists, the
  // supplier's materials are reserved on it and show as "committed" on a normal
  // PO — so we nudge the user to draw a call-off instead (the correct flow).
  const supplierFrameworks = effectiveSupplier
    ? frameworkOptions.filter((f) => f.supplier.trim().toLowerCase() === effectiveSupplier.trim().toLowerCase())
    : [];
  const hasOver = overBudget.length > 0;
  // Genuinely-unpriced extras (not the priced-elsewhere in-scope picks) are what
  // trigger approval + the "unpriced" note.
  const unpricedAdditional = validAdditional.filter((a) => !a.priced);
  const unpricedAdditionalTotal = unpricedAdditional.reduce((s, a) => s + a.qty * a.unit_cost, 0);
  const hasUnpricedAdditional = unpricedAdditional.length > 0;
  // A priced-elsewhere pick still needs sign-off if its qty exceeds the BOQ
  // material's remaining allowance.
  const additionalOver = isCallOff ? false : validAdditional.some((a) => {
    if (!a.priced || a.material_id == null) return false;
    const m = mats.find((mm) => mm.id === a.material_id);
    if (!m) return false;
    return a.qty - ((m.total_units ?? 0) - (m.committed_qty ?? 0)) > 1e-4;
  });
  const needsApproval = hasOver || hasUnpricedAdditional || additionalOver;

  // Scope checks against the approved supplier register. Surfaced as warnings
  // — they don't block submission, but they nudge the PM to use the right
  // merchant for the right element (e.g. don't buy insulation off a flashings-only
  // supplier).
  const scopeWarnings = useMemo(() => {
    if (!supplierRecord) return [];
    if (supplierRecord.approved_elements.length === 0) return []; // no scope = any element
    const ok = new Set(supplierRecord.approved_elements);
    const out: Array<{ item: string; element_code: string }> = [];
    for (const r of pricedSelected) {
      const ec = r.material.product_element_code;
      if (ec && !ok.has(ec)) out.push({ item: r.material.item, element_code: ec });
    }
    return out;
  }, [supplierRecord, pricedSelected]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) return;
    if (!effectiveSupplier) return setErr("Pick a supplier (or enter a custom one).");

    // Call-off mode: lines are drawn from the framework, bounded by its remaining.
    if (frameworkId) {
      if (calloffSelected.length === 0) return setErr("Tick at least one framework line to call off.");
      if (calloffOver) return setErr("A call-off line exceeds what's still available on the framework.");
      setBusy(true); setErr(null);
      try {
        const res = await api.createPO({
          project_id: projectId,
          supplier: effectiveSupplier,
          notes: notes.trim() || undefined,
          delivery_date: deliveryDate || undefined,
          parent_po_id: frameworkId,
          order_type: "call_off",
          category,
          lines: calloffSelected.map((r) => ({
            material_id: r.line.material_id,
            item: r.line.item,
            type: r.line.type,
            manufacturer: r.line.manufacturer,
            qty: r.qty,
            unit: r.line.unit || "ea",
            unit_cost: r.line.unit_cost,
          })),
        });
        nav(`/pos/${res.id}`);
      } catch (e) { setErr(e instanceof Error ? e.message : "failed"); }
      finally { setBusy(false); }
      return;
    }

    if (pricedSelected.length === 0 && validAdditional.length === 0 && validOmissions.length === 0) {
      return setErr("Tick at least one priced item or add an additional item.");
    }
    setBusy(true);
    setErr(null);
    try {
      const lines = [
        ...pricedSelected.map((r) => {
          // If the material has an active substitution, the PO line picks up
          // the replacement's item/manufacturer/cost/unit but still records
          // the ORIGINAL material_id so the BOQ allowance draws down correctly.
          const m = r.material;
          const subbed = isFullSub(m);
          return {
            material_id: m.id,
            item: subbed ? (m.sub_item ?? m.item) : m.item,
            type: m.type,
            manufacturer: subbed
              ? (m.sub_manufacturer ?? m.sub_supplier ?? m.manufacturer)
              : m.manufacturer,
            qty: r.qty,
            unit: subbed
              ? (m.sub_unit ?? m.total_units_unit ?? m.pack_unit ?? "ea")
              : (m.total_units_unit ?? m.pack_unit ?? "ea"),
            unit_cost: effectiveCost(m),
          };
        }),
        ...validAdditional.map((a) => ({
          material_id: a.material_id,           // null for custom, set for library picks
          item: a.item.trim(),
          type: a.type || null,
          manufacturer: a.manufacturer.trim() || null,
          qty: a.qty,
          unit: a.unit || "ea",
          unit_cost: a.unit_cost,
        })),
        // Omissions: NEGATIVE-qty lines against the budgeted material, so the
        // credit reduces its committed allowance (covers a change in materials).
        ...validOmissions.map((o) => ({
          material_id: o.material_id,
          item: o.item,
          type: o.type,
          manufacturer: o.manufacturer,
          qty: -Math.abs(o.qty),
          unit: o.unit || "ea",
          unit_cost: o.unit_cost,
        })),
      ];
      const res = await api.createPO({
        project_id: projectId,
        supplier: effectiveSupplier,
        notes: notes.trim() || undefined,
        delivery_date: deliveryDate || undefined,
        variation_id: variationId,
        parent_po_id: frameworkId ?? (isCallOff ? (manualFrameworkId || undefined) : undefined),
        order_type: isFramework ? "framework" : isCallOff ? "call_off" : undefined,
        category,
        lines,
      });
      nav(`/pos/${res.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  // Budget context for the inspector — sum priced and committed material values.
  const budget = useMemo(() => {
    let priced = 0, committed = 0;
    for (const m of mats) {
      const cost = m.cost ?? 0;
      priced += (m.total_units ?? 0) * cost;
      committed += (m.committed_qty ?? 0) * cost;
    }
    return { priced, committed };
  }, [mats]);
  // Additional (unpriced) items don't reduce the priced budget; omissions credit it back.
  const projectedCommitted = budget.committed + pricedTotal - omissionTotal;

  // Live preview of approval tier — mirrors src/worker/approval.ts logic
  const tierPreview = !needsApproval
    ? null
    : grandTotal <= 2000 && !hasUnpricedAdditional
      ? "Line Manager"
      : grandTotal <= 10000
        ? "Commercial Manager"
        : "Director";

  if (!project) return <main className="muted">Loading…</main>;

  return (
    <>
      <Topbar
        crumbs={<><Link to="/">Projects</Link> / <Link to={`/projects/${projectId}`}>{project.project.code}</Link> / New PO</>}
        title={frameworkPo ? "New call-off" : "New Purchase Order"}
        actions={
          <>
            <Link to={`/projects/${projectId}`} className="btn ghost">Cancel</Link>
            <button
              type="submit"
              form="new-po-form"
              className="accent"
              disabled={busy || (frameworkId ? calloffTotal <= 0 : grandTotal <= 0)}
            >
              {busy ? "Submitting…" : frameworkId ? "Create call-off" : needsApproval ? "Submit for approval" : "Create PO"}
            </button>
          </>
        }
      />
      <main>
      {err && <div className="flash error">{err}</div>}

      {frameworkPo && (
        <div className="flash info">
          <span className="pill neutral" style={{ fontSize: 11, marginRight: 6 }}>Call-off</span>
          Drawing down against framework order <Link to={`/pos/${frameworkPo.id}`}><b>{frameworkPo.po_number}</b></Link> — supplier locked to <b>{frameworkPo.supplier}</b>.
        </div>
      )}

      {effectiveSupplier && supplierRecord?.status === "suspended" && (
        <div className="flash error">
          <b>{effectiveSupplier}</b> is currently <b>suspended</b>. Speak to admin before raising a PO with this supplier.
        </div>
      )}
      {effectiveSupplier && supplierRecord?.status === "pending" && (
        <div className="flash info">
          <b>{effectiveSupplier}</b> is in onboarding (pending). Credit terms may not be set up yet — check before issuing.
        </div>
      )}
      {effectiveSupplier && !supplierRecord && !isCustomSupplier && (
        <div className="flash info">
          <b>{effectiveSupplier}</b> isn't in your <Link to="/suppliers">approved suppliers</Link> register yet.
          Adding them there gives you payment terms, scope, contact details, and lets you preference them in future POs.
        </div>
      )}
      {scopeWarnings.length > 0 && (
        <div className="flash info">
          <b>{scopeWarnings.length} item{scopeWarnings.length === 1 ? "" : "s"} outside supplier's approved scope.</b>{" "}
          {effectiveSupplier} is approved for elements {supplierRecord!.approved_elements.join(", ")} only.
          Items affected: {scopeWarnings.slice(0, 3).map((w) => `${w.item} (${w.element_code})`).join(", ")}
          {scopeWarnings.length > 3 && ` (+${scopeWarnings.length - 3} more)`}.
        </div>
      )}

      <form id="new-po-form" onSubmit={submit}>
        <div className="split">
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Supplier selection */}
        <div className="card card-padded">
          <div className="row" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ minWidth: 320, flex: "1 1 320px" }}>
              <label>Supplier</label>
              {frameworkPo ? (
                <div style={{ fontWeight: 600, padding: "8px 0" }}>
                  {frameworkPo.supplier}
                  <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>Locked to the call-off order's supplier</div>
                </div>
              ) : (
              <SupplierCombobox
                value={supplier === "__other__" ? "" : supplier}
                isCustom={isCustomSupplier}
                onChange={(name) => setSupplier(name)}
                onCustom={() => setSupplier("__other__")}
                onProject={[...suppliers.filter((s) => s.priced > 0 || s.total > 0)].sort(compareSuppliers) as SupplierOption[]}
                offProject={[...suppliers.filter((s) => s.priced === 0 && s.total === 0)].sort(compareSuppliers) as SupplierOption[]}
              />
              )}
              {supplierRecord && (
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  {supplierRecord.payment_terms && <>Terms: {supplierRecord.payment_terms} · </>}
                  {supplierRecord.approved_elements.length > 0
                    ? `Scope: ${supplierRecord.approved_elements.join(", ")}`
                    : "Scope: any element"}
                </div>
              )}
            </div>
            {isCustomSupplier && (
              <div className="grow">
                <label>Custom supplier name</label>
                <input value={customSupplier} onChange={(e) => setCustomSupplier(e.target.value)} placeholder="e.g. SIG Roofing" />
              </div>
            )}
            <div style={{ minWidth: 160 }}>
              <label>Delivery date</label>
              <input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
            </div>
          </div>
          {!frameworkId && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
              <div className="eyebrow" style={{ marginBottom: 6 }}>Order type</div>
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", margin: 0 }}>
                  <input type="checkbox" checked={isFramework} style={{ width: "auto" }}
                    onChange={(e) => { setIsFramework(e.target.checked); if (e.target.checked) { setIsCallOff(false); setManualFrameworkId(""); } }} />
                  <span style={{ fontWeight: 600 }}>Framework order</span>
                  <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>— a blanket order others call off against</span>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", margin: 0 }}>
                  <input type="checkbox" checked={isCallOff} style={{ width: "auto" }}
                    onChange={(e) => { setIsCallOff(e.target.checked); if (e.target.checked) setIsFramework(false); else { setManualFrameworkId(""); setFwSearch(""); setFwOpen(false); } }} />
                  <span style={{ fontWeight: 600 }}>Call-off order</span>
                  <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>— draws down against a framework</span>
                </label>
              </div>
              {isCallOff && (
                <div style={{ marginTop: 10, maxWidth: 460, position: "relative" }}>
                  <label>Framework order to draw against</label>
                  {frameworkOptions.length > 0 ? (
                    <>
                      <input
                        type="text"
                        placeholder="Search framework orders by number or supplier…"
                        value={fwOpen ? fwSearch : (selectedFw ? `${selectedFw.po_number} · ${selectedFw.supplier}` : fwSearch)}
                        onFocus={() => { setFwOpen(true); setFwSearch(""); }}
                        onChange={(e) => { setFwSearch(e.target.value); setFwOpen(true); setManualFrameworkId(""); }}
                        onBlur={() => setFwOpen(false)}
                        style={{ width: "100%" }}
                      />
                      {fwOpen && (
                        <div style={{ position: "absolute", zIndex: 30, left: 0, right: 0, marginTop: 2, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, maxHeight: 220, overflowY: "auto", boxShadow: "0 10px 28px rgba(0,0,0,.14)" }}>
                          {filteredFw.length === 0 ? (
                            <div className="muted" style={{ padding: "8px 10px", fontSize: 12 }}>No matching framework orders.</div>
                          ) : filteredFw.map((f) => (
                            <button type="button" key={f.id}
                              // Switch into the real draw-down flow (?framework=) so the call-off
                              // picks from the framework's own remaining lines — NOT the project
                              // BOQ, whose allowance the framework has already reserved (which would
                              // wrongly flag every line "over budget"). onMouseDown fires before the
                              // input's blur so it lands before the dropdown self-closes.
                              onMouseDown={(e) => { e.preventDefault(); setFwOpen(false); nav(`/projects/${projectId}/new-po?framework=${f.id}`); }}
                              style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", border: "none", borderBottom: "1px solid var(--line)", background: f.id === manualFrameworkId ? "var(--accent-soft)" : "transparent", cursor: "pointer", fontSize: 13 }}>
                              <b>{f.po_number}</b> <span className="muted">· {f.supplier}</span>
                              {f.project_id && f.project_id !== projectId && (
                                <span className="pill" style={{ marginLeft: 6, fontSize: 10 }} title="Framework sits on a sibling block — the call-off still books to the block you're raising on">{f.project_code}</span>
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                        {selectedFw
                          ? <>Linked to <b>{selectedFw.po_number}</b> — supplier set to {selectedFw.supplier}.
                              {selectedFw.project_id && selectedFw.project_id !== projectId && <> Framework sits on <b>{selectedFw.project_code}</b>; this call-off books its cost to the block you're raising on.</>}</>
                          : "Optional — pick a framework to link this call-off, or leave blank to just flag it."}
                      </div>
                    </>
                  ) : (
                    <div className="muted" style={{ fontSize: 12 }}>
                      No framework orders on this site yet — the PO will simply be flagged as a call-off.
                      To link one, mark a PO as a framework first (open a PO → “Make framework”).
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <label>Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ width: "100%" }} />
          </div>
          <div style={{ marginTop: 12, maxWidth: 420 }}>
            <label>Cost category</label>
            <select value={category} onChange={(e) => setCategory(e.target.value as "materials" | "prelims")} style={{ width: "100%" }}>
              <option value="materials">Materials — expends the materials budget</option>
              <option value="prelims">Preliminaries — expends the prelims budget (plant, welfare, scaffold…)</option>
            </select>
            {category === "prelims" && (
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                Prelim expenditure — pick any supplier above (or “Other…” for an ad-hoc one) and add the cost
                lines under <b>Prelim cost lines</b> below (each tagged to a prelim type). This expends the project's prelims budget.
              </div>
            )}
          </div>
          {variations.length > 0 && (
            <div style={{ marginTop: 12, maxWidth: 420 }}>
              <label>Variation (optional)</label>
              <select value={variationId ?? ""} onChange={(e) => setVariationId(e.target.value ? Number(e.target.value) : null)} style={{ width: "100%" }}>
                <option value="">— Base contract (no variation) —</option>
                {variations.map((v) => {
                  const approved = !!v.approved_at;
                  return (
                    <option key={v.id} value={v.id} disabled={!approved}>
                      VO{v.variation_no} — {v.description}
                      {approved
                        ? (v.material_budget > 0 ? `  (materials ${fmtMoney(v.material_budget)})` : "")
                        : "  (pending approval)"}
                    </option>
                  );
                })}
              </select>
              <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>Link this PO to a variation so its value counts as that variation's material spend.</div>
            </div>
          )}
        </div>

        {/* TOP: priced items for this supplier (not for prelim POs) */}
        {/* Call-off mode: draw from the framework's own lines, bounded by what's
            still available on each (framework qty − already called off). */}
        {frameworkId && (
          <div className="card">
            <div className="card-hd">
              <h2 style={{ flex: 1 }}>
                Call off from {calloff?.framework.po_number ?? "framework"}
              </h2>
              <span className="muted">{calloffSelected.length} line{calloffSelected.length === 1 ? "" : "s"} · {fmtMoney(calloffTotal)}</span>
            </div>
            {!calloff ? (
              <div className="card-bd"><div className="muted">Loading framework lines…</div></div>
            ) : calloff.lines.length === 0 ? (
              <div className="card-bd"><div className="muted">This framework has no line items to call off against.</div></div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 36 }} />
                    <th>Item</th>
                    <th className="center">Unit</th>
                    <th className="num">Unit cost</th>
                    <th className="num">Framework</th>
                    <th className="num">Called off</th>
                    <th className="num">Available</th>
                    <th className="num" style={{ width: 110 }}>Call-off qty</th>
                    <th className="num">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {calloff.lines.map((l, i) => {
                    const qty = calloffRows.get(i);
                    const picked = qty != null;
                    const over = picked && (qty ?? 0) - l.available_qty > 1e-4;
                    return (
                      <tr key={i} style={picked ? { background: "var(--accent-soft)" } : undefined}>
                        <td><input type="checkbox" checked={picked} onChange={() => toggleCalloff(i, l.available_qty)} /></td>
                        <td>{l.item}{l.manufacturer ? <div className="muted" style={{ fontSize: 11 }}>{l.manufacturer}</div> : null}</td>
                        <td className="center">{l.unit}</td>
                        <td className="num">{fmtMoney(l.unit_cost)}</td>
                        <td className="num">{fmtQty(l.framework_qty)}</td>
                        <td className="num">{fmtQty(l.called_off_qty)}</td>
                        <td className="num">{fmtQty(l.available_qty)}</td>
                        <td className="num">
                          {picked ? (
                            <input type="number" step="any" min={0} max={l.available_qty} value={qty || ""}
                              onChange={(e) => setCalloffQty(i, Number(e.target.value))}
                              style={{ width: 90, textAlign: "right" }} />
                          ) : <span className="muted">—</span>}
                        </td>
                        <td className="num">
                          {picked ? (
                            <>{fmtMoney((qty ?? 0) * l.unit_cost)}{over && <div><span className="badge over" style={{ marginTop: 4 }}>over</span></div>}</>
                          ) : <span className="muted">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* This supplier already has a framework for the project → its materials
            are reserved on it and read as "committed" on a normal PO. Route the
            user to the call-off flow instead of letting them fight the gate. */}
        {!frameworkId && !isFramework && category !== "prelims" && supplierFrameworks.length > 0 && (
          <div className="card" style={{ borderLeft: "4px solid var(--accent)", background: "var(--accent-soft)" }}>
            <div className="card-bd" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <b>{effectiveSupplier} has a framework order for this project.</b>
                <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>
                  Its materials are reserved on {supplierFrameworks.map((f) => f.po_number).join(", ")}, so they show as “committed” here. To order them, draw a <b>call-off</b> from the framework rather than raising a new PO on top.
                </div>
              </div>
              {supplierFrameworks.map((f) => (
                <button key={f.id} type="button" className="accent"
                  onClick={() => nav(`/projects/${projectId}/new-po?framework=${f.id}`)}>
                  Call off from {f.po_number} →
                </button>
              ))}
            </div>
          </div>
        )}

        {!frameworkId && supplier && !isCustomSupplier && category !== "prelims" && (
          <div className="card">
            <div className="card-hd">
              <h2 style={{ flex: 1 }}>
                Priced items <span className="muted" style={{ fontWeight: 400, fontFamily: "var(--font-sans)", fontSize: 13 }}>from {supplier}</span>
              </h2>
              <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 220 }} />
              <span className="muted">{pricedSelected.length} selected · {fmtMoney(pricedTotal)}</span>
            </div>
            {pricedForSupplier.length === 0 ? (
              <div className="card-bd"><div className="muted">
                No items priced for this job from {supplier}. Use the “Additional items” section below.
              </div></div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>
                      {(() => {
                        const all = pricedForSupplier.length > 0 && pricedForSupplier.every((m) => pricedRows.has(m.id));
                        const some = pricedForSupplier.some((m) => pricedRows.has(m.id));
                        return (
                          <input
                            type="checkbox"
                            aria-label="Select all priced items"
                            title={all ? "Clear all" : "Select all"}
                            checked={all}
                            ref={(el) => { if (el) el.indeterminate = !all && some; }}
                            onChange={toggleAllPriced}
                          />
                        );
                      })()}
                    </th>
                    <th>Item</th>
                    <th className="center">Type</th>
                    <th className="num">Pack cost</th>
                    <th className="center">Unit</th>
                    <th className="num">Priced</th>
                    <th className="num">Committed</th>
                    <th className="num">Remaining</th>
                    <th className="num" style={{ width: 110 }}>Order qty</th>
                    <th className="num">Line total</th>
                    {canSubstitute && <th className="center" style={{ width: 96 }}>Swap</th>}
                  </tr>
                </thead>
                <tbody>
                  {pricedForSupplier.map((m) => {
                    const row = pricedRows.get(m.id);
                    const subbed = isFullSub(m);
                    const displayItem = subbed ? (m.sub_item ?? m.item) : m.item;
                    // The price the PO will use: substitution / applied-quote price, else BOQ.
                    const displayCost = effectiveCost(m);
                    const unit = (subbed ? m.sub_unit : null) ?? m.total_units_unit ?? m.pack_unit ?? "ea";
                    const priced = m.total_units ?? 0;
                    const committed = m.committed_qty ?? 0;
                    const remaining = priced - committed;
                    const lineTotal = row ? row.qty * displayCost : 0;
                    const isOver = row && row.qty - remaining > 1e-4;
                    return (
                      <tr key={m.id} style={row ? { background: "var(--accent-soft)" } : undefined}>
                        <td><input type="checkbox" checked={!!row} onChange={() => toggleRow(m)} /></td>
                        <td>
                          {displayItem}
                          {subbed && (
                            <div className="muted" style={{ fontSize: 11, textDecoration: "line-through", marginTop: 2 }}>{m.item}</div>
                          )}
                          {subbed && <span className="pill approved" style={{ fontSize: 10, marginLeft: 6 }} title={m.sub_reason ?? "Substituted material — original allowance applies"}>Subbed</span>}
                        </td>
                        <td className="center">{m.type}</td>
                        <td className="num">
                          {m.cost != null && Math.abs(m.cost - displayCost) >= 0.005 ? (
                            <>
                              <div>{fmtMoney(displayCost)}</div>
                              <div className="muted" style={{ fontSize: 10, textDecoration: "line-through" }}>{fmtMoney(m.cost)}</div>
                            </>
                          ) : m.cost != null ? fmtMoney(m.cost) : <span className="muted">—</span>}
                        </td>
                        <td className="center">{unit}</td>
                        <td className="num">{fmtQty(priced)}</td>
                        <td className="num">{fmtQty(committed)}</td>
                        <td className="num">{fmtQty(remaining)}</td>
                        <td className="num">
                          {row ? (
                            <input
                              type="number" step="any" min={0}
                              value={row.qty || ""}
                              onChange={(e) => setPricedQty(m.id, Number(e.target.value))}
                              style={{ width: 90, textAlign: "right" }}
                            />
                          ) : <span className="muted">—</span>}
                        </td>
                        <td className="num">
                          {row ? (
                            <>
                              {fmtMoney(lineTotal)}
                              {isOver && <div><span className="badge over" style={{ marginTop: 4 }}>over</span></div>}
                            </>
                          ) : <span className="muted">—</span>}
                        </td>
                        {canSubstitute && (
                          <td className="center" style={{ whiteSpace: "nowrap" }}>
                            <SubstituteAction material={m} onChanged={reloadMats} />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* BOTTOM: additional items. Materials POs pick from the library;
            prelim POs add free-text cost lines tagged to a prelim type.
            Not shown for call-offs — those draw only from the framework. */}
        {!frameworkId && (supplier || isCustomSupplier) && (
          <div className="card">
            <div className="card-hd">
              <div className="grow">
                <h2 style={{ margin: 0 }}>{category === "prelims" ? "Prelim cost lines" : "Additional items"}</h2>
                <div className="muted" style={{ marginTop: 4 }}>
                  {category === "prelims"
                    ? "Prelim expenditure only — plant, site management, welfare, scaffold, etc. Each line is tagged to a prelim type."
                    : scopeSet.size > 0
                      ? `Anything not priced in the BOQ for this job — everything ${effectiveSupplier || "this supplier"} is approved to supply (elements ${supplierRecord!.approved_elements.join(", ")}), or custom.`
                      : "Anything not priced in the BOQ for this job — picked from the materials library, or custom."}
                </div>
              </div>
              <button type="button" className="ghost" onClick={addAdditional}>+ Add {category === "prelims" ? "prelim line" : "item"}</button>
            </div>
            <div className="card-bd">
              {additional.length === 0 ? (
                <div className="muted">None yet.</div>
              ) : (
                additional.map((row, idx) => (
                  <AdditionalRowEditor
                    key={row.key}
                    row={row}
                    idx={idx}
                    prelimMode={category === "prelims"}
                    prelimTypes={prelimOptions}
                    libraryTypes={libraryTypes}
                    library={libraryUnpriced}
                    onChange={(p) => updateAdditional(row.key, p)}
                    onPick={(v) => pickLibraryItem(row.key, v)}
                    onRemove={() => removeAdditional(row.key)}
                  />
                ))
              )}
            </div>
          </div>
        )}

        {/* OMISSIONS: credit a budgeted material you're no longer ordering, to
            cover a change to a different material — keeps the swap from double-
            counting against budget. Materials POs only; not for prelims/call-offs. */}
        {!frameworkId && category !== "prelims" && (supplier || isCustomSupplier) && (
          <div className="card">
            <div className="card-hd">
              <div className="grow">
                <h2 style={{ margin: 0 }}>Omissions / credits</h2>
                <div className="muted" style={{ marginTop: 4 }}>
                  Credit a budgeted material you're no longer ordering — e.g. to cover a change to a different material, so the swap doesn't double-count against the BOQ. Materials only.
                </div>
              </div>
              <select
                value=""
                onChange={(e) => { addOmission(e.target.value); e.currentTarget.value = ""; }}
                style={{ maxWidth: 340 }}
                disabled={omittableMaterials.length === 0}
                title={omittableMaterials.length === 0 ? "No priced materials on this job to credit" : "Pick a budgeted material to credit"}
              >
                <option value="">+ Omit a material…</option>
                {omittableMaterials.map((m) => (
                  <option key={m.id} value={String(m.id)}>
                    {m.item}{m.manufacturer ? ` — ${m.manufacturer}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="card-bd">
              {omissions.length === 0 ? (
                <div className="muted">None. Pick a material above to credit its allowance back.</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Material credited</th>
                      <th className="num">Qty omitted</th>
                      <th className="center">Unit</th>
                      <th className="num">Unit £</th>
                      <th className="num">Credit</th>
                      <th style={{ width: 32 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {omissions.map((o) => (
                      <tr key={o.key}>
                        <td>
                          {o.item}
                          {o.manufacturer && <div className="muted" style={{ fontSize: 11 }}>{o.manufacturer}</div>}
                        </td>
                        <td className="num">
                          <input type="number" step="any" min="0" value={o.qty}
                            onChange={(e) => updateOmission(o.key, { qty: Number(e.target.value) })}
                            style={{ width: 96, textAlign: "right" }} />
                        </td>
                        <td className="center">{o.unit}</td>
                        <td className="num">
                          <input type="number" step="any" min="0" value={o.unit_cost}
                            onChange={(e) => updateOmission(o.key, { unit_cost: Number(e.target.value) })}
                            style={{ width: 96, textAlign: "right" }} />
                        </td>
                        <td className="num" style={{ color: "#b91c1c", fontWeight: 600, whiteSpace: "nowrap" }}>
                          −{fmtMoney(o.qty * o.unit_cost)}
                        </td>
                        <td><button type="button" className="ghost tiny" onClick={() => removeOmission(o.key)}>×</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
          </div>

          {/* Right inspector ──────────────────────────────────────────────── */}
          <div className="inspector">
            <div className="card card-padded">
              <div className="stat">
                <div className="label">Running total</div>
                <div className="value">{fmtMoney(grandTotal)}</div>
                <div className="sub">
                  {pricedSelected.length + validAdditional.length + validOmissions.length} lines · ex VAT
                </div>
              </div>
              {(pricedTotal > 0 || additionalTotal > 0 || omissionTotal > 0) && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)", display: "grid", gap: 6 }}>
                  <Split label="Priced" value={fmtMoney(pricedTotal)} />
                  {additionalTotal > 0 && <Split label="Additional" value={fmtMoney(additionalTotal)} accent />}
                  {omissionTotal > 0 && <Split label="Omissions (credit)" value={`−${fmtMoney(omissionTotal)}`} />}
                </div>
              )}
            </div>

            {budget.priced > 0 && (
              <div className="card card-padded">
                <div className="eyebrow">Budget · {project.project.code}</div>
                <div className="bar" style={{ marginTop: 10 }}>
                  <div style={{ width: `${Math.min(100, (budget.committed / budget.priced) * 100)}%` }} />
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Now · {((budget.committed / budget.priced) * 100).toFixed(0)}% committed</div>
                <div className="bar" style={{ marginTop: 10 }}>
                  <div className="accent" style={{ width: `${Math.min(100, (projectedCommitted / budget.priced) * 100)}%` }} />
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  If submitted · {((projectedCommitted / budget.priced) * 100).toFixed(0)}% · {fmtMoney(Math.max(0, budget.priced - projectedCommitted))} left
                </div>
                {hasUnpricedAdditional && (
                  <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                    + {fmtMoney(unpricedAdditionalTotal)} in unpriced items (outside the BOQ)
                  </div>
                )}
              </div>
            )}

            <div className="card card-padded">
              <div className="eyebrow">Approval</div>
              {needsApproval ? (
                <>
                  <div style={{ marginTop: 8, fontSize: 14, fontWeight: 500 }}>
                    Goes to <b>{tierPreview}</b>
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    {hasUnpricedAdditional && (hasOver || additionalOver)
                      ? "Unpriced items + over allowance"
                      : hasUnpricedAdditional
                        ? "Contains items outside the BOQ"
                        : "Exceeds priced allowance"}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ marginTop: 8, fontSize: 14, fontWeight: 500 }}>Auto-approved</div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>All lines priced and within allowance</div>
                </>
              )}
            </div>
          </div>
        </div>
      </form>
      </main>
    </>
  );
}

function Split({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
      <span className="muted">{label}</span>
      <span className="num" style={accent ? { color: "var(--accent-2)" } : undefined}>{value}</span>
    </div>
  );
}

function AdditionalRowEditor({
  row, idx, prelimMode = false, prelimTypes = PRELIM_TYPES, libraryTypes, library, onChange, onPick, onRemove,
}: {
  row: AdditionalRow;
  idx: number;
  prelimMode?: boolean;
  prelimTypes?: string[];
  libraryTypes: string[];
  library: MaterialWithCommitment[];
  onChange: (p: Partial<AdditionalRow>) => void;
  onPick: (materialIdStr: string) => void;
  onRemove: () => void;
}) {
  const itemsInType = useMemo(
    () => library.filter((m) => !row.type || m.type === row.type),
    [library, row.type],
  );
  const autoFilled = row.source === "library" && row.material_id != null;

  return (
    <div
      style={{
        borderTop: idx === 0 ? "none" : "1px solid var(--line)",
        paddingTop: idx === 0 ? 0 : 20,
        marginTop: idx === 0 ? 0 : 20,
      }}
    >
      <div className="add-row">
        {/* Row 1: Type · Item · Manufacturer */}
        <div className="add-row-top">
          <div>
            <label>{prelimMode ? "Prelim type" : "Type"}</label>
            <select
              value={row.type}
              onChange={(e) =>
                onChange({
                  type: e.target.value,
                  material_id: null,
                  item: row.source === "library" ? "" : row.item,
                })
              }
              // In prelim mode the type drives the prelim category, so it stays
              // editable even though the item itself is a free-text description.
              disabled={!prelimMode && row.source === "custom"}
            >
              <option value="">— select —</option>
              {(prelimMode ? prelimTypes : libraryTypes).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label>Item</label>
            {row.source === "custom" ? (
              <input
                value={row.item}
                onChange={(e) => onChange({ item: e.target.value })}
                placeholder="Custom item description"
              />
            ) : (
              <select
                value={row.material_id ?? ""}
                onChange={(e) => onPick(e.target.value)}
                disabled={!row.type}
              >
                <option value="">{row.type ? "— select item —" : "Choose type first"}</option>
                {itemsInType.map((m) => (
                  <option key={m.id} value={m.id}>{m.item}</option>
                ))}
                <option value="__custom__">+ Custom item (not in database)…</option>
              </select>
            )}
          </div>
          <div>
            <label>Manufacturer</label>
            <input
              value={row.manufacturer}
              onChange={(e) => onChange({ manufacturer: e.target.value })}
              placeholder={autoFilled ? "" : "—"}
              readOnly={autoFilled}
            />
          </div>
        </div>

        {/* Row 2: Qty · Unit · Unit cost · Line total · Remove */}
        <div className="add-row-bottom">
          <div>
            <label>Qty</label>
            <input
              type="number"
              step="any"
              className="num"
              value={row.qty || ""}
              onChange={(e) => onChange({ qty: Number(e.target.value) })}
            />
          </div>
          <div>
            <label>Unit</label>
            <input
              value={row.unit}
              onChange={(e) => onChange({ unit: e.target.value })}
              placeholder="ea"
              readOnly={autoFilled}
            />
          </div>
          <div>
            <label>Unit cost (£)</label>
            <input
              type="number"
              step="0.01"
              className="num"
              value={row.unit_cost || ""}
              onChange={(e) => onChange({ unit_cost: Number(e.target.value) })}
              readOnly={autoFilled && !row.priced}
            />
          </div>
          <div>
            <label>Line total</label>
            <div className="line-total">{fmtMoney(row.qty * row.unit_cost)}</div>
          </div>
          <button
            type="button"
            className="ghost remove-btn"
            onClick={onRemove}
            title="Remove"
            aria-label="Remove item"
          >
            ×
          </button>
        </div>
      </div>
      <div style={{ marginTop: 6 }}>
        {row.priced ? (
          <>
            <span className="badge">in scope</span>{" "}
            <span className="muted">
              Priced in the BOQ{row.manufacturer ? ` under ${row.manufacturer}` : ""} — this supplier is approved to supply it, so it draws down that allowance. Check the price is right for them.
            </span>
          </>
        ) : (
          <>
            <span className="badge unpriced">unpriced</span>{" "}
            <span className="muted">
              {row.source === "library"
                ? "Item is in the materials library but wasn’t priced for this job — needs approval."
                : "Custom item — needs approval."}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
