// Supplier order acknowledgements (SORs) → promised delivery dates on POs.
//
// Two ways in, one pipeline:
//   • accounts@ › SOR — an Outlook rule files acknowledgements there and the
//     hourly Graph pull hands each one over as sor@ (see graph.ts kindFromAs).
//   • projects@ — Angela CCs it on order emails, suppliers reply-all, and the
//     correspondence dropbox now also passes anything that looks like an
//     acknowledgement through here (email.ts).
// The same email arriving both ways is read once: dedupe is on Message-ID, and
// a second copy under a forward's new Message-ID collapses on SOR number + date.
//
// Matching is strict, like invoices and tickets: our PO number printed on it →
// attached automatically. A supplier reference we've already tied to a PO (a
// Fixfast "will be delivered today" notice quoting the acknowledgement number)
// → attached to the same PO. Anything else waits in the SOR inbox with, at
// most, a suggestion — never a guess applied silently.

import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";
import { fuzzyFindPo } from "./poRef";
import { looksLikeOurPoNumber, supplierNameOverlap, supplierNameTokens } from "../shared/line-match";
import { isPlaceholderPromise } from "../shared/order-acks";

export type OrderAckSource = "sor_folder" | "projects_email";

type Attachment = { filename?: string | null; mimeType?: string | null; content: ArrayBuffer | Uint8Array | string; disposition?: string | null; related?: boolean };
export type ParsedEmail = {
  messageId?: string | null;
  subject?: string | null;
  date?: string | null;
  text?: string | null;
  html?: string | null;
  attachments?: Attachment[];
};

export type ExtractedAck = {
  is_order_document: boolean;
  kind: "acknowledgement" | "delivery_notice" | "other";
  supplier_name: string | null;
  supplier_order_ref: string | null;
  our_po_ref: string | null;
  ack_date: string | null;
  promised_date: string | null;
  promised_time: string | null;
  delivery_address: string | null;
  delivery_instructions: string | null;
  goods_total: number | null;
  carriage: number | null;
  total_ex_vat: number | null;
  lines: Array<{ code: string | null; description: string; quantity: number | null; unit: string | null; unit_price: string | null; amount: number | null; line_date: string | null }>;
};

const ACK_TOOL: Anthropic.Tool = {
  name: "extract_order_ack",
  description: "Record what a supplier's order acknowledgement / order confirmation / delivery notice says.",
  input_schema: {
    type: "object",
    properties: {
      is_order_document: { type: "boolean", description: "True if this confirms or acknowledges an order we placed, or tells us when an order will be delivered or has been dispatched. False for invoices, quotes, statements, remittances, price-increase notices, marketing, chit-chat." },
      kind: { type: "string", enum: ["acknowledgement", "delivery_notice", "other"], description: "acknowledgement = order acknowledgement/confirmation (SOR); delivery_notice = 'will be delivered on/today', 'delivery arranged for', 'dispatched'." },
      supplier_name: { type: "string", description: "The supplier (who we are buying from), as they name themselves." },
      supplier_order_ref: { type: "string", description: "The supplier's OWN order number: Sales Order / Order Number / SOR… / Fixfast Ref / acknowledgement number. Not our PO." },
      our_po_ref: { type: "string", description: "Exactly what is printed where OUR order number goes: 'Customer Order Ref', 'Your Order No', 'Your Ref', 'Customer PO'. Copy it verbatim even if it is a site name or a person's name." },
      ack_date: { type: "string", description: "Acknowledgement / order date, YYYY-MM-DD." },
      promised_date: { type: "string", description: "When the goods are due: Expected Due Date / Delivery Date / 'will be delivered on' / 'delivery arranged for'. YYYY-MM-DD. If only per-line dates are given, use the LATEST line date. Resolve 'today'/'tomorrow' against the email's sent date. Leave empty if none is given." },
      promised_time: { type: "string", description: "Any delivery time window or service, e.g. 'between 09:27 - 10:27', 'AM', '12H00 Service A'." },
      delivery_address: { type: "string", description: "Deliver-to address, one line." },
      delivery_instructions: { type: "string", description: "Delivery instructions or site contact, one line." },
      goods_total: { type: "number", description: "Goods total ex VAT, excluding carriage. Plain number." },
      carriage: { type: "number", description: "Carriage / delivery charge ex VAT, if any." },
      total_ex_vat: { type: "number", description: "Total ex VAT including carriage." },
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            code: { type: "string" },
            description: { type: "string" },
            quantity: { type: "number" },
            unit: { type: "string" },
            unit_price: { type: "string", description: "As printed, keeping any per-unit basis, e.g. '44.53 / 100'." },
            amount: { type: "number" },
            line_date: { type: "string", description: "Per-line shipment/delivery date, YYYY-MM-DD." },
          },
          required: ["description"],
        },
      },
    },
    required: ["is_order_document", "kind"],
  },
};

