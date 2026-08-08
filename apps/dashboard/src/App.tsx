import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ageBands, categories, type AgeBand, type Category } from "@safe-browse/contracts";
import { api, type AccessRequest, type Child, type HistoryEvent, type PolicyView, type AuthStatus } from "./api";

const ageLabels: Record<AgeBand, string> = { under_10: "Under 10", age_10_12: "10–12", age_13_15: "13–15", age_16_17: "16–17" };

export function App() {
  const [section, setSection] = useState<"overview" | "history" | "requests">("overview");
  const [children, setChildren] = useState<Child[]>([]);
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [selected, setSelected] = useState<PolicyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authenticated, setAuthenticated] = useState<boolean>(false);

  const checkAuth = useCallback(async () => {
    try {
      const status = await api.authStatus();
      setAuthStatus(status);
      return status;
    } catch {
      return null;
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [childData, requestData, eventData] = await Promise.all([api.children(), api.requests(), api.events()]);
      setChildren(childData.children);
      setRequests(requestData.requests);
      setEvents(eventData.events);
      setError(null);
      setAuthenticated(true);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "Unable to load Safe Browse";
      if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("Parent password")) {
        setAuthenticated(false);
      } else {
        setError(msg);
      }
    }
  }, []);

  useEffect(() => {
    void checkAuth().then((status) => {
      if (status && !status.requireSetup) {
        void refresh();
      }
    });
  }, [checkAuth, refresh]);

  async function openPolicy(id: string) {
    setBusy(true);
    try { setSelected(await api.policy(id)); } catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  }

  function handleLogout() {
    api.logout();
    setAuthenticated(false);
    void checkAuth();
  }

  if (!authenticated) {
    return <ParentAuthScreen authStatus={authStatus} onAuthenticated={async () => { await checkAuth(); await refresh(); }} />;
  }

  return <div className="shell">
    <aside>
      <a className="brand" href="#"><span className="brand-mark">S</span><span>Safe Browse<small>Family console</small></span></a>
      <nav>
        <button className={section === "overview" ? "active" : ""} onClick={() => setSection("overview")}>Overview</button>
        <button className={section === "history" ? "active" : ""} onClick={() => setSection("history")}>Browsing history</button>
        <button className={section === "requests" ? "active" : ""} onClick={() => setSection("requests")}>Access requests <b>{requests.filter((item) => item.status === "pending").length}</b></button>
      </nav>
      <div className="privacy-note"><span>🔒</span><p><strong>Console Protected</strong><button className="text-button" onClick={handleLogout}>Lock console</button></p></div>
    </aside>
    <main>
      <header><div><p className="eyebrow">PARENT DASHBOARD</p><h1>{section === "overview" ? "Your family" : section === "history" ? "Browsing history" : "Access requests"}</h1></div><span className="pilot">Private pilot</span></header>
      {error && <div className="error">{error}<button onClick={() => setError(null)}>×</button></div>}
      {section === "overview" && <Overview children={children} onOpen={openPolicy} onRefresh={refresh} />}
      {section === "history" && <History events={events} />}
      {section === "requests" && <Requests requests={requests} onResolve={async (id, duration) => { await api.resolveRequest(id, duration); await refresh(); }} />}
    </main>
    {selected && <PolicyDrawer policy={selected} busy={busy} onClose={() => setSelected(null)} onSaved={async () => { setSelected(null); await refresh(); }} />}
  </div>;
}

function ParentAuthScreen({ authStatus, onAuthenticated }: { authStatus: AuthStatus | null; onAuthenticated(): Promise<void> }) {
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSetup = authStatus?.requireSetup ?? false;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (isSetup) {
        await api.setupPassword(password, email || undefined);
      } else {
        await api.login(password);
      }
      await onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={handleSubmit}>
        <div className="brand-header">
          <span className="brand-mark">S</span>
          <h2>Safe Browse</h2>
          <p>Parent Control Console</p>
        </div>
        
        {error && <div className="error">{error}</div>}

        <h3>{isSetup ? "Create Master Password" : "Parent Authentication"}</h3>
        <p className="subtext">
          {isSetup
            ? "Set a master password for your household to protect family settings."
            : "Enter your parent master password to access child profiles and browsing logs."}
        </p>

        {isSetup && (
          <label>
            Parent Email (Optional)
            <input
              type="email"
              placeholder="parent@family.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
        )}

        <label>
          Master Password / PIN
          <input
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
          />
        </label>

        <button className="primary full" type="submit" disabled={busy}>
          {busy ? "Authenticating..." : isSetup ? "Set Password & Enter" : "Unlock Console"}
        </button>
      </form>
    </div>
  );
}

