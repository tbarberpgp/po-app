import { Hono } from "hono";
import type { Env, Variables } from "../env";
import type { CreatePOInput, POLine } from "../../shared/types";
import { loadSettings, tierForApproval } from "../approval";
import { learnAliases } from "../matchMemory";
import { emailApprovers, emailRequesterDecision, emailFrameworkOverdraw, FRAMEWORK_OVERDRAW_RECIPIENTS } from "../notify";
import { requirePermission } from "../auth";
import { buildCostCode, derivedProjectNumber } from "../../shared/types";
import { pushPOToXero } from "./xero";
import { isSandboxId } from "../sandbox";

export const pos = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Frameworks a call-off on this project may draw against — every framework
 * across the SITE GROUP, not just this block. A grouped site buys once for the
 * whole site (one framework) and calls material off per block, so limiting the
 * picker to the block's own frameworks made the correct call-off impossible:
 * people raised a fresh PO on whichever block they were looking at, and the
 * cost landed on the wrong contract.
 */
pos.get("/group/frameworks", async (c) => {
  const projectId = c.req.query("project_id");
  if (!projectId) return c.json([]);
  // Group membership resolved in SQL rather than via operations.siteScope —
  // importing that here creates a pos <-> operations import cycle.
  const rows = await c.env.DB.prepare(
    `SELECT po.id, po.po_number, po.supplier, po.project_id, p.code AS project_code
       FROM purchase_orders po JOIN projects p ON p.id = po.project_id
      WHERE po.order_type = 'framework' AND po.status != 'deleted'
        AND p.deleted_at IS NULL
        AND (p.id = ?1
             OR (p.site_group_id IS NOT NULL
                 AND p.site_group_id = (SELECT site_group_id FROM projects WHERE id = ?1)))
      ORDER BY po.created_at DESC`,
  ).bind(projectId).all<{ id: string; po_number: string; supplier: string; project_id: string; project_code: string }>();
  return c.json(rows.results);
});


/** Thrown by enrichPOLines for a bad line; handlers map it to a JSON error. */
class HttpError extends Error {
  constructor(public status: 400 | 404 | 409, message: string) { super(message); }
}

/** Add a PO's supplier to the approved-suppliers register if it isn't there
 *  already (matched case-insensitively). A merchant typed straight onto a PO
 *  becomes an approved supplier, so the register stays the single source of
 *  truth and the name resolves on future POs / Xero pushes. Best-effort: a
 *  failure here never blocks the PO. */
async function ensureApprovedSupplier(db: D1Database, name: string | null | undefined, actor: string | null): Promise<void> {
  const n = (name ?? "").trim();
  if (!n) return;
  try {
    const existing = await db.prepare("SELECT 1 AS x FROM suppliers WHERE lower(name) = lower(?) LIMIT 1").bind(n).first();
    if (existing) return;
    await db.prepare(
      "INSERT INTO suppliers (name, status, created_at, created_by) VALUES (?, 'approved', ?, ?) ON CONFLICT(name) DO NOTHING",
    ).bind(n, new Date().toISOString(), actor).run();
  } catch { /* never block PO creation on register upkeep */ }
}

/** A call-off line that draws a framework line past its actual remaining —
 *  on quantity, cost, or both — driving the immediate email alert. */
type FrameworkOverdraw = {
  item: string; unit: string;
  frameworkQty: number; drawnQty: number; overQty: boolean;
  frameworkValue: number; drawnValue: number; overValue: boolean;
};

type EnrichResult = {
  enriched: POLine[];
  total: number;
  hasUnpriced: boolean;
  hasOverBudget: boolean;
  prelimNeedsApproval: boolean;
  frameworkOverdraws: FrameworkOverdraw[];
};

/**
 * A framework line's actual remaining allowance, per item — on both qty and
 * cost, UNFLOORED so an already-overdrawn line comes back negative rather
 * than clamped to 0. Cost is tracked separately from qty because a call-off
 * can stay within the agreed qty but still blow the budget if its unit cost
 * is higher than the framework line's own (price rises, a different batch,
 * etc.) — qty alone would miss that. Used to gate new call-off draws; the
 * display endpoint (calloff-lines) floors qty at 0 separately for the picker
 * UI, which is fine since that's just presentation. `excludePoId` drops one
 * call-off (the one being edited) from the drawn tally so it doesn't count
 * against itself.
 */
async function frameworkRemainingByItem(
  db: D1Database,
  parentPoId: string,
  excludePoId: string | null,
): Promise<Map<string, { frameworkQty: number; remainingQty: number; frameworkValue: number; remainingValue: number }>> {
  const rows = await db.prepare(
    `SELECT lower(pl.item) AS item_key, pl.qty AS framework_qty, pl.line_total AS framework_value,
            COALESCE((
              SELECT SUM(cl.qty) FROM po_lines cl
              JOIN purchase_orders cp ON cp.id = cl.po_id
              WHERE cp.parent_po_id = ? AND cp.status IN ('approved','issued','pending_approval')
                AND lower(cl.item) = lower(pl.item)${excludePoId ? " AND cp.id != ?" : ""}
            ), 0) AS called_off_qty,
            COALESCE((
              SELECT SUM(cl.line_total) FROM po_lines cl
              JOIN purchase_orders cp ON cp.id = cl.po_id
              WHERE cp.parent_po_id = ? AND cp.status IN ('approved','issued','pending_approval')
                AND lower(cl.item) = lower(pl.item)${excludePoId ? " AND cp.id != ?" : ""}
            ), 0) AS called_off_value
       FROM po_lines pl WHERE pl.po_id = ?`,
  )
    .bind(...(excludePoId
      ? [parentPoId, excludePoId, parentPoId, excludePoId, parentPoId]
      : [parentPoId, parentPoId, parentPoId]))
    .all<{ item_key: string; framework_qty: number; framework_value: number; called_off_qty: number; called_off_value: number }>();
  const map = new Map<string, { frameworkQty: number; remainingQty: number; frameworkValue: number; remainingValue: number }>();
  for (const r of rows.results) {
    map.set(r.item_key, {
      frameworkQty: r.framework_qty ?? 0, remainingQty: (r.framework_qty ?? 0) - (r.called_off_qty ?? 0),
      frameworkValue: r.framework_value ?? 0, remainingValue: (r.framework_value ?? 0) - (r.called_off_value ?? 0),
    });
  }
  return map;
}

/** Real-time alert: a call-off just tipped one or more framework lines past
 *  their agreed qty and/or cost. Emails FRAMEWORK_OVERDRAW_RECIPIENTS. */
async function alertFrameworkOverdraw(
  env: Env,
  project: { id: string; code: string; name: string },
  frameworkPoId: string,
  triggeredByPoNumber: string,
  overdraws: FrameworkOverdraw[],
): Promise<void> {
  const fw = await env.DB.prepare("SELECT po_number, supplier FROM purchase_orders WHERE id = ?")
    .bind(frameworkPoId).first<{ po_number: string; supplier: string }>();
  if (!fw) return;
  await emailFrameworkOverdraw(env, FRAMEWORK_OVERDRAW_RECIPIENTS, {
    projectCode: project.code,
    projectName: project.name,
    frameworkPoNumber: fw.po_number,
    supplier: fw.supplier,
    triggeredByPoNumber,
    lines: overdraws,
    link: `${env.APP_BASE_URL ?? ""}/pos/${frameworkPoId}`,
  });
}

