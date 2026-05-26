// Supplier quote pipeline: upload a PDF on a supplier's page, Claude extracts
// the line items, the PM reviews each line and matches it to a product in the
// catalogue, then applies the new prices to product_suppliers.

import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import type { Env, Variables } from "../env";
import { requirePermission } from "../auth";
import { buildProductCode } from "../../shared/types";
import { loadSettings } from "../approval";
import type { ApprovalTier } from "../../shared/types";

export const quotes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Types ──────────────────────────────────────────────────────────────────

type ExtractedLine = {
  line_no: number;
  description: string;
  sku: string | null;
  qty: number | null;
  unit: string | null;
  unit_price: number | null;
};

type CandidateMatch = {
  product_id: number;
  product_supplier_id: number | null;
  product_code: string;
  description: string;
  current_unit_cost: number | null;
  score: number;
};

// ── Helpers ────────────────────────────────────────────────────────────────

/** ArrayBuffer → base64 string (Workers-safe, chunks to avoid stack overflow). */
function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * Score how well a candidate product matches an extracted quote line.
 * Token overlap on description plus exact SKU/manufacturer bonuses. Returns
 * a value in [0, 1].
 */
function scoreMatch(
  line: ExtractedLine,
  candidate: {
    description: string;
    manufacturer: string | null;
    sku: string | null;
  },
): number {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  const lineTokens = new Set(norm(line.description));
  const candTokens = new Set(norm(candidate.description));
  if (lineTokens.size === 0 || candTokens.size === 0) return 0;
  let overlap = 0;
  for (const t of lineTokens) if (candTokens.has(t)) overlap++;
  const jaccard =
    overlap / (lineTokens.size + candTokens.size - overlap);

  let score = jaccard;
  // SKU exact match is a very strong signal.
  if (line.sku && candidate.sku && line.sku.toLowerCase() === candidate.sku.toLowerCase()) {
    score = Math.max(score, 0.95);
  }
  return Math.min(1, score);
}

/**
 * For each extracted line, find the best matching product in the catalogue
 * (preferring products this supplier already supplies). Returns null if
 * no candidate scores above a threshold.
 */
async function matchLines(
  db: D1Database,
  supplierName: string,
  lines: ExtractedLine[],
): Promise<Map<number, CandidateMatch | null>> {
  // Pull catalogue once, filter in-memory. Fine at typical catalogue sizes;
  // we can move to FTS later if it gets slow.
  const products = await db
    .prepare(
      `SELECT p.id, p.element_code, p.item_no, p.variant, p.description, p.manufacturer, p.unit_cost,
              ps.id AS ps_id, ps.unit_cost AS ps_cost, ps.supplier_sku AS ps_sku
       FROM products p
       LEFT JOIN product_suppliers ps
         ON ps.product_id = p.id AND lower(ps.supplier_name) = lower(?)`,
    )
    .bind(supplierName)
    .all<{
      id: number;
      element_code: string;
      item_no: number;
      variant: string | null;
      description: string;
      manufacturer: string | null;
      unit_cost: number | null;
      ps_id: number | null;
      ps_cost: number | null;
      ps_sku: string | null;
    }>();

  const out = new Map<number, CandidateMatch | null>();
  for (const line of lines) {
    let best: CandidateMatch | null = null;
    for (const p of products.results) {
      const s = scoreMatch(line, {
        description: p.description,
        manufacturer: p.manufacturer,
        sku: p.ps_sku,
      });
      if (s > (best?.score ?? 0)) {
        best = {
          product_id: p.id,
          product_supplier_id: p.ps_id,
          product_code: buildProductCode(p.element_code, p.item_no, p.variant),
          description: p.description,
          current_unit_cost: p.ps_cost ?? p.unit_cost,
          score: s,
        };
      }
    }
    // Threshold keeps low-confidence matches from being shown as suggestions.
    out.set(line.line_no, best && best.score >= 0.25 ? best : null);
  }
  return out;
}

/** For project-scoped quotes: match each line against the project's active
 *  material snapshot rows (by description token overlap, with element-code
 *  bonus when both sides have one). Returns the best candidate per line, or
 *  null if no candidate scored above threshold. */
type MaterialCandidate = {
  material_id: number;
  item: string;
  cost: number | null;
  total_units: number | null;
  total_units_unit: string | null;
  element_code: string | null;
  score: number;
};

