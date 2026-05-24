export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_NAME: string;
  DEFAULT_TIER_THRESHOLDS: string;
  DEFAULT_CURRENCY: string;
  RESEND_API_KEY?: string;
  APP_BASE_URL?: string;
  DEV_USER_EMAIL?: string;
};

export type Variables = {
  userEmail: string;
};