/**
 * Compute per-line approval flags (unpriced / over-budget), the order total and
 * prelim-heading overspend for a set of PO lines. Shared by PO create and the
 * admin edit path. `excludePoId` omits a PO from the committed-spend tally so an
 * edited PO doesn't count its own existing lines against budget. `parentPoId`
 * is the framework a call-off draws against — its lines gate on the framework's
 * actual remaining instead of the project BOQ allowance (see below).
 */
async function enrichPOLines(
  db: D1Database,
  project: { id: string; code: string },
  snap: { id: number } | null,
  lines: CreatePOInput["lines"],
  category: string | null | undefined,
  excludePoId: string | null,
  isCallOff = false,
  parentPoId: string | null = null,
): Promise<EnrichResult> {
  const enriched: POLine[] = [];
  let hasUnpriced = false;
  let hasOverBudget = false;
  let total = 0;

  // A call-off's real ceiling is the framework line's remaining, not the BOQ
  // allowance (see the skip below). Drawn per item as we walk the lines so two
  // lines on the same item in one call-off can't each pass against the same
  // pre-draw remaining and jointly overdraw it.
  const frameworkRemaining = isCallOff && parentPoId
    ? await frameworkRemainingByItem(db, parentPoId, excludePoId)
    : null;
  const drawnSoFar = new Map<string, { qty: number; value: number }>();
  const frameworkOverdraws: FrameworkOverdraw[] = [];

  for (const ln of lines) {
    // Reject non-finite / negative money inputs before they reach round2 — a
    // NaN/Infinity qty or unit_cost would otherwise be stored as the line total
    // and PO total_value, and mis-route approval tiering.
    if (!Number.isFinite(ln.qty) || !Number.isFinite(ln.unit_cost) || ln.qty < 0 || ln.unit_cost < 0) {
      throw new HttpError(400, `Invalid quantity or unit cost on line "${ln.item ?? ""}".`);
    }
    const lineTotal = round2(ln.qty * ln.unit_cost);
    let isUnpriced = ln.material_id == null;
    let isOverBudget = false;
    let pricedQty: number | null = null;
    let committedBefore: number | null = null;
    let manufacturer = ln.manufacturer ?? null;
    let type = ln.type ?? null;
    // The material id we'll actually store: re-pointed to the active snapshot's
    // matching row, or nulled when it can't be resolved (avoids a dangling FK).
    let resolvedMaterialId = ln.material_id;

    if (ln.material_id != null && snap) {
      let mat = await db.prepare(
        "SELECT id, item, type, manufacturer, total_units FROM materials WHERE id = ? AND snapshot_id = ?",
      )
        .bind(ln.material_id, snap.id)
        .first<{ id: number; item: string; type: string; manufacturer: string | null; total_units: number | null }>();
      // The id may belong to a superseded snapshot (the pricing workbook was
      // re-uploaded, re-minting material ids). Re-match by item name in the
      // active snapshot so the line still prices rather than blocking the edit.
      if (!mat && ln.item) {
        mat = await db.prepare(
          "SELECT id, item, type, manufacturer, total_units FROM materials WHERE snapshot_id = ? AND lower(item) = lower(?) LIMIT 1",
        )
          .bind(snap.id, ln.item)
          .first<{ id: number; item: string; type: string; manufacturer: string | null; total_units: number | null }>();
      }
      if (!mat) {
        // No match even by name — treat as a historical/unpriced line (priced by
        // its own cost) rather than rejecting the whole PO. Null the id so the
        // stored line can't dangle against a material that isn't there.
        isUnpriced = true;
        resolvedMaterialId = null;
      } else {
        resolvedMaterialId = mat.id;
        manufacturer = manufacturer ?? mat.manufacturer;
        type = type ?? mat.type;
        // Allowance is in pack units (col V) — same dimension as the PO qty.
        pricedQty = mat.total_units;

        // Other live POs' committed qty for this item; an edited PO excludes its
        // own existing lines so they aren't double-counted. Call-offs are excluded
        // too — a framework reserves the allowance and its call-offs draw within it.
        const committedRow = await db.prepare(
          `SELECT COALESCE(SUM(pl.qty), 0) AS q
             FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
            WHERE po.project_id = ? AND po.status IN ('approved','issued','pending_approval')
              AND COALESCE(po.order_type, 'standard') != 'call_off'
              AND lower(pl.item) = lower(?) AND pl.is_unpriced = 0${excludePoId ? " AND po.id != ?" : ""}`,
        )
          .bind(...(excludePoId ? [project.id, mat.item, excludePoId] : [project.id, mat.item]))
          .first<{ q: number }>();
        committedBefore = committedRow?.q ?? 0;

        // A call-off draws within its framework's existing reservation, so it never
        // trips the BOQ over-budget gate — its ceiling is the framework's remaining
        // (validated against the parent on create), not the materials allowance.
        if (pricedQty == null || pricedQty === 0) isUnpriced = true;
        else if (!isCallOff && committedBefore + ln.qty > pricedQty + 1e-4) isOverBudget = true;
      }
    }

    // The actual write-time gate for a call-off: draw against the framework
    // line's real remaining qty AND value (unfloored — an already-overdrawn
    // line reads negative here, not 0), not a post-hoc display number. Value
    // is checked separately from qty because a call-off can stay within the
    // agreed qty but still blow the budget on a higher unit cost. An item
    // with no matching framework line is left alone — different problem.
    if (frameworkRemaining) {
      const key = (ln.item ?? "").toLowerCase();
      const fw = frameworkRemaining.get(key);
      if (fw != null) {
        const drawnBefore = drawnSoFar.get(key) ?? { qty: 0, value: 0 };
        const drawnQtyTotal = drawnBefore.qty + ln.qty;
        const drawnValueTotal = drawnBefore.value + lineTotal;
        const overQty = drawnQtyTotal > fw.remainingQty + 1e-4;
        const overValue = drawnValueTotal > fw.remainingValue + 0.005;
        if (overQty || overValue) {
          isOverBudget = true;
          // Total now drawn against this framework line = what other
          // call-offs already hold (frameworkQty - remaining) plus this
          // call-off's own running total against the same item.
          frameworkOverdraws.push({
            item: ln.item, unit: ln.unit,
            frameworkQty: fw.frameworkQty, drawnQty: fw.frameworkQty - fw.remainingQty + drawnQtyTotal, overQty,
            frameworkValue: fw.frameworkValue, drawnValue: fw.frameworkValue - fw.remainingValue + drawnValueTotal, overValue,
          });
        }
        drawnSoFar.set(key, { qty: drawnQtyTotal, value: drawnValueTotal });
      }
    }

    if (isUnpriced) hasUnpriced = true;
    if (isOverBudget) hasOverBudget = true;

    total += lineTotal;
    enriched.push({
      material_id: resolvedMaterialId, item: ln.item, type, manufacturer,
      qty: ln.qty, unit: ln.unit, unit_cost: ln.unit_cost, line_total: lineTotal,
      is_unpriced: isUnpriced, is_over_budget: isOverBudget,
      priced_qty_at_order: pricedQty, committed_before: committedBefore,
    });
  }

  total = round2(total);

  // Prelim POs: each line is tagged to a prelim heading (line.type) with a budget
  // in the materials list. Spend that takes a heading over budget — or on an
  // unbudgeted heading — needs sign-off; budgeted within-budget spend auto-approves.
  let prelimNeedsApproval = false;
  if (category === "prelims" && !isCallOff) {
    const byHeading = new Map<string, number>();
    for (const e of enriched) byHeading.set((e.type ?? "").trim(), (byHeading.get((e.type ?? "").trim()) ?? 0) + e.line_total);
    for (const [heading, lineSum] of byHeading) {
      const budgetRow = heading
        ? await db.prepare(
            `SELECT COALESCE(SUM(m.material_total_cost), 0) AS budget
               FROM materials m
               JOIN material_snapshots s ON s.id = m.snapshot_id
               LEFT JOIN elements e ON e.code = m.element_code
              WHERE s.project_id = ? AND s.is_active = 1 AND lower(m.item) = lower(?)
                AND (lower(COALESCE(e.name, '')) LIKE '%prelim%' OR lower(COALESCE(m.type, '')) LIKE '%prelim%')`,
          ).bind(project.id, heading).first<{ budget: number }>()
        : null;
      const budget = budgetRow?.budget ?? 0;
      const committedRow = await db.prepare(
        `SELECT COALESCE(SUM(pl.line_total), 0) AS c
           FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
          WHERE po.project_id = ? AND po.category = 'prelims'
            AND po.status IN ('approved','issued','pending_approval')
            AND COALESCE(po.order_type, 'standard') != 'call_off'
            AND lower(pl.type) = lower(?)${excludePoId ? " AND po.id != ?" : ""}`,
      ).bind(...(excludePoId ? [project.id, heading, excludePoId] : [project.id, heading])).first<{ c: number }>();
      const committed = committedRow?.c ?? 0;
      if (budget <= 0 || committed + lineSum > budget + 0.005) {
        prelimNeedsApproval = true;
        for (const e of enriched) if ((e.type ?? "").trim() === heading) e.is_over_budget = true;
      }
    }
  }

  return { enriched, total, hasUnpriced, hasOverBudget, prelimNeedsApproval, frameworkOverdraws };
}