async function matchProjectMaterials(
  db: D1Database,
  projectId: string,
  lines: ExtractedLine[],
): Promise<Map<number, MaterialCandidate | null>> {
  const snap = await db
    .prepare(
      "SELECT id FROM material_snapshots WHERE project_id = ? AND is_active = 1",
    )
    .bind(projectId)
    .first<{ id: number }>();
  const out = new Map<number, MaterialCandidate | null>();
  if (!snap) {
    for (const l of lines) out.set(l.line_no, null);
    return out;
  }
  const mats = await db
    .prepare(
      `SELECT id, item, cost, total_units, total_units_unit, element_code
       FROM materials WHERE snapshot_id = ?`,
    )
    .bind(snap.id)
    .all<{
      id: number;
      item: string;
      cost: number | null;
      total_units: number | null;
      total_units_unit: string | null;
      element_code: string | null;
    }>();

  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  for (const line of lines) {
    const lineTokens = new Set(norm(line.description));
    if (lineTokens.size === 0) { out.set(line.line_no, null); continue; }
    let best: MaterialCandidate | null = null;
    for (const m of mats.results) {
      const matTokens = new Set(norm(m.item));
      if (matTokens.size === 0) continue;
      let overlap = 0;
      for (const t of lineTokens) if (matTokens.has(t)) overlap++;
      const jaccard = overlap === 0 ? 0 : overlap / (lineTokens.size + matTokens.size - overlap);
      if (jaccard > (best?.score ?? 0)) {
        best = {
          material_id: m.id,
          item: m.item,
          cost: m.cost,
          total_units: m.total_units,
          total_units_unit: m.total_units_unit,
          element_code: m.element_code,
          score: jaccard,
        };
      }
    }
    out.set(line.line_no, best && best.score >= 0.25 ? best : null);
  }
  return out;
}

/** Tier the overspend amount using the configured PO thresholds. */
function tierForOverspend(
  over: number,
  s: { tier_threshold_line_manager: number; tier_threshold_commercial_manager: number; tier_threshold_director: number },
): ApprovalTier {
  if (over <= s.tier_threshold_line_manager) return "line_manager";
  if (over <= s.tier_threshold_commercial_manager) return "commercial_manager";
  return "director";
}

// ── Routes ──────────────────────────────────────────────────────────────────

type ExtractionResult = {
  supplier_name_as_written: string | null;
  supplier_register_id: number | null;
  lines: ExtractedLine[];
};

/**
 * Single Claude pass that identifies the supplier from the PDF's letterhead
 * AND extracts the priced line items. We pass the list of approved suppliers
 * so Claude can match against IDs directly; the server still does a fuzzy
 * fallback in case Claude couldn't pick.
 */
async function extractQuoteWithClaude(
  env: Env,
  pdf: ArrayBuffer,
  approvedSuppliers: Array<{ id: number; name: string }>,
): Promise<ExtractionResult> {
  const pdfBase64 = bufToBase64(pdf);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const supplierListing = approvedSuppliers
    .map((s) => `  ${s.id}: ${s.name}`)
    .join("\n");

  const system = `You are processing a UK construction-supplier quote PDF.

Two jobs in one go:
1. Identify which supplier issued this quote (read the letterhead, header, footer,
   sender details, VAT no., and look at the email signature / company block).
2. Extract every priced line item.

The user's approved supplier register contains these companies — match the
quote to one of them by their numeric id when you can. Use partial-name matches
intelligently (e.g. "Alumasc Water Management Solutions Ltd" on the quote ↔
"Alumasc Water Management Solutions" in the register). If the issuer is clearly
not on this list, return supplier_register_id = 0 and put the as-written name
in supplier_name_as_written so we can ask the user.

Approved supplier register:
${supplierListing || "  (none)"}

Line item rules: skip headers, footers, terms, totals, and any line without
both a quantity and a unit price. Numeric fields must be plain numbers (no
currency symbols, no thousands separators). Preserve document order.`;

  const response = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 4096,
    system,
    tools: [
      {
        name: "extract_supplier_quote",
        description:
          "Return the issuing supplier (matched to the register if possible) and the structured line items from the quote PDF.",
        input_schema: {
          type: "object" as const,
          properties: {
            supplier_name_as_written: {
              type: "string",
              description:
                "The supplier/company name exactly as it appears on the quote letterhead. Empty string only if truly unidentifiable.",
            },
            supplier_register_id: {
              type: "integer",
              description:
                "The numeric id of the best-matching supplier from the approved register listed in the system prompt. Use 0 if the issuer is not in the register or you can't confidently match.",
            },
            lines: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  description: {
                    type: "string",
                    description:
                      "Full description of the product as written on the quote.",
                  },
                  sku: {
                    type: "string",
                    description:
                      "Supplier or manufacturer SKU/part number. Empty string if none.",
                  },
                  qty: {
                    type: "number",
                    description: "Quantity ordered/quoted (numeric).",
                  },
                  unit: {
                    type: "string",
                    description:
                      "Unit of measure as written (e.g. 'each', 'm²', 'Roll', 'Box', 'lm').",
                  },
                  unit_price: {
                    type: "number",
                    description:
                      "Price per unit in GBP excluding VAT. Plain number.",
                  },
                },
                required: ["description", "qty", "unit_price"],
              },
            },
          },
          required: ["supplier_name_as_written", "supplier_register_id", "lines"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "extract_supplier_quote" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
          },
          {
            type: "text",
            text:
              "Identify the supplier and extract the priced line items via extract_supplier_quote. One entry per priced line, in document order.",
          },
        ],
      },
    ],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) throw new Error("Claude did not return structured output");

  const input = toolUse.input as {
    supplier_name_as_written?: string;
    supplier_register_id?: number;
    lines?: Array<Record<string, unknown>>;
  };
  const rawLines = Array.isArray(input.lines) ? input.lines : [];
  const lines: ExtractedLine[] = rawLines.map((r, i) => ({
    line_no: i + 1,
    description: String(r.description ?? "").trim(),
    sku: r.sku && String(r.sku).trim() ? String(r.sku).trim() : null,
    qty: typeof r.qty === "number" ? r.qty : null,
    unit: r.unit && String(r.unit).trim() ? String(r.unit).trim() : null,
    unit_price: typeof r.unit_price === "number" ? r.unit_price : null,
  })).filter((l) => l.description.length > 0);

  const claudeId = Number.isInteger(input.supplier_register_id) ? Number(input.supplier_register_id) : 0;
  return {
    supplier_name_as_written: input.supplier_name_as_written?.trim() || null,
    supplier_register_id: claudeId > 0 ? claudeId : null,
    lines,
  };
}

