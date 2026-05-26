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
import { elements, resourceTypes } from "./routes/taxonomy";
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
app.route("/api/elements", elements);
app.route("/api/resource-types", resourceTypes);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

export default app;