pos.get("/", async (c) => {
  const projectId = c.req.query("project_id");
  const status = c.req.query("status");
  const includeDeleted = c.req.query("include_deleted") === "1";
  // Deleted POs are hidden by default everywhere; superadmins can pass
  // ?include_deleted=1 if we ever build a "Deleted POs" view.
  const where: string[] = [];
  const binds: unknown[] = [];
  if (projectId) {
    where.push("po.project_id = ?");
    binds.push(projectId);
  }
  if (status) {
    where.push("po.status = ?");
    binds.push(status);
  }
  if (!includeDeleted) where.push("po.status != 'deleted'");
  // POs of deleted projects also vanish from every list.
  where.push("p.deleted_at IS NULL");
  const sql = `SELECT po.*, p.code AS project_code, p.name AS project_name,
      -- Framework rows only: any of its own lines currently overdrawn on qty
      -- or cost by its live call-offs — flags the PO row itself in the list
      -- (POsList badges it next to the PO number), not just the line detail.
      CASE WHEN po.order_type = 'framework' AND EXISTS (
        SELECT 1 FROM po_lines pl
         WHERE pl.po_id = po.id
           AND (
             pl.qty < (
               SELECT COALESCE(SUM(cl.qty), 0) FROM po_lines cl
                 JOIN purchase_orders cp ON cp.id = cl.po_id
                WHERE cp.parent_po_id = po.id AND cp.status IN ('approved','issued','pending_approval')
                  AND lower(cl.item) = lower(pl.item)
             ) - 0.0001
             OR pl.line_total < (
               SELECT COALESCE(SUM(cl.line_total), 0) FROM po_lines cl
                 JOIN purchase_orders cp ON cp.id = cl.po_id
                WHERE cp.parent_po_id = po.id AND cp.status IN ('approved','issued','pending_approval')
                  AND lower(cl.item) = lower(pl.item)
             ) - 0.005
           )
      ) THEN 1 ELSE 0 END AS is_overdrawn
     FROM purchase_orders po
     JOIN projects p ON p.id = po.project_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY po.created_at DESC`;
  const rows = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all();
  return c.json(rows.results);
});

pos.get("/:id", async (c) => {
  const id = c.req.param("id");
  const po = await c.env.DB.prepare(
    `SELECT po.*,
            p.code AS project_code,
            p.name AS project_name,
            p.delivery_address      AS project_delivery_address,
            p.site_contact_name     AS project_site_contact_name,
            p.site_contact_phone    AS project_site_contact_phone,
            p.delivery_instructions AS project_delivery_instructions
     FROM purchase_orders po
     JOIN projects p ON p.id = po.project_id
     WHERE po.id = ? AND p.deleted_at IS NULL`,
  )
    .bind(id)
    .first();
  if (!po) return c.json({ error: "not found" }, 404);

  // Heal POs stranded in pending_approval without a tier (retro POs raised
  // from invoices before tiering was wired in): apply the same value-band
  // rule used at creation so the approve flow can proceed.
  const poRec = po as Record<string, unknown>;
  if (poRec.status === "pending_approval" && Number(poRec.requires_approval) === 1 && poRec.approval_tier == null) {
    const settings = await loadSettings(c.env.DB);
    const tier = tierForApproval(Number(poRec.total_value ?? 0), false, settings);
    await c.env.DB.prepare(
      "UPDATE purchase_orders SET approval_tier = ? WHERE id = ? AND approval_tier IS NULL",
    ).bind(tier, id).run();
    poRec.approval_tier = tier;
  }

  // Pull product → element joins so we can derive the PRJ.ELE.RES cost code
  // for any line whose material links to a master product.
  const lines = await c.env.DB.prepare(
    `SELECT pl.*,
            m.product_id        AS link_product_id,
            pr.element_code     AS link_element_code,
            pr.default_resource AS link_default_resource
     FROM po_lines pl
     LEFT JOIN materials m  ON m.id = pl.material_id
     LEFT JOIN products  pr ON pr.id = m.product_id
     WHERE pl.po_id = ?
     ORDER BY pl.id`,
  )
    .bind(id)
    .all<Record<string, unknown> & {
      link_element_code: string | null;
      link_default_resource: string | null;
    }>();

  const projectCode = po.project_code as string;
  const projectNumber = derivedProjectNumber(projectCode);

  // For a framework order, show how much of each line has already been drawn
  // down by its live call-offs — matched by item description, the same rule the
  // call-off draw-down form uses (see /:id/calloff-lines). Value is tracked
  // alongside qty since a call-off can stay within the agreed qty but still
  // blow the budget on a higher unit cost.
  let drawByItem: Map<string, { qty: number; value: number }> | null = null;
  if (po.order_type === "framework") {
    const draw = await c.env.DB.prepare(
      `SELECT lower(cl.item) AS item_key, SUM(cl.qty) AS called_off_qty, SUM(cl.line_total) AS called_off_value
         FROM po_lines cl JOIN purchase_orders cp ON cp.id = cl.po_id
        WHERE cp.parent_po_id = ? AND cp.status IN ('approved','issued','pending_approval')
        GROUP BY lower(cl.item)`,
    ).bind(id).all<{ item_key: string; called_off_qty: number; called_off_value: number }>();
    drawByItem = new Map(draw.results.map((r) => [r.item_key, { qty: r.called_off_qty ?? 0, value: r.called_off_value ?? 0 }]));
  }

  const enriched = lines.results.map((l) => {
    const cost_code =
      l.link_element_code
        ? buildCostCode(projectNumber, l.link_element_code, l.link_default_resource ?? "M")
        : null;
    // SQLite stores these as 0/1 — surface real booleans so the client doesn't
    // render a stray "0" via `{flag && …}`.
    const base = { ...l, cost_code, is_unpriced: !!l.is_unpriced, is_over_budget: !!l.is_over_budget };
    if (drawByItem) {
      const drawn = drawByItem.get(String(l.item ?? "").toLowerCase()) ?? { qty: 0, value: 0 };
      const qty = Number(l.qty ?? 0);
      const value = Number(l.line_total ?? 0);
      // Unfloored — an overdrawn line shows the true (negative) shortfall
      // instead of a "0 remaining" that reads identically to fully-drawn.
      // The call-off draw-down picker (calloff-lines) floors its own copy at
      // 0 separately, since that one caps what a new call-off can enter.
      return {
        ...base,
        called_off_qty: drawn.qty, available_qty: qty - drawn.qty,
        called_off_value: drawn.value, available_value: value - drawn.value,
      };
    }
    return base;
  });

  // Framework drawdown (its call-offs) / call-off parent context.
  let call_offs:
    | Array<{ id: string; po_number: string; status: string; total_value: number; created_at: string }>
    | undefined;
  let parent: { id: string; po_number: string } | null | undefined;
  if (po.order_type === "framework") {
    const kids = await c.env.DB.prepare(
      `SELECT id, po_number, status, total_value, created_at
         FROM purchase_orders WHERE parent_po_id = ? AND status != 'deleted'
        ORDER BY created_at`,
    ).bind(id).all<{ id: string; po_number: string; status: string; total_value: number; created_at: string }>();
    call_offs = kids.results;
  } else if (po.order_type === "call_off" && po.parent_po_id) {
    parent = await c.env.DB.prepare("SELECT id, po_number FROM purchase_orders WHERE id = ?")
      .bind(po.parent_po_id).first<{ id: string; po_number: string }>();
  }

  return c.json({ ...po, requires_approval: !!po.requires_approval, lines: enriched, call_offs, parent });
});