/**
 * Server-side fallback name match when Claude couldn't pick a register id.
 * Returns the highest-scoring candidates by token overlap on the supplier name.
 */
function rankSupplierCandidates(
  detectedName: string | null,
  suppliers: Array<{ id: number; name: string }>,
): Array<{ id: number; name: string; score: number }> {
  if (!detectedName) return [];
  const tokens = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean));
  const target = tokens(detectedName);
  return suppliers
    .map((s) => {
      const cand = tokens(s.name);
      let overlap = 0;
      for (const t of target) if (cand.has(t)) overlap++;
      const score =
        overlap === 0 ? 0 : overlap / (target.size + cand.size - overlap);
      return { id: s.id, name: s.name, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

/**
 * Persist extracted lines for a known supplier. If a project_id is provided,
 * lines are matched against that project's BOQ materials and the BOQ
 * baseline (cost + qty) is snapshotted onto each line for delta calculations.
 * Otherwise lines are matched against the master catalogue as before.
 *
 * Returns the new quote_id.
 */
async function persistExtractedQuote(
  db: D1Database,
  supplier: { id: number; name: string },
  filename: string,
  notes: string | null,
  actor: string,
  lines: ExtractedLine[],
  projectId: string | null,
): Promise<number> {
  const now = new Date().toISOString();
  const quoteRow = await db
    .prepare(
      `INSERT INTO supplier_quotes (supplier_id, project_id, filename, uploaded_at, uploaded_by, status, notes)
       VALUES (?, ?, ?, ?, ?, 'ready', ?) RETURNING id`,
    )
    .bind(supplier.id, projectId, filename, now, actor, notes)
    .first<{ id: number }>();
  const quoteId = quoteRow!.id;

  if (projectId) {
    // Project-scoped: match against the project's BOQ materials. Snapshot the
    // BOQ unit cost and the BOQ ALLOWED qty (not the qty written on the quote
    // line) so savings/overspend are calculated against the full project
    // exposure — e.g. "1,326 sheets × £5 saved" rather than "1 unit × £5".
    const matches = await matchProjectMaterials(db, projectId, lines);
    const stmts = lines.map((l) => {
      const m = matches.get(l.line_no) ?? null;
      const boqCost = m?.cost ?? null;
      const boqQty = m?.total_units ?? null;
      return db
        .prepare(
          `INSERT INTO supplier_quote_lines
             (quote_id, line_no, raw_description, raw_sku, raw_qty, raw_unit, unit_price,
              matched_material_id, match_confidence, boq_unit_cost, boq_qty)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          quoteId,
          l.line_no,
          l.description,
          l.sku,
          l.qty,
          l.unit,
          l.unit_price,
          m?.material_id ?? null,
          m?.score ?? null,
          boqCost,
          boqQty,
        );
    });
    await db.batch(stmts);
  } else {
    // Catalogue scope: match against products + existing supplier prices.
    const matches = await matchLines(db, supplier.name, lines);
    const stmts = lines.map((l) => {
      const m = matches.get(l.line_no) ?? null;
      return db
        .prepare(
          `INSERT INTO supplier_quote_lines
             (quote_id, line_no, raw_description, raw_sku, raw_qty, raw_unit, unit_price,
              matched_product_id, matched_product_supplier_id, match_confidence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          quoteId,
          l.line_no,
          l.description,
          l.sku,
          l.qty,
          l.unit,
          l.unit_price,
          m?.product_id ?? null,
          m?.product_supplier_id ?? null,
          m?.score ?? null,
        );
    });
    await db.batch(stmts);
  }
  return quoteId;
}

/**
 * Top-level upload: auto-detect the supplier from the PDF letterhead and
 * match against the approved register. Optionally accepts `supplier_id` in
 * the form data to skip auto-detection (used when the user has just confirmed
 * which supplier this quote is from after a previous 422).
 */
quotes.post("/upload", async (c) => {
  const denied = requirePermission(c, "suppliers.manage");
  if (denied) return denied;
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ error: "ANTHROPIC_API_KEY not configured" }, 500);
  }

  const form = await c.req.formData();
  const file = form.get("file");
  const notes = (form.get("notes") as string | null) ?? null;
  const forcedSupplierIdRaw = form.get("supplier_id") as string | null;
  const forcedSupplierId = forcedSupplierIdRaw ? Number(forcedSupplierIdRaw) : null;
  const projectId = (form.get("project_id") as string | null) || null;
  if (!(file instanceof File)) return c.json({ error: "file required" }, 400);
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    return c.json({ error: "PDF required" }, 400);
  }

  // If the upload is scoped to a project, make sure it exists.
  if (projectId) {
    const p = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ?")
      .bind(projectId)
      .first();
    if (!p) return c.json({ error: "project not found" }, 404);
  }

  const suppliers = await c.env.DB.prepare(
    "SELECT id, name FROM suppliers ORDER BY name",
  )
    .all<{ id: number; name: string }>();
  if (suppliers.results.length === 0) {
    return c.json({ error: "No approved suppliers in the register yet — add one first" }, 400);
  }

  let extraction: ExtractionResult;
  try {
    extraction = await extractQuoteWithClaude(c.env, await file.arrayBuffer(), suppliers.results);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "extraction failed" }, 502);
  }
  if (extraction.lines.length === 0) {
    return c.json({ error: "No line items found in the PDF" }, 400);
  }

  // Resolve the supplier: forced override > Claude's pick > server fuzzy match.
  let resolved: { id: number; name: string } | null = null;
  if (forcedSupplierId) {
    const s = suppliers.results.find((x) => x.id === forcedSupplierId);
    if (!s) return c.json({ error: "supplier not in register" }, 400);
    resolved = s;
  } else if (extraction.supplier_register_id) {
    const s = suppliers.results.find((x) => x.id === extraction.supplier_register_id);
    if (s) resolved = s;
  }
  if (!resolved && extraction.supplier_name_as_written) {
    const candidates = rankSupplierCandidates(extraction.supplier_name_as_written, suppliers.results);
    if (candidates[0] && candidates[0].score >= 0.6) {
      const s = suppliers.results.find((x) => x.id === candidates[0].id);
      if (s) resolved = s;
    }
  }

  if (!resolved) {
    // No confident match — surface the detected name and top candidates so the
    // UI can prompt the user to pick. We DON'T persist; the user will resubmit
    // with supplier_id set.
    const candidates = rankSupplierCandidates(extraction.supplier_name_as_written, suppliers.results);
    return c.json(
      {
        error: "supplier_unmatched",
        detected_name: extraction.supplier_name_as_written,
        candidates,
        extracted_count: extraction.lines.length,
      },
      422,
    );
  }

  const quoteId = await persistExtractedQuote(
    c.env.DB,
    resolved,
    file.name,
    notes,
    c.get("userEmail"),
    extraction.lines,
    projectId,
  );

  return c.json({
    quote_id: quoteId,
    supplier_id: resolved.id,
    supplier_name: resolved.name,
    project_id: projectId,
    detected_name: extraction.supplier_name_as_written,
    auto_matched: !forcedSupplierId,
    extracted_lines: extraction.lines.length,
  });
});

