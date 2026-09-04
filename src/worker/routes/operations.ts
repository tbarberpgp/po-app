import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import type { Env, Variables } from "../env";
import { requirePermission } from "../auth";
import { sanitizeUserHtml } from "../sanitize-html";
import { isSafeMediaUrl } from "../safe-url";
// Straight from the shared module, not re-exported via ./operatives — that would
// be an import cycle now that operatives.ts pulls siteScope from here.
import { normalisePhone } from "../../shared/operatives-import";
import { isSandboxId } from "../sandbox";
import { signinsCarryOperativeId } from "../schema";
import { sendReportEmail, recipientsFor } from "./site-reports";
import { buildHsPack } from "../../shared/hs-pack-pdf";
import { fuzzyFindPo } from "../poRef";
import { learnAliases, aliasMapsBySupplier, normText } from "../matchMemory";
import { deliveryVariance, matchItemToLine, type VarianceLine, type PriorReceipt } from "../../shared/delivery-variance";
import { summarisePoDeliveries, lineReceivedInFull, isDeliverableLine, PO_DELIVERY_NOTE_COLUMNS, PO_DELIVERY_NOTE_JOIN, type PoDeliveryRow } from "../../shared/po-delivery-status";

// Operations — Phase 1 (site-team basics). Authenticated app-side endpoints:
// the supervisor's view of a site's QR/sign-in link, today's attendance,
// daily briefings & toolbox talks, and the plant-on-site log. The public
// operative-facing side lives in publicOps.ts (mounted at /pub, no auth).
export const operations = new Hono<{ Bindings: Env; Variables: Variables }>();

// Reads open to any authenticated user; mutations require projects.edit
// (superadmin / admin / procurement).
operations.use("/*", async (c, next) => {
  if (c.req.method === "GET") return next();
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  await next();
});

/** URL-friendly 12-char token (Crockford-ish base32, no ambiguous chars). */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let out = "";
  for (const b of bytes) out += alphabet[b & 31];
  return out;
}

/** ArrayBuffer → base64 (chunked to avoid call-stack overflow on large files). */
function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

/** Map a browser file type to a Claude-supported image media type. */
function imgMedia(t: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  if (t === "image/png") return "image/png";
  if (t === "image/gif") return "image/gif";
  if (t === "image/webp") return "image/webp";
  return "image/jpeg";
}

/** Normalise a PO/order number for tolerant comparison (drop spaces, punctuation, case). */
function normPoNo(s: string): string {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Significant lower-case word tokens (len > 2) for fuzzy supplier matching. */
function nameTokens(s: string): Set<string> {
  return new Set((s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length > 2));
}

/** Normalised box on the source image — fractions of width/height, top-left
 *  origin — marking roughly where a field was read. Approximate by design. */
type ReadRegion = { x: number; y: number; w: number; h: number };
type ExtractedDelivery = {
  is_delivery_ticket: boolean;
  /** Clockwise degrees needed to make the ticket's text upright — site photos
   *  are routinely taken sideways. 0 | 90 | 180 | 270. */
  rotation_degrees: 0 | 90 | 180 | 270;
  po_number: string;
  supplier_name: string;
  delivery_note_number: string;
  delivery_date: string;
  summary: string;
  items: Array<{ description: string; qty: number | null; unit: string | null; region?: ReadRegion | null }>;
  regions?: {
    po_number?: ReadRegion | null;
    supplier_name?: ReadRegion | null;
    delivery_note_number?: ReadRegion | null;
    delivery_date?: ReadRegion | null;
  };
};

/** Clamp a model-supplied region to sane normalized bounds; null when junk. */
function cleanRegion(r: unknown): ReadRegion | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  let x = n(o.x), y = n(o.y), w = n(o.w), h = n(o.h);
  if (x == null || y == null || w == null || h == null) return null;
  // Some responses use 0-100 instead of 0-1 — normalise.
  if (x > 1 || y > 1 || w > 1 || h > 1) { x /= 100; y /= 100; w /= 100; h /= 100; }
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x > 1 || y > 1) return null;
  return { x: Math.min(1, x), y: Math.min(1, y), w: Math.min(1 - Math.min(1, x), w), h: Math.min(1 - Math.min(1, y), h) };
}

/** Model sometimes returns placeholder text instead of an empty string for a
 *  field it can't read ("<UNKNOWN>", "N/A", "none"…). Treat those as blank so
 *  they never look like a real PO number / supplier. */
function blankIfPlaceholder(s: string): string {
  const t = s.trim();
  if (!t) return "";
  const low = t.toLowerCase().replace(/[<>[\]()]/g, "");
  if (["unknown", "n/a", "na", "none", "not shown", "not visible", "not applicable", "unclear", "-", "—", "?"].includes(low)) return "";
  return t;
}
type ExtractResult =
  | { ok: true; extracted: ExtractedDelivery }
  | { ok: false; status: 400 | 422 | 502 | 503; error: string };

/** Read a delivery ticket (photo or PDF) with Claude from an uploaded file.
 *  Base64-encodes in the Worker — fine for a single upload. */
async function extractDeliveryTicket(env: Env, file: unknown): Promise<ExtractResult> {
  if (!env.ANTHROPIC_API_KEY) return { ok: false, status: 503, error: "Ticket scanning isn't set up on the server (no AI key)." };
  if (!(file instanceof File) || file.size === 0) return { ok: false, status: 400, error: "Attach a delivery ticket photo or PDF." };
  if (file.size > 10 * 1024 * 1024) return { ok: false, status: 400, error: "File too large (max 10MB)." };

  const b64 = bufToBase64(await file.arrayBuffer());
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  const block = isPdf
    ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: b64 } }
    : { type: "image" as const, source: { type: "base64" as const, media_type: imgMedia(file.type), data: b64 } };
  return runDeliveryExtraction(env, block);
}

/** Read a delivery ticket from a public URL. Claude fetches the image itself, so
 *  the Worker does NO download or base64 — critical on the free plan's 10ms CPU
 *  budget when scanning many WhatsApp photos in a row. */
async function extractDeliveryTicketFromUrl(env: Env, url: string): Promise<ExtractResult> {
  if (!env.ANTHROPIC_API_KEY) return { ok: false, status: 503, error: "Ticket scanning isn't set up on the server (no AI key)." };
  if (!isSafeMediaUrl(url)) return { ok: false, status: 400, error: "unsafe media url" };
  const isPdf = url.split("?")[0].toLowerCase().endsWith(".pdf");
  const block = isPdf
    ? { type: "document" as const, source: { type: "url" as const, url } }
    : { type: "image" as const, source: { type: "url" as const, url } };
  return runDeliveryExtraction(env, block);
}

/** Shared Claude call + tool parse for delivery-ticket extraction. Takes the
 *  already-built content block (base64 upload or URL) so the prompt/schema stay
 *  identical across every entry point. */
type DeliveryContentBlock =
  | { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } }
  | { type: "image"; source: { type: "url"; url: string } }
  | { type: "document"; source: { type: "url"; url: string } };
async function runDeliveryExtraction(env: Env, block: DeliveryContentBlock): Promise<ExtractResult> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let response;
  try {
    response = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 1024,
      system:
        "You examine a photo or PDF from a construction site's WhatsApp group and decide whether it is a supplier's DELIVERY TICKET / delivery note / advice note (the document that comes with a material delivery). Many images are NOT delivery tickets — they are site/progress photos of buildings or works, training certificates (CPD, NPORS, CSCS, medical/fit-to-work), invoices, RAMS, or general paperwork. For anything that is not a genuine delivery note, set is_delivery_ticket=false and leave every other field as an empty string — do NOT invent or guess a PO number, supplier or date, and never output placeholder text like 'UNKNOWN' or 'N/A' (use an empty string). Only when it really is a delivery note, set is_delivery_ticket=true and fill the fields exactly as printed. Numeric fields must be plain numbers.",
      tools: [
        {
          name: "extract_delivery_ticket",
          description: "Classify whether the image is a delivery ticket and, if so, extract the key fields so it can be matched to a purchase order.",
          input_schema: {
            type: "object" as const,
            properties: {
              is_delivery_ticket: { type: "boolean", description: "TRUE only if this image is a genuine supplier delivery ticket / delivery note / advice note. FALSE for site photos, certificates, invoices, RAMS or any other document." },
              rotation_degrees: { type: "number", enum: [0, 90, 180, 270], description: "How many degrees CLOCKWISE this image must be rotated for the printed text to read upright, left-to-right. 0 if it already reads upright. Site photos are often taken sideways: if the text runs bottom-to-top up the left side, answer 90; if upside down, 180; if it runs top-to-bottom down the right side, answer 270." },
              po_number: { type: "string", description: "The purchase order / order number referenced on the ticket (the buyer's PO number), exactly as printed. Empty string if none shown or not a delivery ticket." },
              supplier_name: { type: "string", description: "The supplier/company that issued the ticket — usually the letterhead. Empty string if unclear." },
              delivery_note_number: { type: "string", description: "The supplier's own delivery note / advice note number. Empty string if none." },
              delivery_date: { type: "string", description: "Delivery date as YYYY-MM-DD if shown, else empty string." },
              summary: { type: "string", description: "A short one-line summary of what was delivered, e.g. '12 pallets insulation board'." },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    description: { type: "string" },
                    qty: { type: "number" },
                    unit: { type: "string" },
                    region: {
                    type: "object",
                    properties: {
                      x: { type: "number", description: "left edge, 0-1 fraction of image width" },
                      y: { type: "number", description: "top edge, 0-1 fraction of image height" },
                      w: { type: "number", description: "width, 0-1 fraction" },
                      h: { type: "number", description: "height, 0-1 fraction" },
                    },
                    required: ["x", "y", "w", "h"],
                  },
                  },
                  required: ["description"],
                },
              },
              regions: {
                type: "object",
                description: "Where each extracted field sits ON THE IMAGE, as normalized boxes (fractions of image width/height, top-left origin). Approximate is fine — aim for a box that covers the printed text. Omit a field you can't localise.",
                properties: {
                  po_number: {
                    type: "object",
                    properties: {
                      x: { type: "number", description: "left edge, 0-1 fraction of image width" },
                      y: { type: "number", description: "top edge, 0-1 fraction of image height" },
                      w: { type: "number", description: "width, 0-1 fraction" },
                      h: { type: "number", description: "height, 0-1 fraction" },
                    },
                    required: ["x", "y", "w", "h"],
                  },
                  supplier_name: {
                    type: "object",
                    properties: {
                      x: { type: "number", description: "left edge, 0-1 fraction of image width" },
                      y: { type: "number", description: "top edge, 0-1 fraction of image height" },
                      w: { type: "number", description: "width, 0-1 fraction" },
                      h: { type: "number", description: "height, 0-1 fraction" },
                    },
                    required: ["x", "y", "w", "h"],
                  },
                  delivery_note_number: {
                    type: "object",
                    properties: {
                      x: { type: "number", description: "left edge, 0-1 fraction of image width" },
                      y: { type: "number", description: "top edge, 0-1 fraction of image height" },
                      w: { type: "number", description: "width, 0-1 fraction" },
                      h: { type: "number", description: "height, 0-1 fraction" },
                    },
                    required: ["x", "y", "w", "h"],
                  },
                  delivery_date: {
                    type: "object",
                    properties: {
                      x: { type: "number", description: "left edge, 0-1 fraction of image width" },
                      y: { type: "number", description: "top edge, 0-1 fraction of image height" },
                      w: { type: "number", description: "width, 0-1 fraction" },
                      h: { type: "number", description: "height, 0-1 fraction" },
                    },
                    required: ["x", "y", "w", "h"],
                  },
                },
              },
            },
            required: ["is_delivery_ticket", "po_number", "supplier_name", "summary"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "extract_delivery_ticket" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: [
        { role: "user", content: [block, { type: "text", text: "Extract the delivery ticket details via extract_delivery_ticket." }] as any },
      ],
    });
  } catch (e) {
    console.error("delivery scan failed", e);
    return { ok: false, status: 502, error: "Couldn't read that file. Try a clearer photo or a PDF." };
  }

  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) return { ok: false, status: 422, error: "Couldn't extract anything from the ticket." };
  const x = toolUse.input as {
    is_delivery_ticket?: boolean; rotation_degrees?: number; po_number?: string; supplier_name?: string; delivery_note_number?: string;
    delivery_date?: string; summary?: string; items?: Array<{ description?: string; qty?: number; unit?: string; region?: unknown }>;
    regions?: Record<string, unknown>;
  };
  return {
    ok: true,
    extracted: {
      is_delivery_ticket: x.is_delivery_ticket === true,
      rotation_degrees: ([0, 90, 180, 270].includes(Number(x.rotation_degrees)) ? Number(x.rotation_degrees) : 0) as 0 | 90 | 180 | 270,
      po_number: blankIfPlaceholder(x.po_number ?? ""),
      supplier_name: blankIfPlaceholder(x.supplier_name ?? ""),
      delivery_note_number: blankIfPlaceholder(x.delivery_note_number ?? ""),
      delivery_date: /^\d{4}-\d{2}-\d{2}$/.test((x.delivery_date ?? "").trim()) ? (x.delivery_date ?? "").trim() : "",
      summary: (x.summary ?? "").trim(),
      items: Array.isArray(x.items)
        ? x.items.filter((i) => i && i.description).map((i) => ({ description: String(i.description).trim(), qty: typeof i.qty === "number" ? i.qty : null, unit: i.unit ? String(i.unit).trim() : null, region: cleanRegion(i.region) }))
        : [],
      regions: {
        po_number: cleanRegion(x.regions?.po_number),
        supplier_name: cleanRegion(x.regions?.supplier_name),
        delivery_note_number: cleanRegion(x.regions?.delivery_note_number),
        delivery_date: cleanRegion(x.regions?.delivery_date),
      },
    },
  };
}

/** Tolerant PO-number equality: identical after normalising, or one is a
 *  suffix of the other (covers prefixes like "PO-" / branch codes). */
function poNoMatches(a: string, b: string): boolean {
  const x = normPoNo(a), y = normPoNo(b);
  return !!x && !!y && (x === y || x.endsWith(y) || y.endsWith(x));
}

// "The site day". Stored timestamps are UTC ISO; we group by the UTC calendar
// date. A construction site never signs in at ~01:00 BST, so the rollover
// offset from UK local time is immaterial in practice.
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

type SiteScope = { baseId: string; memberIds: string[]; group: { id: string; name: string } | null };

/** Resolve a project to its shared-operations scope. If the project belongs to a
 *  site group, the group's "base" project physically hosts the shared records
 *  (sign-in, RAMS, notices, deliveries) and `memberIds` lists every contract in
 *  the site. Ungrouped → the project itself. Never throws, so the whole feature
 *  is inert (per-contract behaviour) until the 0046 migration has run. */
export async function siteScope(env: Env, projectId: string): Promise<SiteScope> {
  try {
    const row = await env.DB.prepare(
      `SELECT g.id AS gid, g.name AS gname, g.base_project_id AS base
         FROM projects p JOIN site_groups g ON g.id = p.site_group_id
        WHERE p.id = ?`,
    ).bind(projectId).first<{ gid: string; gname: string; base: string | null }>();
    if (!row) return { baseId: projectId, memberIds: [projectId], group: null };
    const members = await env.DB.prepare(
      "SELECT id FROM projects WHERE site_group_id = ? AND deleted_at IS NULL",
    ).bind(row.gid).all<{ id: string }>();
    const memberIds = members.results.map((m) => m.id);
    return {
      baseId: row.base || projectId,
      memberIds: memberIds.length ? memberIds : [projectId],
      group: { id: row.gid, name: row.gname },
    };
  } catch {
    return { baseId: projectId, memberIds: [projectId], group: null };
  }
}

/** Shorthand: the base project id that hosts a project's shared-ops records. */
async function opsBase(env: Env, projectId: string): Promise<string> {
  return (await siteScope(env, projectId)).baseId;
}

