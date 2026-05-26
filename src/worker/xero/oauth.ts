// Xero OAuth 2.0 (Authorization Code, 3-legged) helpers.
//
// Flow:
//   1. User clicks "Connect to Xero" → we redirect to Xero's authorize URL.
//   2. Xero auths the user, asks them to pick a tenant (organisation), then
//      redirects back to our /api/xero/callback?code=...&state=...
//   3. We exchange the code for an access_token + refresh_token + id_token.
//   4. We list the tenants the access_token can act on, store one connection.
//   5. Every API call uses getValidConnection() which refreshes the token
//      when it's within 60 seconds of expiry.

import type { Env } from "../env";

const AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize";
const TOKEN_URL = "https://identity.xero.com/connect/token";
const CONNECTIONS_URL = "https://api.xero.com/connections";

// Scopes we ask Xero to consent to.
//
// Xero moved to granular scopes on 2 March 2026 — apps created after that
// date (ours included) can only request the new specific scopes, not the
// old umbrella ones like `accounting.transactions`.
//
//   openid                     — REQUIRED by Xero for OAuth 2.0 conformance
//   offline_access             — gives us a refresh_token (otherwise we
//                                lose access after the 30-min token expiry)
//   accounting.contacts.read   — read supplier contacts (for sync FROM Xero)
//   accounting.invoices        — read + write (POs sit under the
//                                Invoices/Bills branch of Xero's data model;
//                                this is the closest granular scope that
//                                covers POST /PurchaseOrders)
export const XERO_SCOPES = [
  "openid",
  "offline_access",
  "accounting.contacts.read",
  "accounting.invoices",
].join(" ");

export function getRedirectUri(env: Env): string {
  if (env.XERO_REDIRECT_URI) return env.XERO_REDIRECT_URI;
  if (env.APP_BASE_URL) return `${env.APP_BASE_URL.replace(/\/$/, "")}/api/xero/callback`;
  throw new Error("XERO_REDIRECT_URI or APP_BASE_URL must be set");
}

export function buildAuthorizeUrl(env: Env, state: string): string {
  if (!env.XERO_CLIENT_ID) throw new Error("XERO_CLIENT_ID not configured");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.XERO_CLIENT_ID,
    redirect_uri: getRedirectUri(env),
    scope: XERO_SCOPES,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export type XeroTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;       // seconds
  token_type: string;       // "Bearer"
  id_token?: string;
  scope?: string;
};

async function postToken(env: Env, body: URLSearchParams): Promise<XeroTokenResponse> {
  if (!env.XERO_CLIENT_ID || !env.XERO_CLIENT_SECRET) {
    throw new Error("Xero credentials not configured");
  }
  const basic = btoa(`${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Xero token endpoint ${res.status}: ${txt}`);
  }
  return (await res.json()) as XeroTokenResponse;
}

export async function exchangeCodeForTokens(env: Env, code: string): Promise<XeroTokenResponse> {
  return postToken(env, new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: getRedirectUri(env),
  }));
}

export async function refreshTokens(env: Env, refresh_token: string): Promise<XeroTokenResponse> {
  return postToken(env, new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token,
  }));
}

export type XeroTenant = {
  id: string;          // connection id
  tenantId: string;    // organisation UUID
  tenantType: string;  // ORGANISATION | PRACTICE
  tenantName: string;
  createdDateUtc: string;
  updatedDateUtc: string;
};

export async function listTenants(accessToken: string): Promise<XeroTenant[]> {
  const res = await fetch(CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`listTenants ${res.status}`);
  return (await res.json()) as XeroTenant[];
}

/** Compute the expires_at ISO timestamp given a token response. */
export function expiresAtFromNow(expires_in_seconds: number): string {
  return new Date(Date.now() + expires_in_seconds * 1000).toISOString();
}