/**
 * Reassign a quote to a different supplier — re-runs product matching against
 * the new supplier's existing prices. Used when the auto-detection picked the
 * wrong company.
 */
quotes.patch("/:quoteId/supplier", async (c) => {
  const denied = requirePermission(c, "suppliers.manage");
  if (denied) return denied;
  const quoteId = Number(c.req.param("quoteId"));
  const body = await c.req.json<{ supplier_id: number }>();
  if (!Number.isInteger(body.supplier_id)) {
    return c.json({ error: "supplier_id required" }, 400);
  }

  const quote = await c.env.DB.prepare(
    "SELECT id, status FROM supplier_quotes WHERE id = ?",
  )
    .bind(quoteId)
    .first<{ id: number; status: string }>();
  if (!quote) return c.json({ error: "not found" }, 404);
  if (quote.status === "applied") {
    return c.json({ error: "quote already applied" }, 409);
  }

  const supplier = await c.env.DB.prepare(
    "SELECT id, name FROM suppliers WHERE id = ?",
  )
    .bind(body.supplier_id)
    .first<{ id: number; name: string }>();
  if (!supplier) return c.json({ error: "supplier not found" }, 404);

  const lines = await c.env.DB.prepare(
    "SELECT id, line_no, raw_description, raw_sku, raw_qty, raw_unit, unit_price FROM supplier_quote_lines WHERE quote_id = ? ORDER BY line_no",
  )
    .bind(quoteId)
    .all<{
      id: number;
      line_no: number;
      raw_description: string;
      raw_sku: string | null;
      raw_qty: number | null;
      raw_unit: string | null;
      unit_price: number | null;
    }>();

  const extracted: ExtractedLine[] = lines.results.map((l) => ({
    line_no: l.line_no,
    description: l.raw_description,
    sku: l.raw_sku,
    qty: l.raw_qty,
    unit: l.raw_unit,
    unit_price: l.unit_price,
  }));
  const matches = await matchLines(c.env.DB, supplier.name, extracted);

  await c.env.DB.prepare(
    "UPDATE supplier_quotes SET supplier_id = ? WHERE id = ?",
  )
    .bind(supplier.id, quoteId)
    .run();

  // Reset matches on every line — the new supplier has its own product_suppliers rows.
  for (const l of lines.results) {
    const m = matches.get(l.line_no) ?? null;
    await c.env.DB.prepare(
      "UPDATE supplier_quote_lines SET matched_product_id = ?, matched_product_supplier_id = ?, match_confidence = ?, skip_reason = NULL, is_applied = 0, old_unit_price = NULL WHERE id = ?",
    )
      .bind(m?.product_id ?? null, m?.product_supplier_id ?? null, m?.score ?? null, l.id)
      .run();
  }

  return c.json({ ok: true, supplier_id: supplier.id, supplier_name: supplier.name });
});