const s = (v: unknown): string | null => { const t = (v == null ? "" : String(v)).trim(); return t || null; };
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const ymd = (v: unknown): string | null => { const t = s(v); return t && /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null; };

function toBuffer(c: Attachment["content"]): ArrayBuffer {
  if (typeof c === "string") return new TextEncoder().encode(c).buffer as ArrayBuffer;
  if (c instanceof ArrayBuffer) return c;
  return c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength) as ArrayBuffer;
}

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
}

/** PDFs, plus photographed acknowledgements — but not the logos and signature
 *  images every forwarded email carries. */
function documentAttachments(parsed: ParsedEmail): Attachment[] {
  return (parsed.attachments ?? []).filter((a) => {
    const name = (a.filename ?? "").toLowerCase();
    const isPdf = a.mimeType === "application/pdf" || name.endsWith(".pdf");
    if (isPdf) return true;
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(a.mimeType ?? "")) return false;
    if (a.related === true || a.disposition === "inline") return false;
    return toBuffer(a.content).byteLength >= 25_000;
  }).slice(0, 3);
}

function plainBody(parsed: ParsedEmail): string {
  const t = parsed.text ?? (parsed.html ?? "").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  return t.replace(/\n{3,}/g, "\n\n").trim().slice(0, 6000);
}

export async function extractOrderAck(env: Env, parsed: ParsedEmail, docs: Attachment[]): Promise<ExtractedAck> {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured (needed to read order acknowledgements)");
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const content: Anthropic.MessageParam["content"] = [];
  for (const a of docs) {
    const buf = toBuffer(a.content);
    if (buf.byteLength > 15_000_000) continue;
    const isPdf = a.mimeType === "application/pdf" || (a.filename ?? "").toLowerCase().endsWith(".pdf");
    content.push(isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: bufToBase64(buf) } }
      : { type: "image", source: { type: "base64", media_type: a.mimeType as "image/png" | "image/jpeg" | "image/webp" | "image/gif", data: bufToBase64(buf) } });
  }
  const sent = parsed.date ? new Date(parsed.date) : null;
  content.push({
    type: "text",
    text: `Email subject: ${parsed.subject ?? "(none)"}\nEmail sent: ${sent && !Number.isNaN(sent.getTime()) ? sent.toISOString().slice(0, 10) : "unknown"}\n\nEmail body:\n${plainBody(parsed) || "(empty)"}\n\nExtract via extract_order_ack.`,
  });
  const response = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 3072,
    system: "You are a UK construction buyer's assistant reading emails from suppliers about orders WE placed with them (Power Grid Projects is the customer). Read the attached acknowledgement or the email itself and record the supplier's own order number, the reference they printed for OUR order, and above all the date they have promised to deliver. Emails are often forwarded internally — read through the forward to the supplier's message. Numbers must be plain — no £ or commas.",
    tools: [ACK_TOOL],
    tool_choice: { type: "tool", name: "extract_order_ack" },
    messages: [{ role: "user", content }],
  });
  const tu = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const r = (tu?.input ?? {}) as Record<string, unknown>;
  const kind = r.kind === "acknowledgement" || r.kind === "delivery_notice" ? r.kind : "other";
  return {
    is_order_document: r.is_order_document === true,
    kind,
    supplier_name: s(r.supplier_name),
    supplier_order_ref: s(r.supplier_order_ref),
    our_po_ref: s(r.our_po_ref),
    ack_date: ymd(r.ack_date),
    promised_date: ymd(r.promised_date),
    promised_time: s(r.promised_time),
    delivery_address: s(r.delivery_address),
    delivery_instructions: s(r.delivery_instructions),
    goods_total: n(r.goods_total),
    carriage: n(r.carriage),
    total_ex_vat: n(r.total_ex_vat),
    lines: (Array.isArray(r.lines) ? (r.lines as Array<Record<string, unknown>>) : []).map((l) => ({
      code: s(l.code), description: s(l.description) ?? "", quantity: n(l.quantity), unit: s(l.unit),
      unit_price: s(l.unit_price), amount: n(l.amount), line_date: ymd(l.line_date),
    })).filter((l) => l.description),
  };
}

