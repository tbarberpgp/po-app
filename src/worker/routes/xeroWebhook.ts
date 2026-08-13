import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { getInvoice } from "../xero/client";
import { applyPaidInvoice } from "../xero/paid";

// Xero webhook receiver. Mounted at /webhooks (OUTSIDE /api) so the auth
// middleware doesn't gate it — Xero calls it unauthenticated, secured instead
// by the x-xero-signature HMAC. Xero only emits INVOICE (ACCREC + ACCPAY) and
// CONTACT events — Purchase Orders are NOT covered, which is why money-out is
// tracked via the ACCPAY Bill a PO becomes.
export const xeroWebhook = new Hono<{ Bindings: Env; Variables: Variables }>();

/** base64(HMAC-SHA256(rawBody, key)) — Xero's x-xero-signature scheme. */
async function sign(rawBody: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", k, enc.encode(rawBody));
  let bin = "";
  for (const b of new Uint8Array(mac)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Constant-time string compare. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type XeroEvent = { resourceId?: string; eventCategory?: string; eventType?: string };

xeroWebhook.post("/xero", async (c) => {
  const raw = await c.req.text();
  const key = c.env.XERO_WEBHOOK_KEY;
  const provided = c.req.header("x-xero-signature") ?? "";
  // No key configured, or signature mismatch → 401 (this is also exactly what
  // Xero's "Intent to receive" check expects for a bad signature).
  if (!key) return c.body(null, 401);
  const expected = await sign(raw, key);
  if (!safeEqual(provided, expected)) return c.body(null, 401);

  // Valid. Parse events, ACK within Xero's ~5s window, do the work after.
  let events: XeroEvent[] = [];
  try {
    const payload = JSON.parse(raw) as { events?: XeroEvent[] };
    events = Array.isArray(payload.events) ? payload.events : [];
  } catch { /* malformed but signed — ACK anyway */ }

  if (events.length) c.executionCtx.waitUntil(processEvents(c.env, events));
  return c.body(null, 200);
});

async function processEvents(env: Env, events: XeroEvent[]): Promise<void> {
  // De-dupe resourceIds within this batch.
  const invoiceIds = [
    ...new Set(
      events
        .filter((e) => e.eventCategory === "INVOICE" && e.resourceId)
        .map((e) => e.resourceId as string),
    ),
  ];
  for (const id of invoiceIds) {
    try {
      const inv = await getInvoice(env, id);
      if (inv) await applyPaidInvoice(env, inv);
    } catch (e) {
      console.warn("xero webhook: failed to process invoice", id, e instanceof Error ? e.message : e);
    }
  }
}