/** List quotes for a supplier (newest first). */
quotes.get("/:supplierId", async (c) => {
  const supplierId = Number(c.req.param("supplierId"));
  if (!Number.isInteger(supplierId)) return c.json([]);

  const rows = await c.env.DB.prepare(
    `SELECT q.*,
            (SELECT COUNT(*) FROM supplier_quote_lines l WHERE l.quote_id = q.id) AS line_count,
            (SELECT COUNT(*) FROM supplier_quote_lines l WHERE l.quote_id = q.id AND l.is_applied = 1) AS applied_count
     FROM supplier_quotes q
     WHERE q.supplier_id = ?
     ORDER BY q.uploaded_at DESC`,
  )
    .bind(supplierId)
    .all();
  return c.json(rows.results);
});

/** Get a single quote with its lines + match context (current price etc.) for review. */
quotes.get("/detail/:quoteId", async (c) => {
  const quoteId = Number(c.req.param("quoteId"));
  if (!Number.isInteger(quoteId)) return c.json({ error: "invalid id" }, 400);

  const quote = await c.env.DB.prepare(
    `SELECT q.*, s.name AS supplier_name
     FROM supplier_quotes q
     JOIN suppliers s ON s.id = q.supplier_id
     WHERE q.id = ?`,
  )
    .bind(quoteId)
    .first();
  if (!quote) return c.json({ error: "not found" }, 404);

  const lines = await c.env.DB.prepare(
    `SELECT l.*,
            p.element_code AS p_element_code, p.item_no AS p_item_no, p.variant AS p_variant,
            p.description  AS product_description, p.unit AS product_unit,
            p.unit_cost    AS product_primary_cost,
            ps.unit_cost   AS supplier_current_cost,
            ps.supplier_sku AS supplier_current_sku,
            mat.item       AS material_item,
            mat.cost       AS material_boq_cost,
            mat.total_units AS material_total_units,
            mat.total_units_unit AS material_total_units_unit,
            mat.element_code AS material_element_code,
            mlp.status     AS live_status,
            mlp.over_amount AS live_over_amount,
            mlp.approval_tier AS live_approval_tier
     FROM supplier_quote_lines l
     LEFT JOIN products p             ON p.id  = l.matched_product_id
     LEFT JOIN product_suppliers ps   ON ps.id = l.matched_product_supplier_id
     LEFT JOIN materials mat          ON mat.id = l.matched_material_id
     LEFT JOIN material_live_prices mlp ON mlp.quote_line_id = l.id
     WHERE l.quote_id = ?
     ORDER BY l.line_no`,
  )
    .bind(quoteId)
    .all<Record<string, unknown> & {
      p_element_code: string | null;
      p_item_no: number | null;
      p_variant: string | null;
    }>();

  // Derive product_code in JS since it's a computed field.
  const out = lines.results.map((r) => {
    const { p_element_code, p_item_no, p_variant, ...rest } = r;
    return {
      ...rest,
      product_code:
        p_element_code != null && p_item_no != null
          ? buildProductCode(p_element_code, p_item_no, p_variant)
          : null,
    };
  });

  return c.json({ quote, lines: out });
});