/** Same supplier? Their paperwork and our register rarely agree on the full
 *  name — Alumasc acknowledge as "Alumasc Building Products" against POs raised
 *  to "Alumasc Water Management Solutions" — so the leading trading name is
 *  enough, as is most of either name. Only ever used to SUGGEST a PO, or to let
 *  a supplier reference carry a PO it was already tied to. */
export function sameSupplier(a: string | null | undefined, b: string | null | undefined): boolean {
  if (supplierNameOverlap(a, b) >= 0.5 || supplierNameOverlap(b, a) >= 0.5) return true;
  const first = (x: string | null | undefined) => [...supplierNameTokens(x)][0] ?? "";
  const fa = first(a), fb = first(b);
  return fa.length >= 4 && fa === fb;
}

type PoRow = { id: string; po_number: string; project_code: string; supplier: string; status: string; total_value: number; created_at: string };

/** Which PO this acknowledgement belongs to — or, failing a certain answer,
 *  which one to suggest. Exported for tests. */
export function resolveAckPo(
  ex: Pick<ExtractedAck, "our_po_ref" | "supplier_name" | "goods_total" | "total_ex_vat" | "carriage" | "delivery_address">,
  pos: PoRow[],
  knownRef: { po_id: string } | null,
): { po_id: string | null; matched_by: "po_number" | "supplier_ref" | null; suggested_po_id: string | null; suggest_reason: string | null } {
  const none = { po_id: null, matched_by: null, suggested_po_id: null, suggest_reason: null } as const;
  if (ex.our_po_ref && looksLikeOurPoNumber(ex.our_po_ref)) {
    const hit = fuzzyFindPo(ex.our_po_ref, pos);
    if (hit) return { po_id: hit.id, matched_by: "po_number", suggested_po_id: null, suggest_reason: null };
  }
  if (knownRef) return { po_id: knownRef.po_id, matched_by: "supplier_ref", suggested_po_id: null, suggest_reason: null };

  // Suggestion only: same supplier, still open, recent.
  const open = pos.filter((p) =>
    ["pending_approval", "approved", "issued"].includes(p.status)
    && sameSupplier(ex.supplier_name, p.supplier));
  if (!open.length) return none;
  const goods = ex.goods_total ?? (ex.total_ex_vat != null ? ex.total_ex_vat - (ex.carriage ?? 0) : null);
  const agrees = (p: PoRow) => goods != null && p.total_value > 0 && Math.abs(goods - p.total_value) <= Math.max(1, p.total_value * 0.01);
  const byTotal = open.filter(agrees);
  if (byTotal.length === 1) return { ...none, suggested_po_id: byTotal[0].id, suggest_reason: "same supplier · goods total agrees with the PO" };
  const text = `${ex.our_po_ref ?? ""} ${ex.delivery_address ?? ""}`;
  const byProject = open.filter((p) => new RegExp(`(?<![0-9])${p.project_code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`).test(text));
  if (byProject.length === 1) return { ...none, suggested_po_id: byProject[0].id, suggest_reason: `same supplier · ${byProject[0].project_code} is quoted on it` };
  if (open.length === 1) return { ...none, suggested_po_id: open[0].id, suggest_reason: "the only open order with this supplier" };
  return none;
}

/** Read one email as an order acknowledgement and file it. Throws on a read
 *  failure so the Graph pull records it and retries next hour. */
