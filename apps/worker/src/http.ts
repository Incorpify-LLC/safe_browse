import { z } from "zod";
import type { Context } from "hono";

export async function parseJson<T>(context: Context, schema: z.ZodType<T>): Promise<T | Response> {
  const length = Number(context.req.header("Content-Length") ?? "0");
  if (length > 128_000) return context.json({ error: "payload_too_large" }, 413);
  try {
    const parsed = schema.safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    return parsed.data;
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
}

export function isResponse<T>(value: T | Response): value is Response {
  return value instanceof Response;
}

export function jsonDetail(value: unknown): string {
  return JSON.stringify(value).slice(0, 2000);
}