// ── Operations landing: every live project with a site-activity summary ──────
operations.get("/sites", async (c) => {
  const d = today();
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.code, p.name, p.client,
            (SELECT COUNT(*) FROM site_signins si
              WHERE si.project_id = p.id
                AND substr(si.signed_in_at,1,10) = ?
                AND si.signed_out_at IS NULL)            AS on_site_now,
            (SELECT COUNT(*) FROM site_signins si
              WHERE si.project_id = p.id
                AND substr(si.signed_in_at,1,10) = ?)    AS signins_today,
            (SELECT COUNT(*) FROM plant_logs pl
              WHERE pl.project_id = p.id AND pl.off_hire_to IS NULL) AS plant_on_site,
            (SELECT t.token FROM site_tokens t
              WHERE t.project_id = p.id AND t.active = 1 LIMIT 1) AS token
       FROM projects p
      WHERE p.deleted_at IS NULL
      ORDER BY on_site_now DESC, signins_today DESC, p.created_at DESC`,
  ).bind(d, d).all();
  return c.json(rows.results);
});

// ── Site groups — bundle contracts that are areas of one physical site ───────
// Operational sharing only: sign-in / attendance / RAMS / notices / deliveries
// resolve to the group's base project. Commercials stay per contract.
// (1-segment static paths — no collision with the 2+ segment /:projectId routes.)
operations.get("/site-groups", async (c) => {
  try {
    const groups = await c.env.DB.prepare(
      "SELECT id, name, base_project_id, created_at FROM site_groups ORDER BY created_at DESC",
    ).all<{ id: string; name: string; base_project_id: string | null; created_at: string }>();
    const members = await c.env.DB.prepare(
      `SELECT id, code, name, site_group_id FROM projects
        WHERE site_group_id IS NOT NULL AND deleted_at IS NULL ORDER BY code`,
    ).all<{ id: string; code: string; name: string; site_group_id: string }>();
    const byGroup = new Map<string, Array<{ id: string; code: string; name: string }>>();
    for (const m of members.results) {
      const arr = byGroup.get(m.site_group_id) ?? [];
      arr.push({ id: m.id, code: m.code, name: m.name });
      byGroup.set(m.site_group_id, arr);
    }
    return c.json(groups.results.map((g) => ({ ...g, members: byGroup.get(g.id) ?? [] })));
  } catch (e) {
    console.warn("site-groups list skipped (pre-0046):", e instanceof Error ? e.message : e);
    return c.json([]);
  }
});

operations.post("/site-groups", async (c) => {
  const body = await c.req.json<{ name?: string; project_ids?: string[]; base_project_id?: string }>();
  const name = (body.name ?? "").trim();
  const ids = Array.isArray(body.project_ids) ? [...new Set(body.project_ids.filter((x) => typeof x === "string"))] : [];
  if (!name) return c.json({ error: "Site name required." }, 400);
  if (ids.length < 2) return c.json({ error: "Pick at least two contracts to group into a site." }, 400);
  const base = body.base_project_id && ids.includes(body.base_project_id) ? body.base_project_id : ids[0];
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "INSERT INTO site_groups (id, name, base_project_id, created_at, created_by) VALUES (?,?,?,?,?)",
  ).bind(id, name, base, now, c.get("userEmail")).run();
  await c.env.DB.batch(ids.map((pid) =>
    c.env.DB.prepare("UPDATE projects SET site_group_id = ? WHERE id = ?").bind(id, pid)));
  return c.json({ id, base_project_id: base });
});

operations.patch("/site-groups/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ name?: string; project_ids?: string[]; base_project_id?: string }>();
  const exists = await c.env.DB.prepare("SELECT id FROM site_groups WHERE id = ?").bind(id).first();
  if (!exists) return c.json({ error: "not found" }, 404);
  if (body.name != null && body.name.trim()) {
    await c.env.DB.prepare("UPDATE site_groups SET name = ? WHERE id = ?").bind(body.name.trim(), id).run();
  }
  if (Array.isArray(body.project_ids)) {
    const ids = [...new Set(body.project_ids.filter((x) => typeof x === "string"))];
    await c.env.DB.prepare("UPDATE projects SET site_group_id = NULL WHERE site_group_id = ?").bind(id).run();
    if (ids.length) {
      await c.env.DB.batch(ids.map((pid) =>
        c.env.DB.prepare("UPDATE projects SET site_group_id = ? WHERE id = ?").bind(id, pid)));
    }
  }
  if (body.base_project_id) {
    await c.env.DB.prepare("UPDATE site_groups SET base_project_id = ? WHERE id = ?").bind(body.base_project_id, id).run();
  }
  return c.json({ ok: true });
});

operations.delete("/site-groups/:id", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare("UPDATE projects SET site_group_id = NULL WHERE site_group_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM site_groups WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// The site group a project belongs to (members + base) — for the Operations tab
// banner + delivery contract tagging. null when ungrouped.
operations.get("/:projectId/site-group", async (c) => {
  const scope = await siteScope(c.env, c.req.param("projectId"));
  if (!scope.group) return c.json(null);
  const rows = await c.env.DB.prepare(
    "SELECT id, code, name FROM projects WHERE site_group_id = ? AND deleted_at IS NULL ORDER BY code",
  ).bind(scope.group.id).all<{ id: string; code: string; name: string }>();
  return c.json({ id: scope.group.id, name: scope.group.name, base_project_id: scope.baseId, members: rows.results });
});

// ── Per-site public sign-in link (the QR target) ────────────────────────────
operations.get("/:projectId/site-link", async (c) => {
  const projectId = await opsBase(c.env, c.req.param("projectId"));
  const row = await c.env.DB.prepare(
    "SELECT token FROM site_tokens WHERE project_id = ? AND active = 1 LIMIT 1",
  ).bind(projectId).first<{ token: string }>();
  return c.json({ token: row?.token ?? null });
});

/** Ensure a link exists (create on first use), returning the active token. */
operations.post("/:projectId/site-link", async (c) => {
  const projectId = await opsBase(c.env, c.req.param("projectId"));
  let row = await c.env.DB.prepare(
    "SELECT token FROM site_tokens WHERE project_id = ? AND active = 1 LIMIT 1",
  ).bind(projectId).first<{ token: string }>();
  if (!row) {
    const token = newToken();
    await c.env.DB.prepare(
      "INSERT INTO site_tokens (token, project_id, active, created_at, created_by) VALUES (?,?,1,?,?)",
    ).bind(token, projectId, new Date().toISOString(), c.get("userEmail")).run();
    row = { token };
  }
  return c.json({ token: row.token });
});

/** Rotate the link — deactivates the old token (revokes the old QR). */
operations.post("/:projectId/site-link/rotate", async (c) => {
  const projectId = await opsBase(c.env, c.req.param("projectId"));
  const token = newToken();
  await c.env.DB.prepare(
    "UPDATE site_tokens SET active = 0 WHERE project_id = ? AND active = 1",
  ).bind(projectId).run();
  await c.env.DB.prepare(
    "INSERT INTO site_tokens (token, project_id, active, created_at, created_by) VALUES (?,?,1,?,?)",
  ).bind(token, projectId, new Date().toISOString(), c.get("userEmail")).run();
  return c.json({ token });
});

// ── Attendance for a day (default today) ─────────────────────────────────────
operations.get("/:projectId/attendance", async (c) => {
  const projectId = await opsBase(c.env, c.req.param("projectId"));
  const date = c.req.query("date") || today();
  const rows = await c.env.DB.prepare(
    `SELECT id, name, company, trade, phone, signature, lat, lng, accuracy,
            signed_in_at, signed_out_at, signed_out_auto
       FROM site_signins
      WHERE project_id = ? AND substr(signed_in_at,1,10) = ?
      ORDER BY signed_in_at DESC`,
  ).bind(projectId, date).all<Record<string, unknown>>();

  // Attach which notices each sign-in acknowledged.
  const ids = rows.results.map((r) => r.id as number);
  const acksBySignin = new Map<number, number[]>();
  if (ids.length) {
    const acks = await c.env.DB.prepare(
      `SELECT signin_id, notice_id FROM site_notice_acks
        WHERE signin_id IN (${ids.map(() => "?").join(",")})`,
    ).bind(...ids).all<{ signin_id: number; notice_id: number }>();
    for (const a of acks.results) {
      const arr = acksBySignin.get(a.signin_id) ?? [];
      arr.push(a.notice_id);
      acksBySignin.set(a.signin_id, arr);
    }
  }

  // Standing daily briefing is mandatory at sign-in, so a sign-in implies it was
  // acknowledged. RAMS-signed is resolved from the operative register by phone
  // (signins aren't linked to operatives directly). Both are wrapped so a
  // missing operatives table never breaks attendance.
  let hasBriefing = false;
  const activeRamsIds = new Set<number>();
  const signedByPhone = new Map<string, Set<number>>();
  try {
    const brief = await c.env.DB.prepare("SELECT value FROM settings WHERE key = ?")
      .bind(`site_briefing:${projectId}`).first<{ value: string }>();
    hasBriefing = !!brief?.value;
  } catch { /* settings table is always present */ }
  try {
    const ramsRows = await c.env.DB.prepare(
      "SELECT id FROM rams_documents WHERE project_id = ? AND active = 1",
    ).bind(projectId).all<{ id: number }>();
    for (const r of ramsRows.results) activeRamsIds.add(r.id);
    if (activeRamsIds.size) {
      const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const signs = await c.env.DB.prepare(
        `SELECT o.phone_norm AS phone_norm, s.rams_id AS rams_id
           FROM operative_rams_signs s JOIN operatives o ON o.id = s.operative_id
          WHERE s.project_id = ? AND s.signed_at IS NOT NULL AND s.signed_at >= ?
            AND o.phone_norm IS NOT NULL`,
      ).bind(projectId, monthAgo).all<{ phone_norm: string; rams_id: number }>();
      for (const r of signs.results) {
        if (!activeRamsIds.has(r.rams_id)) continue;
        const set = signedByPhone.get(r.phone_norm) ?? new Set<number>();
        set.add(r.rams_id);
        signedByPhone.set(r.phone_norm, set);
      }
    }
  } catch (e) { console.warn("attendance rams skipped:", e instanceof Error ? e.message : e); }

  return c.json(
    rows.results.map((r) => {
      const phoneNorm = normalisePhone(r.phone as string | null);
      const signedN = phoneNorm ? (signedByPhone.get(phoneNorm)?.size ?? 0) : 0;
      return {
        ...r,
        ack_notice_ids: acksBySignin.get(r.id as number) ?? [],
        // null = no standing briefing set for this site (nothing to show).
        briefing_ack: hasBriefing ? true : null,
        // null = no active RAMS on this site (nothing to track).
        rams_signed: activeRamsIds.size === 0 ? null : signedN >= activeRamsIds.size,
      };
    }),
  );
});

// ── Manager sign-out ─────────────────────────────────────────────────────────
// Close everyone still on site for this project in one go (end of day). Listed
// before the per-id route so "signout-all" isn't read as an :id.
/** Register + briefing-version data for a range — the H&S paper trail. Shared
 *  by the attendance export endpoint and the H&S pack (download + scheduled
 *  email release). */
async function attendanceExportData(env: Env, projectId: string, from: string, to: string) {
  const signins = (await env.DB.prepare(
    `SELECT id, name, company, trade, phone, signature, signed_in_at, signed_out_at, signed_out_auto
       FROM site_signins
      WHERE project_id = ? AND substr(signed_in_at, 1, 10) BETWEEN ? AND ?
      ORDER BY signed_in_at`,
  ).bind(projectId, from, to).all<Record<string, unknown>>()).results;
  const acks = (await env.DB.prepare(
    // d.* is the distributed sign-off: the operative's drawn signature and where
    // they took the talk. site_notice_acks itself only records THAT they acked —
    // the evidence lives on operative_notice_acks, so join it back in.
    `SELECT a.signin_id, a.notice_id, a.name, a.acked_at, n.type AS notice_type, n.title, n.notice_date,
            COALESCE(s.company, o.company) AS company, COALESCE(s.trade, o.trade) AS trade,
            d.signature, d.lat, d.lng, d.geo_status
       FROM site_notice_acks a
       JOIN site_notices n ON n.id = a.notice_id
       LEFT JOIN site_signins s ON s.id = a.signin_id
       LEFT JOIN operative_notice_acks d
              ON d.notice_id = a.notice_id AND d.acked_at = a.acked_at
       LEFT JOIN operatives o ON o.id = d.operative_id
      WHERE n.project_id = ? AND substr(a.acked_at, 1, 10) BETWEEN ? AND ?
      ORDER BY a.acked_at`,
  ).bind(projectId, from, to).all<Record<string, unknown>>()).results;

  // The standing daily briefing is mandatory at sign-in, so every sign-in
  // implies acceptance of the version IN FORCE AT THAT INSTANT. The version
  // history says which text that was; each sign-in gets its version's tag
  // (B1, B2, …) and the export lists every version given in the range.
  type BriefingVersion = { title: string; content: string | null; effective_from: string };
  let versions: BriefingVersion[] = [];
  try {
    versions = (await env.DB.prepare(
      `SELECT title, content, effective_from FROM site_briefing_history
        WHERE project_id = ? ORDER BY effective_from`,
    ).bind(projectId).all<BriefingVersion>()).results;
  } catch { /* pre-migration — fall through to the settings baseline */ }
  if (!versions.length) {
    // No history yet: the current standing briefing is the only known version.
    const briefingRow = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
      .bind(`site_briefing:${projectId}`).first<{ value: string }>();
    if (briefingRow?.value) {
      try {
        const cur = JSON.parse(briefingRow.value) as { title?: string; content?: string; updated_at?: string };
        if (cur.title) versions = [{ title: cur.title, content: cur.content ?? null, effective_from: cur.updated_at ?? "1970-01-01T00:00:00.000Z" }];
      } catch { /* unparseable blob — export shows no briefing */ }
    }
  }
  // Version in force at an instant: the last one starting at or before it.
  // Sign-ins predating all recorded versions attribute to the earliest known
  // one (histories start when the feature landed, not when the site opened).
  const versionAt = (iso: string): BriefingVersion | null => {
    let v: BriefingVersion | null = null;
    for (const h of versions) { if (h.effective_from <= iso) v = h; else break; }
    return v ?? versions[0] ?? null;
  };
  // Versions actually given in this range = those some sign-in accepted, in
  // first-accepted order. Cleared periods ('' title) never tag.
  const tagByKey = new Map<string, string>();
  const briefings: Array<{ tag: string; title: string; content: string | null; effective_from: string }> = [];
  const taggedSignins = signins.map((s) => {
    const v = versionAt(String(s.signed_in_at));
    if (!v || !v.title) return { ...s, briefing_tag: null };
    const key = v.effective_from;
    let tag = tagByKey.get(key);
    if (!tag) {
      tag = `B${briefings.length + 1}`;
      tagByKey.set(key, tag);
      briefings.push({ tag, title: v.title, content: v.content, effective_from: v.effective_from });
    }
    return { ...s, briefing_tag: tag };
  });
  return { from, to, signins: taggedSignins, acks, briefings };
}

operations.get("/:projectId/attendance/export", async (c) => {
  const projectId = await opsBase(c.env, c.req.param("projectId"));
  const from = (c.req.query("from") || today()).slice(0, 10);
  const to = (c.req.query("to") || from).slice(0, 10);
  return c.json(await attendanceExportData(c.env, projectId, from, to));
});

// ── H&S pack — register + briefings + toolbox-talk copies + qualifications ──

/** Everything the pack needs: the register data plus the toolbox talks given
 *  in the range (full copy) and the qualification register for the site's
 *  crew (operatives assigned to any contract sharing this site). */
async function hsPackData(env: Env, projectId: string, from: string, to: string) {
  const base = await attendanceExportData(env, projectId, from, to);
  // sections_json carries the parsed talk, so the pack can reproduce the actual
  // document (headings, bullets, tables) rather than a flat text blob.
  const talkRows = (await env.DB.prepare(
    `SELECT id, title, content, sections_json, notice_date, created_by FROM site_notices
      WHERE project_id = ? AND type = 'toolbox' AND notice_date BETWEEN ? AND ?
      ORDER BY notice_date, created_at`,
  ).bind(projectId, from, to).all<Record<string, unknown>>()).results;
  const talks = talkRows.map((t) => {
    let doc: unknown = null;
    // Unparseable JSON must not sink the whole pack — fall back to the text.
    try { if (t.sections_json) doc = JSON.parse(String(t.sections_json)); }
    catch (e) { console.warn(`talk ${t.id} sections_json unreadable:`, e instanceof Error ? e.message : e); }
    const { sections_json: _drop, ...rest } = t;
    return { ...rest, doc };
  });
  const scope = await siteScope(env, projectId);
  const memberIds = scope.memberIds.length ? scope.memberIds : [projectId];
  const quals = (await env.DB.prepare(
    `SELECT o.name AS operative, o.company, o.trade,
            q.qual_type, q.card_no, q.expiry_date, q.verified_at, q.source
       FROM operatives o
       LEFT JOIN operative_quals q ON q.operative_id = o.id
      WHERE o.archived_at IS NULL AND o.assigned_project_id IN (${memberIds.map(() => "?").join(",")})
      ORDER BY o.name, q.qual_type`,
  ).bind(...memberIds).all<Record<string, unknown>>()).results;
  return { ...base, talks, quals };
}

operations.get("/:projectId/hs-pack", async (c) => {
  const projectId = await opsBase(c.env, c.req.param("projectId"));
  const from = (c.req.query("from") || today()).slice(0, 10);
  const to = (c.req.query("to") || from).slice(0, 10);
  return c.json(await hsPackData(c.env, projectId, from, to));
});

/** The hs_pack distribution rule shaped as the HsPackSchedule the Operations
 *  card has always consumed — H&S release now lives in distribution_rules
 *  (migration 0109), but the per-project card keeps its familiar shape. */
type HsPackRuleRow = {
  id: number; frequency: string; weekday: number | null; send_time: string | null;
  recipients: string; include_managers: number; enabled: number; last_sent_at: string | null;
};
function ruleToSchedule(projectId: string, r: HsPackRuleRow) {
  let emails: string[] = [];
  try { const v = JSON.parse(r.recipients || "[]"); if (Array.isArray(v)) emails = v.filter((x): x is string => typeof x === "string"); } catch { /* comma fallback below */ }
  if (!emails.length && r.recipients?.includes("@")) emails = r.recipients.split(/[,;\s]+/).filter((x) => x.includes("@"));
  return {
    project_id: projectId,
    frequency: r.frequency === "monthly" ? "monthly" : "weekly",
    weekday: r.weekday ?? 1,
    send_hour: Math.min(23, Math.max(0, parseInt((r.send_time ?? "7").split(":")[0], 10) || 0)),
    recipients: emails.join(", ") || null,
    include_managers: r.include_managers, active: r.enabled,
    last_sent_at: r.last_sent_at, updated_at: null, updated_by: null,
  };
}
async function hsPackRule(env: Env, projectId: string): Promise<HsPackRuleRow | null> {
  try {
    return await env.DB.prepare(
      `SELECT id, frequency, weekday, send_time, recipients, include_managers, enabled, last_sent_at
         FROM distribution_rules WHERE content = 'hs_pack' AND project_id = ? ORDER BY id LIMIT 1`,
    ).bind(projectId).first<HsPackRuleRow>();
  } catch { return null; /* pre-0109 */ }
}

operations.get("/:projectId/hs-pack/schedule", async (c) => {
  const projectId = await opsBase(c.env, c.req.param("projectId"));
  const rule = await hsPackRule(c.env, projectId);
  return c.json(rule ? ruleToSchedule(projectId, rule) : null);
});

operations.put("/:projectId/hs-pack/schedule", async (c) => {
  const projectId = await opsBase(c.env, c.req.param("projectId"));
  const b = await c.req.json<{ frequency?: string; weekday?: number; send_hour?: number; recipients?: string; include_managers?: number | boolean; active?: number | boolean }>();
  const frequency = b.frequency === "monthly" ? "monthly" : "weekly";
  const weekday = Math.min(7, Math.max(1, Math.round(Number(b.weekday) || 1)));
  const sendHour = Math.min(23, Math.max(0, Math.round(Number(b.send_hour ?? 7))));
  const sendTime = `${String(sendHour).padStart(2, "0")}:00`;
  const emails = (b.recipients ?? "").split(/[,;\s]+/).map((x) => x.trim()).filter((x) => x.includes("@"));
  const existing = await hsPackRule(c.env, projectId);
  if (existing) {
    await c.env.DB.prepare(
      `UPDATE distribution_rules SET frequency=?, weekday=?, send_time=?, recipients=?, include_managers=?, enabled=? WHERE id=?`,
    ).bind(frequency, weekday, sendTime, JSON.stringify(emails), b.include_managers ? 1 : 0, b.active ? 1 : 0, existing.id).run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO distribution_rules (project_id, name, content, frequency, format, recipients, send_time, weekday, only_if, enabled, include_managers, created_at, created_by)
       VALUES (?, 'H&S pack', 'hs_pack', ?, 'pdf', ?, ?, ?, 'always', ?, ?, ?, ?)`,
    ).bind(projectId, frequency, JSON.stringify(emails), sendTime, weekday, b.active ? 1 : 0, b.include_managers ? 1 : 0,
      new Date().toISOString(), c.get("userEmail") ?? null).run();
  }
  const rule = await hsPackRule(c.env, projectId);
  return c.json(rule ? ruleToSchedule(projectId, rule) : null);
});

// Manual release — same pack the schedule would send, on demand.
operations.post("/:projectId/hs-pack/send-now", async (c) => {
  const projectId = await opsBase(c.env, c.req.param("projectId"));
  const b = await c.req.json<{ from?: string; to?: string }>().catch(() => ({} as { from?: string; to?: string }));
  const to = (b.to || today()).slice(0, 10);
  const from = (b.from || new Date(Date.now() - 6 * 86_400_000).toISOString()).slice(0, 10);
  const recipients = await hsPackRecipients(c.env, projectId);
  const result = await sendHsPack(c.env, projectId, from, to, recipients);
  if (!result.ok) return c.json({ error: result.error ?? "send failed" }, 400);
  await c.env.DB.prepare("UPDATE distribution_rules SET last_sent_at = ? WHERE content = 'hs_pack' AND project_id = ?")
    .bind(new Date().toISOString(), projectId).run()
    .catch(() => { /* pre-0109 — nothing to stamp */ });
  return c.json(result);
});

/** Compose the pack PDF and email it to the schedule's recipients. */
/** Recipients for a project's H&S pack: the addresses on its hs_pack distribution
 *  rule, plus site managers when the rule opts in (or when there's no rule yet, so
 *  a manual Send-now still reaches someone). H&S auto-release lives in the shared
 *  distribution_rules table now — see Reports → Distribution. */
async function hsPackRecipients(env: Env, projectId: string): Promise<string[]> {
  let custom: string[] = [], inclMgr = true, hasRule = false;
  try {
    const rule = await env.DB.prepare(
      "SELECT recipients, include_managers FROM distribution_rules WHERE content = 'hs_pack' AND project_id = ? ORDER BY id LIMIT 1",
    ).bind(projectId).first<{ recipients: string; include_managers: number }>();
    if (rule) {
      hasRule = true;
      try { const v = JSON.parse(rule.recipients || "[]"); if (Array.isArray(v)) custom = v.filter((x): x is string => typeof x === "string"); } catch { /* keep custom empty */ }
      inclMgr = rule.include_managers !== 0;
    }
  } catch { /* pre-0109 — fall back to managers */ }
  const managers = (!hasRule || inclMgr) ? await recipientsFor(env, projectId).catch(() => []) : [];
  return [...new Set([...custom, ...managers].filter((x) => x && x.includes("@")))];
}

/** Build and email the H&S pack for a project over a date range to explicit
 *  recipients (from the send-now endpoint or the distribution-rule cron) — no
 *  longer coupled to a per-project schedule row. */
async function sendHsPack(env: Env, projectId: string, from: string, to: string, recipients: string[]): Promise<{ ok: boolean; sent_to?: string[]; error?: string }> {
  const proj = await env.DB.prepare("SELECT code, name FROM projects WHERE id = ?").bind(projectId)
    .first<{ code: string; name: string }>();
  if (!proj) return { ok: false, error: "project not found" };
  const to_ = [...new Set(recipients.filter((x) => x && x.includes("@")))];
  if (!to_.length) return { ok: false, error: "No recipients — add them to the H&S distribution rule in Reports → Distribution, or set the site's manager emails." };

  const data = await hsPackData(env, projectId, from, to);
  let logo: Uint8Array | null = null;
  try {
    const res = await env.ASSETS.fetch(new Request("https://assets.local/logo.png"));
    if (res.ok) logo = new Uint8Array(await res.arrayBuffer());
  } catch { /* pack renders without the logo */ }
  const bytes = await buildHsPack({
    projectCode: proj.code, projectName: proj.name, from, to,
    signins: data.signins as never, acks: data.acks as never, briefings: data.briefings,
    talks: data.talks as never, quals: data.quals as never,
    logoPng: logo, today: new Date().toISOString().slice(0, 10),
  });
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const range = from === to ? from : `${from} to ${to}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px">
    <h2 style="font-size:18px;color:#0f1130;margin:0 0 8px">Health &amp; Safety pack — ${proj.code} ${proj.name}</h2>
    <p style="font-size:13px;color:#333;line-height:1.5">Attached for ${range}: the sign-in register with daily-briefing acceptance and operative signatures,
    the briefing texts given, toolbox talks (tagged, full copy, acknowledgements) and the operative qualification register.</p>
    <p style="font-size:11px;color:#6a6d8a">Generated automatically by the PGP projects app.</p>
  </div>`;
  const sent = await sendReportEmail(env, to_, `H&S pack — ${proj.code} ${proj.name} (${range})`, html, undefined,
    [{ filename: `${proj.code}-hs-pack-${from}_to_${to}.pdf`, content: btoa(bin) }]);
  return sent ? { ok: true, sent_to: to_ } : { ok: false, error: "Email send failed — check the RESEND configuration." };
}

/** Hourly cron: release any H&S packs whose schedule matches this UK hour.
 *  Weekly packs cover the previous 7 full days; monthly (sent on the 1st) the
 *  previous calendar month. last_sent_at guards against double-fires. */
/** Hourly cron: drain a batch of unscanned site photos per site so delivery
 *  tickets photographed into WhatsApp surface as pending check-ins on their
 *  own — the Scan button remains only as a "right now" accelerator. Bounded
 *  per run (vision calls cost money); the backlog drains oldest-first. */
