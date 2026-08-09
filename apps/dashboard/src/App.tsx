import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ageBands, categories, type AgeBand, type Category } from "@safe-browse/contracts";
import { api, type AccessRequest, type Child, type HistoryEvent, type PolicyView, type AuthStatus } from "./api";

declare global {
  interface Window {
    turnstile?: {
      render(container: string | HTMLElement, options: { sitekey: string; callback: (token: string) => void }): string;
      reset(widgetId?: string): void;
    };
  }
}

const ageLabels: Record<AgeBand, string> = { under_10: "Under 10", age_10_12: "10–12", age_13_15: "13–15", age_16_17: "16–17" };

function BrandMark({ className = "" }: { className?: string }) {
  return (
    <img
      className={`brand-logo ${className}`.trim()}
      src="/logo-mark.svg"
      width={44}
      height={44}
      alt="Safe Browse by Incorpify"
    />
  );
}

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
      // Drop stale tokens (server has no session for this Bearer)
      if (localStorage.getItem("sb_parent_token") && status.hasSession === false) {
        localStorage.removeItem("sb_parent_token");
      }
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
      if (
        msg.includes("401") ||
        msg.includes("unauthorized") ||
        msg.includes("Parent password") ||
        msg.includes("totp_required")
      ) {
        setAuthenticated(false);
      } else {
        setError(msg);
      }
    }
  }, []);

  useEffect(() => {
    void checkAuth().then((status) => {
      const token = localStorage.getItem("sb_parent_token");
      // Load console only when we have a session and TOTP is complete
      if (token && status && !status.requireTotp && (status.hasSession !== false)) {
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

  const hasSession = typeof localStorage !== "undefined" && Boolean(localStorage.getItem("sb_parent_token"));

  // Incomplete onboarding: force authenticator link when session exists but TOTP missing
  if (hasSession && authStatus?.requireTotp && !authStatus.requireSetup) {
    return (
      <MandatoryTotpGate
        onComplete={async () => {
          const status = await checkAuth();
          if (status && !status.requireTotp) await refresh();
        }}
        onLogout={handleLogout}
      />
    );
  }

  if (!authenticated) {
    return (
      <ParentAuthScreen
        authStatus={authStatus}
        onAuthenticated={async () => {
          const status = await checkAuth();
          if (status?.requireTotp) return; // MandatoryTotpGate will render on next pass
          await refresh();
        }}
      />
    );
  }

  return <div className="shell">
    <aside>
      <a className="brand" href="#"><BrandMark /><span>Safe Browse<small>by Incorpify</small></span></a>
      <nav>
        <button className={section === "overview" ? "active" : ""} onClick={() => setSection("overview")}>Overview</button>
        <button className={section === "history" ? "active" : ""} onClick={() => setSection("history")}>Browsing history</button>
        <button className={section === "requests" ? "active" : ""} onClick={() => setSection("requests")}>Access requests <b>{requests.filter((item) => item.status === "pending").length}</b></button>
      </nav>
      <div className="privacy-note"><span>🔒</span><p><strong>Console Protected</strong><button className="text-button" onClick={handleLogout}>Lock console</button></p></div>
    </aside>
    <main>
      <header><div><p className="eyebrow">PARENT DASHBOARD</p><h1>{section === "overview" ? "Your family" : section === "history" ? "Browsing history" : "Access requests"}</h1></div><span className="pilot">SaaS pilot</span></header>
      {error && <div className="error">{error}<button onClick={() => setError(null)}>×</button></div>}
      {section === "overview" && <Overview children={children} onOpen={openPolicy} onRefresh={refresh} />}
      {section === "history" && <History events={events} />}
      {section === "requests" && <Requests requests={requests} onResolve={async (id, duration) => { await api.resolveRequest(id, duration); await refresh(); }} />}
    </main>
    {selected && <PolicyDrawer policy={selected} busy={busy} onClose={() => setSelected(null)} onSaved={async () => { setSelected(null); await refresh(); }} />}
  </div>;
}

function MandatoryTotpGate({ onComplete, onLogout }: { onComplete(): Promise<void>; onLogout(): void }) {
  const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        setTotpSetup(await api.totpSetup());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not start authenticator setup");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <div className="auth-shell">
        <div className="auth-card"><p className="subtext">Preparing authenticator setup…</p></div>
      </div>
    );
  }

  if (error || !totpSetup) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <div className="error">{error ?? "Setup unavailable"}</div>
          <button className="secondary full" type="button" onClick={onLogout}>Lock console</button>
        </div>
      </div>
    );
  }

  return (
    <TotpSetupWizard
      setup={totpSetup}
      required
      onConfirmed={async (code) => {
        await api.totpConfirm(totpSetup.secret, code);
        await onComplete();
      }}
    />
  );
}

