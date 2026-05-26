import { Hono } from "hono";
import type { Env, Variables } from "../env";

// Read-only lookups for elements + resource types. Both are seeded by the
// migration and edited (rarely) via the D1 console.

export const elements = new Hono<{ Bindings: Env; Variables: Variables }>();
elements.get("/", async (c) => {
  const rows = await c.env.DB.prepare("SELECT code, name, notes FROM elements ORDER BY code").all();
  return c.json(rows.results);
});

export const resourceTypes = new Hono<{ Bindings: Env; Variables: Variables }>();
resourceTypes.get("/", async (c) => {
  const rows = await c.env.DB.prepare("SELECT code, name, usage FROM resource_types ORDER BY code").all();
  return c.json(rows.results);
});
