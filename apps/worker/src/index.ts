import { Hono } from "hono";
import type { AppBindings, AppVariables } from "./types";
import parentRoutes from "./routes/parent";
import deviceRoutes from "./routes/device";
import { runScheduled } from "./scheduled";

const app = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

app.use("*", async (context, next) => {
  const requestId = context.req.header("Cf-Ray") ?? crypto.randomUUID();
  const started = Date.now();
  try {
    await next();
  } finally {
    console.log(JSON.stringify({ message: "request", requestId, method: context.req.method, path: context.req.path, status: context.res.status, durationMs: Date.now() - started }));
  }
});

app.get("/health", (context) => context.json({ ok: true, service: "safe-browse-api" }));
app.route("/api/v1/parent", parentRoutes);
app.route("/api/v1/device", deviceRoutes);
app.notFound((context) => context.env.ASSETS.fetch(context.req.raw));
app.onError((error, context) => {
  console.error(JSON.stringify({ message: "unhandled_error", path: context.req.path, error: error.message }));
  return context.json({ error: "internal_error" }, 500);
});

export default {
  fetch: app.fetch,
  scheduled: runScheduled,
} satisfies ExportedHandler<Env>;