/** Re-assign a quote line's matched product (or clear it). */
quotes.patch("/lines/:lineId/match", async (c) => {
  const denied = requirePermission(c, "suppliers.manage");
  if (denied) return denied;
  const lineId = Number(c.req.param("lineId"));
  const body = await c.req.json<{ product_id: number | null }>();

  const line = await c.env.DB.prepare(
    `SELECT l.id, l.quote_id, q.supplier_id, s.name AS supplier_name
     FROM supplier_quote_lines l
     JOIN supplier_quotes q ON q.id = l.quote_id
     JOIN suppliers s ON s.id = q.supplier_id
     WHERE l.id = ?`,
  )
    .bind(lineId)
    .first<{ id: number; quote_id: number; supplier_id: number; supplier_name: string }>();
  if (!line) return c.json({ error: "line not found" }, 404);

  let productSupplierId: number | null = null;
  if (body.product_id != null) {
    const ps = await c.env.DB.prepare(
      "SELECT id FROM product_suppliers WHERE product_id = ? AND lower(supplier_name) = lower(?)",
    )
      .bind(body.product_id, line.supplier_name)
      .first<{ id: number }>();
    productSupplierId = ps?.id ?? null;
  }

  await c.env.DB.prepare(
    `UPDATE supplier_quote_lines
     SET matched_product_id = ?, matched_product_supplier_id = ?, match_confidence = NULL,
         skip_reason = NULL
     WHERE id = ?`,
  )
    .bind(body.product_id, productSupplierId, lineId)
    .run();
  return c.json({ ok: true });
});

/** Mark a line as intentionally skipped. */
quotes.patch("/lines/:lineId/skip", async (c) => {
  const denied = requirePermission(c, "suppliers.manage");
  if (denied) return denied;
  const lineId = Number(c.req.param("lineId"));
  const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: undefined }));
  await c.env.DB.prepare(
    `UPDATE supplier_quote_lines
     SET skip_reason = COALESCE(?, 'skipped'), matched_product_id = NULL, matched_product_supplier_id = NULL
     WHERE id = ?`,
  )
    .bind(body.reason ?? null, lineId)
    .run();
  return c.json({ ok: true });
});

/**
 * Apply the quote. Splits by quote scope:
 *
 *  - Catalogue quotes (project_id IS NULL): every matched line writes its
 *    new unit_cost into product_suppliers (upserting on the supplier name).
 *
 *  - Project quotes (project_id set): each matched line is compared against
 *    the BOQ unit cost snapshotted on the line. Cheaper-or-equal lines apply
 *    immediately (status 'applied'); pricier lines get a pending row in
 *    material_live_prices with an approval_tier banded by the overspend £.
 *
 * Either way the quote ends up in status='applied' with totals recorded.
 */