export async function runWhatsappTicketScans(env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT u.project_id AS pid
       FROM project_updates u JOIN projects p ON p.id = u.project_id
      WHERE u.media_url IS NOT NULL AND p.deleted_at IS NULL AND p.id != 'sandbox'
        AND u.id NOT IN (SELECT update_id FROM delivery_ticket_scans WHERE update_id IS NOT NULL)`,
  ).all<{ pid: string }>();
  const bases = new Set<string>();
  for (const r of rows.results) {
    try { bases.add((await siteScope(env, r.pid)).baseId); } catch { bases.add(r.pid); }
  }
  for (const base of bases) {
    try {
      const r = await scanWhatsappTicketBatch(env, base, 12, "cron");
      if (r.scanned > 0) console.log(`ticket scan cron: ${base} scanned ${r.scanned}, tickets ${r.tickets}, remaining ${r.remaining}`);
    } catch (e) {
      console.error("ticket scan cron failed for", base, e instanceof Error ? e.message : e);
    }
  }
}

export async function runHsPackReleases(env: Env, now: Date): Promise<void> {
  let rows: Array<{ id: number; project_id: string; frequency: string; weekday: number | null; send_time: string | null; last_sent_at: string | null }> = [];
  try {
    rows = (await env.DB.prepare(
      `SELECT id, project_id, frequency, weekday, send_time, last_sent_at
         FROM distribution_rules WHERE content = 'hs_pack' AND enabled = 1 AND project_id IS NOT NULL`,
    ).all<{ id: number; project_id: string; frequency: string; weekday: number | null; send_time: string | null; last_sent_at: string | null }>()).results;
  } catch { return; /* pre-0109 */ }
  if (!rows.length) return;
  const nowISO = now.toISOString();
  const weekdayName = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" }).format(now);
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekdayName) + 1;
  const todayLondon = londonDateOf(nowISO);
  for (const r of rows) {
    // Catch-up semantics: work out the most recent instant this schedule was
    // DUE (its day + hour in UK time, this period). Send if that instant has
    // passed and nothing has been sent since — so a schedule created after
    // its hour, or an hour the cron missed, still releases on the next tick
    // instead of silently waiting a whole period.
    let dueDay: string;
    if (r.frequency === "monthly") {
      dueDay = `${todayLondon.slice(0, 8)}01`;
    } else {
      const daysSince = (weekday - (r.weekday ?? 1) + 7) % 7;
      dueDay = new Date(Date.parse(`${todayLondon}T12:00:00Z`) - daysSince * 86_400_000).toISOString().slice(0, 10);
    }
    const dueISO = londonISO(dueDay, (r.send_time ?? "07:00").slice(0, 5));
    if (dueISO > nowISO) continue;                            // not due yet this period
    if (r.last_sent_at && r.last_sent_at >= dueISO) continue; // already released this period
    // Period covered, anchored to the due day (not "now") so late catch-ups
    // still ship the right window.
    let from: string, to: string;
    if (r.frequency === "monthly") {
      const d = new Date(`${dueDay}T12:00:00Z`);
      d.setUTCDate(0);                       // last day of the previous month
      to = d.toISOString().slice(0, 10);
      d.setUTCDate(1);
      from = d.toISOString().slice(0, 10);
    } else {
      const t = Date.parse(`${dueDay}T12:00:00Z`);
      to = new Date(t - 86_400_000).toISOString().slice(0, 10);
      from = new Date(t - 7 * 86_400_000).toISOString().slice(0, 10);
    }
    const recipients = await hsPackRecipients(env, r.project_id).catch(() => [] as string[]);
    const res = await sendHsPack(env, r.project_id, from, to, recipients).catch((e) => ({ ok: false as const, error: String(e) }));
    if (res.ok) {
      await env.DB.prepare("UPDATE distribution_rules SET last_sent_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), r.id).run();
    } else {
      console.error("H&S pack release failed", r.project_id, res.error);
    }
  }
}

/** DEMO ONLY: sign an operative in by hand, so the sign-in → briefing → toolbox
 *  talk flow can be walked through end-to-end without a phone at a real site.
 *
 *  Hard-limited to the sandbox project. On a live site the register has to be
 *  the operative's OWN act — their phone, their signature, their location. A
 *  manager typing someone in would be inventing an attendance record, which is
 *  exactly the thing the register exists to prevent. */
operations.post("/:projectId/attendance/manual-signin", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const projectId = c.req.param("projectId");
  if (!isSandboxId(projectId)) {
    return c.json({ error: "Manual sign-in is only available on the demo project. On a live site an operative signs themselves in by QR code." }, 400);
  }
  const body = await c.req.json<{ operative_id?: string }>().catch(() => ({} as { operative_id?: string }));
  const opId = (body.operative_id ?? "").trim();
  if (!opId) return c.json({ error: "operative_id required" }, 400);
  const op = await c.env.DB.prepare(
    "SELECT id, name, company, trade, phone FROM operatives WHERE id = ? AND archived_at IS NULL",
  ).bind(opId).first<{ id: string; name: string; company: string | null; trade: string | null; phone: string | null }>();
  if (!op) return c.json({ error: "operative not found" }, 404);
  const now = new Date().toISOString();
  // Already on site → no-op, so a double tap doesn't double the register.
  const open = await c.env.DB.prepare(
    `SELECT id FROM site_signins
      WHERE project_id = ? AND phone = ? AND signed_out_at IS NULL
        AND substr(signed_in_at,1,10) = ?`,
  ).bind(projectId, op.phone, now.slice(0, 10)).first<{ id: number }>();
  if (open) return c.json({ ok: true, id: open.id, already_on_site: true });
  // operative_id is guarded the same way as the public sign-in — a deploy can
  // land before migration 0117 is applied.
  const withOperative = await signinsCarryOperativeId(c.env);
  const res = await c.env.DB.prepare(
    withOperative
      ? `INSERT INTO site_signins (project_id, operative_id, name, company, trade, phone, signed_in_at, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      : `INSERT INTO site_signins (project_id, name, company, trade, phone, signed_in_at, created_at)
         VALUES (?,?,?,?,?,?,?)`,
  ).bind(
    ...(withOperative ? [projectId, op.id] : [projectId]),
    op.name, op.company, op.trade, op.phone, now, now,
  ).run();
  return c.json({ ok: true, id: res.meta?.last_row_id ?? null, already_on_site: false });
});

operations.post("/:projectId/attendance/signout-all", async (c) => {
  const projectId = await opsBase(c.env, c.req.param("projectId"));
  const res = await c.env.DB.prepare(
    `UPDATE site_signins SET signed_out_at = ?
      WHERE project_id = ? AND signed_out_at IS NULL`,
  ).bind(new Date().toISOString(), projectId).run();
  return c.json({ ok: true, count: res.meta?.changes ?? 0 });
});

// Close a single open sign-in (an operative forgot to, or end of day). Idempotent
// — only affects rows that are still open.
operations.post("/:projectId/attendance/:id/signout", async (c) => {
  const projectId = await opsBase(c.env, c.req.param("projectId"));
  const res = await c.env.DB.prepare(
    `UPDATE site_signins SET signed_out_at = ?
      WHERE id = ? AND project_id = ? AND signed_out_at IS NULL`,
  ).bind(new Date().toISOString(), Number(c.req.param("id")), projectId).run();
  return c.json({ ok: true, signed_out: (res.meta?.changes ?? 0) > 0 });
});

// ── Sign-out corrections & the 19:00 auto sign-out ──────────────────────────

/** YYYY-MM-DD of an instant in UK local time (en-CA locale = ISO date order). */
function londonDateOf(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso));
}

/** UTC ISO instant for a UK wall-clock HH:MM on a date — BST/GMT aware. The
 *  offset is probed at noon UTC that day (DST switches at 01:00 UTC, so noon
 *  safely reflects the day's prevailing offset). */
function londonISO(dateYMD: string, hhmm: string): string {
  const probe = new Date(`${dateYMD}T12:00:00Z`);
  const zone = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", timeZoneName: "shortOffset" })
    .formatToParts(probe).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const offsetH = Number(/GMT([+-]\d+)/.exec(zone)?.[1] ?? 0);
  const [h, min] = hhmm.split(":").map((x) => parseInt(x, 10));
  return new Date(Date.UTC(
    Number(dateYMD.slice(0, 4)), Number(dateYMD.slice(5, 7)) - 1, Number(dateYMD.slice(8, 10)),
    h - offsetH, min || 0, 0,
  )).toISOString();
}

// Manager corrects a sign-out time (typically the 19:00 auto stamp, or a wrong
// manual one). HH:MM is applied on the sign-in's UK calendar day; the auto flag
// clears so the register shows it as a deliberate entry.
operations.patch("/:projectId/attendance/:id/signout-time", async (c) => {
  const projectId = await opsBase(c.env, c.req.param("projectId"));
  const body = await c.req.json<{ time?: string }>().catch(() => ({} as { time?: string }));
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((body.time ?? "").trim());
  if (!m) return c.json({ error: "Give the sign-out time as HH:MM (24-hour)." }, 400);
  const row = await c.env.DB.prepare(
    "SELECT id, signed_in_at FROM site_signins WHERE id = ? AND project_id = ?",
  ).bind(Number(c.req.param("id")), projectId).first<{ id: number; signed_in_at: string }>();
  if (!row) return c.json({ error: "sign-in not found" }, 404);
  const iso = londonISO(londonDateOf(row.signed_in_at), `${m[1].padStart(2, "0")}:${m[2]}`);
  if (iso < row.signed_in_at) return c.json({ error: "Sign-out can't be before the sign-in time." }, 400);
  await c.env.DB.prepare(
    "UPDATE site_signins SET signed_out_at = ?, signed_out_auto = 0 WHERE id = ?",
  ).bind(iso, row.id).run();
  return c.json({ ok: true, signed_out_at: iso });
});

/** Hourly-cron sweep: any sign-in still open past 19:00 UK time on its sign-in
 *  day is closed at exactly 19:00 (flagged auto). Evening sign-ins made AFTER
 *  19:00 close at 23:59 that day instead, so a stamp never precedes the
 *  sign-in. Idempotent — rows only close once their cutoff has passed. */
export async function runAutoSignouts(env: Env): Promise<void> {
  const open = (await env.DB.prepare(
    "SELECT id, signed_in_at FROM site_signins WHERE signed_out_at IS NULL",
  ).all<{ id: number; signed_in_at: string }>()).results;
  if (!open.length) return;
  const nowISO = new Date().toISOString();
  const stamps: Array<{ id: number; at: string }> = [];
  for (const s of open) {
    const day = londonDateOf(s.signed_in_at);
    let cutoff = londonISO(day, "19:00");
    if (cutoff <= s.signed_in_at) cutoff = londonISO(day, "23:59");
    if (cutoff <= nowISO) stamps.push({ id: s.id, at: cutoff });
  }
  if (!stamps.length) return;
  await env.DB.batch(stamps.map((s) =>
    env.DB.prepare(
      "UPDATE site_signins SET signed_out_at = ?, signed_out_auto = 1 WHERE id = ? AND signed_out_at IS NULL",
    ).bind(s.at, s.id),
  ));
}

// ── Briefings & toolbox talks ────────────────────────────────────────────────
operations.get("/:projectId/notices", async (c) => {
  const projectId = await opsBase(c.env, c.req.param("projectId"));
  const rows = await c.env.DB.prepare(
    `SELECT n.*,
            (SELECT COUNT(*) FROM site_notice_acks a WHERE a.notice_id = n.id) AS ack_count,
            (SELECT COUNT(*) FROM operative_notice_acks d WHERE d.notice_id = n.id) AS sent_count
       FROM site_notices n
      WHERE n.project_id = ?
      ORDER BY n.notice_date DESC, n.created_at DESC`,
  ).bind(projectId).all();
  return c.json(rows.results);
});

operations.post("/:projectId/notices", async (c) => {
  const projectId = await opsBase(c.env, c.req.param("projectId"));
  const body = await c.req.json<{ type?: string; title?: string; content?: string; notice_date?: string; template_id?: string }>();
  if (!body.title?.trim()) return c.json({ error: "title required" }, 400);
  const type = body.type === "toolbox" ? "toolbox" : "briefing";
  const now = new Date().toISOString();
  // Recording FROM a library talk copies that talk's document onto this notice.
  // The copy is deliberate: editing or removing the template later must never
  // rewrite a talk that has already been given and acknowledged.
  let sections: string | null = null, html: string | null = null, templateId: string | null = null;
  if (body.template_id) {
    try {
      const t = await c.env.DB.prepare(
        "SELECT id, sections_json, html_content FROM toolbox_talk_templates WHERE id = ? AND active = 1",
      ).bind(body.template_id).first<{ id: string; sections_json: string | null; html_content: string | null }>();
      if (t) { sections = t.sections_json; html = t.html_content; templateId = t.id; }
    } catch (e) { console.warn("notice template copy skipped:", e instanceof Error ? e.message : e); }
  }
  const res = await c.env.DB.prepare(
    `INSERT INTO site_notices (project_id, type, title, content, notice_date, active, created_at, created_by,
                               sections_json, html_content, template_id)
     VALUES (?,?,?,?,?,1,?,?,?,?,?) RETURNING id`,
  ).bind(
    projectId, type, body.title.trim(), body.content?.trim() || null,
    body.notice_date || today(), now, c.get("userEmail"),
    sections, html, templateId,
  ).first<{ id: number }>();
  return c.json({ id: res!.id });
});

/** Who a talk has been pushed to and who has acknowledged it — the manager's
 *  chase list, and what the "N outstanding" pill counts once distributed. */
operations.get("/notices/:id/recipients", async (c) => {
  try {
    const rows = await c.env.DB.prepare(
      `SELECT a.operative_id, a.requested_at, a.acked_at, a.signature, a.lat, a.lng,
              a.accuracy, a.geo_status, o.name, o.company
         FROM operative_notice_acks a JOIN operatives o ON o.id = a.operative_id
        WHERE a.notice_id = ? ORDER BY o.name`,
    ).bind(Number(c.req.param("id"))).all();
    return c.json(rows.results);
  } catch { return c.json([]); }
});

operations.patch("/notices/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<Record<string, unknown>>();
  const allowed = ["type", "title", "content", "notice_date", "active"] as const;
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const k of allowed) {
    if (k in body) {
      sets.push(`${k} = ?`);
      let v = body[k];
      if (typeof v === "string") v = v.trim() || null;
      if (k === "active") v = v ? 1 : 0;
      binds.push(v ?? null);
    }
  }
  if (!sets.length) return c.json({ ok: true });
  binds.push(id);
  await c.env.DB.prepare(`UPDATE site_notices SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  return c.json({ ok: true });
});

operations.delete("/notices/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM site_notices WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// ── Standing daily briefing — set once, acknowledged at EVERY sign-in ────────
// Settings-backed (key site_briefing:<projectId>), so no migration.
operations.get("/:projectId/briefing", async (c) => {
  const projectId = await opsBase(c.env, c.req.param("projectId"));
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(`site_briefing:${projectId}`).first<{ value: string }>();
  if (!row?.value) return c.json(null);
  try { return c.json(JSON.parse(row.value)); } catch { return c.json(null); }
});

operations.put("/:projectId/briefing", async (c) => {
  const projectId = await opsBase(c.env, c.req.param("projectId"));
  const body = await c.req.json<{ title?: string; content?: string }>().catch(() => ({} as { title?: string; content?: string }));
  const title = (body.title ?? "").trim();
  const content = (body.content ?? "").trim();
  const now = new Date().toISOString();
  // Every change appends to the version history, so exports can say which
  // briefing text each past sign-in accepted. '' title = briefing cleared.
  const logVersion = (t: string, cnt: string | null) =>
    c.env.DB.prepare(
      "INSERT INTO site_briefing_history (project_id, title, content, effective_from, created_by) VALUES (?,?,?,?,?)",
    ).bind(projectId, t, cnt, now, c.get("userEmail") ?? null).run().catch((e) => console.warn("briefing history skipped:", e));
  if (!title && !content) {
    await c.env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(`site_briefing:${projectId}`).run();
    await logVersion("", null);
    return c.json(null);
  }
  const value = JSON.stringify({
    title: title || "Daily briefing",
    content,
    updated_at: now,
    updated_by: c.get("userEmail"),
  });
  await c.env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).bind(`site_briefing:${projectId}`, value).run();
  await logVersion(title || "Daily briefing", content || null);
  return c.json(JSON.parse(value));
});

operations.delete("/:projectId/briefing", async (c) => {
  const projectId = await opsBase(c.env, c.req.param("projectId"));
  await c.env.DB.prepare("DELETE FROM settings WHERE key = ?")
    .bind(`site_briefing:${projectId}`).run();
  return c.json({ ok: true });
});

// AI assist — expand a short description into a full daily-briefing draft. The
// site manager reviews and saves it via the normal PUT, so this only drafts.
operations.post("/:projectId/briefing/draft", async (c) => {
  const projectId = await opsBase(c.env, c.req.param("projectId"));
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ error: "AI drafting isn't set up on the server (no AI key)." }, 503);
  }
  const body = await c.req.json<{ prompt?: string }>().catch(() => ({} as { prompt?: string }));
  const prompt = (body.prompt ?? "").trim();
  if (!prompt) return c.json({ error: "Type a short description first." }, 400);

  // Light context: the site/project name for a professional header.
  const proj = await c.env.DB.prepare("SELECT name FROM projects WHERE id = ?")
    .bind(projectId).first<{ name: string }>();
  const siteName = proj?.name ?? "the site";

  try {
    const client = new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 1200,
      system: `You are a UK construction site manager writing the standing DAILY BRIEFING that every operative must read and acknowledge before signing in on site at ${siteName}.
You are given the site manager's short description of today's key points. Expand it into a clear, professional briefing.
Rules:
- British English. Plain, direct site language. No emojis, no marketing fluff.
- Lead with the specific hazards and controls implied by the description, then any relevant site rules, PPE, exclusion zones, permits and emergency/first-aid arrangements.
- Only state what the description supports or what is standard good practice for the activities mentioned. Do NOT invent specific incidents, names, dates, sub-contractors or figures that were not given.
- Keep it short enough to read in under a minute. Use one point per line, each starting with "• ".
- "title" is a short heading (max ~8 words), e.g. "Daily briefing — roof works & wet weather".
- "content" is the briefing body, ready to display verbatim.`,
      tools: [{
        name: "daily_briefing",
        description: "Return the drafted daily site briefing.",
        input_schema: {
          type: "object" as const,
          properties: {
            title: { type: "string", description: "Short heading for the briefing." },
            content: { type: "string", description: "The briefing body, ready to display. Use '• ' bullet lines." },
          },
          required: ["title", "content"],
        },
      }],
      tool_choice: { type: "tool", name: "daily_briefing" },
      messages: [{ role: "user", content: `Site manager's notes for today:\n\n${prompt}` }],
    });
    const block = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!block) return c.json({ error: "AI did not return a briefing. Try again." }, 502);
    const out = block.input as { title?: unknown; content?: unknown };
    const title = typeof out.title === "string" ? out.title.trim() : "";
    const content = typeof out.content === "string" ? out.content.trim() : "";
    if (!content) return c.json({ error: "AI returned an empty briefing. Try again." }, 502);
    return c.json({ title: title || "Daily briefing", content });
  } catch (e) {
    console.warn("briefing draft failed:", e instanceof Error ? e.message : e);
    return c.json({ error: "AI drafting failed. Try again or write the briefing manually." }, 502);
  }
});

// ── Plant on site ─────────────────────────────────────────────────────────────
operations.get("/:projectId/plant", async (c) => {
  const projectId = c.req.param("projectId");
  try {
    const rows = await c.env.DB.prepare(
      `SELECT pl.*, po.po_number AS po_number
         FROM plant_logs pl
         LEFT JOIN purchase_orders po ON po.id = pl.po_id
        WHERE pl.project_id = ?
        ORDER BY (pl.off_hire_to IS NULL) DESC, pl.on_hire_from DESC, pl.created_at DESC`,
    ).bind(projectId).all();
    return c.json(rows.results);
  } catch (e) {
    // Pre-migration (0045 not yet applied): plant_logs has no po_id column.
    // Fall back to the legacy shape so the Plant tab keeps working.
    console.warn("plant GET fell back (pre-0045):", e instanceof Error ? e.message : e);
    const rows = await c.env.DB.prepare(
      `SELECT * FROM plant_logs WHERE project_id = ?
        ORDER BY (off_hire_to IS NULL) DESC, on_hire_from DESC, created_at DESC`,
    ).bind(projectId).all();
    return c.json(rows.results);
  }
});