type AuthMode = "login" | "signup" | "recover" | "totp-recover";

function ParentAuthScreen({ authStatus, onAuthenticated }: { authStatus: AuthStatus | null; onAuthenticated(): Promise<void> }) {
  const multiTenant = authStatus?.multiTenant !== false && authStatus?.signupEnabled !== false;
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [householdName, setHouseholdName] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string>("");
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [mode, setMode] = useState<AuthMode>("login");
  const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [totpConfirmed, setTotpConfirmed] = useState(false);
  const [totpNewPassword, setTotpNewPassword] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const renderedSiteKey = useRef<string | null>(null);

  useEffect(() => {
    const siteKey = authStatus?.turnstileSiteKey;
    if (!siteKey) return;
    const container = document.getElementById("turnstile-container");
    if (!container || !window.turnstile) return;
    if (renderedSiteKey.current === siteKey && container.hasChildNodes()) return;
    container.innerHTML = "";
    renderedSiteKey.current = null;
    try {
      window.turnstile.render("#turnstile-container", {
        sitekey: siteKey,
        callback: (token: string) => setTurnstileToken(token),
      });
      renderedSiteKey.current = siteKey;
    } catch {
      /* ignore */
    }
  }, [authStatus, mode]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "recover") {
        const res = await api.recoverPassword(recoveryKey, newPassword, turnstileToken);
        setGeneratedKey(res.newRecoveryKey);
        return;
      }
      if (mode === "totp-recover") {
        await api.totpRecover(email.trim(), totpCode, totpNewPassword, turnstileToken);
        await onAuthenticated();
        return;
      }
      if (mode === "signup") {
        const res = await api.signup(
          email.trim(),
          password,
          turnstileToken,
          householdName.trim() || undefined,
        );
        setGeneratedKey(res.recoveryKey);
        return;
      }
      // login
      await api.login(email.trim(), password, turnstileToken);
      await onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  function handleCopyKey() {
    if (generatedKey) {
      void navigator.clipboard.writeText(generatedKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  // After signup / paper-key recover: show recovery key then mandatory TOTP
  if (generatedKey) {
    if (totpConfirmed) {
      return (
        <div className="auth-shell">
          <div className="auth-card recovery-box">
            <div className="brand-header">
              <span className="logo-shine"><BrandMark /></span>
              <h2>You&apos;re protected</h2>
              <p>
                Daily access uses your email and PIN. If you forget your PIN, open your authenticator app
                and use <strong>Forgot PIN</strong> on the login screen.
              </p>
            </div>
            <button
              className="primary full"
              type="button"
              onClick={async () => {
                setGeneratedKey(null);
                setTotpConfirmed(false);
                await onAuthenticated();
              }}
            >
              Enter Dashboard
            </button>
          </div>
        </div>
      );
    }
    if (totpSetup) {
      return (
        <TotpSetupWizard
          setup={totpSetup}
          required
          onConfirmed={async (code) => {
            await api.totpConfirm(totpSetup.secret, code);
            setTotpConfirmed(true);
            setTotpSetup(null);
          }}
        />
      );
    }
    return (
      <div className="auth-shell">
        <div className="auth-card recovery-box">
          <div className="brand-header">
            <span className="logo-shine"><BrandMark /></span>
            <h2>Optional paper recovery key</h2>
            <p>
              Write this down if you want a backup besides your phone.
              Your <strong>primary</strong> way to reset a forgotten PIN is your authenticator app.
            </p>
          </div>
          {error && <div className="error">{error}</div>}
          <div className="key-display">
            <code>{generatedKey}</code>
            <button type="button" className="secondary" onClick={handleCopyKey}>
              {copied ? "Copied!" : "Copy Key"}
            </button>
          </div>
          <p className="subtext warning">
            Next step is required: link Google Authenticator, Authy, 1Password, or any TOTP app.
          </p>
          <button
            className="primary full"
            type="button"
            onClick={async () => {
              try {
                setError(null);
                setTotpSetup(await api.totpSetup());
              } catch (err) {
                setError(err instanceof Error ? err.message : "Could not start authenticator setup");
              }
            }}
          >
            Continue → Link Authenticator App
          </button>
        </div>
      </div>
    );
  }

  const titles: Record<AuthMode, string> = {
    login: "Log in",
    signup: "Create your family account",
    recover: "Paper recovery key",
    "totp-recover": "Forgot PIN — Authenticator",
  };
  const subtitles: Record<AuthMode, string> = {
    login: "Email + PIN unlocks your household console.",
    signup: "Free multi-tenant account. Next: link an authenticator (required).",
    recover: "Use the paper key shown once at sign-up.",
    "totp-recover": "Email + 6-digit authenticator code + new PIN.",
  };

  const authForm = (
    <form className="auth-card landing-auth-card" onSubmit={handleSubmit}>
      <div className="brand-header">
        <span className="logo-shine">
          <BrandMark className="brand-logo-lg" />
        </span>
        <h2>Safe Browse</h2>
        <p>Parent console · by Incorpify</p>
      </div>

      {multiTenant && (mode === "login" || mode === "signup") && (
        <div className="auth-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className={mode === "login" ? "auth-tab active" : "auth-tab"}
            onClick={() => { setError(null); setMode("login"); }}
          >
            Log in
          </button>
          <button
            type="button"
            role="tab"
            className={mode === "signup" ? "auth-tab active" : "auth-tab"}
            onClick={() => { setError(null); setMode("signup"); }}
          >
            Sign up
          </button>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <h3>{titles[mode]}</h3>
      <p className="subtext">{subtitles[mode]}</p>

      {mode === "recover" ? (
        <>
          <label>
            Emergency Recovery Key
            <input
              type="text"
              placeholder="SB-XXXX-XXXX-XXXX-XXXX"
              value={recoveryKey}
              onChange={(e) => setRecoveryKey(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label>
            New Master Password / PIN
            <input
              type="password"
              placeholder="••••••••"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
          </label>
        </>
      ) : mode === "totp-recover" ? (
        <>
          <label>
            Email
            <input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          <label>
            6-Digit Authenticator Code
            <input
              type="text"
              inputMode="numeric"
              placeholder="123456"
              maxLength={6}
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              required
            />
          </label>
          <label>
            New Master Password / PIN
            <input type="password" placeholder="••••••••" value={totpNewPassword} onChange={(e) => setTotpNewPassword(e.target.value)} required />
          </label>
        </>
      ) : (
        <>
          <label>
            Email
            <input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          {mode === "signup" && (
            <label>
              Household name <span style={{ opacity: 0.6 }}>(optional)</span>
              <input type="text" placeholder="The Smith family" value={householdName} onChange={(e) => setHouseholdName(e.target.value)} maxLength={80} />
            </label>
          )}
          <label>
            {mode === "signup" ? "Choose a PIN / password" : "PIN / password"}
            <input type="password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={4} />
          </label>
        </>
      )}

      <div id="turnstile-container" style={{ margin: "16px 0", display: "flex", justifyContent: "center" }} />

      <button className="primary full" type="submit" disabled={busy}>
        {busy
          ? "Processing..."
          : mode === "totp-recover" || mode === "recover"
            ? "Reset PIN & Log in"
            : mode === "signup"
              ? "Create free account"
              : "Log in"}
      </button>

      <div className="auth-footer">
        {(mode === "login" || mode === "signup") && (
          <>
            <button type="button" className="text-button" onClick={() => { setError(null); setMode("totp-recover"); }}>
              Forgot PIN? Use authenticator app
            </button>
            <button type="button" className="text-button" onClick={() => { setError(null); setMode("recover"); }}>
              Use paper recovery key instead
            </button>
          </>
        )}
        {(mode === "recover" || mode === "totp-recover") && (
          <button type="button" className="text-button" onClick={() => { setError(null); setMode("login"); }}>
            Back to log in
          </button>
        )}
      </div>
    </form>
  );

  return (
    <div className="landing">
      <div className="landing-glow" aria-hidden />
      <header className="landing-top">
        <a className="landing-brand" href="https://incorpify.in" target="_blank" rel="noreferrer">
          <span className="logo-shine"><BrandMark /></span>
          <span>
            Safe Browse
            <small>by Incorpify</small>
          </span>
        </a>
        <nav className="landing-nav">
          <a href="#why">Why it matters</a>
          <a href="#how">How it works</a>
          <a href="#deploy">Deploy</a>
          <a href="#scale">Scale</a>
          <a className="landing-nav-cta" href="#console">Open console</a>
        </nav>
      </header>

      <section className="landing-hero">
        <div className="landing-hero-copy">
          <p className="landing-kicker">Privacy-first parental controls · Windows 10/11</p>
          <h1>
            Protect young minds
            <span> without spying on their messages.</span>
          </h1>
          <p className="landing-lead">
            Safe Browse filters harmful and addictive destinations on the PC itself—using local DNS and category lists—
            while parents manage rules from a calm web console. No invasive TLS interception. No page content collection.
          </p>
          <div className="landing-cta-row">
            <a className="primary landing-btn" href="#console">Get started free</a>
            <a className="secondary landing-btn" href="#child-install">
              Install on child PC
            </a>
          </div>
          <ul className="landing-pills">
            <li>Local DNS filter</li>
            <li>Works offline after sync</li>
            <li>Multi-family SaaS</li>
            <li>One-line Windows install</li>
          </ul>
        </div>
        <div className="landing-hero-art" aria-hidden>
          <div className="logo-shine logo-shine-xl">
            <img src="/logo-mark.svg" alt="" width={160} height={160} />
          </div>
          <img className="wordmark-mint" src="/incorpify-wordmark-mint.png" alt="Incorpify" />
        </div>
      </section>

      <section id="why" className="landing-section">
        <div className="landing-section-head">
          <p className="eyebrow">Why it matters</p>
          <h2>Social feeds are engineered for attention—not childhood.</h2>
          <p>
            Safe Browse exists because parents need practical boundaries for the open web and app ecosystems,
            without turning the home into a surveillance lab.
          </p>
        </div>
        <div className="stat-grid">
          <article>
            <strong>11%</strong>
            <span>of adolescents show signs of <em>problematic social media use</em> (WHO Europe, 2022 data; up from 7% in 2018).</span>
          </article>
          <article>
            <strong>~2.5×</strong>
            <span>higher likelihood of recent depression symptoms among teens with high daily screen time vs peers (CDC analysis of U.S. teens).</span>
          </article>
          <article>
            <strong>45%</strong>
            <span>of teens say they spend too much time on social media (Pew Research Center, 2024–25).</span>
          </article>
          <article>
            <strong>24%+</strong>
            <span>of adolescents meet criteria for social media addiction in recent reviews—linked to anxiety, low mood, and attention strain.</span>
          </article>
        </div>
        <p className="landing-cite">
          Sources: WHO/Europe adolescent digital health briefings; CDC Preventing Chronic Disease screen-time analyses;
          Pew Research Center teens &amp; social media surveys; APA guidance on adolescent social media use.
          Stats describe associations—not destiny. Boundaries still help.
        </p>
      </section>

      <section id="how" className="landing-section landing-section-alt">
        <div className="landing-section-head">
          <p className="eyebrow">How it works</p>
          <h2>Cloud for parents. Enforcement on the PC.</h2>
        </div>
        <div className="how-grid">
          <article>
            <span className="how-step">1</span>
            <h3>Parent console</h3>
            <p>Sign up, add children, pick age bands &amp; categories, approve access requests, generate enrollment codes.</p>
          </article>
          <article>
            <span className="how-step">2</span>
            <h3>Windows agent</h3>
            <p>Lightweight service on the kid PC: local DNS proxy on 127.0.0.1:53, policy engine, optional browser native messaging.</p>
          </article>
          <article>
            <span className="how-step">3</span>
            <h3>What we record</h3>
            <p>Only top-level domains and block events—not page paths, search queries, titles, or chat content.</p>
          </article>
          <article>
            <span className="how-step">4</span>
            <h3>Offline resilience</h3>
            <p>After policy &amp; lists sync, filtering continues when the cloud is unreachable.</p>
          </article>
        </div>
      </section>

      <section id="deploy" className="landing-section">
        <div className="landing-section-head">
          <p className="eyebrow">Deploy</p>
          <h2>Zero-effort SaaS—or your own Cloudflare account.</h2>
        </div>
        <div className="deploy-grid">
          <article className="deploy-card deploy-card-featured">
            <p className="deploy-badge">Recommended</p>
            <h3>Hosted by Incorpify · 0 ops for parents</h3>
            <p>
              Use this site. Create an account, download the MSI, enroll the PC.
              We run the Worker, D1, and shared blocklist storage.
            </p>
            <ul>
              <li>No Cloudflare account required</li>
              <li>Multi-family SaaS on <code>safebrowse.incorpify.in</code></li>
              <li>MSI from public R2 downloads</li>
            </ul>
            <a className="primary landing-btn" href="#console">Open console →</a>
          </article>
          <article className="deploy-card">
            <p className="deploy-badge quiet">Advanced</p>
            <h3>Self-host on your Cloudflare account</h3>
            <p>
              Prefer data only under your CF tenancy? Clone the open repo and run one-click deploy.
            </p>
            <ul>
              <li><code>bash tools/deploy.sh</code> with your API token</li>
              <li>Creates D1, R2 lists, Turnstile, Worker + dashboard</li>
              <li>Point the agent <code>ApiBaseUrl</code> at your Worker</li>
            </ul>
            <a className="secondary landing-btn" href="https://github.com/Incorpify-LLC/safe_browse" target="_blank" rel="noreferrer">
              GitHub repo &amp; docs
            </a>
          </article>
        </div>
      </section>

      <section id="scale" className="landing-section landing-section-alt">
        <div className="landing-section-head">
          <p className="eyebrow">Scale</p>
          <h2>Start free. Grow deliberately.</h2>
        </div>
        <div className="scale-grid">
          <article>
            <h3>Family pilot</h3>
            <p>One household, a few Windows PCs, shared category lists, 30-day history retention.</p>
          </article>
          <article>
            <h3>Many families (SaaS)</h3>
            <p>Row-level isolation by household; shared R2 blocklists so cost stays near Cloudflare free-tier for early scale.</p>
          </article>
          <article>
            <h3>When you grow</h3>
            <p>Raise device caps, tighten rate limits, add paid plans, custom domains, and GitHub Actions for Incorpify deploys—without redesigning the agent.</p>
          </article>
        </div>
      </section>

      <section id="child-install" className="landing-section">
        <div className="landing-section-head">
          <p className="eyebrow">Child PC · no Git</p>
          <h2>One elevated PowerShell command.</h2>
          <p>
            No Git, no clone, no multi-step scripts. Download + install + configure the production API + harden DNS
            in a single run. Optionally pass the enroll code from this console.
          </p>
        </div>
        <div className="install-box">
          <p className="install-label">Install + harden (Run PowerShell as Administrator)</p>
          <pre className="install-code">{`irm https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/Install.ps1 | iex`}</pre>
          <p className="install-label">Install + harden + enroll in one shot</p>
          <pre className="install-code">{`$u='https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/Install.ps1'
iex "& { $(irm $u) } -EnrollCode 'AB3K-M9NP-Q2VX'"`}</pre>
          <p className="install-note">
            Or double-click the{" "}
            <a href="https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/SafeBrowseSetup.msi">MSI</a>
            {" "}then run the one-liner so API URL + DNS hardening are applied. Future MSI builds will ship with
            production defaults baked in.
          </p>
        </div>
      </section>

      <section id="console" className="landing-console">
        <div className="landing-console-copy">
          <p className="eyebrow">Console</p>
          <h2>Ready when you are.</h2>
          <p>Sign up free, protect a Windows PC in minutes, tighten categories as habits change.</p>
          <div className="landing-mini-links">
            <a href="#child-install">Child PC one-liner</a>
            <a href="https://github.com/Incorpify-LLC/safe_browse/blob/main/docs/saas-multitenant-plan.md" target="_blank" rel="noreferrer">SaaS architecture</a>
            <a href="https://incorpify.in" target="_blank" rel="noreferrer">incorpify.in</a>
          </div>
        </div>
        {authForm}
      </section>

      <footer className="landing-footer">
        <span className="logo-shine"><BrandMark className="brand-logo-sm" /></span>
        <p>
          © {new Date().getFullYear()} Incorpify LLC · Safe Browse · Apache-2.0 application code ·
          Blocklist data retains upstream licenses where applicable.
        </p>
      </footer>
    </div>
  );
}

// ── TOTP Setup Wizard ─────────────────────────────────────────────────────────
function TotpSetupWizard({
  setup,
  onConfirmed,
  required = false,
}: {
  setup: { secret: string; otpauthUri: string };
  onConfirmed: (code: string) => Promise<void>;
  required?: boolean;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Generate QR code URL using a free public QR API (no third-party data leaks — only the otpauth:// URI is sent)
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(setup.otpauthUri)}`;

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onConfirmed(code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Code incorrect — try again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card recovery-box">
        <div className="brand-header">
          <span className="logo-shine"><BrandMark /></span>
          <h2>Link Your Authenticator App</h2>
          <p>
            {required
              ? "Required for password recovery without email. Scan with Google Authenticator, Authy, 1Password, or Bitwarden — then enter the 6-digit code."
              : "Scan this QR code with Google Authenticator, Authy, or any TOTP app — then enter the 6-digit code to confirm."}
          </p>
        </div>

        <div style={{ display: "flex", justifyContent: "center", margin: "12px 0" }}>
          <img src={qrUrl} alt="TOTP QR Code" width={200} height={200} style={{ borderRadius: 8, border: "1px solid var(--border)" }} />
        </div>

        <details style={{ marginBottom: 12 }}>
          <summary style={{ cursor: "pointer", fontSize: "0.85rem", opacity: 0.7 }}>Can't scan? Enter key manually</summary>
          <div className="key-display" style={{ marginTop: 8 }}>
            <code style={{ fontSize: "0.85rem", letterSpacing: 2 }}>{setup.secret}</code>
            <button type="button" className="secondary" onClick={() => { void navigator.clipboard.writeText(setup.secret); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </details>

        {error && <div className="error">{error}</div>}

        <form onSubmit={handleConfirm}>
          <label>
            Enter the 6-digit code from your app
            <input
              type="text"
              inputMode="numeric"
              placeholder="123456"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              required
              autoFocus
            />
          </label>
          <button className="primary full" type="submit" disabled={busy || code.length !== 6}>
            {busy ? "Verifying..." : "Confirm & Link App"}
          </button>
        </form>
        {required && (
          <p className="subtext" style={{ marginTop: 12 }}>
            You cannot skip this step. Keep this phone (or export the authenticator) — it is how you reset a forgotten PIN.
          </p>
        )}
      </div>
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
    <h3>Windows enrollment</h3>{code ? <div className="enrollment"><strong style={{ fontSize: 18, letterSpacing: "0.12em" }}>{code}</strong><span>Type this on the PC (hyphens optional). Expires in 10 minutes.</span></div> : <button className="secondary full" onClick={async () => setCode((await api.enrollmentCode(policy.child.id)).code)}>Generate setup code</button>}
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
