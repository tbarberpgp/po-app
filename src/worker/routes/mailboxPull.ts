// Admin surface for the Microsoft Graph mailbox pull (see src/worker/graph.ts):
// a status readout (is it configured, what's wired, how far each mailbox has
// been read, recent runs) and a manual "run now" so it can be tested without
// waiting for the hourly cron. Superadmin only — it touches mail-flow plumbing.
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
  let watermarks: unknown[] = [];
  let stuck: unknown[] = [];
  let total_ingested = 0;
  try {
    const runs = await c.env.DB.prepare(
      "SELECT ran_at, ok, mailboxes, fetched, ingested, error FROM graph_pull_runs ORDER BY id DESC LIMIT 5",
    ).all();
    last_runs = runs.results;
    const t = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM graph_pulled_messages WHERE status = 'ingested'",
    ).first<{ n: number }>();
    total_ingested = t?.n ?? 0;
    // How far each mailbox has been read. This is the queue now — not the unread
    // flag — so it's worth being able to see it, and to spot one that has stopped
    // moving while the runs still report "ok".
    const wm = await c.env.DB.prepare(
      "SELECT mailbox, watermark, updated_at FROM graph_pull_state ORDER BY mailbox",
    ).all();
    watermarks = wm.results;
    // Messages the pull couldn't ingest. They're retried while the window still
    // covers them; these are the ones that need a human to look.
    const bad = await c.env.DB.prepare(
      "SELECT subject, from_addr, attempts, last_error, received_at FROM graph_pulled_messages " +
      "WHERE status = 'failed' ORDER BY received_at DESC LIMIT 10",
    ).all();
    stuck = bad.results;
  } catch { /* tables may predate migration 0085 / 0123 */ }
  return c.json({ configured, mailboxes, last_runs, watermarks, stuck, total_ingested });
});

mailboxPull.post("/run", async (c) => {
  if (!graphConfigured(c.env)) {
    return c.json({ error: "Microsoft Graph isn't configured yet — set MS_GRAPH_TENANT_ID / MS_GRAPH_CLIENT_ID / MS_GRAPH_CLIENT_SECRET and MS_GRAPH_MAILBOXES." }, 400);
  }
  const result = await runMailboxPull(c.env);
  return c.json(result);
});