/**
 * Draw-down view for raising a call-off: the parent framework's own line items,
 * each with how much is still available to call off (framework qty − the qty
 * already called off across its live call-offs). The call-off form picks from
 * these, not from the project BOQ.
 */
pos.get("/:id/calloff-lines", async (c) => {
  const id = c.req.param("id");
  const fw = await c.env.DB.prepare(
    "SELECT id, po_number, supplier, order_type FROM purchase_orders WHERE id = ? AND status != 'deleted'",
  ).bind(id).first<{ id: string; po_number: string; supplier: string; order_type: string | null }>();
  if (!fw) return c.json({ error: "framework not found" }, 404);

  const rows = await c.env.DB.prepare(
    `SELECT pl.material_id, pl.item, pl.manufacturer, pl.type, pl.unit, pl.unit_cost,
            pl.qty AS framework_qty,
            COALESCE((
              SELECT SUM(cl.qty) FROM po_lines cl JOIN purchase_orders cp ON cp.id = cl.po_id
               WHERE cp.parent_po_id = ? AND cp.status IN ('approved','issued','pending_approval')
                 AND lower(cl.item) = lower(pl.item)
            ), 0) AS called_off_qty
       FROM po_lines pl WHERE pl.po_id = ? ORDER BY pl.id`,
  ).bind(id, id).all<{
    material_id: number | null; item: string; manufacturer: string | null; type: string | null;
    unit: string; unit_cost: number; framework_qty: number; called_off_qty: number;
  }>();

  const lines = rows.results.map((r) => ({
    ...r,
    available_qty: Math.max(0, (r.framework_qty ?? 0) - (r.called_off_qty ?? 0)),
  }));
  return c.json({
    framework: { id: fw.id, po_number: fw.po_number, supplier: fw.supplier, order_type: fw.order_type },
    lines,
  });
});

