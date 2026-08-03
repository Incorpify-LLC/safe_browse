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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/parent${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    credentials: "same-origin",
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(problem.error ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export const api = {
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
