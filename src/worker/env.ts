export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_NAME: string;
  DEFAULT_TIER_THRESHOLDS: string;
  DEFAULT_CURRENCY: string;
  RESEND_API_KEY?: string;
  APP_BASE_URL?: string;
  DEV_USER_EMAIL?: string;
  // For /api/products/research — when unset, the endpoint returns 503.
  ANTHROPIC_API_KEY?: string;
  // Xero OAuth — register an app at https://developer.xero.com to obtain.
  // When unset, Xero integration endpoints return 503.
  XERO_CLIENT_ID?: string;
  XERO_CLIENT_SECRET?: string;
  // Optional override — defaults to `${APP_BASE_URL}/api/xero/callback`.
  // Must match exactly the redirect URI registered with the Xero app.
  XERO_REDIRECT_URI?: string;
};

import type { Role } from "../shared/permissions";

export type Variables = {
  userEmail: string;
  userRole: Role;
  userName: string | null;
};
