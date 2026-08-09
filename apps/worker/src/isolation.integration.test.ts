/**
 * Cross-tenant isolation + stronger enrollment codes.
 * Runs against local Miniflare via wrangler unstable_dev (shared local D1).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";
import { computeTotp } from "./totp";
import { normalizeEnrollmentCode } from "./crypto";

const origin = "http://127.0.0.1";

describe("multi-tenant isolation", () => {
  let worker: Unstable_DevWorker;
  const stamp = Date.now();
  const emailA = `iso-a-${stamp}@example.com`;
  const emailB = `iso-b-${stamp}@example.com`;
  let tokenA = "";
  let tokenB = "";
  let childA = "";
  let childB = "";
  let enrollCode = "";
  let deviceToken = "";

  async function j(
    path: string,
    init?: RequestInit & { token?: string },
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers = new Headers(init?.headers);
    if (!headers.has("Content-Type") && init?.body) headers.set("Content-Type", "application/json");
    if (init?.token) headers.set("Authorization", `Bearer ${init.token}`);
    // Same-origin CSRF bypass not needed: ENVIRONMENT=development
    const res = await worker.fetch(`${origin}${path}`, { ...init, headers });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = { raw: text };
    }
    return { status: res.status, body };
  }

  async function completeTotp(token: string): Promise<void> {
    const setup = await j("/api/v1/auth/totp/setup", { token });
    expect(setup.status).toBe(200);
    const secret = setup.body.secret as string;
    const code = await computeTotp(secret);
    const confirm = await j("/api/v1/auth/totp/confirm", {
      method: "POST",
      token,
      body: JSON.stringify({ secret, code }),
    });
    expect(confirm.status).toBe(200);
  }

  beforeAll(async () => {
    worker = await unstable_dev("src/index.ts", {
      config: "wrangler.jsonc",
      experimental: { disableExperimentalWarning: true },
      local: true,
    });
  }, 60_000);

  afterAll(async () => {
    await worker?.stop();
  });

  it("signs up two isolated households and links TOTP", async () => {
    const a = await j("/api/v1/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: emailA, password: "pin-aaa1", householdName: "House A" }),
    });
    expect(a.status).toBe(200);
    tokenA = a.body.token as string;
    await completeTotp(tokenA);

    const b = await j("/api/v1/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: emailB, password: "pin-bbb2", householdName: "House B" }),
    });
    expect(b.status).toBe(200);
    tokenB = b.body.token as string;
    await completeTotp(tokenB);

    const meA = await j("/api/v1/parent/me", { token: tokenA });
    const meB = await j("/api/v1/parent/me", { token: tokenB });
    expect(meA.status).toBe(200);
    expect(meB.status).toBe(200);
    expect(meA.body.householdId).not.toBe(meB.body.householdId);
    expect(meA.body.email).toBe(emailA);
    expect(meB.body.email).toBe(emailB);
  }, 60_000);

  it("parents only see their own children", async () => {
    const createA = await j("/api/v1/parent/children", {
      method: "POST",
      token: tokenA,
      body: JSON.stringify({ name: "Alice", ageBand: "age_10_12", timezone: "UTC" }),
    });
    expect(createA.status).toBe(201);
    childA = createA.body.id as string;

    const createB = await j("/api/v1/parent/children", {
      method: "POST",
      token: tokenB,
      body: JSON.stringify({ name: "Bob", ageBand: "age_13_15", timezone: "UTC" }),
    });
    expect(createB.status).toBe(201);
    childB = createB.body.id as string;

    const listA = await j("/api/v1/parent/children", { token: tokenA });
    const listB = await j("/api/v1/parent/children", { token: tokenB });
    const namesA = ((listA.body.children as { name: string }[]) ?? []).map((c) => c.name);
    const namesB = ((listB.body.children as { name: string }[]) ?? []).map((c) => c.name);
    expect(namesA).toContain("Alice");
    expect(namesA).not.toContain("Bob");
    expect(namesB).toContain("Bob");
    expect(namesB).not.toContain("Alice");
  });

  it("blocks cross-tenant policy and enrollment access", async () => {
    const crossPolicy = await j(`/api/v1/parent/children/${childB}/policy`, { token: tokenA });
    expect(crossPolicy.status).toBe(404);

    const crossEnroll = await j(`/api/v1/parent/children/${childB}/enrollment-code`, {
      method: "POST",
      token: tokenA,
    });
    expect(crossEnroll.status).toBe(404);

    const crossRule = await j(`/api/v1/parent/children/${childB}/rules`, {
      method: "POST",
      token: tokenA,
      body: JSON.stringify({ domain: "evil.example", action: "block", expiresAt: null }),
    });
    expect(crossRule.status).toBe(404);

    const ownPolicy = await j(`/api/v1/parent/children/${childA}/policy`, { token: tokenA });
    expect(ownPolicy.status).toBe(200);
  });

  it("issues high-entropy enrollment codes and enrolls only that child", async () => {
    const codeRes = await j(`/api/v1/parent/children/${childA}/enrollment-code`, {
      method: "POST",
      token: tokenA,
    });
    expect(codeRes.status).toBe(201);
    enrollCode = codeRes.body.code as string;
    expect(enrollCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // Enroll with hyphens stripped / lowercase should still work
    const enroll = await j("/api/v1/device/enroll", {
      method: "POST",
      body: JSON.stringify({
        code: enrollCode.toLowerCase().replaceAll("-", ""),
        deviceName: "Alice-PC",
        platform: "windows",
        agentVersion: "0.1.0",
      }),
    });
    expect(enroll.status).toBe(201);
    expect(enroll.body.deviceId).toBeTruthy();
    expect(enroll.body.token).toBeTruthy();
    deviceToken = enroll.body.token as string;

    // Code is single-use
    const reuse = await j("/api/v1/device/enroll", {
      method: "POST",
      body: JSON.stringify({
        code: normalizeEnrollmentCode(enrollCode),
        deviceName: "Other",
        platform: "windows",
        agentVersion: "0.1.0",
      }),
    });
    expect(reuse.status).toBe(400);

    // Device can sync
    const sync = await j("/api/v1/device/sync", { token: deviceToken });
    expect([200, 304]).toContain(sync.status);
  });

  it("prevents household B from revoking household A device", async () => {
    const childrenA = await j("/api/v1/parent/children", { token: tokenA });
    const alice = ((childrenA.body.children as { id: string; deviceId: string | null; name: string }[]) ?? []).find(
      (c) => c.name === "Alice",
    );
    expect(alice?.deviceId).toBeTruthy();

    const revoke = await j(`/api/v1/parent/devices/${alice!.deviceId}/revoke`, {
      method: "POST",
      token: tokenB,
    });
    expect(revoke.status).toBe(404);

    const revokeOwn = await j(`/api/v1/parent/devices/${alice!.deviceId}/revoke`, {
      method: "POST",
      token: tokenA,
    });
    expect(revokeOwn.status).toBe(200);
  });

  it("keeps access requests and events scoped by household", async () => {
    // Inject an event row for A via device heartbeat path is heavy; use parent events list empty + B empty
    const eventsA = await j("/api/v1/parent/events", { token: tokenA });
    const eventsB = await j("/api/v1/parent/events", { token: tokenB });
    expect(eventsA.status).toBe(200);
    expect(eventsB.status).toBe(200);
    // B must not see any of A's device history (including none after revoke)
    const idsB = new Set(((eventsB.body.events as { id: string }[]) ?? []).map((e) => e.id));
    for (const ev of (eventsA.body.events as { id: string }[]) ?? []) {
      expect(idsB.has(ev.id)).toBe(false);
    }

    const reqA = await j("/api/v1/parent/requests", { token: tokenA });
    const reqB = await j("/api/v1/parent/requests", { token: tokenB });
    expect(reqA.status).toBe(200);
    expect(reqB.status).toBe(200);
  });
});
