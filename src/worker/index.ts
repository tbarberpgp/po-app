import { Hono } from "hono";
import type { Env, Variables } from "./env";
import { authMiddleware, loadCurrentUser } from "./auth";
import { projects } from "./routes/projects";
import { materials } from "./routes/materials";
import { pos } from "./routes/pos";
import { approvers } from "./routes/approvers";
import { users } from "./routes/users";
import { products } from "./routes/products";
import { suppliers } from "./routes/suppliers";
import { quotes } from "./routes/quotes";
import { elements, resourceTypes } from "./routes/taxonomy";
import { xero } from "./routes/xero";
import { loadSettings } from "./approval";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("/api/*", authMiddleware);

app.get("/api/me", async (c) => c.json(await loadCurrentUser(c)));
app.get("/api/settings", async (c) => c.json(await loadSettings(c.env.DB)));

app.route("/api/projects", projects);
app.route("/api/materials", materials);
app.route("/api/pos", pos);
app.route("/api/approvers", approvers);
app.route("/api/users", users);
app.route("/api/products", products);
app.route("/api/suppliers", suppliers);
app.route("/api/quotes", quotes);
app.route("/api/elements", elements);
app.route("/api/resource-types", resourceTypes);
app.route("/api/xero", xero);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

// Any non-API route falls back to the SPA shell so React Router can take
// over (e.g. /admin, /admin?xero=connected, /pos/abc, /projects/xyz).
// Without this, server-side requests to client-side routes return Hono's
// default 404 text — which is what was happening after the OAuth redirect.
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