pos.post("/", async (c) => {
  const denied = requirePermission(c, "pos.create");
  if (denied) return denied;
  const body = await c.req.json<CreatePOInput>();
  const actor = c.get("userEmail");
  if (!body.project_id || !body.supplier || !body.lines?.length) {
    return c.json({ error: "project_id, supplier and at least one line are required" }, 400);
  }

  const project = await c.env.DB.prepare(
    "SELECT id, code, name FROM projects WHERE id = ?",
  )
    .bind(body.project_id)
    .first<{ id: string; code: string; name: string }>();
  if (!project) return c.json({ error: "project not found" }, 404);

  const snap = await c.env.DB.prepare(
    "SELECT id FROM material_snapshots WHERE project_id = ? AND is_active = 1",
  )
    .bind(project.id)
    .first<{ id: number }>();

  // Per-line approval flags, order total and prelim-overspend (shared with edit).
  const creatingCallOff = !!body.parent_po_id || body.order_type === "call_off";
  // A call-off inherits its framework's budget coding: uncoded lines pick up the
  // parent line's material_id (matched by item wording) so a call-off from a
  // coded framework never re-flags as "unpriced". enrichPOLines still re-resolves
  // the id against the active snapshot, so a stale parent id can't dangle.
  if (creatingCallOff && body.parent_po_id) {
    const pls = await c.env.DB.prepare("SELECT lower(item) AS k, material_id FROM po_lines WHERE po_id = ?")
      .bind(body.parent_po_id).all<{ k: string; material_id: number | null }>();
    const codeByItem = new Map(pls.results.filter((r) => r.material_id != null).map((r) => [r.k, r.material_id]));
    for (const ln of body.lines) {
      if (ln.material_id == null && ln.item) ln.material_id = codeByItem.get(ln.item.toLowerCase()) ?? null;
    }
  }
  let enrichRes: EnrichResult;
  try {
    enrichRes = await enrichPOLines(c.env.DB, project, snap, body.lines, body.category, null, creatingCallOff, body.parent_po_id ?? null);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }
  const { enriched, total, hasUnpriced, hasOverBudget, prelimNeedsApproval, frameworkOverdraws } = enrichRes;

  // A variation carries NEW budget that must be signed off before it can be
  // expended. Block linking a PO to a variation that isn't approved yet.
  if (body.variation_id != null) {
    const v = await c.env.DB.prepare(
      "SELECT approved_at FROM variations WHERE id = ?",
    ).bind(body.variation_id).first<{ approved_at: string | null }>();
    if (!v) return c.json({ error: "variation not found" }, 400);
    if (!v.approved_at) {
      return c.json({ error: "This variation is awaiting approval — its budget can't be expended yet." }, 409);
    }
  }

  // Prelim POs are gated on prelim-heading overspend (budgeted, within-budget
  // prelim spend auto-approves); material POs gate on unpriced / over-budget.
  const isPrelim = body.category === "prelims";
  const requiresApproval = isPrelim ? prelimNeedsApproval : (hasUnpriced || hasOverBudget);
  const settings = await loadSettings(c.env.DB);
  const tier = requiresApproval ? tierForApproval(total, isPrelim ? false : hasUnpriced, settings) : null;
  const reason = !requiresApproval
    ? null
    : isPrelim
      ? "over_budget"
      : hasUnpriced && hasOverBudget
        ? "both"
        : hasUnpriced
          ? "unpriced"
          : "over_budget";

  const status = requiresApproval ? "pending_approval" : "approved";
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  // Call-offs take their framework's number plus a -C index so the link is
  // visible everywhere (Xero, PDFs); a flagged-but-unlinked call-off, or a
  // missing parent, falls back to the flat per-project sequence.
  const poNumber = body.parent_po_id
    ? (await nextCallOffNumber(c.env.DB, body.parent_po_id)) ?? (await nextPONumber(c.env.DB, project.code))
    : await nextPONumber(c.env.DB, project.code);
  const approvedAt = requiresApproval ? null : now;
  const approvedBy = requiresApproval ? null : "auto";
  // Call-offs draw against a framework PO (parent_po_id), or can be flagged
  // explicitly via the call-off toggle even without a linked framework.
  const orderType =
    body.parent_po_id ? "call_off"
    : body.order_type === "framework" ? "framework"
    : body.order_type === "call_off" ? "call_off"
    : "standard";
  // Prelim-tagged POs expend the Preliminaries budget instead of materials.
  const category = body.category === "prelims" ? "prelims" : "materials";

  await c.env.DB.prepare(
    `INSERT INTO purchase_orders
       (id, po_number, project_id, supplier, status, requires_approval,
        approval_tier, approval_reason, total_value, notes, delivery_date,
        created_at, created_by, approved_at, approved_by, variation_id,
        order_type, parent_po_id, category)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      poNumber,
      project.id,
      body.supplier,
      status,
      requiresApproval ? 1 : 0,
      tier,
      reason,
      total,
      body.notes ?? null,
      body.delivery_date ?? null,
      now,
      actor,
      approvedAt,
      approvedBy,
      body.variation_id ?? null,
      orderType,
      body.parent_po_id ?? null,
      category,
    )
    .run();

  // A custom supplier typed onto the PO joins the approved-suppliers register.
  await ensureApprovedSupplier(c.env.DB, body.supplier, actor);

  await c.env.DB.batch(
    enriched.map((ln) =>
      c.env.DB.prepare(
        `INSERT INTO po_lines
           (po_id, material_id, item, type, manufacturer, qty, unit, unit_cost,
            line_total, is_unpriced, is_over_budget, priced_qty_at_order, committed_before)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        ln.material_id,
        ln.item,
        ln.type,
        ln.manufacturer,
        ln.qty,
        ln.unit,
        ln.unit_cost,
        ln.line_total,
        ln.is_unpriced ? 1 : 0,
        ln.is_over_budget ? 1 : 0,
        ln.priced_qty_at_order,
        ln.committed_before,
      ),
    ),
  );

  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('po', ?, 'created', ?, ?, ?)`,
  )
    .bind(id, actor, JSON.stringify({ po_number: poNumber, status, total }), now)
    .run();

  if (frameworkOverdraws.length && body.parent_po_id && !isSandboxId(project.id)) {
    c.executionCtx.waitUntil(
      alertFrameworkOverdraw(c.env, project, body.parent_po_id, poNumber, frameworkOverdraws)
        .catch((e) => console.warn("framework overdraw alert failed", e instanceof Error ? e.message : e)),
    );
  }

  if (requiresApproval && tier && !isSandboxId(project.id)) {
    const approvers = await c.env.DB.prepare(
      `SELECT email, name FROM approvers
       WHERE tier = ? AND (project_id = ? OR project_id IS NULL)
       ORDER BY project_id IS NULL`,
    )
      .bind(tier, project.id)
      .all<{ email: string; name: string | null }>();
    c.executionCtx.waitUntil(
      emailApprovers(
        c.env,
        {
          id,
          po_number: poNumber,
          project_id: project.id,
          supplier: body.supplier,
          status: "pending_approval",
          requires_approval: true,
          approval_tier: tier,
          approval_reason: reason,
          total_value: total,
          notes: body.notes ?? null,
          delivery_date: body.delivery_date ?? null,
          created_at: now,
          created_by: actor,
          approved_at: null,
          approved_by: null,
          rejected_at: null,
          rejected_by: null,
          rejection_reason: null,
          issued_at: null,
          lines: enriched,
        },
        { code: project.code, name: project.code },
        approvers.results,
      ),
    );
  }

  // Auto-approved POs (priced + within budget, no approval gate) still need to
  // land in Xero. The approve hook covers approval-gated POs; this covers the
  // rest — otherwise every PO that doesn't need sign-off silently never posts.
  // Best-effort: failures are recorded on the PO row (xero_sync_status='failed')
  // and surfaced in the PO view; the PO itself is unaffected. A PO follows
  // exactly one path (auto-approved here, or pending→approve), so it never
  // double-pushes.
  if (!requiresApproval && c.env.XERO_CLIENT_ID && c.env.XERO_CLIENT_SECRET) {
    c.executionCtx.waitUntil(
      pushPOToXero(c.env, id).catch((e) =>
        console.warn("Xero auto-push (on create) failed", e instanceof Error ? e.message : e),
      ),
    );
  }

  return c.json({ id, po_number: poNumber, status, requires_approval: requiresApproval });
});

/**
 * Edit an existing PO — header + line items. Admin / superadmin only. Preserves
 * the workflow status (an amend doesn't bounce an approved/issued PO back to
 * pending), recomputes totals + approval flags, writes an audit entry, and
 * re-syncs a Xero-linked PO in place.
 */
pos.put("/:id", async (c) => {
  const denied = requirePermission(c, "pos.edit");
  if (denied) return denied;
  const id = c.req.param("id");
  const actor = c.get("userEmail");
  const body = await c.req.json<{
    supplier: string;
    notes?: string | null;
    delivery_date?: string | null;
    category?: "materials" | "prelims";
    lines: CreatePOInput["lines"];
  }>();
  if (!body.supplier || !body.lines?.length) {
    return c.json({ error: "supplier and at least one line are required" }, 400);
  }

  const existing = await c.env.DB.prepare(
    `SELECT po.*, p.code AS project_code, p.name AS project_name
       FROM purchase_orders po JOIN projects p ON p.id = po.project_id
      WHERE po.id = ? AND p.deleted_at IS NULL`,
  ).bind(id).first<{
    id: string; project_id: string; project_code: string; project_name: string; status: string;
    category: string | null; order_type: string | null; xero_po_id: string | null;
    parent_po_id: string | null; po_number: string;
  }>();
  if (!existing) return c.json({ error: "not found" }, 404);
  if (existing.status === "deleted") return c.json({ error: "Can't edit a deleted PO" }, 409);

  const project = { id: existing.project_id, code: existing.project_code, name: existing.project_name };
  const snap = await c.env.DB.prepare(
    "SELECT id FROM material_snapshots WHERE project_id = ? AND is_active = 1",
  ).bind(project.id).first<{ id: number }>();

  // Category: explicit from the form, else keep what the PO already had.
  const category: "materials" | "prelims" =
    body.category === "prelims" ? "prelims"
    : body.category === "materials" ? "materials"
    : existing.category === "prelims" ? "prelims" : "materials";

  let enrichRes: EnrichResult;
  try {
    enrichRes = await enrichPOLines(c.env.DB, project, snap, body.lines, category, id, existing.order_type === "call_off", existing.parent_po_id);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }
  const { enriched, total, hasUnpriced, hasOverBudget, prelimNeedsApproval, frameworkOverdraws } = enrichRes;

  const isPrelim = category === "prelims";
  const requiresApproval = isPrelim ? prelimNeedsApproval : (hasUnpriced || hasOverBudget);
  const settings = await loadSettings(c.env.DB);
  const tier = requiresApproval ? tierForApproval(total, isPrelim ? false : hasUnpriced, settings) : null;
  const reason = !requiresApproval ? null
    : isPrelim ? "over_budget"
    : hasUnpriced && hasOverBudget ? "both"
    : hasUnpriced ? "unpriced" : "over_budget";
  const now = new Date().toISOString();

  // Header — status / approved-by / issued-at deliberately untouched.
  await c.env.DB.prepare(
    `UPDATE purchase_orders
        SET supplier = ?, total_value = ?, notes = ?, delivery_date = ?,
            requires_approval = ?, approval_tier = ?, approval_reason = ?, category = ?
      WHERE id = ?`,
  ).bind(
    body.supplier, total, body.notes ?? null, body.delivery_date ?? null,
    requiresApproval ? 1 : 0, tier, reason, category, id,
  ).run();

  // A changed/custom supplier joins the approved-suppliers register.
  await ensureApprovedSupplier(c.env.DB, body.supplier, c.get("userEmail"));

  // Replace the lines wholesale.
  await c.env.DB.prepare("DELETE FROM po_lines WHERE po_id = ?").bind(id).run();
  await c.env.DB.batch(
    enriched.map((ln) =>
      c.env.DB.prepare(
        `INSERT INTO po_lines
           (po_id, material_id, item, type, manufacturer, qty, unit, unit_cost,
            line_total, is_unpriced, is_over_budget, priced_qty_at_order, committed_before)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id, ln.material_id, ln.item, ln.type, ln.manufacturer, ln.qty, ln.unit,
        ln.unit_cost, ln.line_total, ln.is_unpriced ? 1 : 0, ln.is_over_budget ? 1 : 0,
        ln.priced_qty_at_order, ln.committed_before,
      ),
    ),
  );

  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('po', ?, 'edited', ?, ?, ?)`,
  ).bind(id, actor, JSON.stringify({ total, lines: enriched.length }), now).run();

  if (frameworkOverdraws.length && existing.parent_po_id && !isSandboxId(project.id)) {
    c.executionCtx.waitUntil(
      alertFrameworkOverdraw(c.env, project, existing.parent_po_id, existing.po_number, frameworkOverdraws)
        .catch((e) => console.warn("framework overdraw alert failed", e instanceof Error ? e.message : e)),
    );
  }

  // Keep the linked Xero PO in step — updates in place (no duplicate). Inline so
  // the editor sees whether the re-sync succeeded.
  let xero: { ok: boolean; error?: string } | undefined;
  if (existing.xero_po_id && c.env.XERO_CLIENT_ID && c.env.XERO_CLIENT_SECRET) {
    try { await pushPOToXero(c.env, id); xero = { ok: true }; }
    catch (e) { xero = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }

  return c.json({ id, total, requires_approval: requiresApproval, xero });
});

/** Mark a standard PO as a framework/blanket order that call-offs draw against. */
pos.post("/:id/make-framework", async (c) => {
  const denied = requirePermission(c, "pos.create");
  if (denied) return denied;
  const id = c.req.param("id");
  const po = await c.env.DB.prepare("SELECT order_type, parent_po_id FROM purchase_orders WHERE id = ?")
    .bind(id).first<{ order_type: string; parent_po_id: string | null }>();
  if (!po) return c.json({ error: "not found" }, 404);
  if (po.parent_po_id) return c.json({ error: "a call-off can't be a framework" }, 409);
  if (po.order_type === "framework") return c.json({ ok: true });
  await c.env.DB.prepare("UPDATE purchase_orders SET order_type = 'framework' WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

/** Mark/unmark a PO as "arriving in parts" — ordered as one drop but the
 *  supplier is delivering it piecemeal, so partial receipts are expected. */
pos.post("/:id/part-delivery", async (c) => {
  const denied = requirePermission(c, "pos.create");
  if (denied) return denied;
  let body: { part_delivery?: boolean } = {};
  try { body = await c.req.json(); } catch { /* bare call = toggle */ }
  const po = await c.env.DB.prepare("SELECT id, part_delivery FROM purchase_orders WHERE id = ? AND status != 'deleted'")
    .bind(c.req.param("id")).first<{ id: string; part_delivery: number }>();
  if (!po) return c.json({ error: "not found" }, 404);
  const next = body.part_delivery != null ? (body.part_delivery ? 1 : 0) : (po.part_delivery ? 0 : 1);
  await c.env.DB.prepare("UPDATE purchase_orders SET part_delivery = ? WHERE id = ?").bind(next, po.id).run();
  return c.json({ ok: true, part_delivery: !!next });
});

/** Tag a PO's cost category — 'prelims' expends the Preliminaries budget. */
pos.post("/:id/category", async (c) => {
  const denied = requirePermission(c, "pos.create");
  if (denied) return denied;
  const body = await c.req.json<{ category?: string }>().catch(() => ({} as { category?: string }));
  const category = body.category === "prelims" ? "prelims" : "materials";
  await c.env.DB.prepare("UPDATE purchase_orders SET category = ? WHERE id = ?").bind(category, c.req.param("id")).run();
  return c.json({ ok: true, category });
});

pos.get("/:id/activity", async (c) => {
  const id = c.req.param("id");
  const rows = await c.env.DB.prepare(
    `SELECT id, action, actor, details, created_at
     FROM audit_log
     WHERE entity_type = 'po' AND entity_id = ?
     ORDER BY created_at ASC`,
  )
    .bind(id)
    .all<{ id: number; action: string; actor: string; details: string | null; created_at: string }>();
  return c.json(rows.results);
});

/** Coding a framework cascades to its call-offs: the framework line is the
 *  budget truth and call-off lines mirror it (matched by item wording — the
 *  same match the drawdown availability query uses), so coding the main PO
 *  once clears the "unpriced / assign to budget" nag across the family.
 *  Mirrors clears too (materialId null) so the framework stays authoritative. */
async function cascadeFrameworkCoding(db: D1Database, frameworkId: string, items: string[], materialId: number | null): Promise<number> {
  const keys = [...new Set(items.map((s) => s.toLowerCase()))].filter(Boolean);
  if (!keys.length) return 0;
  const ph = keys.map(() => "?").join(",");
  const res = await db.prepare(
    `UPDATE po_lines SET material_id = ?
      WHERE lower(item) IN (${ph})
        AND po_id IN (SELECT id FROM purchase_orders WHERE parent_po_id = ? AND status != 'deleted')`,
  ).bind(materialId, ...keys, frameworkId).run();
  return res.meta.changes ?? 0;
}

/** Code EVERY line of a PO to one budget line — whole-order coding for a
 *  retrospective PO that is all one cost (e.g. a fixings invoice against a
 *  single ancillary budget line). Same rules as the per-line endpoint. */
pos.post("/:id/assign-budget", async (c) => {
  const denied = requirePermission(c, "pos.edit");
  if (denied) return denied;
  const id = c.req.param("id");
  const body = await c.req.json<{ material_id?: number | null }>().catch(() => ({} as { material_id?: number | null }));
  const po = await c.env.DB.prepare("SELECT id, project_id, status, supplier, order_type FROM purchase_orders WHERE id = ?")
    .bind(id).first<{ id: string; project_id: string; status: string; supplier: string | null; order_type: string | null }>();
  if (!po) return c.json({ error: "not found" }, 404);
  if (po.status === "deleted") return c.json({ error: "Can't code a deleted PO" }, 409);

  let materialId: number | null = null;
  let codedItem: string | null = null;
  if (body.material_id != null) {
    const m = await c.env.DB.prepare(
      `SELECT m.id, m.item FROM materials m
         JOIN material_snapshots s ON s.id = m.snapshot_id
        WHERE m.id = ? AND s.project_id = ? AND s.is_active = 1`,
    ).bind(body.material_id, po.project_id).first<{ id: number; item: string }>();
    if (!m) return c.json({ error: "That budget line isn't on this project's live materials list." }, 400);
    materialId = m.id;
    codedItem = m.item;
  }
  const res = await c.env.DB.prepare("UPDATE po_lines SET material_id = ? WHERE po_id = ?").bind(materialId, id).run();
  const lineItems = (await c.env.DB.prepare("SELECT item FROM po_lines WHERE po_id = ?").bind(id).all<{ item: string }>()).results;
  // Remember each wording → budget line, so the next retro PO guesses itself.
  if (codedItem) {
    await learnAliases(c.env.DB, "budget_item", po.supplier, lineItems.map((l) => ({ alias: l.item, target: codedItem })), c.get("userEmail"));
  }
  const cascaded = po.order_type === "framework"
    ? await cascadeFrameworkCoding(c.env.DB, id, lineItems.map((l) => l.item), materialId)
    : 0;
  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('po', ?, 'line_budget_assigned', ?, ?, ?)`,
  ).bind(id, c.get("userEmail"), JSON.stringify({ all_lines: true, material_id: materialId, budget_item: codedItem, call_off_lines: cascaded }), new Date().toISOString()).run();
  return c.json({ ok: true, material_id: materialId, lines: res.meta.changes ?? 0, call_off_lines: cascaded });
});