export async function ingestOrderAckEmail(
  env: Env,
  parsed: ParsedEmail,
  meta: { source: OrderAckSource; sender: string; subject: string },
): Promise<{ id: number | null; status: string } | null> {
  const key = (parsed.messageId || `${meta.subject}|${parsed.date ?? ""}|${meta.sender}`).slice(0, 300);
  const prior = await env.DB.prepare("SELECT id, status FROM order_acks WHERE dedupe_key = ?").bind(key).first<{ id: number; status: string }>();
  if (prior) return prior;

  const docs = documentAttachments(parsed);
  const ex = await extractOrderAck(env, parsed, docs);
  const now = new Date().toISOString();
  const receivedAt = parsed.date && !Number.isNaN(new Date(parsed.date).getTime()) ? new Date(parsed.date).toISOString() : now;

  // Not an order document (a quote, a statement, a price-increase letter) —
  // keep the row so the SOR inbox can say it was looked at and set aside.
  let fileKey: string | null = null, fileName: string | null = null;
  if (docs[0]) {
    fileName = (docs[0].filename || "acknowledgement.pdf").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80);
    fileKey = `sor/${receivedAt.slice(0, 7)}/${crypto.randomUUID()}-${fileName}`;
    try {
      await env.R2.put(fileKey, toBuffer(docs[0].content), { httpMetadata: { contentType: docs[0].mimeType || "application/pdf" } });
    } catch { fileKey = null; }
  }

  let promised = ex.promised_date;
  let promisedNote = ex.promised_time;
  if (isPlaceholderPromise(ex.supplier_name, promised)) {
    promised = null;
    promisedNote = "Placeholder date on the acknowledgement (24/12 or 29/12) — no real date given";
  }

  let status: "matched" | "pending" | "dismissed" = "pending";
  let dismissReason: string | null = null;
  let match: ReturnType<typeof resolveAckPo> = { po_id: null, matched_by: null, suggested_po_id: null, suggest_reason: null };

  if (!ex.is_order_document) {
    status = "dismissed";
    dismissReason = "Not an order confirmation";
  } else {
    const pos = (await env.DB.prepare(
      `SELECT po.id, po.po_number, p.code AS project_code, po.supplier, po.status, po.total_value, po.created_at
         FROM purchase_orders po JOIN projects p ON p.id = po.project_id
        WHERE po.status NOT IN ('deleted','rejected') AND p.deleted_at IS NULL AND p.id <> 'sandbox'`,
    ).all<PoRow>()).results;
    const knownRef = ex.supplier_order_ref
      ? await env.DB.prepare(
          `SELECT po_id FROM order_acks
            WHERE status = 'matched' AND po_id IS NOT NULL AND supplier_order_ref = ?
            ORDER BY id DESC LIMIT 1`,
        ).bind(ex.supplier_order_ref).first<{ po_id: string }>()
      : null;
    // A supplier ref only carries a PO over when it's the same supplier.
    const knownPo = knownRef ? pos.find((p) => p.id === knownRef.po_id) : null;
    match = resolveAckPo(ex, pos, knownPo && sameSupplier(ex.supplier_name, knownPo.supplier) ? knownRef : null);
    if (match.po_id) status = "matched";

    // The same acknowledgement through both doors (folder + projects@), or
    // forwarded twice: same supplier ref, same promise → read once.
    if (ex.supplier_order_ref) {
      const twin = await env.DB.prepare(
        `SELECT id FROM order_acks WHERE supplier_order_ref = ? AND kind = ?
            AND COALESCE(promised_date, '') = COALESCE(?, '') AND status <> 'dismissed' LIMIT 1`,
      ).bind(ex.supplier_order_ref, ex.kind, promised).first<{ id: number }>();
      if (twin) { status = "dismissed"; dismissReason = `Same as #${twin.id} — already read`; }
    }
  }

  const res = await env.DB.prepare(
    `INSERT INTO order_acks
       (dedupe_key, source, kind, sender, subject, received_at, file_key, file_name,
        supplier_name, supplier_order_ref, our_po_ref, ack_date, promised_date, promised_note,
        delivery_address, goods_total, carriage, total_ex_vat, extracted_json,
        po_id, matched_by, suggested_po_id, suggest_reason, status, dismiss_reason, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(dedupe_key) DO NOTHING`,
  ).bind(
    key, meta.source, ex.kind, meta.sender || null, meta.subject.slice(0, 300) || null, receivedAt, fileKey, fileName,
    ex.supplier_name, ex.supplier_order_ref, ex.our_po_ref, ex.ack_date, promised, promisedNote,
    ex.delivery_address, ex.goods_total, ex.carriage, ex.total_ex_vat, JSON.stringify(ex),
    status === "dismissed" ? null : match.po_id, status === "dismissed" ? null : match.matched_by,
    status === "dismissed" ? null : match.suggested_po_id, status === "dismissed" ? null : match.suggest_reason,
    status, dismissReason, now,
  ).run();
  return { id: Number(res.meta?.last_row_id ?? 0) || null, status };
}
