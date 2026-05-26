import { Hono } from "hono";
import type { Env, Variables } from "./env";
import { authMiddleware, loadCurrentUser } from "./auth";
import { projects } from "./routes/projects";
import { materials } from "./routes/materials";
import { pos } from "./routes/pos";
import { approvers } from "./routes/approvers";
import { users } from "./routes/users";
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

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

export default app;