/** Code a PO line to a budget (materials-list) line after the fact — how a
 *  retrospective PO raised off an invoice gets assigned to costs within the
 *  budget. Only material_id moves: the approval snapshots (priced_qty_at_order,
 *  is_over_budget) are order-time history and stay put. */
pos.post("/:id/lines/:lineId/assign-budget", async (c) => {
  const denied = requirePermission(c, "pos.edit");
  if (denied) return denied;
  const id = c.req.param("id");
  const lineId = Number(c.req.param("lineId"));
  if (!Number.isInteger(lineId)) return c.json({ error: "bad line id" }, 400);
  const body = await c.req.json<{ material_id?: number | null }>().catch(() => ({} as { material_id?: number | null }));
  const po = await c.env.DB.prepare("SELECT id, project_id, status, supplier, order_type FROM purchase_orders WHERE id = ?")
    .bind(id).first<{ id: string; project_id: string; status: string; supplier: string | null; order_type: string | null }>();
  if (!po) return c.json({ error: "not found" }, 404);
  if (po.status === "deleted") return c.json({ error: "Can't code a deleted PO" }, 409);
  const line = await c.env.DB.prepare("SELECT id, item FROM po_lines WHERE id = ? AND po_id = ?").bind(lineId, id).first<{ id: number; item: string }>();
  if (!line) return c.json({ error: "line not found" }, 404);

  let materialId: number | null = null;
  let codedItem: string | null = null;
  if (body.material_id != null) {
    const m = await c.env.DB.prepare(
      `SELECT m.id, m.item FROM materials m
         JOIN material_snapshots s ON s.id = m.snapshot_id
        WHERE m.id = ? AND s.project_id = ? AND s.is_active = 1`,
    ).bind(body.material_id, po.project_id).first<{ id: number; item: string }>();
    if (!m) return c.json({ error: "That budget line isn't on this project's live materials list." }, 400);
    materialId = m.id;
    codedItem = m.item;
  }
  await c.env.DB.prepare("UPDATE po_lines SET material_id = ? WHERE id = ? AND po_id = ?").bind(materialId, lineId, id).run();
  if (codedItem) await learnAliases(c.env.DB, "budget_item", po.supplier, [{ alias: line.item, target: codedItem }], c.get("userEmail"));
  const cascaded = po.order_type === "framework"
    ? await cascadeFrameworkCoding(c.env.DB, id, [line.item], materialId)
    : 0;
  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('po', ?, 'line_budget_assigned', ?, ?, ?)`,
  ).bind(id, c.get("userEmail"), JSON.stringify({ line_id: lineId, material_id: materialId, budget_item: codedItem, call_off_lines: cascaded }), new Date().toISOString()).run();
  return c.json({ ok: true, material_id: materialId, call_off_lines: cascaded });
});

pos.post("/:id/approve", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("userEmail");
  const po = await c.env.DB.prepare(
    `SELECT po.id, po.project_id, po.status, po.approval_tier, po.po_number, po.supplier, po.total_value, po.created_by,
            p.code AS project_code, p.name AS project_name
     FROM purchase_orders po
     JOIN projects p ON p.id = po.project_id
     WHERE po.id = ?`,
  )
    .bind(id)
    .first<{
      id: string; project_id: string; status: string; approval_tier: string | null;
      po_number: string; supplier: string; total_value: number; created_by: string;
      project_code: string; project_name: string;
    }>();
  if (!po) return c.json({ error: "not found" }, 404);
  if (po.status !== "pending_approval") {
    return c.json({ error: `cannot approve a ${po.status} PO` }, 409);
  }
  const approver = await c.env.DB.prepare(
    "SELECT 1 AS ok FROM approvers WHERE lower(email) = ? AND tier = ? LIMIT 1",
  )
    .bind(actor, po.approval_tier ?? "")
    .first();
  if (!approver) {
    return c.json({ error: "you are not an approver for this tier" }, 403);
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE purchase_orders SET status = 'approved', approved_at = ?, approved_by = ? WHERE id = ?",
  )
    .bind(now, actor, id)
    .run();
  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('po', ?, 'approved', ?, NULL, ?)`,
  )
    .bind(id, actor, now)
    .run();

  if (!isSandboxId(po.project_id)) c.executionCtx.waitUntil(
    emailRequesterDecision(c.env, {
      decision: "approved",
      po: { id: po.id, po_number: po.po_number, supplier: po.supplier, total_value: po.total_value },
      project: { code: po.project_code, name: po.project_name },
      requesterEmail: po.created_by,
      actorEmail: actor,
    }),
  );

  // Auto-push to Xero if connected. Best-effort — failures are stored on the
  // PO row (xero_sync_status='failed' + xero_sync_error) and surfaced in the
  // PO view; the approval itself isn't rolled back.
  if (c.env.XERO_CLIENT_ID && c.env.XERO_CLIENT_SECRET) {
    c.executionCtx.waitUntil(
      pushPOToXero(c.env, id).catch((e) =>
        console.warn("Xero auto-push failed", e instanceof Error ? e.message : e),
      ),
    );
  }

  return c.json({ ok: true });
});