function Overview({ children, onOpen, onRefresh }: { children: Child[]; onOpen(id: string): void; onRefresh(): Promise<void> }) {
  const [adding, setAdding] = useState(false);
  return <>
    <section className="stats">
      <article><span>Protected devices</span><strong>{children.filter((c) => c.deviceId).length}</strong><small>{children.length} child profiles</small></article>
      <article><span>Needs attention</span><strong>{children.filter((c) => c.status && c.status !== "healthy").length}</strong><small>Offline or tampered</small></article>
      <article className="accent"><span>Protection</span><strong>Active</strong><small>Threat lists update daily</small></article>
    </section>
    <div className="section-title"><div><h2>Children & devices</h2><p>One policy follows each enrolled computer.</p></div><button className="primary" onClick={() => setAdding(true)}>Add child</button></div>
    <section className="cards">
      {children.map((child) => <article className="child-card" key={child.id}>
        <div className="avatar">{child.name.slice(0, 1).toUpperCase()}</div>
        <div className="child-heading"><h3>{child.name}</h3><span className={`status ${child.status ?? "waiting"}`}>{child.status ?? "Not enrolled"}</span></div>
        <dl><div><dt>Age preset</dt><dd>{ageLabels[child.ageBand]}</dd></div><div><dt>Device</dt><dd>{child.deviceName ?? "Waiting for setup"}</dd></div><div><dt>Last check-in</dt><dd>{child.lastSeenAt ? relativeTime(child.lastSeenAt) : "—"}</dd></div></dl>
        <button className="secondary" onClick={() => onOpen(child.id)}>Manage protection</button>
      </article>)}
      {!children.length && <div className="empty"><span>◎</span><h3>No child profiles yet</h3><p>Add a child to generate an enrollment code for their Windows PC.</p></div>}
    </section>
    {adding && <AddChild onClose={() => setAdding(false)} onCreated={async () => { setAdding(false); await onRefresh(); }} />}
  </>;
}

function AddChild({ onClose, onCreated }: { onClose(): void; onCreated(): Promise<void> }) {
  const [name, setName] = useState(""); const [ageBand, setAgeBand] = useState<AgeBand>("age_10_12");
  async function submit(event: FormEvent) { event.preventDefault(); await api.createChild({ name, ageBand, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }); await onCreated(); }
  return <div className="modal-backdrop"><form className="modal" onSubmit={submit}><button type="button" className="close" onClick={onClose}>×</button><p className="eyebrow">NEW PROFILE</p><h2>Add a child</h2><label>Name<input value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></label><label>Age preset<select value={ageBand} onChange={(e) => setAgeBand(e.target.value as AgeBand)}>{ageBands.map((band) => <option key={band} value={band}>{ageLabels[band]}</option>)}</select></label><button className="primary" type="submit">Create profile</button></form></div>;
}

