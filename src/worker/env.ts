export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  // Object storage — delivery-ticket photos, RAMS, progress photos (Phase 2).
  R2: R2Bucket;
  // Browser Rendering — renders the rich site report to a PDF for email
  // attachment (renderReportPdf). Optional: when unset, report emails fall back
  // to the inline HTML with no PDF attached.
  BROWSER?: import("@cloudflare/puppeteer").BrowserWorker;
  // Images binding — used to downscale/re-encode site-report photos before
  // embedding them in the report PDF (keeps the PDF emailable, ~40MB → a few MB).
  // Optional: when unset/unavailable, photos are embedded at their original size.
  IMAGES?: ImagesBinding;
  APP_NAME: string;
  DEFAULT_TIER_THRESHOLDS: string;
  DEFAULT_CURRENCY: string;
  RESEND_API_KEY?: string;
  /** Optional "Name <addr@verified-domain>" override for outbound email. */
  RESEND_FROM?: string;
  // Twilio SMS — used to text operatives their profile link on creation.
  // When any of these are unset, SMS is skipped (best-effort, no error).
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  /** The Twilio sender — an SMS-capable phone number (E.164) or Messaging Service SID. */
  TWILIO_FROM?: string;
  APP_BASE_URL?: string;
  DEV_USER_EMAIL?: string;
  // For /api/products/research and the daily/weekly site-report summaries —
  // when unset, AI features fall back / return 503.
  ANTHROPIC_API_KEY?: string;
  // Shared bearer token for the /pub/site-report-ingest webhook (WhatsApp →
  // field updates). When unset, the ingest endpoint returns 503.
  SITE_REPORT_INGEST_TOKEN?: string;
  // Whapi.cloud REST token — lets the Reports "Connect a group" modal list the
  // WhatsApp groups the number is in. When unset, the modal shows the manual
  // helper instead (group lists/member counts need this). Inbound webhook
  // ingest is unaffected (it doesn't need the API token).
  WHAPI_TOKEN?: string;
  /** Whapi API base — defaults to https://gate.whapi.cloud. */
  WHAPI_BASE_URL?: string;
  // Xero OAuth — register an app at https://developer.xero.com to obtain.
  // When unset, Xero integration endpoints return 503.
  XERO_CLIENT_ID?: string;
  XERO_CLIENT_SECRET?: string;
  // Optional override — defaults to `${APP_BASE_URL}/api/xero/callback`.
  // Must match exactly the redirect URI registered with the Xero app.
  XERO_REDIRECT_URI?: string;
  // Xero webhooks signing key (from the Xero app's Webhooks config). Used to
  // verify the x-xero-signature on POSTs to /webhooks/xero. When unset, the
  // webhook endpoint rejects everything with 401.
  XERO_WEBHOOK_KEY?: string;
  // Key for encrypting the Xero OAuth tokens at rest in D1 (AES-256-GCM; see
  // xero/crypto.ts). Set with `wrangler secret put XERO_TOKEN_KEY` (any
  // high-entropy string, e.g. `openssl rand -base64 32`). Required once the
  // encryption code is live — connecting/refreshing Xero throws without it.
  XERO_TOKEN_KEY?: string;
  // Microsoft Graph — pull inbound invoice/labour/client emails directly from
  // Microsoft 365 mailboxes, so ingestion doesn't depend on auto-forwarding
  // (which M365 blocks externally). TENANT_ID + CLIENT_ID come from an Entra app
  // registration with the Mail.Read application permission (scoped to the shared
  // mailboxes via an Application Access Policy). CLIENT_SECRET set via
  // `wrangler secret put MS_GRAPH_CLIENT_SECRET`. MAILBOXES is a JSON array
  // mapping each source mailbox to the app address it should ingest as:
  //  [{ "mailbox":"accounts@powergridprojects.net", "as":"invoices@pgpprojects.com", "folder":"Inbox" }]
  // When any of these are unset the hourly mailbox pull is a no-op.
  MS_GRAPH_TENANT_ID?: string;
  MS_GRAPH_CLIENT_ID?: string;
  MS_GRAPH_CLIENT_SECRET?: string;
  MS_GRAPH_MAILBOXES?: string;
};

import type { Role } from "../shared/permissions";

export type Variables = {
  userEmail: string;
  userRole: Role;
  userName: string | null;
};