pos.post("/:id/reject", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("userEmail");
  const body = await c.req.json<{ reason?: string }>();
  const po = await c.env.DB.prepare(
    `SELECT po.id, po.project_id, po.status, po.approval_tier, po.po_number, po.supplier, po.total_value, po.created_by,
            p.code AS project_code, p.name AS project_name
     FROM purchase_orders po
     JOIN projects p ON p.id = po.project_id
     WHERE po.id = ?`,
  )
    .bind(id)
    .first<{
      id: string; project_id: string; status: string; approval_tier: string | null;
      po_number: string; supplier: string; total_value: number; created_by: string;
      project_code: string; project_name: string;
    }>();
  if (!po) return c.json({ error: "not found" }, 404);
  if (po.status !== "pending_approval") {
    return c.json({ error: `cannot reject a ${po.status} PO` }, 409);
  }
  const approver = await c.env.DB.prepare(
    "SELECT 1 AS ok FROM approvers WHERE lower(email) = ? AND tier = ? LIMIT 1",
  )
    .bind(actor, po.approval_tier ?? "")
    .first();
  if (!approver) {
    return c.json({ error: "you are not an approver for this tier" }, 403);
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE purchase_orders
       SET status = 'rejected', rejected_at = ?, rejected_by = ?, rejection_reason = ?
       WHERE id = ?`,
  )
    .bind(now, actor, body.reason ?? null, id)
    .run();
  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('po', ?, 'rejected', ?, ?, ?)`,
  )
    .bind(id, actor, JSON.stringify({ reason: body.reason ?? null }), now)
    .run();

  if (!isSandboxId(po.project_id)) c.executionCtx.waitUntil(
    emailRequesterDecision(c.env, {
      decision: "rejected",
      po: { id: po.id, po_number: po.po_number, supplier: po.supplier, total_value: po.total_value },
      project: { code: po.project_code, name: po.project_name },
      requesterEmail: po.created_by,
      actorEmail: actor,
      reason: body.reason ?? null,
    }),
  );
  return c.json({ ok: true });
});

