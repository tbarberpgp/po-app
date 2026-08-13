// Admin surface for the Microsoft Graph mailbox pull (see src/worker/graph.ts):
// a status readout (is it configured, what's wired, recent runs) and a manual
// "run now" so it can be tested without waiting for the hourly cron.
// Superadmin only — it touches mail-flow plumbing.
import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { runMailboxPull, graphConfigured, configuredMailboxes } from "../graph";

export const mailboxPull = new Hono<{ Bindings: Env; Variables: Variables }>();

mailboxPull.use("*", async (c, next) => {
  if (c.get("userRole") !== "superadmin") return c.json({ error: "Superadmin only" }, 403);
  await next();
});

mailboxPull.get("/status", async (c) => {
  const configured = graphConfigured(c.env);
  const mailboxes = configuredMailboxes(c.env);
  let last_runs: unknown[] = [];
  let total_ingested = 0;
  try {
    const runs = await c.env.DB.prepare(
      "SELECT ran_at, ok, mailboxes, fetched, ingested, error FROM graph_pull_runs ORDER BY id DESC LIMIT 5",
    ).all();
    last_runs = runs.results;
    const t = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM graph_pulled_messages").first<{ n: number }>();
    total_ingested = t?.n ?? 0;
  } catch { /* tables may predate migration 0085 */ }
  return c.json({ configured, mailboxes, last_runs, total_ingested });
});

mailboxPull.post("/run", async (c) => {
  if (!graphConfigured(c.env)) {
    return c.json({ error: "Microsoft Graph isn't configured yet — set MS_GRAPH_TENANT_ID / MS_GRAPH_CLIENT_ID / MS_GRAPH_CLIENT_SECRET and MS_GRAPH_MAILBOXES." }, 400);
  }
  const result = await runMailboxPull(c.env);
  return c.json(result);
});