quotes.post("/:quoteId/apply", async (c) => {
  const denied = requirePermission(c, "suppliers.manage");
  if (denied) return denied;
  const quoteId = Number(c.req.param("quoteId"));

  const quote = await c.env.DB.prepare(
    `SELECT q.id, q.supplier_id, q.project_id, q.status, s.name AS supplier_name
     FROM supplier_quotes q
     JOIN suppliers s ON s.id = q.supplier_id
     WHERE q.id = ?`,
  )
    .bind(quoteId)
    .first<{ id: number; supplier_id: number; project_id: string | null; status: string; supplier_name: string }>();
  if (!quote) return c.json({ error: "not found" }, 404);
  if (quote.status === "applied") {
    return c.json({ error: "already applied" }, 409);
  }

  const actor = c.get("userEmail");
  const now = new Date().toISOString();

  // ── Project-scoped apply: live prices + tiered approval for overspend ──
  if (quote.project_id) {
    const settings = await loadSettings(c.env.DB);
    const lines = await c.env.DB.prepare(
      `SELECT id, raw_qty, unit_price, matched_material_id, boq_unit_cost, boq_qty, skip_reason
       FROM supplier_quote_lines
       WHERE quote_id = ? AND matched_material_id IS NOT NULL AND skip_reason IS NULL`,
    )
      .bind(quoteId)
      .all<{
        id: number;
        raw_qty: number | null;
        unit_price: number | null;
        matched_material_id: number;
        boq_unit_cost: number | null;
        boq_qty: number | null;
        skip_reason: string | null;
      }>();
    if (lines.results.length === 0) {
      return c.json({ error: "no lines matched to BOQ materials" }, 400);
    }

    let savings = 0;
    let pendingOverspend = 0;
    let appliedCount = 0;
    let pendingCount = 0;
    let totalNew = 0;
    let totalOld = 0;

    for (const l of lines.results) {
      if (l.unit_price == null) continue;
      const boqCost = l.boq_unit_cost;
      // Savings/overspend are calculated against the BOQ allowance qty (the
      // full quantity the project plans to buy), not the qty written on the
      // quote line. If the BOQ qty is missing we fall back to the quote qty
      // so we don't lose the line entirely.
      const qty = l.boq_qty ?? l.raw_qty ?? 0;
      const newTotal = qty * l.unit_price;
      const boqTotal = boqCost != null ? qty * boqCost : 0;
      const over = newTotal - boqTotal; // negative = saving, positive = overspend
      totalNew += newTotal;
      totalOld += boqTotal;
      const status: "applied" | "pending_approval" = over > 0 ? "pending_approval" : "applied";
      const tier: ApprovalTier | null =
        status === "pending_approval" ? tierForOverspend(over, settings) : null;

      await c.env.DB.prepare(
        `INSERT INTO material_live_prices
           (material_id, quote_line_id, quote_id, project_id, unit_price, boq_unit_cost,
            boq_qty, over_amount, status, approval_tier, applied_at, applied_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          l.matched_material_id, l.id, quoteId, quote.project_id,
          l.unit_price, boqCost, qty, over,
          status, tier, now, actor,
        )
        .run();
      await c.env.DB.prepare(
        "UPDATE supplier_quote_lines SET is_applied = 1, old_unit_price = ? WHERE id = ?",
      )
        .bind(boqCost, l.id)
        .run();

      if (status === "applied") {
        appliedCount++;
        if (over < 0) savings += -over;
      } else {
        pendingCount++;
        pendingOverspend += over;
      }
    }

    await c.env.DB.prepare(
      `UPDATE supplier_quotes
       SET status = 'applied', applied_at = ?, applied_by = ?,
           total_applied_value = ?, total_old_value = ?
       WHERE id = ?`,
    )
      .bind(now, actor, totalNew, totalOld, quoteId)
      .run();

    return c.json({
      scope: "project",
      applied: appliedCount,
      pending_approval: pendingCount,
      total_applied_value: totalNew,
      total_old_value: totalOld,
      delta_value: totalNew - totalOld,
      savings,
      pending_overspend: pendingOverspend,
    });
  }

  // ── Catalogue-scoped apply: write new unit_cost to product_suppliers ──
  const lines = await c.env.DB.prepare(
    `SELECT id, raw_qty, unit_price, matched_product_id, matched_product_supplier_id, skip_reason
     FROM supplier_quote_lines
     WHERE quote_id = ? AND matched_product_id IS NOT NULL AND skip_reason IS NULL`,
  )
    .bind(quoteId)
    .all<{
      id: number;
      raw_qty: number | null;
      unit_price: number | null;
      matched_product_id: number;
      matched_product_supplier_id: number | null;
      skip_reason: string | null;
    }>();

  if (lines.results.length === 0) {
    return c.json({ error: "no lines selected to apply" }, 400);
  }

  let totalApplied = 0;
  let totalOld = 0;
  let appliedCount = 0;

  for (const l of lines.results) {
    if (l.unit_price == null) continue;

    let oldPrice: number | null = null;
    if (l.matched_product_supplier_id) {
      const cur = await c.env.DB.prepare(
        "SELECT unit_cost FROM product_suppliers WHERE id = ?",
      )
        .bind(l.matched_product_supplier_id)
        .first<{ unit_cost: number | null }>();
      oldPrice = cur?.unit_cost ?? null;
      await c.env.DB.prepare(
        "UPDATE product_suppliers SET unit_cost = ? WHERE id = ?",
      )
        .bind(l.unit_price, l.matched_product_supplier_id)
        .run();
    } else {
      const ins = await c.env.DB.prepare(
        `INSERT INTO product_suppliers
           (product_id, supplier_name, unit_cost, created_at, created_by)
         VALUES (?, ?, ?, ?, ?) RETURNING id`,
      )
        .bind(l.matched_product_id, quote.supplier_name, l.unit_price, now, actor)
        .first<{ id: number }>();
      await c.env.DB.prepare(
        "UPDATE supplier_quote_lines SET matched_product_supplier_id = ? WHERE id = ?",
      )
        .bind(ins!.id, l.id)
        .run();
    }

    await c.env.DB.prepare(
      "UPDATE supplier_quote_lines SET is_applied = 1, old_unit_price = ? WHERE id = ?",
    )
      .bind(oldPrice, l.id)
      .run();

    if (l.raw_qty != null) {
      totalApplied += l.raw_qty * l.unit_price;
      if (oldPrice != null) totalOld += l.raw_qty * oldPrice;
    }
    appliedCount++;
  }

  await c.env.DB.prepare(
    `UPDATE supplier_quotes
     SET status = 'applied', applied_at = ?, applied_by = ?,
         total_applied_value = ?, total_old_value = ?
     WHERE id = ?`,
  )
    .bind(now, actor, totalApplied, totalOld, quoteId)
    .run();

  return c.json({
    scope: "catalogue",
    applied: appliedCount,
    total_applied_value: totalApplied,
    total_old_value: totalOld,
    delta_value: totalApplied - totalOld,
  });
});

/** List pending price approvals (optionally filter by tier and/or project). */
quotes.get("/_pending-prices", async (c) => {
  const tier = c.req.query("tier");
  const projectId = c.req.query("project_id");
  const where: string[] = ["mlp.status = 'pending_approval'"];
  const params: (string | number)[] = [];
  if (tier) { where.push("mlp.approval_tier = ?"); params.push(tier); }
  if (projectId) { where.push("mlp.project_id = ?"); params.push(projectId); }

  const rows = await c.env.DB.prepare(
    `SELECT mlp.*,
            m.item AS material_item,
            m.element_code AS material_element_code,
            p.code AS project_code, p.name AS project_name,
            s.name AS supplier_name,
            q.filename AS quote_filename
     FROM material_live_prices mlp
     JOIN materials m         ON m.id  = mlp.material_id
     JOIN projects  p         ON p.id  = mlp.project_id
     JOIN supplier_quotes  q  ON q.id  = mlp.quote_id
     JOIN suppliers s         ON s.id  = q.supplier_id
     WHERE ${where.join(" AND ")}
     ORDER BY mlp.applied_at DESC`,
  )
    .bind(...params)
    .all();
  return c.json(rows.results);
});

/** Approve a single pending price (or reject). */
quotes.post("/_pending-prices/:id/decide", async (c) => {
  // Decision happens server-side as the same approver flow used for POs —
  // any user who can manage suppliers + is configured as an approver can act.
  const denied = requirePermission(c, "suppliers.manage");
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ action: "approve" | "reject"; reason?: string }>();
  if (body.action !== "approve" && body.action !== "reject") {
    return c.json({ error: "action must be 'approve' or 'reject'" }, 400);
  }
  const actor = c.get("userEmail");
  const now = new Date().toISOString();
  const row = await c.env.DB.prepare(
    "SELECT id, status FROM material_live_prices WHERE id = ?",
  )
    .bind(id)
    .first<{ id: number; status: string }>();
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.status !== "pending_approval") {
    return c.json({ error: "already decided" }, 409);
  }
  if (body.action === "approve") {
    await c.env.DB.prepare(
      "UPDATE material_live_prices SET status = 'approved', approved_at = ?, approved_by = ? WHERE id = ?",
    )
      .bind(now, actor, id)
      .run();
  } else {
    await c.env.DB.prepare(
      "UPDATE material_live_prices SET status = 'rejected', rejected_at = ?, rejected_by = ?, rejection_reason = ? WHERE id = ?",
    )
      .bind(now, actor, body.reason ?? null, id)
      .run();
  }
  return c.json({ ok: true });
});

/** Discard a quote (soft — keeps the row + lines for audit, just hides it). */
quotes.delete("/:quoteId", async (c) => {
  const denied = requirePermission(c, "suppliers.manage");
  if (denied) return denied;
  const quoteId = Number(c.req.param("quoteId"));
  await c.env.DB.prepare(
    "UPDATE supplier_quotes SET status = 'discarded' WHERE id = ? AND status != 'applied'",
  )
    .bind(quoteId)
    .run();
  return c.json({ ok: true });
});

/** Lightweight product search for the manual match picker in the review UI. */
quotes.get("/_search/products", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  if (q.length < 2) return c.json([]);
  const like = `%${q}%`;
  const rows = await c.env.DB.prepare(
    `SELECT id, element_code, item_no, variant, description, manufacturer, unit, unit_cost
     FROM products
     WHERE description  LIKE ? COLLATE NOCASE
        OR manufacturer LIKE ? COLLATE NOCASE
     ORDER BY description
     LIMIT 25`,
  )
    .bind(like, like)
    .all<{
      id: number;
      element_code: string;
      item_no: number;
      variant: string | null;
      description: string;
      manufacturer: string | null;
      unit: string | null;
      unit_cost: number | null;
    }>();
  const out = rows.results.map((p) => ({
    id: p.id,
    product_code: buildProductCode(p.element_code, p.item_no, p.variant),
    description: p.description,
    manufacturer: p.manufacturer,
    unit: p.unit,
    unit_cost: p.unit_cost,
  }));
  return c.json(out);
});