pos.post("/:id/issue", async (c) => {
  const denied = requirePermission(c, "pos.issue");
  if (denied) return denied;
  const id = c.req.param("id");
  const actor = c.get("userEmail");
  const po = await c.env.DB.prepare("SELECT id, status, created_by, xero_po_id FROM purchase_orders WHERE id = ?")
    .bind(id)
    .first<{ id: string; status: string; created_by: string; xero_po_id: string | null }>();
  if (!po) return c.json({ error: "not found" }, 404);
  if (po.status !== "approved") {
    return c.json({ error: `cannot issue a ${po.status} PO` }, 409);
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE purchase_orders SET status = 'issued', issued_at = ? WHERE id = ?",
  )
    .bind(now, id)
    .run();
  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('po', ?, 'issued', ?, NULL, ?)`,
  )
    .bind(id, actor, now)
    .run();

  // Safety net: if this PO never made it into Xero (e.g. Xero was disconnected
  // when it was approved), push it on issue. Guarded on xero_po_id IS NULL so an
  // already-synced PO is never pushed twice (which would duplicate it in Xero).
  if (!po.xero_po_id && c.env.XERO_CLIENT_ID && c.env.XERO_CLIENT_SECRET) {
    c.executionCtx.waitUntil(
      pushPOToXero(c.env, id).catch((e) =>
        console.warn("Xero push (on issue) failed", e instanceof Error ? e.message : e),
      ),
    );
  }

  return c.json({ ok: true });
});

/**
 * Soft delete — superadmin only. Sets status='deleted' and records who,
 * when, and why. The PO row stays so the audit trail is preserved, but it
 * disappears from every list query (which all filter
 * status IN ('approved','issued','pending_approval', ...)) and stops
 * counting against project committed budget.
 */
pos.delete("/:id", async (c) => {
  const denied = requirePermission(c, "pos.delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const actor = c.get("userEmail");
  const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: undefined }));
  const reason = (body.reason ?? "").trim();
  if (!reason) return c.json({ error: "deletion reason is required" }, 400);

  const po = await c.env.DB.prepare("SELECT id, status, po_number FROM purchase_orders WHERE id = ?")
    .bind(id)
    .first<{ id: string; status: string; po_number: string }>();
  if (!po) return c.json({ error: "not found" }, 404);
  if (po.status === "deleted") return c.json({ error: "already deleted" }, 409);

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE purchase_orders
       SET status = 'deleted', deleted_at = ?, deleted_by = ?, deletion_reason = ?
       WHERE id = ?`,
  )
    .bind(now, actor, reason, id)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, actor, details, created_at)
     VALUES ('po', ?, 'deleted', ?, ?, ?)`,
  )
    .bind(id, actor, JSON.stringify({ reason, previous_status: po.status }), now)
    .run();
  return c.json({ ok: true });
});

export async function nextPONumber(db: D1Database, projectCode: string): Promise<string> {
  const prefix = `PO-${projectCode}-`;
  // Exclude call-off numbers (…-C1, -C2): those share the project prefix but a
  // string DESC sort would float "…0009-C3" above "…0010", and Number() of the
  // suffixed value is NaN — which would reset the sequence and collide.
  const row = await db
    .prepare(
      `SELECT po_number FROM purchase_orders
       WHERE po_number LIKE ? AND po_number NOT GLOB '*-C[0-9]*'
       ORDER BY po_number DESC LIMIT 1`,
    )
    .bind(`${prefix}%`)
    .first<{ po_number: string }>();
  let next = 1;
  if (row) {
    const seq = Number(row.po_number.slice(prefix.length));
    if (Number.isFinite(seq)) next = seq + 1;
  }
  return `${prefix}${String(next).padStart(4, "0")}`;
}

/**
 * Call-off number: the framework's own number plus a per-framework call-off
 * index, e.g. framework PO-26004-0007 → PO-26004-0007-C1, -C2. Indexes by the
 * highest existing -C suffix (not a count) so deletes never cause a collision.
 * Returns null if the parent can't be found (caller falls back to a flat number).
 */
async function nextCallOffNumber(db: D1Database, parentPoId: string): Promise<string | null> {
  const parent = await db
    .prepare("SELECT po_number FROM purchase_orders WHERE id = ?")
    .bind(parentPoId)
    .first<{ po_number: string }>();
  if (!parent) return null;
  const kids = await db
    .prepare("SELECT po_number FROM purchase_orders WHERE parent_po_id = ? AND status != 'deleted'")
    .bind(parentPoId)
    .all<{ po_number: string }>();
  let max = 0;
  for (const k of kids.results) {
    const m = /-C(\d+)$/.exec(k.po_number);
    if (m) { const n = Number(m[1]); if (n > max) max = n; }
  }
  return `${parent.po_number}-C${max + 1}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