operations.post("/:projectId/plant", async (c) => {
  const projectId = c.req.param("projectId");
  const body = await c.req.json<{
    item?: string; supplier?: string; on_hire_from?: string;
    off_hire_to?: string; day_rate?: number; rate_unit?: string; notes?: string;
    po_id?: string; expected_weeks?: number; expected_off_hire?: string;
  }>();
  if (!body.item?.trim()) return c.json({ error: "item required" }, 400);
  // The PLANNED off-hire date drives the reminders. Take it explicitly, else
  // derive it from on-hire date + expected weeks. off_hire_to stays NULL until
  // the item is actually marked off-hired (preserves the "on site" semantics).
  let plannedOff = body.expected_off_hire || null;
  if (!plannedOff && body.on_hire_from && body.expected_weeks && body.expected_weeks > 0) {
    const d = new Date(body.on_hire_from + "T00:00:00Z");
    if (!isNaN(d.getTime())) { d.setUTCDate(d.getUTCDate() + Math.round(body.expected_weeks * 7)); plannedOff = d.toISOString().slice(0, 10); }
  }
  const now = new Date().toISOString();
  const ru = body.rate_unit === "week" ? "week" : "day";
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO plant_logs (project_id, item, supplier, on_hire_from, off_hire_to, day_rate, rate_unit, notes, po_id, expected_weeks, expected_off_hire, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    ).bind(
      projectId, body.item.trim(), body.supplier?.trim() || null,
      body.on_hire_from || null, body.off_hire_to || null,
      body.day_rate ?? null, ru, body.notes?.trim() || null,
      body.po_id || null, body.expected_weeks ?? null, plannedOff, now, c.get("userEmail"),
    ).first<{ id: number }>();
    return c.json({ id: res!.id });
  } catch (e) {
    // Pre-migration (0045): plant_logs lacks po_id/expected_weeks/expected_off_hire.
    // Store the legacy columns so check-in still works; the PO link is dropped.
    console.warn("plant POST fell back (pre-0045):", e instanceof Error ? e.message : e);
    const res = await c.env.DB.prepare(
      `INSERT INTO plant_logs (project_id, item, supplier, on_hire_from, off_hire_to, day_rate, rate_unit, notes, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    ).bind(
      projectId, body.item.trim(), body.supplier?.trim() || null,
      body.on_hire_from || null, body.off_hire_to || null,
      body.day_rate ?? null, ru, body.notes?.trim() || null, now, c.get("userEmail"),
    ).first<{ id: number }>();
    return c.json({ id: res!.id });
  }
});

operations.patch("/plant/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<Record<string, unknown>>();
  const allowed = ["item", "supplier", "on_hire_from", "off_hire_to", "day_rate", "rate_unit", "notes", "expected_weeks", "expected_off_hire"] as const;
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const k of allowed) {
    if (k in body) {
      sets.push(`${k} = ?`);
      let v = body[k];
      if (typeof v === "string") v = v.trim() || null;
      binds.push(v ?? null);
    }
  }
  if (!sets.length) return c.json({ ok: true });
  binds.push(id);
  await c.env.DB.prepare(`UPDATE plant_logs SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  return c.json({ ok: true });
});

operations.delete("/plant/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM plant_logs WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// ── Phase 2: file-backed records (deliveries, RAMS, progress photos) ─────────
// Binary lives in R2; metadata + keys in D1. Keys are prefixed + uuid'd.

const FILE_PREFIXES = ["deliveries/", "rams/", "progress/"];
const MAX_FILE_BYTES = 20_000_000; // 20 MB

function sanitizeName(name: string): string {
  return (name || "file").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80);
}

/** Stream an R2 object back. Authed (whole route is) + prefix-whitelisted. */
operations.get("/file", async (c) => {
  const key = c.req.query("key");
  if (!key || !FILE_PREFIXES.some((p) => key.startsWith(p))) {
    return c.json({ error: "bad key" }, 400);
  }
  const obj = await c.env.R2.get(key);
  if (!obj) return c.json({ error: "not found" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("Cache-Control", "private, max-age=3600");
  if (c.req.query("download")) {
    headers.set("Content-Disposition", `attachment; filename="${sanitizeName(key.split("/").pop() || "file")}"`);
  }

  // `w` asks for a thumbnail, capped on the WIDTH. A ticket photographed on a
  // phone is several megabytes, and the PO delivery register asks for one per
  // note — sending the full frame to draw it 36px wide is the whole download
  // for none of the detail.
  //
  // Only the width is constrained, deliberately. `shrinkPhoto` boxes width AND
  // height, which is right for a print slot but here would hand the page a
  // ticket squashed to a square: callers crop these to a square in CSS, and a
  // source that has already been distorted can't be cropped back. Leaving the
  // height free keeps the aspect ratio.
  //
  // A failed or unavailable transform serves the original bytes, so asking for
  // a thumbnail is never worse than not asking. The etag carries the width so
  // a thumbnail and the full image can't be served to each other from cache.
  const w = Number(c.req.query("w"));
  const type = obj.httpMetadata?.contentType ?? "";
  if (Number.isInteger(w) && w >= 16 && w <= 2000 && /^image\//i.test(type) && !/svg/i.test(type)) {
    const original = await obj.arrayBuffer();
    let thumb: { body: ArrayBuffer; mime: string } | null = null;
    if (c.env.IMAGES) {
      try {
        const out = await c.env.IMAGES
          .input(new Response(original).body as ReadableStream<Uint8Array>)
          .transform({ width: w, fit: "scale-down" })
          .output({ format: "image/jpeg", quality: 78 });
        const buf = await out.response().arrayBuffer();
        if (buf.byteLength > 0) thumb = { body: buf, mime: "image/jpeg" };
      } catch (e) {
        console.warn("thumbnail resize failed — serving the original:", e instanceof Error ? e.message : e);
      }
    }
    if (thumb) headers.set("Content-Type", thumb.mime);
    headers.set("etag", `${obj.httpEtag.replace(/"$/, "")}-w${w}"`);
    return new Response(thumb?.body ?? original, { headers });
  }

  return new Response(obj.body, { headers });
});

// ── Deliveries ────────────────────────────────────────────────────────────
// Scan a delivery ticket (photo or PDF): Claude reads the PO number / supplier /
// items off it, and we match that to one of the project's POs so the check-in
// form can be pre-filled. Doesn't persist anything — the manager reviews then
// submits via the normal create below (which stores the ticket).
operations.post("/:projectId/deliveries/scan", async (c) => {
  const scope = await siteScope(c.env, c.req.param("projectId"));
  const form = await c.req.formData();
  const result = await extractDeliveryTicket(c.env, form.get("file"));
  if (!result.ok) return c.json({ error: result.error }, result.status);
  const extracted = result.extracted;

  // POs we can match against — every contract in the site (so a delivery for any
  // area resolves), not deleted. The matched PO's contract pre-tags the check-in.
  const ph = scope.memberIds.map(() => "?").join(",");
  const pos = await c.env.DB.prepare(
    `SELECT po.id, po.po_number, po.supplier, po.status, po.order_type,
            po.project_id, p.code AS project_code
       FROM purchase_orders po JOIN projects p ON p.id = po.project_id
      WHERE po.project_id IN (${ph}) AND po.status != 'deleted' ORDER BY po.created_at DESC`,
  ).bind(...scope.memberIds).all<{ id: string; po_number: string; supplier: string | null; status: string; order_type: string | null; project_id: string; project_code: string }>();

  // Match: PO number first (tolerant), then fall back to supplier name overlap.
  const exNo = normPoNo(extracted.po_number);
  let matched: { id: string; po_number: string; supplier: string | null; order_type: string | null; project_id: string; project_code: string } | null = null;
  let matchedBy: "po_number" | "supplier" | null = null;
  if (exNo) {
    const hit = pos.results.find((p) => poNoMatches(extracted.po_number, p.po_number))
      ?? fuzzyFindPo(extracted.po_number, pos.results);
    if (hit) { matched = hit; matchedBy = "po_number"; }
  }
  const exSup = nameTokens(extracted.supplier_name);
  const scored = pos.results
    .map((p) => {
      const ct = nameTokens(p.supplier ?? "");
      let overlap = 0;
      for (const t of exSup) if (ct.has(t)) overlap++;
      return { p, score: exSup.size ? overlap / exSup.size : 0 };
    })
    .sort((a, b) => b.score - a.score);
  if (!matched && scored.length && scored[0].score >= 0.5) { matched = scored[0].p; matchedBy = "supplier"; }

  return c.json({
    extracted,
    matched_po: matched ? { id: matched.id, po_number: matched.po_number, supplier: matched.supplier, order_type: matched.order_type, project_id: matched.project_id, project_code: matched.project_code, matched_by: matchedBy } : null,
    candidates: scored.filter((s) => s.score > 0).slice(0, 5).map((s) => ({ id: s.p.id, po_number: s.p.po_number, supplier: s.p.supplier, order_type: s.p.order_type, project_id: s.p.project_id, project_code: s.p.project_code, score: Math.round(s.score * 100) / 100 })),
  });
});

// Cross-project scan — used from the Projects workspace, where no project is
// open yet. We read the ticket then search EVERY live project's POs by PO
// number to work out which site the delivery belongs to. Supplier name alone
// is too ambiguous across sites to auto-resolve, so only a PO-number hit sets
// matched_po; everything sharing the number (or supplier) comes back as a
// candidate for the operative to pick. 2-segment path, so it never collides
// with the 3-segment "/:projectId/deliveries/scan" above.
operations.post("/deliveries/scan", async (c) => {
  const form = await c.req.formData();
  const result = await extractDeliveryTicket(c.env, form.get("file"));
  if (!result.ok) return c.json({ error: result.error }, result.status);
  const extracted = result.extracted;

  // Every PO on a live (non-deleted) project, with its project attached.
  const pos = await c.env.DB.prepare(
    `SELECT po.id, po.po_number, po.supplier, po.status, po.order_type,
            po.project_id, p.code AS project_code, p.name AS project_name
       FROM purchase_orders po
       JOIN projects p ON p.id = po.project_id
      WHERE po.status != 'deleted' AND p.deleted_at IS NULL
      ORDER BY po.created_at DESC`,
  ).all<{ id: string; po_number: string; supplier: string | null; status: string; order_type: string | null; project_id: string; project_code: string; project_name: string }>();

  const matched = extracted.po_number
    ? pos.results.find((p) => poNoMatches(extracted.po_number, p.po_number))
      ?? fuzzyFindPo(extracted.po_number, pos.results)
    : null;

  // Candidates: a PO-number hit scores 1; otherwise rank on supplier overlap so
  // the operative still gets a sensible shortlist to choose the site from.
  const exSup = nameTokens(extracted.supplier_name);
  const candidates = pos.results
    .map((p) => {
      const poHit = extracted.po_number ? poNoMatches(extracted.po_number, p.po_number) : false;
      const ct = nameTokens(p.supplier ?? "");
      let overlap = 0;
      for (const t of exSup) if (ct.has(t)) overlap++;
      const supScore = exSup.size ? overlap / exSup.size : 0;
      return { p, score: poHit ? 1 : supScore };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((s) => ({
      id: s.p.id, po_number: s.p.po_number, supplier: s.p.supplier, order_type: s.p.order_type,
      project_id: s.p.project_id, project_code: s.p.project_code, project_name: s.p.project_name,
      score: Math.round(s.score * 100) / 100,
    }));

  return c.json({
    extracted,
    matched_po: matched
      ? { id: matched.id, po_number: matched.po_number, supplier: matched.supplier, order_type: matched.order_type,
          project_id: matched.project_id, project_code: matched.project_code, project_name: matched.project_name, matched_by: "po_number" as const }
      : null,
    candidates,
  });
});

// ── WhatsApp delivery tickets ───────────────────────────────────────────────
// Delivery tickets photographed into the site WhatsApp group arrive as progress
// photos (created_by = 'whatsapp'). These endpoints scan those images for a PO
// number, remember the result (so we never re-pay to scan the same photo), and
// surface genuine tickets as one-tap delivery check-ins.

operations.post("/:projectId/deliveries/scan-whatsapp", async (c) => {
  let body: { limit?: number } = {};
  try { body = await c.req.json(); } catch { /* empty body ok */ }
  const limit = Math.min(Math.max(Number(body.limit) || 8, 1), 15);
  const r = await scanWhatsappTicketBatch(c.env, c.req.param("projectId"), limit, c.get("userEmail"));
  return c.json(r);
});

/**
 * Copy a WhatsApp ticket photo into OUR storage and return the R2 key.
 *
 * The messaging provider deletes media after about 30 days, and the scan record
 * only ever held the provider's URL — so a delivery ticket that backs a payment
 * quietly turned into a broken image once it aged out. Tickets are evidence:
 * they must live in R2, not on someone else's expiry clock. Returns null if the
 * copy fails, in which case the caller keeps the URL (better than nothing).
 */
async function archiveTicketPhoto(env: Env, projectId: string, url: string): Promise<string | null> {
  try {
    if (!isSafeMediaUrl(url)) return null;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const type = resp.headers.get("content-type") || "image/jpeg";
    const ext = /pdf/i.test(type) ? "pdf" : /png/i.test(type) ? "png" : "jpg";
    const key = `deliveries/${projectId}/ticket-${crypto.randomUUID()}.${ext}`;
    await env.R2.put(key, await resp.arrayBuffer(), { httpMetadata: { contentType: type } });
    return key;
  } catch {
    return null;
  }
}

/** Scan one batch of unscanned WhatsApp/site photos for a site scope. Shared
 *  by the manual "Scan" button and the hourly cron — tickets photographed into
 *  the group surface as pending check-ins WITHOUT anyone pressing anything. */
export async function scanWhatsappTicketBatch(
  env: Env, projectId: string, limit: number, actor: string,
): Promise<{ scanned: number; tickets: number; remaining: number }> {
  const scope = await siteScope(env, projectId);
  const base = scope.baseId;

  // WhatsApp-group messages carrying an image/document, across the site, not yet
  // scanned — oldest first so repeated calls drain the backlog in arrival order.
  const ph = scope.memberIds.map(() => "?").join(",");
  const photos = await env.DB.prepare(
    `SELECT u.id, u.media_url, u.sender, u.body, u.occurred_at, u.created_at
       FROM project_updates u
      WHERE u.project_id IN (${ph}) AND u.media_url IS NOT NULL
        AND u.id NOT IN (SELECT update_id FROM delivery_ticket_scans WHERE update_id IS NOT NULL)
      ORDER BY u.id ASC LIMIT ?`,
  ).bind(...scope.memberIds, limit).all<{ id: number; media_url: string; sender: string | null; body: string | null; occurred_at: string; created_at: string }>();

  // Remaining backlog count so the UI can say "scan N more".
  const remainingRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM project_updates u
      WHERE u.project_id IN (${ph}) AND u.media_url IS NOT NULL
        AND u.id NOT IN (SELECT update_id FROM delivery_ticket_scans WHERE update_id IS NOT NULL)`,
  ).bind(...scope.memberIds).first<{ n: number }>();

  // POs we can match against — every contract in the site, not deleted.
  const pos = await env.DB.prepare(
    `SELECT po.id, po.po_number, po.supplier, po.order_type, po.project_id, p.code AS project_code
       FROM purchase_orders po JOIN projects p ON p.id = po.project_id
      WHERE po.project_id IN (${ph}) AND po.status != 'deleted'
      ORDER BY po.created_at DESC`,
  ).bind(...scope.memberIds).all<{ id: string; po_number: string; supplier: string | null; order_type: string | null; project_id: string; project_code: string }>();

  const now = new Date().toISOString();
  let scanned = 0, tickets = 0;
  for (const p of photos.results) {
    scanned++;
    let extracted: ExtractedDelivery | null = null;
    try {
      // Claude fetches the image by URL — the Worker never downloads or base64s
      // it, so per-photo CPU stays within the free plan's 10ms budget.
      const result = await extractDeliveryTicketFromUrl(env, p.media_url);
      if (result.ok) extracted = result.extracted;
    } catch (e) {
      console.warn("whatsapp ticket scan skipped", p.id, e instanceof Error ? e.message : e);
    }

    // Trust Claude's explicit classification, but require at least one concrete
    // identifier so a mislabelled site photo can't slip through as a "ticket".
    const ex = extracted;
    const isTicket = !!ex && ex.is_delivery_ticket
      && (!!ex.po_number.trim() || !!ex.delivery_note_number.trim() || !!ex.supplier_name.trim());

    let matchedId: string | null = null, matchedBy: string | null = null;
    if (ex && isTicket) {
      if (ex.po_number.trim()) {
        const hit = pos.results.find((po) => poNoMatches(ex.po_number, po.po_number))
          ?? fuzzyFindPo(ex.po_number, pos.results);
        if (hit) { matchedId = hit.id; matchedBy = "po_number"; }
      }
      if (!matchedId && ex.supplier_name.trim()) {
        const exSup = nameTokens(ex.supplier_name);
        let best: { id: string; score: number } | null = null;
        for (const po of pos.results) {
          const ct = nameTokens(po.supplier ?? "");
          let overlap = 0; for (const t of exSup) if (ct.has(t)) overlap++;
          const score = exSup.size ? overlap / exSup.size : 0;
          if (!best || score > best.score) best = { id: po.id, score };
        }
        if (best && best.score >= 0.5) { matchedId = best.id; matchedBy = "supplier"; }
      }
    }

    if (isTicket) tickets++;
    // Archive the photo for real tickets only — site photos aren't evidence and
    // aren't worth the storage. Falls back to the provider URL on failure.
    const storedKey = isTicket ? (await archiveTicketPhoto(env, base, p.media_url)) ?? p.media_url : p.media_url;
    try {
      await env.DB.prepare(
        `INSERT INTO delivery_ticket_scans
           (project_id, update_id, photo_key, is_ticket, po_number, supplier_name,
            delivery_note_number, delivery_date, summary, extracted_json,
            matched_po_id, matched_by, status, occurred_at, scanned_at, scanned_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(photo_key) DO NOTHING`,
      ).bind(
        base, p.id, storedKey, isTicket ? 1 : 0,
        ex?.po_number.trim() || null, ex?.supplier_name.trim() || null,
        ex?.delivery_note_number.trim() || null, ex?.delivery_date.trim() || null,
        ex?.summary.trim() || null, ex ? JSON.stringify(ex) : null,
        matchedId, matchedBy, isTicket ? "pending" : "dismissed",
        p.occurred_at || p.created_at, now, actor,
      ).run();
    } catch (e) {
      console.error("failed to record ticket scan", p.id, e instanceof Error ? e.message : e);
    }
  }

  return { scanned, tickets, remaining: Math.max(0, (remainingRow?.n ?? scanned) - scanned) };
}

/**
 * Cross-project deliveries inbox — every pending ticket candidate across all
 * live projects, each row carrying its project so the detail pane can drive
 * the per-project reconcile/check-in endpoints. Plus the KPI strip: deliveries
 * expected today / overdue (open POs past their delivery date with nothing
 * received) / checked in today / tickets still needing a PO.
 */
operations.get("/deliveries-inbox", async (c) => {
  // A checked-in ticket whose delivery record has since been deleted is not
  // checked in — return it to the inbox. (Sandbox excluded: its deliveries are
  // reseeded nightly and would resurrect scans forever.)
  try {
    await c.env.DB.prepare(
      `UPDATE delivery_ticket_scans SET status = 'pending', delivery_id = NULL
        WHERE status = 'checked_in' AND delivery_id IS NOT NULL AND project_id != 'sandbox'
          AND NOT EXISTS (SELECT 1 FROM site_deliveries d WHERE d.id = delivery_ticket_scans.delivery_id)
          AND NOT EXISTS (SELECT 1 FROM site_deliveries d2 WHERE d2.scan_id = delivery_ticket_scans.id)`,
    ).run();
  } catch { /* table may predate the column */ }
  const today = new Date().toISOString().slice(0, 10);
  let candidates: unknown[] = [];
  try {
    const rows = await c.env.DB.prepare(
      `SELECT s.id, s.project_id, pr.code AS project_code, pr.name AS project_name,
              s.photo_key, s.po_number, s.supplier_name, s.delivery_note_number,
              s.delivery_date, s.summary, s.extracted_json, s.matched_po_id, s.matched_by, s.occurred_at,
              po.po_number AS matched_po_number, po.supplier AS matched_po_supplier,
              po.order_type AS matched_order_type, po.project_id AS matched_project_id,
              p.code AS matched_project_code
         FROM delivery_ticket_scans s
         JOIN projects pr ON pr.id = s.project_id
         LEFT JOIN purchase_orders po ON po.id = s.matched_po_id
         LEFT JOIN projects p ON p.id = po.project_id
        WHERE s.is_ticket = 1 AND s.status = 'pending' AND pr.deleted_at IS NULL
        ORDER BY s.occurred_at DESC, s.id DESC LIMIT 200`,
    ).all();
    const posForGuess = (await c.env.DB.prepare(
      `SELECT po.id, po.po_number, p.code AS project_code FROM purchase_orders po JOIN projects p ON p.id = po.project_id
        WHERE po.status != 'deleted' AND po.order_type != 'framework' AND p.deleted_at IS NULL`,
    ).all<{ id: string; po_number: string; project_code: string }>()).results;
    const guessLines = posForGuess.length ? (await c.env.DB.prepare(
      `SELECT id, po_id, item, qty, unit FROM po_lines WHERE po_id IN (${posForGuess.map(() => "?").join(",")})`,
    ).bind(...posForGuess.map((p) => p.id)).all<{ id: number; po_id: string; item: string; qty: number | null; unit: string | null }>()).results : [];
    const poIndex = posForGuess.map((po) => ({
      id: po.id, po_number: po.po_number, project_code: po.project_code,
      codes: new Set(guessLines.filter((l) => l.po_id === po.id).map((l) => materialCode(l.item))),
      norms: new Set(guessLines.filter((l) => l.po_id === po.id).map((l) => normText(l.item))),
    }));
    const deliveryAliases = await aliasMapsBySupplier(c.env.DB, "delivery_item");
    candidates = rows.results.map((r) => {
      const row = r as { photo_key: string; extracted_json: string | null };
      const key = String(row.photo_key);
      let scanned_qty: number | null = null, scanned_unit: string | null = null;
      let items: Array<{ description: string; qty: number | null; unit: string | null }> = [];
      let regions: Record<string, unknown> | null = null;
      let itemRegions: Array<ReadRegion | null> = [];
      let rotation = 0;
      try {
        const ex = row.extracted_json ? JSON.parse(row.extracted_json) as { items?: Array<{ description?: string; qty?: number | null; unit?: string | null; region?: unknown }>; regions?: Record<string, unknown> } : null;
        regions = ex?.regions ?? null;
        rotation = [0, 90, 180, 270].includes(Number((ex as Record<string, unknown> | null)?.rotation_degrees)) ? Number((ex as Record<string, unknown>).rotation_degrees) : 0;
        itemRegions = (ex?.items || []).map((i) => cleanRegion(i.region));
        items = (ex?.items || []).map((i) => ({ description: String(i.description ?? "").trim(), qty: typeof i.qty === "number" ? i.qty : null, unit: i.unit ? String(i.unit).trim() : null })).filter((i) => i.description);
        const withQty = items.filter((i) => i.qty != null);
        if (withQty.length) {
          scanned_qty = Math.round(withQty.reduce((s, i) => s + (i.qty ?? 0), 0) * 100) / 100;
          scanned_unit = (withQty.find((i) => i.unit)?.unit ?? null) || null;
        }
      } catch { /* ignore malformed json */ }
      const rest: Record<string, unknown> = { ...(r as Record<string, unknown>) };
      delete rest.extracted_json;
      rest.regions = regions;
      rest.item_regions = itemRegions;
      rest.rotation_degrees = rotation;
      let method: "po" | "line" | "none" = "none", conf = 0;
      let guess_po_id: string | null = null, guess_po_number: string | null = null, guess_project_code: string | null = null;
      if (rest.matched_po_id) {
        method = "po";
        conf = rest.matched_by === "po_number" ? 96 : rest.matched_by === "supplier" ? 74 : 60;
      } else {
        const icodes = new Set(items.map((i) => materialCode(i.description)).filter((x) => x.length >= 3));
        // Learned wording (supplier-specific corrections) counts triple — a
        // human already confirmed these exact descriptions belong together.
        const am = deliveryAliases.get(normText(String(rest.supplier_name ?? ""))) ?? deliveryAliases.get("");
        const targets = am ? items.map((i) => am.get(normText(i.description))).filter((x): x is string => !!x) : [];
        let best: { id: string; po_number: string; project_code: string; hits: number } | null = null;
        for (const po of poIndex) {
          let hits = 0; for (const cd of icodes) if (po.codes.has(cd)) hits++;
          for (const t of targets) if (po.norms.has(t)) hits += 3;
          if (hits > 0 && (!best || hits > best.hits)) best = { id: po.id, po_number: po.po_number, project_code: po.project_code, hits };
        }
        if (best) { method = "line"; conf = Math.min(90, 45 + best.hits * 15); guess_po_id = best.id; guess_po_number = best.po_number; guess_project_code = best.project_code; }
      }
      return { ...rest, scanned_qty, scanned_unit, items, method, conf, guess_po_id, guess_po_number, guess_project_code, ticket_url: /^https?:\/\//i.test(key) ? key : `/api/operations/file?key=${encodeURIComponent(key)}` };
    });

    // Does what ARRIVED match what was ordered? The PO-number match above only
    // says the reference on the paper resolves to an order we hold — it compares
    // no quantities, so a ticket for 5,000 against a line of 50 was reported as
    // "Matched" and would check in as fully delivered. See shared/delivery-variance.
    // Lines are already in hand from the guess index above; only prior receipts
    // need fetching, and only for the POs these tickets actually point at.
    const varRows = candidates as Array<Record<string, unknown>>;
    const varPoIds = [...new Set(varRows
      .map((x) => (x.matched_po_id || x.guess_po_id) as string | null)
      .filter((x): x is string => !!x))];
    // scan_id and the scan's delivery note are carried through so a ticket is
    // never judged against its OWN goods. Two ways that happens: once checked
    // in, a ticket's own delivery rows become "already received" and it flags
    // itself for delivering more than the nothing left; and the SAME note is
    // routinely scanned twice (15 notes on this book, one of them six times —
    // WhatsApp and email both carry it), so the twin's receipts do the same.
    // A note number is the unit of delivery, and within one PO it identifies it.
    const priorRows = varPoIds.length ? (await c.env.DB.prepare(
      `SELECT d.po_id, d.po_line_id, d.scan_id, s2.delivery_note_number AS dn, SUM(d.received_qty) AS rq
         FROM site_deliveries d
         LEFT JOIN delivery_ticket_scans s2 ON s2.id = d.scan_id
        WHERE d.po_id IN (${varPoIds.map(() => "?").join(",")}) AND d.po_line_id IS NOT NULL AND d.received_qty IS NOT NULL
        GROUP BY d.po_id, d.po_line_id, d.scan_id, s2.delivery_note_number`,
    ).bind(...varPoIds).all<{ po_id: string; po_line_id: number; scan_id: number | null; dn: string | null; rq: number | null }>()).results : [];
    const linesByPo = new Map<string, VarianceLine[]>();
    for (const l of guessLines) {
      const arr = linesByPo.get(l.po_id) ?? [];
      arr.push({ id: l.id, item: l.item, qty: l.qty, unit: l.unit });
      linesByPo.set(l.po_id, arr);
    }
    const priorByPo = new Map<string, Array<PriorReceipt & { scan_id: number | null; dn: string | null }>>();
    for (const pr of priorRows) {
      const arr = priorByPo.get(pr.po_id) ?? [];
      arr.push({ po_line_id: pr.po_line_id, qty: pr.rq, scan_id: pr.scan_id, dn: pr.dn });
      priorByPo.set(pr.po_id, arr);
    }
    /** Receipts that are this same delivery — its own, or a twin scan of the
     *  same note. Everything else is a genuinely earlier drop. */
    const isSelf = (pr: { scan_id: number | null; dn: string | null }, id: unknown, dn: unknown) =>
      pr.scan_id === id || (!!pr.dn && !!dn && String(pr.dn).trim() === String(dn).trim());

    // Where the whole ORDER stands — not just the lines this ticket's own items
    // touch. `priorRows` above excludes whole-PO receipts (it filters
    // po_line_id IS NOT NULL, which the variance check needs), so a separate
    // read carries completes_po for the shared rule. Same POs, one more column.
    const orderDelRows = varPoIds.length ? (await c.env.DB.prepare(
      `SELECT d.po_id, ${PO_DELIVERY_NOTE_COLUMNS} FROM site_deliveries d ${PO_DELIVERY_NOTE_JOIN}
        WHERE d.po_id IN (${varPoIds.map(() => "?").join(",")})`,
    ).bind(...varPoIds).all<PoDeliveryRow>()).results : [];

    candidates = varRows.map((x) => {
      const poId = (x.matched_po_id || x.guess_po_id) as string | null;
      if (!poId) return x;
      const poNo = (x.matched_po_number || x.guess_po_number) as string | null;
      const its = (x.items ?? []) as Array<{ description: string; qty: number | null; unit: string | null }>;
      const prior = (priorByPo.get(poId) ?? []).filter((pr) => !isSelf(pr, x.id, x.delivery_note_number));
      const poLineRefs = guessLines.filter((l) => l.po_id === poId);
      const d = summarisePoDeliveries(poId, poLineRefs, orderDelRows);
      return {
        ...x,
        variance: deliveryVariance(its, linesByPo.get(poId) ?? [], prior, poNo),
        po_delivery: d,
      };
    });
  } catch { candidates = []; }

  // KPI strip. "Overdue" = an open PO past its delivery date with nothing ever
  // received against it; "expected today" counts POs due today the same way.
  const kpi = { expected_today: 0, overdue: 0, checked_in_today: 0, needs_po: 0, variance: 0 };
  try {
    const exp = await c.env.DB.prepare(
      `SELECT
         SUM(CASE WHEN po.delivery_date = ? THEN 1 ELSE 0 END) AS expected_today,
         SUM(CASE WHEN po.delivery_date < ? AND NOT EXISTS (SELECT 1 FROM site_deliveries d WHERE d.po_id = po.id) THEN 1 ELSE 0 END) AS overdue
        FROM purchase_orders po JOIN projects p ON p.id = po.project_id
       WHERE po.status NOT IN ('deleted','rejected') AND po.order_type != 'framework'
         AND p.deleted_at IS NULL AND p.completed_at IS NULL AND po.delivery_date IS NOT NULL`,
    ).bind(today, today).first<{ expected_today: number | null; overdue: number | null }>();
    kpi.expected_today = exp?.expected_today ?? 0;
    kpi.overdue = exp?.overdue ?? 0;
    const chk = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM site_deliveries WHERE substr(created_at, 1, 10) = ?",
    ).bind(today).first<{ n: number }>();
    kpi.checked_in_today = chk?.n ?? 0;
  } catch { /* tables may predate migrations */ }
  kpi.needs_po = (candidates as Array<{ method?: string }>).filter((x) => x.method === "none").length;
  // Tickets whose GOODS disagree with the order they matched. Counted here and
  // not in SQL because the comparison needs the ticket's parsed items, which
  // only exist once the row has been through the reader above.
  kpi.variance = (candidates as Array<{ variance?: { ok: boolean } }>).filter((x) => x.variance && !x.variance.ok).length;

  // Recently actioned tickets — the "where did it go" register. Each scan links
  // to the first delivery it created; the rest of that check-in shares the same
  // copied ticket file, so the group is recovered via ticket_key.
  let checkedIn: unknown[] = [];
  try {
    const scans = (await c.env.DB.prepare(
      `SELECT s.id, s.project_id, pr.code AS project_code, s.photo_key, s.supplier_name,
              s.delivery_note_number, s.delivery_date, s.summary, s.occurred_at, s.delivery_id
         FROM delivery_ticket_scans s
         JOIN projects pr ON pr.id = s.project_id
        WHERE s.is_ticket = 1 AND s.status = 'checked_in'
        ORDER BY s.occurred_at DESC, s.id DESC LIMIT 60`,
    ).all<{ id: number; project_id: string; project_code: string; photo_key: string; supplier_name: string | null;
            delivery_note_number: string | null; delivery_date: string | null; summary: string | null;
            occurred_at: string | null; delivery_id: number | null }>()).results;
    const dids = [...new Set(scans.map((x) => x.delivery_id).filter((x): x is number => x != null))];
    const firsts = dids.length ? (await c.env.DB.prepare(
      `SELECT id, ticket_key FROM site_deliveries WHERE id IN (${dids.map(() => "?").join(",")})`,
    ).bind(...dids).all<{ id: number; ticket_key: string | null }>()).results : [];
    const keys = [...new Set(firsts.map((f) => f.ticket_key).filter((k): k is string => !!k))];
    const dels = keys.length ? (await c.env.DB.prepare(
      `SELECT d.id, d.ticket_key, d.description, d.received_qty, d.received_unit, d.po_id, d.po_number,
              d.po_line_desc, d.delivered_at, d.project_id, p.code AS project_code, cp.code AS contract_code
         FROM site_deliveries d
         JOIN projects p ON p.id = d.project_id
         LEFT JOIN projects cp ON cp.id = d.contract_project_id
        WHERE d.ticket_key IN (${keys.map(() => "?").join(",")})
        ORDER BY d.id`,
    ).bind(...keys).all<Record<string, unknown>>()).results : [];
    const keyByFirst = new Map(firsts.map((f) => [f.id, f.ticket_key]));
    checkedIn = scans.map((x) => {
      const tk = x.delivery_id != null ? keyByFirst.get(x.delivery_id) ?? null : null;
      const deliveries = tk
        ? dels.filter((d) => d.ticket_key === tk)
        : dels.filter((d) => x.delivery_id != null && d.id === x.delivery_id);
      const key = String(x.photo_key);
      return { ...x, deliveries, ticket_url: /^https?:\/\//i.test(key) ? key : `/api/operations/file?key=${encodeURIComponent(key)}` };
    });
  } catch { checkedIn = []; }

  return c.json({ kpi, candidates, checked_in: checkedIn });
});

/** Pending ticket candidates (scanned, look like tickets, not yet actioned),
 *  plus how many WhatsApp photos are still waiting to be scanned. */
operations.get("/:projectId/deliveries/ticket-candidates", async (c) => {
  // A checked-in ticket whose delivery records are all gone belongs back in
  // the inbox — same heal as the cross-project workspace, scoped here so the
  // project tab self-fixes too (deletes made before the exact scan link).
  try {
    await c.env.DB.prepare(
      `UPDATE delivery_ticket_scans SET status = 'pending', delivery_id = NULL
        WHERE status = 'checked_in' AND delivery_id IS NOT NULL AND project_id != 'sandbox'
          AND NOT EXISTS (SELECT 1 FROM site_deliveries d WHERE d.id = delivery_ticket_scans.delivery_id)
          AND NOT EXISTS (SELECT 1 FROM site_deliveries d2 WHERE d2.scan_id = delivery_ticket_scans.id)`,
    ).run();
  } catch { /* pre-0092 */ }
  const scope = await siteScope(c.env, c.req.param("projectId"));
  const base = scope.baseId;
  const ph = scope.memberIds.map(() => "?").join(",");
  let unscanned = 0;
  try {
    const r = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM project_updates u
        WHERE u.project_id IN (${ph}) AND u.media_url IS NOT NULL
          AND u.id NOT IN (SELECT update_id FROM delivery_ticket_scans WHERE update_id IS NOT NULL)`,
    ).bind(...scope.memberIds).first<{ n: number }>();
    unscanned = r?.n ?? 0;
  } catch { /* table may predate migration */ }

  let candidates: unknown[] = [];
  try {
    const rows = await c.env.DB.prepare(
      `SELECT s.id, s.photo_key, s.po_number, s.supplier_name, s.delivery_note_number,
              s.delivery_date, s.summary, s.extracted_json, s.matched_po_id, s.matched_by, s.occurred_at,
              po.po_number AS matched_po_number, po.supplier AS matched_po_supplier,
              po.order_type AS matched_order_type, po.project_id AS matched_project_id,
              p.code AS matched_project_code
         FROM delivery_ticket_scans s
         LEFT JOIN purchase_orders po ON po.id = s.matched_po_id
         LEFT JOIN projects p ON p.id = po.project_id
        WHERE s.project_id = ? AND s.is_ticket = 1 AND s.status = 'pending'
        ORDER BY s.occurred_at DESC, s.id DESC`,
    ).bind(base).all();
    // Line-item code index for the site's open POs — lets us infer a PO for a
    // ticket whose printed PO number didn't match, so the inbox row can show
    // matched / inferred / needs-a-PO up front without a round-trip per row.
    const posForGuess = (await c.env.DB.prepare(
      `SELECT po.id, po.po_number, p.code AS project_code FROM purchase_orders po JOIN projects p ON p.id = po.project_id
        WHERE po.project_id IN (${ph}) AND po.status != 'deleted' AND po.order_type != 'framework'`,
    ).bind(...scope.memberIds).all<{ id: string; po_number: string; project_code: string }>()).results;
    const guessLines = posForGuess.length ? (await c.env.DB.prepare(
      `SELECT id, po_id, item, qty, unit FROM po_lines WHERE po_id IN (${posForGuess.map(() => "?").join(",")})`,
    ).bind(...posForGuess.map((p) => p.id)).all<{ id: number; po_id: string; item: string; qty: number | null; unit: string | null }>()).results : [];
    const poIndex = posForGuess.map((po) => ({
      id: po.id, po_number: po.po_number, project_code: po.project_code,
      codes: new Set(guessLines.filter((l) => l.po_id === po.id).map((l) => materialCode(l.item))),
      norms: new Set(guessLines.filter((l) => l.po_id === po.id).map((l) => normText(l.item))),
    }));
    const deliveryAliases = await aliasMapsBySupplier(c.env.DB, "delivery_item");
    candidates = rows.results.map((r) => {
      const row = r as { photo_key: string; extracted_json: string | null };
      const key = String(row.photo_key);
      // Pull the quantity the reader saw off the ticket so the check-in can
      // pre-fill "delivered this drop". Single-line tickets → that item's qty;
      // multi-line → the total (units usually match on one ticket).
      let scanned_qty: number | null = null, scanned_unit: string | null = null;
      let regions2: Record<string, unknown> | null = null;
      let itemRegions2: Array<ReadRegion | null> = [];
      let rotation2 = 0;
      let items: Array<{ description: string; qty: number | null; unit: string | null }> = [];
      try {
        const ex = row.extracted_json ? JSON.parse(row.extracted_json) as { items?: Array<{ description?: string; qty?: number | null; unit?: string | null; region?: unknown }>; regions?: Record<string, unknown> } : null;
        regions2 = ex?.regions ?? null;
        rotation2 = [0, 90, 180, 270].includes(Number((ex as Record<string, unknown> | null)?.rotation_degrees)) ? Number((ex as Record<string, unknown>).rotation_degrees) : 0;
        itemRegions2 = (ex?.items || []).map((i) => cleanRegion(i.region));
        items = (ex?.items || []).map((i) => ({ description: String(i.description ?? "").trim(), qty: typeof i.qty === "number" ? i.qty : null, unit: i.unit ? String(i.unit).trim() : null })).filter((i) => i.description);
        const withQty = items.filter((i) => i.qty != null);
        if (withQty.length) {
          scanned_qty = Math.round(withQty.reduce((s, i) => s + (i.qty ?? 0), 0) * 100) / 100;
          scanned_unit = (withQty.find((i) => i.unit)?.unit ?? null) || null;
        }
      } catch { /* ignore malformed json */ }
      const rest: Record<string, unknown> = { ...(r as Record<string, unknown>) };
      delete rest.extracted_json; // don't ship the big JSON blob to the client
      rest.regions = regions2;
      rest.item_regions = itemRegions2;
      rest.rotation_degrees = rotation2;
      // Headline match state for the inbox row: a matched PO → 'po'; else infer a
      // PO from the ticket's item codes → 'line' (with a guess); else 'none'.
      let method: "po" | "line" | "none" = "none", conf = 0;
      let guess_po_id: string | null = null, guess_po_number: string | null = null, guess_project_code: string | null = null;
      if (rest.matched_po_id) {
        method = "po";
        conf = rest.matched_by === "po_number" ? 96 : rest.matched_by === "supplier" ? 74 : 60;
      } else {
        const icodes = new Set(items.map((i) => materialCode(i.description)).filter((x) => x.length >= 3));
        // Learned wording (supplier-specific corrections) counts triple — a
        // human already confirmed these exact descriptions belong together.
        const am = deliveryAliases.get(normText(String(rest.supplier_name ?? ""))) ?? deliveryAliases.get("");
        const targets = am ? items.map((i) => am.get(normText(i.description))).filter((x): x is string => !!x) : [];
        let best: { id: string; po_number: string; project_code: string; hits: number } | null = null;
        for (const po of poIndex) {
          let hits = 0; for (const cd of icodes) if (po.codes.has(cd)) hits++;
          for (const t of targets) if (po.norms.has(t)) hits += 3;
          if (hits > 0 && (!best || hits > best.hits)) best = { id: po.id, po_number: po.po_number, project_code: po.project_code, hits };
        }
        if (best) { method = "line"; conf = Math.min(90, 45 + best.hits * 15); guess_po_id = best.id; guess_po_number = best.po_number; guess_project_code = best.project_code; }
      }
      // WhatsApp tickets live at an external (Wasabi) URL; older R2-sourced ones
      // stream through the ops file endpoint.
      return { ...rest, scanned_qty, scanned_unit, items, method, conf, guess_po_id, guess_po_number, guess_project_code, ticket_url: /^https?:\/\//i.test(key) ? key : `/api/operations/file?key=${encodeURIComponent(key)}` };
    });

    // Does what ARRIVED match what was ordered? The PO-number match above only
    // says the reference on the paper resolves to an order we hold — it compares
    // no quantities, so a ticket for 5,000 against a line of 50 was reported as
    // "Matched" and would check in as fully delivered. See shared/delivery-variance.
    // Lines are already in hand from the guess index above; only prior receipts
    // need fetching, and only for the POs these tickets actually point at.
    const varRows = candidates as Array<Record<string, unknown>>;
    const varPoIds = [...new Set(varRows
      .map((x) => (x.matched_po_id || x.guess_po_id) as string | null)
      .filter((x): x is string => !!x))];
    // scan_id and the scan's delivery note are carried through so a ticket is
    // never judged against its OWN goods. Two ways that happens: once checked
    // in, a ticket's own delivery rows become "already received" and it flags
    // itself for delivering more than the nothing left; and the SAME note is
    // routinely scanned twice (15 notes on this book, one of them six times —
    // WhatsApp and email both carry it), so the twin's receipts do the same.
    // A note number is the unit of delivery, and within one PO it identifies it.
    const priorRows = varPoIds.length ? (await c.env.DB.prepare(
      `SELECT d.po_id, d.po_line_id, d.scan_id, s2.delivery_note_number AS dn, SUM(d.received_qty) AS rq
         FROM site_deliveries d
         LEFT JOIN delivery_ticket_scans s2 ON s2.id = d.scan_id
        WHERE d.po_id IN (${varPoIds.map(() => "?").join(",")}) AND d.po_line_id IS NOT NULL AND d.received_qty IS NOT NULL
        GROUP BY d.po_id, d.po_line_id, d.scan_id, s2.delivery_note_number`,
    ).bind(...varPoIds).all<{ po_id: string; po_line_id: number; scan_id: number | null; dn: string | null; rq: number | null }>()).results : [];
    const linesByPo = new Map<string, VarianceLine[]>();
    for (const l of guessLines) {
      const arr = linesByPo.get(l.po_id) ?? [];
      arr.push({ id: l.id, item: l.item, qty: l.qty, unit: l.unit });
      linesByPo.set(l.po_id, arr);
    }
    const priorByPo = new Map<string, Array<PriorReceipt & { scan_id: number | null; dn: string | null }>>();
    for (const pr of priorRows) {
      const arr = priorByPo.get(pr.po_id) ?? [];
      arr.push({ po_line_id: pr.po_line_id, qty: pr.rq, scan_id: pr.scan_id, dn: pr.dn });
      priorByPo.set(pr.po_id, arr);
    }
    /** Receipts that are this same delivery — its own, or a twin scan of the
     *  same note. Everything else is a genuinely earlier drop. */
    const isSelf = (pr: { scan_id: number | null; dn: string | null }, id: unknown, dn: unknown) =>
      pr.scan_id === id || (!!pr.dn && !!dn && String(pr.dn).trim() === String(dn).trim());

    // Where the whole ORDER stands — not just the lines this ticket's own items
    // touch. `priorRows` above excludes whole-PO receipts (it filters
    // po_line_id IS NOT NULL, which the variance check needs), so a separate
    // read carries completes_po for the shared rule. Same POs, one more column.
    const orderDelRows = varPoIds.length ? (await c.env.DB.prepare(
      `SELECT d.po_id, ${PO_DELIVERY_NOTE_COLUMNS} FROM site_deliveries d ${PO_DELIVERY_NOTE_JOIN}
        WHERE d.po_id IN (${varPoIds.map(() => "?").join(",")})`,
    ).bind(...varPoIds).all<PoDeliveryRow>()).results : [];

    candidates = varRows.map((x) => {
      const poId = (x.matched_po_id || x.guess_po_id) as string | null;
      if (!poId) return x;
      const poNo = (x.matched_po_number || x.guess_po_number) as string | null;
      const its = (x.items ?? []) as Array<{ description: string; qty: number | null; unit: string | null }>;
      const prior = (priorByPo.get(poId) ?? []).filter((pr) => !isSelf(pr, x.id, x.delivery_note_number));
      const poLineRefs = guessLines.filter((l) => l.po_id === poId);
      const d = summarisePoDeliveries(poId, poLineRefs, orderDelRows);
      return {
        ...x,
        variance: deliveryVariance(its, linesByPo.get(poId) ?? [], prior, poNo),
        po_delivery: d,
      };
    });
  } catch { candidates = []; }

  return c.json({ unscanned, candidates });
});

/** Leading product-code token of a material line, normalised for matching
 *  ("SAVBRF - Euroroof…" / "SAVBRF Euroroof…" → "SAVBRF"; "PUAD-HFD" → "PUADHFD"). */
function materialCode(s: string): string {
  const first = (s || "").trim().split(/\s+/)[0] || "";
  return first.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Suggest which PO a ticket belongs to from its item codes — used when the PO
 *  number printed on the ticket is wrong/missing. Ranks the site's open POs by
 *  how many of the ticket's item codes appear as line items on them. */
operations.get("/:projectId/deliveries/ticket-candidates/:id/suggest", async (c) => {
  const scope = await siteScope(c.env, c.req.param("projectId"));
  const base = scope.baseId;
  const scan = await c.env.DB.prepare(
    "SELECT extracted_json FROM delivery_ticket_scans WHERE id = ? AND project_id = ?",
  ).bind(c.req.param("id"), base).first<{ extracted_json: string | null }>();
  if (!scan) return c.json({ error: "not found" }, 404);
  let items: Array<{ description?: string }> = [];
  try { items = (JSON.parse(scan.extracted_json || "{}").items) || []; } catch { /* none */ }
  const codes = new Set(items.map((i) => materialCode(i.description ?? "")).filter((x) => x.length >= 3));
  if (!codes.size) return c.json({ suggested_po_id: null, ranked: [] });

  const ph = scope.memberIds.map(() => "?").join(",");
  const pos = await c.env.DB.prepare(
    `SELECT po.id, po.po_number, po.supplier, po.order_type, po.project_id, p.code AS project_code
       FROM purchase_orders po JOIN projects p ON p.id = po.project_id
      WHERE po.project_id IN (${ph}) AND po.status != 'deleted' AND po.order_type != 'framework'`,
  ).bind(...scope.memberIds).all<{ id: string; po_number: string; supplier: string | null; order_type: string | null; project_id: string; project_code: string }>();
  if (!pos.results.length) return c.json({ suggested_po_id: null, ranked: [] });

  const poIds = pos.results.map((p) => p.id);
  const lph = poIds.map(() => "?").join(",");
  const lines = (await c.env.DB.prepare(
    `SELECT po_id, item FROM po_lines WHERE po_id IN (${lph})`,
  ).bind(...poIds).all<{ po_id: string; item: string }>()).results;

  const ranked = pos.results.map((po) => {
    const poCodes = new Set(lines.filter((l) => l.po_id === po.id).map((l) => materialCode(l.item)));
    let hits = 0;
    for (const cd of codes) if (poCodes.has(cd)) hits++;
    return { id: po.id, po_number: po.po_number, supplier: po.supplier, order_type: po.order_type, project_id: po.project_id, project_code: po.project_code, hits };
  }).filter((r) => r.hits > 0).sort((a, b) => b.hits - a.hits);

  return c.json({ suggested_po_id: ranked[0]?.id ?? null, item_codes: [...codes], ranked: ranked.slice(0, 5) });
});

/** Full reconciliation for one ticket against a chosen (or best-guess) PO: the
 *  PO's lines with ordered qty + cumulative prior receipts, the ticket's parsed
 *  items matched to those lines with a per-line confidence, plus ranked
 *  alternative POs and a headline match method/confidence. Powers the photo
 *  lightbox reconciliation and the per-line check-in modal. Read-only.
 *  Optional ?po_id overrides which PO to reconcile against. */
operations.get("/:projectId/deliveries/ticket-candidates/:id/reconcile", async (c) => {
  const scope = await siteScope(c.env, c.req.param("projectId"));
  const base = scope.baseId;
  const scan = await c.env.DB.prepare(
    `SELECT s.id, s.po_number, s.supplier_name, s.delivery_note_number, s.delivery_date,
            s.summary, s.extracted_json, s.matched_po_id, s.matched_by
       FROM delivery_ticket_scans s WHERE s.id = ? AND s.project_id = ?`,
  ).bind(c.req.param("id"), base).first<{
    id: number; po_number: string | null; supplier_name: string | null;
    delivery_note_number: string | null; delivery_date: string | null; summary: string | null;
    extracted_json: string | null; matched_po_id: string | null; matched_by: string | null;
  }>();
  if (!scan) return c.json({ error: "not found" }, 404);

  let items: Array<{ description: string; qty: number | null; unit: string | null }> = [];
  try {
    const ex = scan.extracted_json ? JSON.parse(scan.extracted_json) as { items?: Array<{ description?: string; qty?: number | null; unit?: string | null }> } : null;
    items = (ex?.items || []).map((i) => ({ description: String(i.description ?? "").trim(), qty: typeof i.qty === "number" ? i.qty : null, unit: i.unit ? String(i.unit).trim() : null })).filter((i) => i.description);
  } catch { /* none */ }

  // Open (non-framework) POs across the site + their lines, for matching + ranking.
  const ph = scope.memberIds.map(() => "?").join(",");
  const pos = (await c.env.DB.prepare(
    `SELECT po.id, po.po_number, po.supplier, po.order_type, po.project_id, p.code AS project_code
       FROM purchase_orders po JOIN projects p ON p.id = po.project_id
      WHERE po.project_id IN (${ph}) AND po.status != 'deleted' AND po.order_type != 'framework'
      ORDER BY po.created_at DESC`,
  ).bind(...scope.memberIds).all<{ id: string; po_number: string; supplier: string | null; order_type: string | null; project_id: string; project_code: string }>()).results;
  const allLines = pos.length ? (await c.env.DB.prepare(
    `SELECT id, po_id, item, qty, unit, unit_cost FROM po_lines WHERE po_id IN (${pos.map(() => "?").join(",")}) ORDER BY id`,
  ).bind(...pos.map((p) => p.id)).all<{ id: number; po_id: string; item: string; qty: number; unit: string; unit_cost: number }>()).results : [];

  // Rank POs by how many of the ticket's item codes appear on them (inference).
  const codes = new Set(items.map((i) => materialCode(i.description)).filter((x) => x.length >= 3));
  const ranked = pos.map((po) => {
    const poCodes = new Set(allLines.filter((l) => l.po_id === po.id).map((l) => materialCode(l.item)));
    let hits = 0; for (const cd of codes) if (poCodes.has(cd)) hits++;
    return { po, hits };
  }).filter((r) => r.hits > 0).sort((a, b) => b.hits - a.hits);

  // Chosen PO: explicit ?po_id → stored match → best item-code guess.
  const override = (c.req.query("po_id") || "").trim();
  const chosenId = (override && pos.find((p) => p.id === override) ? override : null)
    || (scan.matched_po_id && pos.find((p) => p.id === scan.matched_po_id) ? scan.matched_po_id : null)
    || ranked[0]?.po.id || null;
  const chosen = pos.find((p) => p.id === chosenId) || null;

  // How the match was derived + a headline confidence for the row.
  let method: "po" | "line" | "none" = "none";
  let conf = 0;
  if (chosen) {
    if (scan.matched_po_id === chosen.id && scan.matched_by === "po_number") { method = "po"; conf = 96; }
    else if (scan.matched_po_id === chosen.id && scan.matched_by === "supplier") { method = "po"; conf = 74; }
    else if (ranked[0]?.po.id === chosen.id && ranked[0].hits > 0) { method = "line"; conf = Math.min(90, 45 + ranked[0].hits * 15); }
    else { method = "po"; conf = 60; }
  }
  const suggested = ranked.slice(0, 5).map((r) => ({ id: r.po.id, po_number: r.po.po_number, supplier: r.po.supplier, project_code: r.po.project_code, hits: r.hits }));

  if (!chosen) {
    return c.json({
      ticket: { id: scan.id, dn: scan.delivery_note_number, date: scan.delivery_date, supplier: scan.supplier_name, po_number: scan.po_number },
      method, conf, matched_po: null, suggested,
      variance: { ok: true, checked: false, issues: [], headline: null },
      po_delivery: { state: "none" as const, lines_delivered: 0, lines_started: 0, lines_total: 0, drops: 0 },
      items: items.map((it) => ({ desc: it.description, qty: it.qty, unit: it.unit, po_line_id: null, lc: 0 })),
      po_lines: [],
    });
  }

  const poLines = allLines.filter((l) => l.po_id === chosen.id);
  // Cumulative receipts per line (oldest first) for the delivery-history strip.
  const dels = (await c.env.DB.prepare(
    `SELECT d.po_line_id, d.received_qty, d.received_unit, d.delivered_at, d.scan_id,
            s2.delivery_note_number AS dn
       FROM site_deliveries d
       LEFT JOIN delivery_ticket_scans s2 ON s2.id = d.scan_id
      WHERE d.project_id = ? AND d.po_id = ? AND d.po_line_id IS NOT NULL AND d.received_qty IS NOT NULL
      ORDER BY d.delivered_at ASC, d.id ASC`,
  ).bind(base, chosen.id).all<{ po_line_id: number; received_qty: number; received_unit: string | null; delivered_at: string; scan_id: number | null; dn: string | null }>()).results;
  const priorByLine = new Map<number, Array<{ date: string; qty: number; dn: string | null }>>();
  for (const d of dels) {
    const arr = priorByLine.get(d.po_line_id) || [];
    arr.push({ date: d.delivered_at, qty: d.received_qty, dn: d.dn });
    priorByLine.set(d.po_line_id, arr);
  }

  const po_lines = poLines.map((l) => {
    const prior = priorByLine.get(l.id) || [];
    const received = prior.reduce((s, p) => s + p.qty, 0);
    return { id: l.id, desc: l.item, unit: l.unit, ordered: l.qty, received, remaining: Math.max(0, (l.qty ?? 0) - received), prior };
  });

  // Match each ticket item to the best PO line: exact item-code first, the code
  // anywhere in the wording next, else a description token-overlap fallback.
  // Shared with the variance check so a line blamed for an over-delivery is the
  // same line the check-in modal pre-fills.
  const varLines: VarianceLine[] = poLines.map((l) => ({ id: l.id, item: l.item, qty: l.qty, unit: l.unit }));
  const outItems = items.map((it) => {
    const m = matchItemToLine(it.description, varLines);
    return { desc: it.description, qty: it.qty, unit: it.unit, po_line_id: m?.line.id ?? null, lc: m?.lc ?? 0 };
  });

  // What arrived vs what was ordered — judged on what is still OUTSTANDING, so
  // a top-up on a part-delivered line does not read as an over-delivery.
  // This delivery's own receipts are excluded — its own rows, and those of any
  // twin scan of the same note — so a checked-in or double-scanned ticket is not
  // compared against a line its own goods have already burnt down.
  // (The per-line history strip above deliberately keeps every receipt.)
  const ownDn = (scan.delivery_note_number ?? "").trim();
  const variance = deliveryVariance(
    items, varLines,
    dels.filter((d) => d.scan_id !== scan.id && !(ownDn && (d.dn ?? "").trim() === ownDn))
      .map((d) => ({ po_line_id: d.po_line_id, qty: d.received_qty })),
    chosen.po_number,
  );

  // Where the whole ORDER stands, not just the lines this ticket happens to
  // touch. An order takes as many notes as the supplier chooses to send, and
  // the inbox gave no sign that the ticket on screen was the third against an
  // order already recorded complete.
  //
  // Every receipt on the order counts here, twin scans of this same note
  // included — a note that has already been checked in once is precisely what
  // the reader needs warning about. (The variance check excludes them for its
  // own purposes: it must not compare a ticket against goods it delivered.)
  const orderDels = (await c.env.DB.prepare(
    `SELECT d.po_id, ${PO_DELIVERY_NOTE_COLUMNS} FROM site_deliveries d ${PO_DELIVERY_NOTE_JOIN} WHERE d.po_id = ?`,
  ).bind(chosen.id).all<PoDeliveryRow>()).results;
  const po_delivery = summarisePoDeliveries(chosen.id, poLines, orderDels);

  return c.json({
    ticket: { id: scan.id, dn: scan.delivery_note_number, date: scan.delivery_date, supplier: scan.supplier_name, po_number: scan.po_number },
    method, conf, variance, po_delivery,
    matched_po: { id: chosen.id, po_number: chosen.po_number, supplier: chosen.supplier, project_id: chosen.project_id, project_code: chosen.project_code, is_stored: scan.matched_po_id === chosen.id },
    suggested,
    items: outItems,
    po_lines,
  });
});

/** Re-read the pending ticket candidates with the current extractor (picks up
 *  later improvements — line items, better classification, PO matching). Updates
 *  each in place; a candidate that no longer reads as a ticket is dismissed. The
 *  `before` timestamp bounds one pass so the client can drain it without loops. */
operations.post("/:projectId/deliveries/rescan", async (c) => {
  const scope = await siteScope(c.env, c.req.param("projectId"));
  const base = scope.baseId;
  let body: { before?: string; limit?: number } = {};
  try { body = await c.req.json(); } catch { /* defaults */ }
  const before = (body.before && String(body.before)) || new Date().toISOString();
  const limit = Math.min(Math.max(Number(body.limit) || 5, 1), 10);

  const ph = scope.memberIds.map(() => "?").join(",");
  const pos = await c.env.DB.prepare(
    `SELECT po.id, po.po_number, po.supplier, p.code AS project_code FROM purchase_orders po JOIN projects p ON p.id = po.project_id
      WHERE po.project_id IN (${ph}) AND po.status != 'deleted' ORDER BY po.created_at DESC`,
  ).bind(...scope.memberIds).all<{ id: string; po_number: string; supplier: string | null; project_code: string }>();

  const scans = await c.env.DB.prepare(
    `SELECT id, photo_key FROM delivery_ticket_scans
      WHERE project_id = ? AND is_ticket = 1 AND status = 'pending' AND scanned_at < ?
      ORDER BY scanned_at ASC LIMIT ?`,
  ).bind(base, before, limit).all<{ id: number; photo_key: string }>();

  const now = new Date().toISOString();
  let rescanned = 0, stillTickets = 0;
  for (const s of scans.results) {
    rescanned++;
    let ex: ExtractedDelivery | null = null;
    try {
      if (/^https?:\/\//i.test(s.photo_key)) {
        const r = await extractDeliveryTicketFromUrl(c.env, s.photo_key);
        if (r.ok) ex = r.extracted;
      }
    } catch { /* leave ex null */ }
    if (!ex) {
      // Couldn't re-read (e.g. expired URL) — keep as-is, just advance the cursor.
      await c.env.DB.prepare("UPDATE delivery_ticket_scans SET scanned_at = ? WHERE id = ?").bind(now, s.id).run();
      stillTickets++;
      continue;
    }
    const isTicket = ex.is_delivery_ticket && (!!ex.po_number.trim() || !!ex.delivery_note_number.trim() || !!ex.supplier_name.trim());
    let matchedId: string | null = null, matchedBy: string | null = null;
    if (isTicket) {
      if (ex.po_number.trim()) {
        const hit = pos.results.find((p) => poNoMatches(ex!.po_number, p.po_number))
          ?? fuzzyFindPo(ex!.po_number, pos.results);
        if (hit) { matchedId = hit.id; matchedBy = "po_number"; }
      }
      if (!matchedId && ex.supplier_name.trim()) {
        const exSup = nameTokens(ex.supplier_name);
        let best: { id: string; score: number } | null = null;
        for (const p of pos.results) {
          const ct = nameTokens(p.supplier ?? "");
          let overlap = 0; for (const t of exSup) if (ct.has(t)) overlap++;
          const score = exSup.size ? overlap / exSup.size : 0;
          if (!best || score > best.score) best = { id: p.id, score };
        }
        if (best && best.score >= 0.5) { matchedId = best.id; matchedBy = "supplier"; }
      }
    }
    if (isTicket) stillTickets++;
    await c.env.DB.prepare(
      `UPDATE delivery_ticket_scans SET is_ticket = ?, po_number = ?, supplier_name = ?, delivery_note_number = ?,
              delivery_date = ?, summary = ?, extracted_json = ?, matched_po_id = ?, matched_by = ?, status = ?, scanned_at = ?
        WHERE id = ?`,
    ).bind(
      isTicket ? 1 : 0, ex.po_number.trim() || null, ex.supplier_name.trim() || null, ex.delivery_note_number.trim() || null,
      ex.delivery_date.trim() || null, ex.summary.trim() || null, JSON.stringify(ex), matchedId, matchedBy,
      isTicket ? "pending" : "dismissed", now, s.id,
    ).run();
  }

  const remainRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM delivery_ticket_scans
      WHERE project_id = ? AND is_ticket = 1 AND status = 'pending' AND scanned_at < ?`,
  ).bind(base, before).first<{ n: number }>();

  return c.json({ rescanned, still_tickets: stillTickets, remaining: remainRow?.n ?? 0 });
});

operations.post("/:projectId/deliveries/ticket-candidates/:id/dismiss", async (c) => {
  const base = await opsBase(c.env, c.req.param("projectId"));
  await c.env.DB.prepare(
    "UPDATE delivery_ticket_scans SET status = 'dismissed' WHERE id = ? AND project_id = ? AND status = 'pending'",
  ).bind(c.req.param("id"), base).run();
  return c.json({ ok: true });
});

/** Turn a scanned ticket into a logged delivery: copy the WhatsApp photo into
 *  the deliveries bucket, insert the site_delivery, and mark the scan actioned.
 *  Optional JSON body overrides the auto-derived supplier / PO / contract. */
operations.post("/:projectId/deliveries/ticket-candidates/:id/check-in", async (c) => {
  const scope = await siteScope(c.env, c.req.param("projectId"));
  const base = scope.baseId;
  const scan = await c.env.DB.prepare(
    `SELECT s.*, po.po_number AS m_po_number, po.project_id AS m_project_id
       FROM delivery_ticket_scans s
       LEFT JOIN purchase_orders po ON po.id = s.matched_po_id
      WHERE s.id = ? AND s.project_id = ?`,
  ).bind(c.req.param("id"), base).first<{
    id: number; photo_key: string; po_number: string | null; supplier_name: string | null;
    delivery_note_number: string | null; delivery_date: string | null; summary: string | null;
    matched_po_id: string | null; occurred_at: string | null; status: string;
    m_po_number: string | null; m_project_id: string | null;
  }>();
  if (!scan) return c.json({ error: "not found" }, 404);
  if (scan.status !== "pending") return c.json({ error: "already actioned" }, 409);

  let ov: { supplier?: string; po_number?: string; po_id?: string; description?: string; delivered_at?: string; contract_project_id?: string; target_project_id?: string; completes_po?: string; po_line_id?: string; po_line_desc?: string; received_qty?: string | number; received_unit?: string; part?: string; lines?: Array<{ po_line_id?: string; po_line_desc?: string; received_qty?: string | number; received_unit?: string }> } = {};
  try { ov = await c.req.json(); } catch { /* no overrides */ }
  const completesPo = ov.completes_po === "0" ? 0 : 1;
  const poLineId = ov.po_line_id && /^\d+$/.test(ov.po_line_id) ? Number(ov.po_line_id) : null;
  const poLineDesc = (ov.po_line_desc || "").trim() || null;
  const receivedQty = ov.received_qty != null && String(ov.received_qty).trim() !== "" && Number.isFinite(Number(ov.received_qty)) ? Number(ov.received_qty) : null;
  const receivedUnit = (ov.received_unit || "").trim() || null;

  // The ticket may have landed on the wrong site (WhatsApp group ≠ the delivery's
  // site). target_project_id re-homes it: the delivery is logged against that
  // site's base and tagged to the chosen contract (if it's a grouped block).
  let destBase = base;
  let destContract: string | null = (ov.contract_project_id
    || (scan.m_project_id && scope.memberIds.includes(scan.m_project_id) ? scan.m_project_id : "")) || null;
  const target = (ov.target_project_id || "").trim();
  if (target) {
    const exists = await c.env.DB.prepare(
      "SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL",
    ).bind(target).first();
    if (!exists) return c.json({ error: "target site not found" }, 400);
    const targetScope = await siteScope(c.env, target);
    destBase = targetScope.baseId;
    // Grouped block → tag that contract; standalone site → explicit tag or none.
    destContract = target !== targetScope.baseId ? target : (ov.contract_project_id || null);
  }

  // Copy the ticket image into deliveries/ so the delivery owns it (correct
  // prefix + independent of the external WhatsApp URL later expiring). The key
  // is the external media URL for WhatsApp tickets, else an R2 object key.
  let ticketKey: string | null = null, ticketType: string | null = null;
  try {
    let bytes: ArrayBuffer | null = null;
    if (/^https?:\/\//i.test(scan.photo_key)) {
      if (isSafeMediaUrl(scan.photo_key)) {
        const resp = await fetch(scan.photo_key);
        if (resp.ok) {
          ticketType = (resp.headers.get("content-type") || "image/jpeg").split(";")[0].trim() || "image/jpeg";
          bytes = await resp.arrayBuffer();
        }
      }
    } else {
      const obj = await c.env.R2.get(scan.photo_key);
      if (obj) { ticketType = obj.httpMetadata?.contentType || "image/jpeg"; bytes = await obj.arrayBuffer(); }
    }
    if (bytes) {
      const ext = ticketType === "application/pdf" ? "pdf" : "jpg";
      ticketKey = `deliveries/${destBase}/${crypto.randomUUID()}-ticket.${ext}`;
      await c.env.R2.put(ticketKey, bytes, { httpMetadata: { contentType: ticketType || "image/jpeg" } });
    }
  } catch (e) { console.warn("ticket photo copy failed", e instanceof Error ? e.message : e); }

  const supplier = (ov.supplier ?? scan.supplier_name ?? "").trim() || null;
  const poNumber = (ov.po_number ?? scan.po_number ?? scan.m_po_number ?? "").trim() || null;
  const poId = (ov.po_id ?? scan.matched_po_id ?? "").trim() || null;
  const description = (ov.description || scan.summary
    || (supplier ? `Delivery from ${supplier}` : "WhatsApp delivery ticket")).trim();
  const deliveredAt = (ov.delivered_at || scan.delivery_date || scan.occurred_at || new Date().toISOString()).trim();
  const now = new Date().toISOString();
  const actor = c.get("userEmail");

  // One ticket can cover several PO lines (a note with SAVBRF, MG3BASE, …). When
  // `lines` is supplied we log one delivery per line — all sharing this ticket
  // photo — so each burns down its own line. Otherwise it's a single delivery.
  const num = (v: string | number | null | undefined) => v != null && String(v).trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
  const partAll = ov.part === "1";
  type Row = { lineId: number | null; lineDesc: string | null; rq: number | null; ru: string | null; desc: string; completes: number };
  const rows: Row[] = [];
  if (Array.isArray(ov.lines) && ov.lines.length) {
    for (const ln of ov.lines) {
      const lid = ln.po_line_id && /^\d+$/.test(ln.po_line_id) ? Number(ln.po_line_id) : null;
      const ldesc = (ln.po_line_desc || "").trim() || null;
      rows.push({ lineId: lid, lineDesc: ldesc, rq: num(ln.received_qty), ru: (ln.received_unit || "").trim() || null, desc: ldesc || description, completes: partAll ? 0 : 1 });
    }
  } else {
    rows.push({ lineId: poLineId, lineDesc: poLineDesc, rq: receivedQty, ru: receivedUnit, desc: description, completes: completesPo });
  }

  // Auto-derive completeness from the quantities: if 150 of a 200-piece line
  // arrives, it's a part delivery — nobody should have to tick a box to say so.
  // The caller's flag only stands when the drop carries no usable quantities.
  if (poId) {
    try {
      const plines = (await c.env.DB.prepare(
        "SELECT id, qty FROM po_lines WHERE po_id = ?",
      ).bind(poId).all<{ id: number; qty: number | null }>()).results;
      const prior = (await c.env.DB.prepare(
        "SELECT po_line_id, SUM(received_qty) AS rq FROM site_deliveries WHERE po_id = ? AND po_line_id IS NOT NULL GROUP BY po_line_id",
      ).bind(poId).all<{ po_line_id: number; rq: number | null }>()).results;
      const priorBy = new Map(prior.map((p) => [p.po_line_id, p.rq ?? 0]));
      const dropBy = new Map<number, number>();
      for (const r of rows) if (r.lineId != null && r.rq != null) dropBy.set(r.lineId, (dropBy.get(r.lineId) ?? 0) + r.rq);
      const lineDone = (id: number, qty: number | null) =>
        qty == null || qty <= 0 || (priorBy.get(id) ?? 0) + (dropBy.get(id) ?? 0) >= qty - 0.001;
      if (dropBy.size) {
        for (const r of rows) {
          if (r.lineId == null || r.rq == null) continue;
          const pl = plines.find((p) => p.id === r.lineId);
          if (pl) r.completes = lineDone(pl.id, pl.qty) ? 1 : 0;
        }
        // A whole-PO row (no specific line) counts as complete only when every
        // quantified line is now fully received.
        const poDone = plines.length > 0 && plines.every((p) => lineDone(p.id, p.qty));
        for (const r of rows) if (r.lineId == null) r.completes = poDone ? 1 : 0;
      }
    } catch { /* quantities unavailable — keep the caller's flag */ }
  }

  // Remember which PO line each ticket item was checked in against — the next
  // note from this supplier with the same wording matches without being asked.
  await learnAliases(c.env.DB, "delivery_item", supplier,
    rows.filter((r) => r.lineId != null && r.lineDesc).map((r) => ({ alias: r.desc, target: r.lineDesc })),
    actor);

  const ids: number[] = [];
  for (const r of rows) {
    const res = await c.env.DB.prepare(
      `INSERT INTO site_deliveries
         (project_id, supplier, description, po_number, po_id, po_line_id, po_line_desc, received_qty, received_unit, ticket_key, ticket_type,
          status, notes, delivered_at, contract_project_id, completes_po, created_at, created_by, scan_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    ).bind(
      destBase, supplier, r.desc, poNumber, poId, r.lineId, r.lineDesc, r.rq, r.ru, ticketKey, ticketType,
      "received", "Checked in from WhatsApp delivery ticket", deliveredAt,
      destContract, r.completes, now, actor, scan.id,
    ).first<{ id: number }>();
    if (res?.id) ids.push(res.id);
  }

  await c.env.DB.prepare(
    "UPDATE delivery_ticket_scans SET status = 'checked_in', delivery_id = ? WHERE id = ?",
  ).bind(ids[0] ?? null, scan.id).run();

  return c.json({ id: ids[0] ?? null, ids });
});

// Manual check-in — goods that arrived with NO delivery ticket (or the
// paperwork is lost). Deliberately admin-only: it bypasses the paper trail,
// so the delivery is flagged as manual and records who logged it. Feeds the
// same site_deliveries pipeline as ticket check-ins (burn-down, delivered
// quantities, 3-way match all see it).
operations.post("/:projectId/deliveries/manual-check-in", async (c) => {
  const denied = requirePermission(c, "delivery.checkin_manual");
  if (denied) return denied;
  const scope = await siteScope(c.env, c.req.param("projectId"));
  const base = scope.baseId;
  type ManualCheckinBody = {
    po_id?: string; delivered_at?: string; notes?: string;
    whole_order?: boolean;
    lines?: Array<{ po_line_id?: number; po_line_desc?: string; received_qty?: number; received_unit?: string }>;
  };
  const b = await c.req.json<ManualCheckinBody>().catch(() => ({} as ManualCheckinBody));
  const poId = (b.po_id ?? "").trim();
  if (!poId) return c.json({ error: "po_id required" }, 400);
  const po = await c.env.DB.prepare(
    "SELECT id, po_number, supplier, project_id FROM purchase_orders WHERE id = ? AND status != 'deleted'",
  ).bind(poId).first<{ id: string; po_number: string; supplier: string | null; project_id: string }>();
  if (!po) return c.json({ error: "PO not found" }, 404);
  if (po.project_id !== base && !scope.memberIds.includes(po.project_id)) {
    return c.json({ error: "That PO belongs to a different site." }, 400);
  }
  const deliveredAt = (b.delivered_at || "").trim() || new Date().toISOString();
  const now = new Date().toISOString();
  const actor = c.get("userEmail");
  const noteText = `MANUAL CHECK-IN — no delivery ticket. Logged by ${actor ?? "unknown"}.${(b.notes ?? "").trim() ? ` ${(b.notes ?? "").trim()}` : ""}`;

  type Row = { lineId: number | null; lineDesc: string | null; rq: number | null; ru: string | null; desc: string; completes: number };
  const rows: Row[] = [];
  if (b.whole_order) {
    rows.push({ lineId: null, lineDesc: null, rq: null, ru: null, desc: `Delivery from ${po.supplier ?? "supplier"} (${po.po_number})`, completes: 1 });
  } else {
    for (const ln of b.lines ?? []) {
      const lid = ln.po_line_id != null && Number.isInteger(Number(ln.po_line_id)) ? Number(ln.po_line_id) : null;
      const rq = ln.received_qty != null && Number.isFinite(Number(ln.received_qty)) && Number(ln.received_qty) > 0 ? Number(ln.received_qty) : null;
      if (lid == null || rq == null) continue;
      const ldesc = (ln.po_line_desc ?? "").trim() || null;
      rows.push({ lineId: lid, lineDesc: ldesc, rq, ru: (ln.received_unit ?? "").trim() || null, desc: ldesc ?? `Delivery (${po.po_number})`, completes: 0 });
    }
    if (!rows.length) return c.json({ error: "Enter a received quantity for at least one line (or mark the whole order delivered)." }, 400);
  }

  // Same completeness derivation as ticket check-ins: cumulative received vs
  // ordered decides part/complete per line.
  if (rows.some((r) => r.lineId != null)) {
    try {
      const plines = (await c.env.DB.prepare(
        "SELECT id, qty FROM po_lines WHERE po_id = ?",
      ).bind(poId).all<{ id: number; qty: number | null }>()).results;
      const prior = (await c.env.DB.prepare(
        "SELECT po_line_id, SUM(received_qty) AS rq FROM site_deliveries WHERE po_id = ? AND po_line_id IS NOT NULL GROUP BY po_line_id",
      ).bind(poId).all<{ po_line_id: number; rq: number | null }>()).results;
      const priorBy = new Map(prior.map((p) => [p.po_line_id, p.rq ?? 0]));
      const dropBy = new Map<number, number>();
      for (const r of rows) if (r.lineId != null && r.rq != null) dropBy.set(r.lineId, (dropBy.get(r.lineId) ?? 0) + r.rq);
      const lineDone = (id: number, qty: number | null) =>
        qty == null || qty <= 0 || (priorBy.get(id) ?? 0) + (dropBy.get(id) ?? 0) >= qty - 0.001;
      for (const r of rows) {
        if (r.lineId == null || r.rq == null) continue;
        const pl = plines.find((p) => p.id === r.lineId);
        if (pl) r.completes = lineDone(pl.id, pl.qty) ? 1 : 0;
      }
    } catch { /* quantities unavailable — rows stay part-deliveries */ }
  }

  // Grouped block → tag the PO's own contract, mirroring ticket check-ins.
  const contract = po.project_id !== base ? po.project_id : null;
  const ids: number[] = [];
  for (const r of rows) {
    const res = await c.env.DB.prepare(
      `INSERT INTO site_deliveries
         (project_id, supplier, description, po_number, po_id, po_line_id, po_line_desc, received_qty, received_unit, ticket_key, ticket_type,
          status, notes, delivered_at, contract_project_id, completes_po, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    ).bind(
      base, po.supplier, r.desc, po.po_number, poId, r.lineId, r.lineDesc, r.rq, r.ru, null, null,
      "received", noteText, deliveredAt, contract, r.completes, now, actor,
    ).first<{ id: number }>();
    if (res?.id) ids.push(res.id);
  }
  return c.json({ ok: true, ids });
});

operations.get("/:projectId/deliveries", async (c) => {
  const projectId = await opsBase(c.env, c.req.param("projectId"));
  try {
    const rows = await c.env.DB.prepare(
      `SELECT d.id, d.supplier, d.description, d.po_number, d.po_id, d.po_line_id, d.po_line_desc, d.ticket_key, d.ticket_type,
              d.signed_by, d.signature, d.status, d.notes, d.delivered_at, d.expected_qty, d.received_qty, d.received_unit,
              d.completes_po, d.created_at, d.created_by, d.contract_project_id, cp.code AS contract_code
         FROM site_deliveries d
         LEFT JOIN projects cp ON cp.id = d.contract_project_id
        WHERE d.project_id = ? ORDER BY d.delivered_at DESC, d.id DESC`,
    ).bind(projectId).all();
    return c.json(rows.results);
  } catch (e) {
    // Pre-0046: site_deliveries has no contract_project_id column yet.
    console.warn("deliveries GET fell back (pre-0046):", e instanceof Error ? e.message : e);
    const rows = await c.env.DB.prepare(
      `SELECT id, supplier, description, po_number, po_id, ticket_key, ticket_type,
              signed_by, signature, status, notes, delivered_at, expected_qty, received_qty, created_at, created_by
         FROM site_deliveries WHERE project_id = ? ORDER BY delivered_at DESC, id DESC`,
    ).bind(projectId).all();
    return c.json(rows.results);
  }
});

// Per-line delivery burn-down: each open (non-framework) PO across the site with
// its line items, and for each line whether it's been delivered / part-delivered
// (derived from the deliveries logged against it). A line is delivered when a
// delivery assigned to it marks the PO/line complete, or a whole-PO delivery
// completes everything. Drives the "awaiting" list so it clears line by line.
operations.get("/:projectId/deliveries/po-status", async (c) => {
  const scope = await siteScope(c.env, c.req.param("projectId"));
  const base = scope.baseId;
  const ph = scope.memberIds.map(() => "?").join(",");
  const pos = await c.env.DB.prepare(
    `SELECT po.id, po.po_number, po.supplier, po.order_type, po.project_id, p.code AS project_code
       FROM purchase_orders po JOIN projects p ON p.id = po.project_id
      WHERE po.project_id IN (${ph}) AND po.status IN ('approved','issued') AND po.order_type != 'framework'
      ORDER BY po.created_at DESC`,
  ).bind(...scope.memberIds).all<{ id: string; po_number: string; supplier: string | null; order_type: string | null; project_id: string; project_code: string }>();
  if (!pos.results.length) return c.json([]);

  const poIds = pos.results.map((p) => p.id);
  const lph = poIds.map(() => "?").join(",");
  const lines = (await c.env.DB.prepare(
    `SELECT id, po_id, item, qty, unit FROM po_lines WHERE po_id IN (${lph}) ORDER BY id`,
  ).bind(...poIds).all<{ id: number; po_id: string; item: string; qty: number; unit: string }>()).results;
  // Deliveries logged against these POs (on the base project).
  const dels = (await c.env.DB.prepare(
    `SELECT d.po_id, ${PO_DELIVERY_NOTE_COLUMNS}, d.received_qty, d.received_unit
       FROM site_deliveries d ${PO_DELIVERY_NOTE_JOIN}
      WHERE d.project_id = ? AND d.po_id IN (${lph})`,
  ).bind(base, ...poIds).all<PoDeliveryRow & { received_qty: number | null; received_unit: string | null }>()).results;

  const out = pos.results.map((po) => {
    const poDels = dels.filter((d) => d.po_id === po.id);
    const wholePoDone = poDels.some((d) => d.po_line_id == null && d.completes_po === 1);
    // Charges, vouchers and collections are never chased — they don't arrive.
    const poLines = lines.filter((l) => l.po_id === po.id && isDeliverableLine(l.item)).map((l) => {
      const lineDels = poDels.filter((d) => d.po_line_id === l.id);
      const deliveredQtyTotal = lineDels.reduce((t, d) => t + (d.received_qty ?? 0), 0);
      const delivered = wholePoDone
        || lineDels.some((d) => d.completes_po === 1)
        || lineReceivedInFull(deliveredQtyTotal, l.qty);
      const inProgress = !delivered && lineDels.length > 0;
      // Running tally of what's landed, in the delivery's own unit (packs/pallets)
      // — NOT compared to the PO line's ordered unit (m²/scheme), which differs.
      const deliveredQty = lineDels.reduce((s, d) => s + (d.received_qty ?? 0), 0);
      const deliveredUnit = lineDels.find((d) => d.received_unit)?.received_unit ?? null;
      return { id: l.id, item: l.item, qty: l.qty, unit: l.unit, delivered, in_progress: inProgress, drops: lineDels.length, delivered_qty: deliveredQty || null, delivered_unit: deliveredUnit };
    });
    // The order-level roll-up comes from the shared rule, so this list, the
    // delivery check-in picker and the invoice matcher cannot drift apart on
    // what "already delivered" means.
    const summary = summarisePoDeliveries(po.id, lines, poDels);
    return {
      id: po.id, po_number: po.po_number, supplier: po.supplier, order_type: po.order_type,
      project_id: po.project_id, project_code: po.project_code,
      fully_delivered: summary.state === "full",
      delivery_state: summary.state,
      lines_delivered: summary.lines_delivered,
      lines_started: summary.lines_started,
      lines_total: summary.lines_total,
      drops: summary.drops,
      lines: poLines,
    };
  });
  return c.json(out);
});

operations.post("/:projectId/deliveries", async (c) => {
  // Logged once against the shared site (base project); the originating contract
  // is the default tag (overridable via contract_project_id).
  const actingId = c.req.param("projectId");
  const projectId = await opsBase(c.env, actingId);
  const form = await c.req.formData();
  const description = String(form.get("description") ?? "").trim();
  if (!description) return c.json({ error: "description required" }, 400);

  let ticketKey: string | null = null;
  let ticketType: string | null = null;
  const file = form.get("ticket");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_FILE_BYTES) return c.json({ error: "Ticket image too large (max 20MB)" }, 400);
    ticketKey = `deliveries/${projectId}/${crypto.randomUUID()}-${sanitizeName(file.name)}`;
    ticketType = file.type || "application/octet-stream";
    await c.env.R2.put(ticketKey, await file.arrayBuffer(), { httpMetadata: { contentType: ticketType } });
  }

  const signature = String(form.get("signature") ?? "") || null;
  if (signature && signature.length > 400_000) return c.json({ error: "Signature too large" }, 400);
  const statusRaw = String(form.get("status") ?? "received");
  const status = ["received", "partial", "rejected"].includes(statusRaw) ? statusRaw : "received";
  const now = new Date().toISOString();
  const numOrNull = (k: string) => { const v = Number(form.get(k)); return Number.isFinite(v) && String(form.get(k) ?? "").trim() !== "" ? v : null; };
  const supplier = String(form.get("supplier") ?? "").trim() || null;
  const poNumber = String(form.get("po_number") ?? "").trim() || null;
  const poId = String(form.get("po_id") ?? "").trim() || null;
  const signedBy = String(form.get("signed_by") ?? "").trim() || null;
  const notes = String(form.get("notes") ?? "").trim() || null;
  const deliveredAt = String(form.get("delivered_at") ?? "").trim() || now;
  const expected = numOrNull("expected_qty");
  const received = numOrNull("received_qty");
  const actor = c.get("userEmail");
  // contract_project_id: explicit form value, else default to the originating
  // contract when this is a grouped site (so it's tagged, not orphaned).
  const contractProjectId = String(form.get("contract_project_id") ?? "").trim()
    || (projectId !== actingId ? actingId : "") || null;
  // Part-load flag: a delivery only closes its PO when this is 1 (the default).
  const completesPo = String(form.get("completes_po") ?? "") === "0" ? 0 : 1;
  const poLineIdRaw = String(form.get("po_line_id") ?? "").trim();
  const poLineId = /^\d+$/.test(poLineIdRaw) ? Number(poLineIdRaw) : null;
  const poLineDesc = String(form.get("po_line_desc") ?? "").trim() || null;
  const receivedUnit = String(form.get("received_unit") ?? "").trim() || null;
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO site_deliveries
         (project_id, supplier, description, po_number, po_id, po_line_id, po_line_desc, ticket_key, ticket_type,
          signed_by, signature, status, notes, delivered_at, expected_qty, received_qty, received_unit,
          contract_project_id, completes_po, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    ).bind(
      projectId, supplier, description, poNumber, poId, poLineId, poLineDesc, ticketKey, ticketType,
      signedBy, signature, status, notes, deliveredAt, expected, received, receivedUnit,
      contractProjectId, completesPo, now, actor,
    ).first<{ id: number }>();
    return c.json({ id: res!.id });
  } catch (e) {
    // Pre-0046: no contract_project_id column. Store without the tag.
    console.warn("deliveries POST fell back (pre-0046):", e instanceof Error ? e.message : e);
    const res = await c.env.DB.prepare(
      `INSERT INTO site_deliveries
         (project_id, supplier, description, po_number, po_id, ticket_key, ticket_type,
          signed_by, signature, status, notes, delivered_at, expected_qty, received_qty, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    ).bind(
      projectId, supplier, description, poNumber, poId, ticketKey, ticketType,
      signedBy, signature, status, notes, deliveredAt, expected, received, now, actor,
    ).first<{ id: number }>();
    return c.json({ id: res!.id });
  }
});

operations.delete("/deliveries/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT ticket_key, scan_id FROM site_deliveries WHERE id = ?")
    .bind(id).first<{ ticket_key: string | null; scan_id: number | null }>();
  if (!row) return c.json({ ok: true });
  await c.env.DB.prepare("DELETE FROM site_deliveries WHERE id = ?").bind(id).run();
  // Every line of one ticket check-in shares the copied ticket file — only
  // remove it when the last of those lines goes.
  let othersShareTicket = false;
  if (row.ticket_key) {
    othersShareTicket = !!(await c.env.DB.prepare(
      "SELECT 1 AS x FROM site_deliveries WHERE ticket_key = ? LIMIT 1",
    ).bind(row.ticket_key).first());
    if (!othersShareTicket) await c.env.R2.delete(row.ticket_key);
  }
  // Deleting the last record of a checked-in ticket puts the ticket back in
  // the inbox, so it can be checked in again properly. The scan link is exact
  // and order-independent; rows from before the link fall back to matching the
  // scan's first-row pointer once the shared ticket file is gone.
  if (row.scan_id != null) {
    const remains = await c.env.DB.prepare("SELECT 1 AS x FROM site_deliveries WHERE scan_id = ? LIMIT 1").bind(row.scan_id).first();
    if (!remains) {
      await c.env.DB.prepare(
        "UPDATE delivery_ticket_scans SET status = 'pending', delivery_id = NULL WHERE id = ? AND status = 'checked_in'",
      ).bind(row.scan_id).run();
    }
  } else if (!othersShareTicket) {
    await c.env.DB.prepare(
      `UPDATE delivery_ticket_scans SET status = 'pending', delivery_id = NULL
        WHERE status = 'checked_in' AND delivery_id = ?`,
    ).bind(Number(id)).run();
  }
  return c.json({ ok: true });
});

// Move a delivery to another site and/or reassign its supplier / PO — e.g. a
// WhatsApp ticket that was checked in against the wrong site. Re-homes it onto
// the target's base project and tags the chosen contract.
operations.post("/deliveries/:id/reassign", async (c) => {
  const id = c.req.param("id");
  const exists = await c.env.DB.prepare("SELECT id FROM site_deliveries WHERE id = ?").bind(id).first();
  if (!exists) return c.json({ error: "not found" }, 404);
  let body: { target_project_id?: string; supplier?: string; po_id?: string; po_number?: string; contract_project_id?: string; completes_po?: string; po_line_id?: string; po_line_desc?: string; received_qty?: string; received_unit?: string; description?: string } = {};
  try { body = await c.req.json(); } catch { /* no body */ }

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.completes_po !== undefined) { sets.push("completes_po = ?"); binds.push(body.completes_po === "0" ? 0 : 1); }
  if (body.po_line_id !== undefined) { sets.push("po_line_id = ?"); binds.push(body.po_line_id && /^\d+$/.test(body.po_line_id) ? Number(body.po_line_id) : null); }
  if (body.po_line_desc !== undefined) { sets.push("po_line_desc = ?"); binds.push((body.po_line_desc || "").trim() || null); }
  if (body.received_qty !== undefined) { sets.push("received_qty = ?"); binds.push(String(body.received_qty).trim() !== "" && Number.isFinite(Number(body.received_qty)) ? Number(body.received_qty) : null); }
  if (body.received_unit !== undefined) { sets.push("received_unit = ?"); binds.push((body.received_unit || "").trim() || null); }
  const target = (body.target_project_id || "").trim();
  if (target) {
    const t = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL").bind(target).first();
    if (!t) return c.json({ error: "target site not found" }, 400);
    const targetScope = await siteScope(c.env, target);
    sets.push("project_id = ?"); binds.push(targetScope.baseId);
    sets.push("contract_project_id = ?");
    binds.push(target !== targetScope.baseId ? target : (body.contract_project_id || null));
  } else if (body.contract_project_id !== undefined) {
    sets.push("contract_project_id = ?"); binds.push(body.contract_project_id || null);
  }
  if (body.description !== undefined) { sets.push("description = ?"); binds.push((body.description || "").trim() || null); }
  if (body.supplier !== undefined) { sets.push("supplier = ?"); binds.push((body.supplier || "").trim() || null); }
  if (body.po_id !== undefined) { sets.push("po_id = ?"); binds.push((body.po_id || "").trim() || null); }
  if (body.po_number !== undefined) { sets.push("po_number = ?"); binds.push((body.po_number || "").trim() || null); }
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);

  binds.push(id);
  await c.env.DB.prepare(`UPDATE site_deliveries SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();

  // A reassign is often where a delivery FIRST meets its order, and until now
  // nothing worked out what that meant for completeness. The check-in derives
  // it from the quantities, but only when it already knows the PO — and a
  // ticket whose "PO number" was really the invoice number is checked in with
  // no PO at all. PO-26001-0058 was reassigned onto a retrospective order at
  // 71 of 71 and 114 of 114 received, and reported neither line delivered,
  // because this route only ever wrote completes_po when the caller named it.
  //
  // So once the row has landed on a line, re-read what that line has received
  // in total and promote the receipt if it now covers the order. Promotion
  // only: see `lineReceivedInFull` for why the comparison is trusted in one
  // direction and never the other.
  const mayHaveChangedTheSum =
    body.po_id !== undefined || body.po_line_id !== undefined || body.received_qty !== undefined;
  if (body.completes_po === undefined && mayHaveChangedTheSum) {
    try {
      const row = await c.env.DB.prepare(
        "SELECT po_id, po_line_id, completes_po FROM site_deliveries WHERE id = ?",
      ).bind(id).first<{ po_id: string | null; po_line_id: number | null; completes_po: number }>();
      if (row?.po_id && row.po_line_id != null && row.completes_po !== 1) {
        const tot = await c.env.DB.prepare(
          `SELECT (SELECT qty FROM po_lines WHERE id = ?1 AND po_id = ?2) AS ordered,
                  (SELECT COALESCE(SUM(received_qty), 0) FROM site_deliveries
                    WHERE po_id = ?2 AND po_line_id = ?1) AS received`,
        ).bind(row.po_line_id, row.po_id).first<{ ordered: number | null; received: number }>();
        if (tot && lineReceivedInFull(tot.received ?? 0, tot.ordered)) {
          await c.env.DB.prepare("UPDATE site_deliveries SET completes_po = 1 WHERE id = ?").bind(id).run();
        }
      }
    } catch (e) {
      // The reassign itself stands; only the derived flag is missing, and the
      // next reassign or check-in on that line will settle it.
      console.warn("reassign completeness re-derive failed:", e instanceof Error ? e.message : e);
    }
  }

  return c.json({ ok: true });
});

// ── RAMS / safety documents ──────────────────────────────────────────────────
operations.get("/:projectId/rams", async (c) => {
  const projectId = await opsBase(c.env, c.req.param("projectId"));
  let rows: { results: Record<string, unknown>[] };
  try {
    // Post-0055: includes expiry_date.
    rows = await c.env.DB.prepare(
      `SELECT id, title, category, file_key, file_name, file_type, file_size, version,
              rev_group, revision, expiry_date, active, created_at, created_by
         FROM rams_documents WHERE project_id = ? ORDER BY active DESC, revision DESC, created_at DESC`,
    ).bind(projectId).all<Record<string, unknown>>();
  } catch {
    try {
      // Pre-0055 (no expiry_date) but post-0050 (rev_group/revision).
      rows = await c.env.DB.prepare(
        `SELECT id, title, category, file_key, file_name, file_type, file_size, version,
                rev_group, revision, active, created_at, created_by
           FROM rams_documents WHERE project_id = ? ORDER BY active DESC, revision DESC, created_at DESC`,
      ).bind(projectId).all<Record<string, unknown>>();
    } catch {
      // Pre-0050: no rev_group/revision either.
      rows = await c.env.DB.prepare(
        `SELECT id, title, category, file_key, file_name, file_type, file_size, version,
                active, created_at, created_by
           FROM rams_documents WHERE project_id = ? ORDER BY active DESC, created_at DESC`,
      ).bind(projectId).all<Record<string, unknown>>();
    }
  }

  // Crew size + per-doc signed counts — signatures within the last month, by
  // operatives currently assigned to this site (mirrors the RAMS re-sign rule).
  // Wrapped so a missing operatives table never breaks the docs list.
  let crew = 0;
  const signedByDoc = new Map<number, number>();
  const requestedDocs = new Set<number>();
  try {
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const crewRow = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM operatives WHERE assigned_project_id = ? AND archived_at IS NULL",
    ).bind(projectId).first<{ n: number }>();
    crew = crewRow?.n ?? 0;
    const signs = await c.env.DB.prepare(
      `SELECT s.rams_id AS rams_id, COUNT(DISTINCT s.operative_id) AS n
         FROM operative_rams_signs s
         JOIN operatives o ON o.id = s.operative_id
        WHERE s.project_id = ? AND s.signed_at IS NOT NULL AND s.signed_at >= ?
          AND o.assigned_project_id = ? AND o.archived_at IS NULL
        GROUP BY s.rams_id`,
    ).bind(projectId, monthAgo, projectId).all<{ rams_id: number; n: number }>();
    for (const r of signs.results) signedByDoc.set(r.rams_id, r.n);
    // Docs that have been distributed at all (any request, signed or not) — drives
    // the "NEW · UNDISTRIBUTED" badge.
    const reqd = await c.env.DB.prepare(
      "SELECT DISTINCT rams_id FROM operative_rams_signs WHERE project_id = ?",
    ).bind(projectId).all<{ rams_id: number }>();
    for (const r of reqd.results) requestedDocs.add(r.rams_id);
  } catch (e) {
    console.warn("rams signed-counts skipped:", e instanceof Error ? e.message : e);
  }

  // Operative certificate cards (verified quals with an expiry) for crew assigned
  // to this site — surfaced read-only in the Documents hub as "Certificate" rows.
  let operativeCerts: Record<string, unknown>[] = [];
  try {
    const certs = await c.env.DB.prepare(
      `SELECT q.id, q.qual_type, q.card_no, q.file_key, q.file_type, q.expiry_date, q.verified_at,
              o.name AS operative_name, o.company AS operative_company
         FROM operative_quals q
         JOIN operatives o ON o.id = q.operative_id
        WHERE o.assigned_project_id = ? AND o.archived_at IS NULL AND q.verified_at IS NOT NULL
        ORDER BY q.expiry_date IS NULL, q.expiry_date`,
    ).bind(projectId).all<Record<string, unknown>>();
    operativeCerts = certs.results;
  } catch (e) {
    console.warn("operative certs skipped:", e instanceof Error ? e.message : e);
  }

  return c.json({
    documents: rows.results.map((r) => ({
      ...r,
      crew_count: crew,
      signed_count: signedByDoc.get(r.id as number) ?? 0,
      distributed: requestedDocs.has(r.id as number),
    })),
    operative_certs: operativeCerts,
  });
});

// ── Preformed toolbox talks (org-level library) ─────────────────────────────
// Uploaded Word docs that any site can start a talk from. Same conversion as
// RAMS (docx → readable HTML, original kept in R2) but no signature: a talk is
// acknowledged at sign-in, never signed.

operations.get("/toolbox-templates", async (c) => {
  try {
    const rows = await c.env.DB.prepare(
      `SELECT id, title, content, file_name, file_type, required, display_order,
              (html_content IS NOT NULL) AS has_doc
         FROM toolbox_talk_templates WHERE active = 1
        ORDER BY display_order, title`,
    ).all();
    return c.json(rows.results);
  } catch (e) {
    // Pre-0106 — the built-in list still works, the library is just empty.
    console.warn("toolbox templates unavailable:", e instanceof Error ? e.message : e);
    return c.json([]);
  }
});

/** The readable page for one talk — the manager preview and the operative view. */
operations.get("/toolbox-templates/:id", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT id, title, content, html_content, file_key, file_name, file_type, required FROM toolbox_talk_templates WHERE id = ? AND active = 1",
  ).bind(c.req.param("id")).first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

operations.post("/toolbox-templates", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return c.json({ error: "file required" }, 400);
  if (file.size > MAX_FILE_BYTES) return c.json({ error: "File too large (max 20MB)" }, 400);
  const isWord = /\.docx$/i.test(file.name) || /officedocument\.wordprocessing/i.test(file.type);
  const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
  if (!isWord && !isPdf) return c.json({ error: "Upload the talk as Word (.docx) so it's readable on a phone, or as a PDF to keep on file." }, 400);
  const html = String(form.get("html_content") ?? "").trim();
  if (isWord && !html) return c.json({ error: "Couldn't read that Word document. Re-save it as .docx and try again." }, 400);
  // Sanitized before storing — this HTML renders into the page later, so raw
  // markup would be a stored-XSS sink.
  const htmlToStore = html ? sanitizeUserHtml(html) : null;
  // The talk's own paper attendance sheet / presenter sign-off is dead weight
  // here: the app captures who acknowledged and when, so those sections would
  // just ask an operative to sign something that isn't collected.
  let sectionsToStore = String(form.get("sections_json") ?? "").trim() || null;
  if (sectionsToStore) {
    try {
      const parsed = JSON.parse(sectionsToStore) as { sections?: Array<{ title?: string }> };
      if (Array.isArray(parsed.sections)) {
        parsed.sections = parsed.sections.filter(
          (s) => !/attendance|signature|sign[-\s]?off|register/i.test(s.title ?? ""),
        );
        sectionsToStore = parsed.sections.length ? JSON.stringify(parsed) : null;
      }
    } catch { /* unparseable — store as sent rather than lose it */ }
  }
  const title = String(form.get("title") ?? "").trim() || file.name.replace(/\.[a-z0-9]+$/i, "");
  const content = String(form.get("content") ?? "").trim() || null;
  const order = Number(form.get("display_order") ?? "") || null;
  const fileType = file.type || (isPdf ? "application/pdf" : "application/octet-stream");
  const fileKey = `toolbox-templates/${crypto.randomUUID()}-${sanitizeName(file.name)}`;
  await c.env.R2.put(fileKey, await file.arrayBuffer(), { httpMetadata: { contentType: fileType } });
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO toolbox_talk_templates
       (id, title, content, html_content, sections_json, file_key, file_name, file_type, required, display_order, active, created_at, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`,
  ).bind(
    id, title, content, htmlToStore, sectionsToStore, fileKey, file.name, fileType,
    form.get("required") === "1" ? 1 : 0, order, new Date().toISOString(), c.get("userEmail") ?? null,
  ).run();
  return c.json({ id, title });
});

operations.delete("/toolbox-templates/:id", async (c) => {
  const denied = requirePermission(c, "delivery.edit");
  if (denied) return denied;
  // Soft-delete: talks already recorded from it keep their own copy of the text.
  await c.env.DB.prepare("UPDATE toolbox_talk_templates SET active = 0 WHERE id = ?")
    .bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

operations.post("/:projectId/rams", async (c) => {
  const projectId = await opsBase(c.env, c.req.param("projectId"));
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return c.json({ error: "file required" }, 400);
  if (file.size > MAX_FILE_BYTES) return c.json({ error: "File too large (max 20MB)" }, 400);
  let title = String(form.get("title") ?? "").trim() || file.name.replace(/\.[a-z0-9]+$/i, "");
  const categoryRaw = String(form.get("category") ?? "RAMS");
  let category = ["RAMS", "Method", "COSHH", "Permit", "Certificate", "Other"].includes(categoryRaw) ? categoryRaw : "RAMS";
  const expiryDate = String(form.get("expiry_date") ?? "").trim() || null;
  // Signable docs (RAMS / method / COSHH / permit) are Word, converted client-side
  // to a phone-readable page operatives scroll & sign. Certificates are
  // reference-only (a scaffold handover, a card scan) — any file type, no signing.
  const signable = category !== "Certificate";
  const html = String(form.get("html_content") ?? "").trim();
  if (signable) {
    const isWord = /\.docx?$/i.test(file.name) || /word|officedocument\.wordprocessing/i.test(file.type);
    if (!isWord) return c.json({ error: "Upload signable docs (RAMS, method, COSHH, permit) as Word (.docx) — they're converted to a phone-readable page operatives read & sign. For a PDF/scan, use the Certificate category." }, 400);
    if (!html) return c.json({ error: "Couldn't read that Word document. Re-save it as .docx, or start from the RAMS template." }, 400);
  }
  // Sanitize before storing — this HTML is later rendered via
  // dangerouslySetInnerHTML on the PUBLIC operative page, so raw markup here is a
  // stored-XSS sink. Allow-list keeps formatting/tables/links, drops scripts/handlers.
  const htmlToStore = signable ? sanitizeUserHtml(html) : null;
  const fileKey = `rams/${projectId}/${crypto.randomUUID()}-${sanitizeName(file.name)}`;
  const fileType = file.type || "application/octet-stream";
  await c.env.R2.put(fileKey, await file.arrayBuffer(), { httpMetadata: { contentType: fileType } });
  const now = new Date().toISOString();
  const actor = c.get("userEmail");

  // Revision control. A fresh upload starts a family (rev_group) at revision 1.
  // "revises_id" uploads the next revision of an existing document — it inherits
  // that document's identity (title/category/family), bumps the revision, and
  // supersedes the prior one. Revisions are auto-numbered — never typed by hand.
  const revisesId = String(form.get("revises_id") ?? "").trim();
  let revGroup: string = crypto.randomUUID();
  let revision = 1;
  if (revisesId) {
    try {
      const parent = await c.env.DB.prepare(
        "SELECT rev_group, title, category FROM rams_documents WHERE id = ? AND project_id = ?",
      ).bind(revisesId, projectId).first<{ rev_group: string | null; title: string; category: string }>();
      if (parent) {
        revGroup = parent.rev_group || String(revisesId);
        title = parent.title;
        category = parent.category;
        const mx = await c.env.DB.prepare(
          "SELECT MAX(revision) AS m FROM rams_documents WHERE rev_group = ? AND project_id = ?",
        ).bind(revGroup, projectId).first<{ m: number | null }>();
        revision = (mx?.m ?? 1) + 1;
      }
    } catch (e) { console.warn("rams revision lookup skipped (pre-0050):", e instanceof Error ? e.message : e); }
  }
  const version = `Rev ${revision}`;

  // Insert, degrading gracefully on older schemas: full (rev + html) → html only
  // (pre-0050) → legacy (pre-0047, no html — won't be signable until migrated).
  let newId: number;
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO rams_documents
         (project_id, title, category, file_key, file_name, file_type, file_size, version, rev_group, revision, expiry_date, html_content, active, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?) RETURNING id`,
    ).bind(projectId, title, category, fileKey, file.name, fileType, file.size, version, revGroup, revision, expiryDate, htmlToStore, now, actor).first<{ id: number }>();
    newId = res!.id;
  } catch (e1) {
    console.warn("rams upload fell back (pre-0050):", e1 instanceof Error ? e1.message : e1);
    try {
      const res = await c.env.DB.prepare(
        `INSERT INTO rams_documents
           (project_id, title, category, file_key, file_name, file_type, file_size, version, html_content, active, created_at, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,1,?,?) RETURNING id`,
      ).bind(projectId, title, category, fileKey, file.name, fileType, file.size, version, htmlToStore, now, actor).first<{ id: number }>();
      newId = res!.id;
    } catch (e2) {
      console.warn("rams upload fell back (pre-0047):", e2 instanceof Error ? e2.message : e2);
      const res = await c.env.DB.prepare(
        `INSERT INTO rams_documents
           (project_id, title, category, file_key, file_name, file_type, file_size, version, active, created_at, created_by)
         VALUES (?,?,?,?,?,?,?,?,1,?,?) RETURNING id`,
      ).bind(projectId, title, category, fileKey, file.name, fileType, file.size, version, now, actor).first<{ id: number }>();
      newId = res!.id;
    }
  }

  // The new revision becomes the only active one in its family.
  if (revisesId) {
    try {
      await c.env.DB.prepare(
        "UPDATE rams_documents SET active = 0 WHERE rev_group = ? AND project_id = ? AND id != ?",
      ).bind(revGroup, projectId, newId).run();
    } catch (e) { console.warn("rams supersede skipped (pre-0050):", e instanceof Error ? e.message : e); }
  }

  // Structured content for the gated operative reader (parsed client-side from
  // the same .docx). Best-effort: the column was added in 0061, and any embedded
  // images are uploaded to R2 with their src rewritten to a leaf name the
  // operative resolves via /rams-media/. Failure here never blocks the upload —
  // html_content remains the fallback.
  const sectionsJson = signable ? String(form.get("sections_json") ?? "").trim() : "";
  if (sectionsJson) {
    try {
      let json = sectionsJson;
      const media = form.getAll("media").filter((m): m is File => m instanceof File && m.size > 0);
      if (media.length) {
        const parsed = JSON.parse(sectionsJson) as { sections: Array<{ blocks: RamsBlockLite[] }> };
        const map = new Map<string, string>();
        for (const m of media) {
          const leaf = sanitizeName(m.name);
          await c.env.R2.put(`rams/${projectId}/media/${newId}/${leaf}`, await m.arrayBuffer(), { httpMetadata: { contentType: m.type || "application/octet-stream" } });
          map.set(m.name, leaf);
        }
        const rewrite = (blocks: RamsBlockLite[]) => {
          for (const b of blocks) {
            if (b && b.type === "image" && b.src && map.has(b.src)) b.src = map.get(b.src)!;
            else if (b && b.type === "rawPage" && Array.isArray(b.blocks)) rewrite(b.blocks);
          }
        };
        for (const s of parsed.sections) rewrite(s.blocks);
        json = JSON.stringify(parsed);
      }
      await c.env.DB.prepare("UPDATE rams_documents SET sections_json = ? WHERE id = ?").bind(json, newId).run();
    } catch (e) { console.warn("rams sections_json store skipped (pre-0061 or bad json):", e instanceof Error ? e.message : e); }
  }

  return c.json({ id: newId, revision, version });
});

/** Minimal shape for rewriting image src in a stored RamsDoc — avoids importing
 *  the full client model into the worker. */
type RamsBlockLite = { type: string; src?: string; blocks?: RamsBlockLite[] };

operations.patch("/rams/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ active?: boolean; title?: string; category?: string; version?: string; expiry_date?: string | null }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if ("active" in body) { sets.push("active = ?"); binds.push(body.active ? 1 : 0); }
  if (body.title != null) { sets.push("title = ?"); binds.push(body.title.trim()); }
  if (body.category != null) { sets.push("category = ?"); binds.push(body.category); }
  if (body.version !== undefined) { sets.push("version = ?"); binds.push(body.version?.trim() || null); }
  if ("expiry_date" in body) { sets.push("expiry_date = ?"); binds.push(body.expiry_date || null); }
  if (!sets.length) return c.json({ ok: true });
  binds.push(id);
  await c.env.DB.prepare(`UPDATE rams_documents SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  return c.json({ ok: true });
});

operations.delete("/rams/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT file_key FROM rams_documents WHERE id = ?")
    .bind(id).first<{ file_key: string }>();
  if (row?.file_key) await c.env.R2.delete(row.file_key);
  await c.env.DB.prepare("DELETE FROM rams_documents WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// ── Progress photos ───────────────────────────────────────────────────────────
operations.get("/:projectId/photos", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, file_key, file_type, caption, taken_on, lat, lng, created_at, created_by
       FROM progress_photos WHERE project_id = ? ORDER BY taken_on DESC, id DESC`,
  ).bind(c.req.param("projectId")).all();
  return c.json(rows.results);
});

operations.post("/:projectId/photos", async (c) => {
  const projectId = c.req.param("projectId");
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return c.json({ error: "photo required" }, 400);
  if (file.size > MAX_FILE_BYTES) return c.json({ error: "Photo too large (max 20MB)" }, 400);
  const fileKey = `progress/${projectId}/${crypto.randomUUID()}-${sanitizeName(file.name)}`;
  const fileType = file.type || "image/jpeg";
  await c.env.R2.put(fileKey, await file.arrayBuffer(), { httpMetadata: { contentType: fileType } });
  const latRaw = form.get("lat"); const lngRaw = form.get("lng");
  const now = new Date().toISOString();
  const res = await c.env.DB.prepare(
    `INSERT INTO progress_photos
       (project_id, file_key, file_type, caption, taken_on, lat, lng, created_at, created_by)
     VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
  ).bind(
    projectId, fileKey, fileType,
    String(form.get("caption") ?? "").trim() || null,
    String(form.get("taken_on") ?? "").trim() || now.slice(0, 10),
    latRaw != null && latRaw !== "" ? Number(latRaw) : null,
    lngRaw != null && lngRaw !== "" ? Number(lngRaw) : null,
    now, c.get("userEmail"),
  ).first<{ id: number }>();
  return c.json({ id: res!.id });
});

operations.delete("/photos/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT file_key FROM progress_photos WHERE id = ?")
    .bind(id).first<{ file_key: string }>();
  if (row?.file_key) await c.env.R2.delete(row.file_key);
  await c.env.DB.prepare("DELETE FROM progress_photos WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});
