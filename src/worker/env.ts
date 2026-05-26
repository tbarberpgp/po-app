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
};

import type { Role } from "../shared/permissions";

export type Variables = {
  userEmail: string;
  userRole: Role;
  userName: string | null;
};