function PolicyDrawer({ policy, onClose, onSaved }: { policy: PolicyView; busy: boolean; onClose(): void; onSaved(): Promise<void> }) {
  const [enabled, setEnabled] = useState(new Set(policy.categories.filter((row) => row.enabled).map((row) => row.category)));
  const [paused, setPaused] = useState(Boolean(policy.child.paused)); const [code, setCode] = useState<string | null>(null);
  const [domain, setDomain] = useState("");
  async function save() { await api.savePolicy(policy.child.id, { ageBand: policy.child.ageBand, timezone: policy.child.timezone, enabledCategories: [...enabled], safeSearch: Boolean(policy.child.safeSearch), youtubeRestricted: Boolean(policy.child.youtubeRestricted), paused }); await onSaved(); }
  return <div className="drawer-backdrop" onMouseDown={onClose}><section className="drawer" onMouseDown={(e) => e.stopPropagation()}><button className="close" onClick={onClose}>×</button><p className="eyebrow">PROTECTION POLICY</p><h2>{policy.child.name}</h2>
    <div className="pause-row"><div><strong>Pause internet</strong><p>Keep Safe Browse online so you can resume remotely.</p></div><button className={`switch ${paused ? "on" : ""}`} onClick={() => setPaused(!paused)} aria-label="Pause internet"><i /></button></div>
    <h3>Filtered categories</h3><div className="category-grid">{categories.map((category) => <label key={category} className={enabled.has(category) ? "checked" : ""}><input type="checkbox" checked={enabled.has(category)} disabled={category === "threats"} onChange={() => { const next = new Set(enabled); next.has(category) ? next.delete(category) : next.add(category); setEnabled(next); }} /><span>{category}</span></label>)}</div>
    <h3>Domain exceptions</h3><form className="rule-form" onSubmit={async (e) => { e.preventDefault(); await api.addRule(policy.child.id, { domain, action: "allow", expiresAt: null }); setDomain(""); }}><input placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} required /><button className="secondary">Always allow</button></form>
    <ul className="rules">{policy.rules.map((rule) => <li key={rule.id}><span><b>{rule.domain}</b><small>{rule.action}</small></span><button onClick={() => api.deleteRule(policy.child.id, rule.id)}>Remove</button></li>)}</ul>
    <h3>Windows enrollment</h3>{code ? <div className="enrollment"><strong>{code}</strong><span>Expires in 10 minutes</span></div> : <button className="secondary full" onClick={async () => setCode((await api.enrollmentCode(policy.child.id)).code)}>Generate setup code</button>}
    <button className="primary full save" onClick={save}>Save policy</button>
  </section></div>;
}

function Requests({ requests, onResolve }: { requests: AccessRequest[]; onResolve(id: string, duration: string): Promise<void> }) {
  return <section className="list-panel">{requests.map((request) => <article className="request" key={request.id}><div><span className="domain-icon">↗</span><div><h3>{request.domain}</h3><p>{request.childName} · {request.category ?? "custom rule"} · {relativeTime(request.requestedAt)}</p>{request.reason && <blockquote>“{request.reason}”</blockquote>}</div></div>{request.status === "pending" ? <div className="request-actions"><button onClick={() => onResolve(request.id, "deny")}>Deny</button><select defaultValue="session" id={`duration-${request.id}`}><option value="session">Allow 10 min</option><option value="hour">Allow 1 hour</option><option value="day">Rest of day</option><option value="permanent">Always allow</option></select><button className="primary" onClick={() => onResolve(request.id, (document.getElementById(`duration-${request.id}`) as HTMLSelectElement).value)}>Approve</button></div> : <span className="resolved">{request.status}</span>}</article>)}{!requests.length && <div className="empty"><span>✓</span><h3>No access requests</h3><p>New requests from blocked pages will appear here.</p></div>}</section>;
}

function History({ events }: { events: HistoryEvent[] }) {
  const [search, setSearch] = useState(""); const shown = events.filter((event) => !search || event.domain?.includes(search.toLowerCase()));
  return <section className="list-panel"><div className="filters"><input placeholder="Filter by domain" value={search} onChange={(e) => setSearch(e.target.value)} /><span>Automatically removed after 30 days</span></div>{shown.map((event) => <article className="history-row" key={event.id}><time>{new Date(event.occurredAt).toLocaleString()}</time><div><strong>{event.domain ?? event.kind}</strong><small>{event.childName} · {event.browser ?? "Windows"}</small></div><span className={`event-kind ${event.kind}`}>{event.category ?? event.kind}</span></article>)}{!shown.length && <div className="empty"><span>◌</span><h3>No matching activity</h3></div>}</section>;
}

function relativeTime(value: string) { const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000); const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }); if (Math.abs(seconds) < 3600) return formatter.format(Math.round(seconds / 60), "minute"); if (Math.abs(seconds) < 86400) return formatter.format(Math.round(seconds / 3600), "hour"); return formatter.format(Math.round(seconds / 86400), "day"); }
