import type { AgeBand, Category } from "@safe-browse/contracts";

export type Child = {
  id: string; name: string; ageBand: AgeBand; timezone: string; policyVersion: number;
  paused: number; deviceId: string | null; deviceName: string | null; status: string | null; lastSeenAt: string | null;
};
export type AccessRequest = { id: string; childName: string; domain: string; category: Category | null; reason: string | null; status: string; requestedAt: string };
export type HistoryEvent = { id: string; childName: string; occurredAt: string; kind: string; domain: string | null; category: Category | null; browser: string | null; detail: string | null };
export type PolicyView = {
  child: { id: string; name: string; ageBand: AgeBand; timezone: string; safeSearch: number; youtubeRestricted: number; paused: number };
  categories: { category: Category; enabled: number }[];
  schedules: { id: string; category: Category; daysJson: string; startMinutes: number; endMinutes: number }[];
  rules: { id: string; domain: string; action: "allow" | "block"; expiresAt: string | null }[];
};

export type AuthStatus = {
  hasPassword: boolean;
  hasTotpBackup: boolean;
  parentCount: number;
  requireSetup: boolean;
  /** Password exists (or session) but authenticator not linked yet */
  requireTotp: boolean;
  turnstileSiteKey?: string;
};

function getAuthHeader(): Record<string, string> {
  const token = localStorage.getItem("sb_parent_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/parent${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...getAuthHeader(), ...init?.headers },
    credentials: "same-origin",
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({})) as { error?: string; message?: string };
    throw new Error(problem.message ?? problem.error ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export const api = {
  authStatus: async () => {
    const res = await fetch("/api/v1/auth/status", { headers: getAuthHeader() });
    return res.json() as Promise<AuthStatus>;
  },
  setupPassword: async (password: string, email?: string, turnstileToken?: string) => {
    const res = await fetch("/api/v1/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, email, turnstileToken }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string; message?: string };
      throw new Error(data.message ?? data.error ?? "Password setup failed");
    }
    const data = await res.json() as { token: string; email: string; recoveryKey: string };
    localStorage.setItem("sb_parent_token", data.token);
    return data;
  },
  recoverPassword: async (recoveryKey: string, newPassword: string, turnstileToken?: string) => {
    const res = await fetch("/api/v1/auth/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recoveryKey, newPassword, turnstileToken }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string; message?: string };
      throw new Error(data.message ?? data.error ?? "Invalid recovery key");
    }
    const data = await res.json() as { token: string; email: string; newRecoveryKey: string };
    localStorage.setItem("sb_parent_token", data.token);
    return data;
  },
  login: async (password: string, turnstileToken?: string) => {
    const res = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, turnstileToken }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string; message?: string };
      throw new Error(data.message ?? data.error ?? "Incorrect password");
    }
    const data = await res.json() as { token: string; email: string };
    localStorage.setItem("sb_parent_token", data.token);
    return data;
  },
  logout: () => {
    const token = localStorage.getItem("sb_parent_token");
    if (token) {
      void fetch("/api/v1/auth/logout", { method: "POST", headers: getAuthHeader() });
    }
    localStorage.removeItem("sb_parent_token");
  },
  totpSetup: async () => {
    const res = await fetch("/api/v1/auth/totp/setup", { headers: getAuthHeader() });
    if (!res.ok) throw new Error("Failed to generate authenticator setup");
    return res.json() as Promise<{ secret: string; otpauthUri: string }>;
  },
  totpConfirm: async (secret: string, code: string) => {
    const res = await fetch("/api/v1/auth/totp/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeader() },
      body: JSON.stringify({ secret, code }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { message?: string };
      throw new Error(data.message ?? "Confirmation failed");
    }
    return res.json() as Promise<{ ok: true }>;
  },
  totpRecover: async (totpCode: string, newPassword: string, turnstileToken?: string) => {
    const res = await fetch("/api/v1/auth/totp/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ totpCode, newPassword, turnstileToken }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { message?: string };
      throw new Error(data.message ?? "Recovery failed");
    }
    const data = await res.json() as { token: string; email: string };
    localStorage.setItem("sb_parent_token", data.token);
    return data;
  },
  children: () => request<{ children: Child[] }>("/children"),
  createChild: (body: { name: string; ageBand: AgeBand; timezone: string }) => request<{ id: string }>("/children", { method: "POST", body: JSON.stringify(body) }),
  policy: (id: string) => request<PolicyView>(`/children/${id}/policy`),
  savePolicy: (id: string, body: unknown) => request<{ ok: true }>(`/children/${id}/policy`, { method: "PUT", body: JSON.stringify(body) }),
  enrollmentCode: (id: string) => request<{ code: string; expiresAt: string }>(`/children/${id}/enrollment-code`, { method: "POST" }),
  addRule: (id: string, body: { domain: string; action: "allow" | "block"; expiresAt: null }) => request(`/children/${id}/rules`, { method: "POST", body: JSON.stringify(body) }),
  deleteRule: (childId: string, ruleId: string) => request(`/children/${childId}/rules/${ruleId}`, { method: "DELETE" }),
  requests: () => request<{ requests: AccessRequest[] }>("/requests"),
  resolveRequest: (id: string, duration: string) => request(`/requests/${id}/resolve`, { method: "POST", body: JSON.stringify({ duration }) }),
  events: () => request<{ events: HistoryEvent[] }>("/events?limit=100"),
};
