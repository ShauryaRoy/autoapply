import { useEffect, useMemo, useState, useCallback, useRef, type ChangeEvent } from "react";
import {
  login,
  register,
  logout,
  getMe,
  getStoredToken,
  getStoredProfile,
  saveProfile,
  createApplication,
  getApplication,
  getLatestPreview,
  pauseApplication,
  resumeApplication,
  subscribeToApplication,
  type UserProfile
} from "./api.js";
import "./styles.css";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

type EventLog = {
  id: string;
  step: string;
  message: string;
  createdAt: string;
  payloadJson?: { screenshotPath?: string; [key: string]: unknown };
};

type AppData = {
  id: string;
  currentStep: string;
  status: string;
  jobUrl: string;
  targetRole: string;
  events: EventLog[];
};

type AuthUser = { id: string; email: string; firstName: string; lastName: string };
type Screen = "auth" | "profile" | "apply";

const ORDERED_STEPS = [
  "queued", "job_scraped", "job_analyzed", "resume_optimized",
  "answers_generated", "browser_started", "logged_in", "form_filled",
  "submitted", "completed"
];

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

const EMPTY_PROFILE: UserProfile = {
  firstName: "", lastName: "", email: "", phone: "",
  location: "", resumeText: "", linkedIn: "", portfolio: "",
  yearsExperience: "", whyCompany: ""
};

function profileComplete(p: UserProfile): boolean {
  return !!(p.firstName && p.lastName && p.email && p.phone && p.location && p.resumeText);
}

// ──────────────────────────────────────────────
// Auth Screen
// ──────────────────────────────────────────────

function AuthScreen({ onAuth }: { onAuth: (user: AuthUser) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handle = async () => {
    setError("");
    setLoading(true);
    try {
      if (mode === "register") {
        await register({ email, password, firstName, lastName });
        onAuth({ id: "", email, firstName, lastName });
      } else {
        await login({ email, password });
        const me = await getMe();
        onAuth(me);
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message ?? "Something went wrong";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => { if (e.key === "Enter") void handle(); };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-logo">
          <span className="logo-icon">⚡</span>
          <h1>AutoApply</h1>
          <p>AI-powered job application engine</p>
        </div>

        <div className="auth-tabs">
          <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Sign In</button>
          <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Create Account</button>
        </div>

        {mode === "register" && (
          <div className="field-row">
            <div className="field">
              <label>First Name</label>
              <input value={firstName} onChange={e => setFirstName(e.target.value)} onKeyDown={onKey} placeholder="Jane" />
            </div>
            <div className="field">
              <label>Last Name</label>
              <input value={lastName} onChange={e => setLastName(e.target.value)} onKeyDown={onKey} placeholder="Doe" />
            </div>
          </div>
        )}

        <div className="field">
          <label>Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={onKey} placeholder="you@email.com" />
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={onKey} placeholder="••••••••" />
        </div>

        {error && <div className="auth-error">{error}</div>}

        <button className="auth-btn" onClick={handle} disabled={loading}>
          {loading ? "Please wait…" : mode === "login" ? "Sign In →" : "Create Account →"}
        </button>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// Profile Setup Screen
// ──────────────────────────────────────────────

function ProfileScreen({
  user,
  initial,
  onSave
}: {
  user: AuthUser;
  initial: UserProfile;
  onSave: (p: UserProfile) => void;
}) {
  const [profile, setProfile] = useState<UserProfile>(initial);
  const [saved, setSaved] = useState(false);

  const set = (field: keyof UserProfile) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setSaved(false);
    setProfile(prev => ({ ...prev, [field]: e.target.value }));
  };

  const handleSave = () => {
    saveProfile(profile);
    setSaved(true);
    onSave(profile);
  };

  return (
    <div className="profile-wrap">
      <aside className="left-panel">
        <div className="panel-header">
          <span className="logo-icon-sm">⚡</span>
          <div>
            <h2>Your Profile</h2>
            <p className="user-email">{user.email}</p>
          </div>
        </div>
        <p className="panel-hint">
          Fill in your details once — AutoApply will use them for every job application automatically.
        </p>
        <div className="nav-items">
          <div className="nav-item active">👤 Profile</div>
        </div>
      </aside>

      <main className="profile-main">
        <div className="profile-card">
          <h2>Personal Information</h2>
          <p className="section-hint">Required for all applications</p>
          <div className="field-row">
            <div className="field">
              <label>First Name *</label>
              <input value={profile.firstName} onChange={set("firstName")} placeholder="Jane" />
            </div>
            <div className="field">
              <label>Last Name *</label>
              <input value={profile.lastName} onChange={set("lastName")} placeholder="Doe" />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Email *</label>
              <input value={profile.email} onChange={set("email")} placeholder="jane@email.com" />
            </div>
            <div className="field">
              <label>Phone *</label>
              <input value={profile.phone} onChange={set("phone")} placeholder="+1 555 000 0000" />
            </div>
          </div>
          <div className="field">
            <label>Location *</label>
            <input value={profile.location} onChange={set("location")} placeholder="San Francisco, CA" />
          </div>
        </div>

        <div className="profile-card">
          <h2>Online Presence</h2>
          <p className="section-hint">Optional — used in application forms</p>
          <div className="field-row">
            <div className="field">
              <label>LinkedIn URL</label>
              <input value={profile.linkedIn ?? ""} onChange={set("linkedIn")} placeholder="https://linkedin.com/in/janedoe" />
            </div>
            <div className="field">
              <label>Portfolio / GitHub</label>
              <input value={profile.portfolio ?? ""} onChange={set("portfolio")} placeholder="https://github.com/janedoe" />
            </div>
          </div>
        </div>

        <div className="profile-card">
          <h2>Application Defaults</h2>
          <p className="section-hint">Pre-filled answers used across all applications</p>
          <div className="field-row">
            <div className="field">
              <label>Years of Experience</label>
              <input value={profile.yearsExperience ?? ""} onChange={set("yearsExperience")} placeholder="5" />
            </div>
          </div>
          <div className="field">
            <label>Why this company? (default cover text)</label>
            <textarea
              value={profile.whyCompany ?? ""}
              onChange={set("whyCompany")}
              rows={3}
              placeholder="I am passionate about building products that..."
            />
          </div>
        </div>

        <div className="profile-card">
          <h2>Resume *</h2>
          <p className="section-hint">Paste the full text of your resume — AI will optimize it per job</p>
          <textarea
            className="resume-area"
            value={profile.resumeText}
            onChange={set("resumeText")}
            rows={14}
            placeholder="John Doe&#10;Software Engineer&#10;&#10;EXPERIENCE&#10;..."
          />
        </div>

        <div className="save-row">
          {saved && <span className="saved-badge">✓ Saved</span>}
          {!profileComplete(profile) && (
            <span className="warn-badge">Fill required (*) fields to start applying</span>
          )}
          <button className="save-btn" onClick={handleSave} disabled={!profileComplete(profile)}>
            Save Profile &amp; Continue →
          </button>
        </div>
      </main>
    </div>
  );
}

// ──────────────────────────────────────────────
// Apply Screen
// ──────────────────────────────────────────────

function ApplyScreen({
  user,
  profile,
  onEditProfile,
  onLogout
}: {
  user: AuthUser;
  profile: UserProfile;
  onEditProfile: () => void;
  onLogout: () => void;
}) {
  const [jobUrl, setJobUrl] = useState("");
  const [targetRole, setTargetRole] = useState("");
  const [applicationId, setApplicationId] = useState("");
  const [runData, setRunData] = useState<AppData | null>(null);
  const [loading, setLoading] = useState(false);
  const [isLive, setIsLive] = useState(false);
  const [error, setError] = useState("");
  const [livePreviewUrl, setLivePreviewUrl] = useState("");
  const previewPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const progress = useMemo(() => {
    if (!runData) return 0;
    const idx = ORDERED_STEPS.indexOf(runData.currentStep);
    return Math.max(0, ((idx + 1) / ORDERED_STEPS.length) * 100);
  }, [runData]);

  // Extract HTTP screenshotUrl from events (set by worker)
  const eventPreviewUrl = useMemo(() => {
    const events = runData?.events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const payload = events[i].payloadJson;
      const url = payload?.screenshotUrl as string | undefined;
      if (url && typeof url === "string") return url;
    }
    return "";
  }, [runData]);

  // Prefer live-polled URL (refreshed every 2s), fall back to last event's URL
  const latestPreview = livePreviewUrl || eventPreviewUrl;

  const refresh = useCallback(async () => {
    if (!applicationId) return;
    try {
      const details = await getApplication(applicationId);
      setRunData(details);
    } catch { /* ignore */ }
  }, [applicationId]);

  useEffect(() => {
    if (!applicationId) {
      setIsLive(false);
      setLivePreviewUrl("");
      if (previewPollRef.current) { clearInterval(previewPollRef.current); previewPollRef.current = null; }
      return;
    }

    // Live preview poll every 2 seconds
    previewPollRef.current = setInterval(() => {
      void getLatestPreview(applicationId).then(url => {
        if (url) setLivePreviewUrl(`${url}?t=${Date.now()}`);
      });
    }, 2000);

    const unsub = subscribeToApplication(applicationId, () => {
      void refresh();
      setIsLive(true);
    });
    const interval = window.setInterval(() => { void refresh(); }, 6000);
    return () => {
      unsub();
      clearInterval(interval);
      if (previewPollRef.current) { clearInterval(previewPollRef.current); previewPollRef.current = null; }
      setIsLive(false);
    };
  }, [applicationId, refresh]);

  const submitJob = async () => {
    if (!jobUrl || !targetRole) return;
    setError("");
    setLoading(true);
    try {
      const created = await createApplication({
        jobUrl,
        targetRole,
        metadata: {
          profile: {
            firstName: profile.firstName,
            lastName: profile.lastName,
            email: profile.email,
            phone: profile.phone,
            location: profile.location,
            linkedIn: profile.linkedIn,
            portfolio: profile.portfolio
          },
          resumeText: profile.resumeText,
          answers: {
            "why-this-company": profile.whyCompany || "I am excited about this opportunity.",
            "years-experience": profile.yearsExperience || "5"
          }
        }
      });
      setApplicationId(created.applicationId);
      const details = await getApplication(created.applicationId);
      setRunData(details);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })
        ?.response?.data?.message ?? "Failed to start application";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const pause = async () => { if (!applicationId) return; await pauseApplication(applicationId); await refresh(); };
  const resume = async () => { if (!applicationId) return; await resumeApplication(applicationId); await refresh(); };
  const newApplication = () => {
    setJobUrl(""); setTargetRole(""); setApplicationId(""); setRunData(null);
    setError(""); setIsLive(false); setLivePreviewUrl("");
    if (previewPollRef.current) { clearInterval(previewPollRef.current); previewPollRef.current = null; }
  };

  const statusColor = (s: string) => {
    if (s === "completed") return "#22c55e";
    if (s === "failed") return "#ef4444";
    if (s === "paused") return "#f59e0b";
    if (s === "running") return "#3b82f6";
    return "#94a3b8";
  };

  return (
    <div className="app-shell">
      {/* Left panel */}
      <aside className="left-panel">
        <div className="panel-header">
          <span className="logo-icon-sm">⚡</span>
          <div style={{ flex: 1 }}>
            <h2>AutoApply</h2>
            <p className="user-email">{user.firstName} · {user.email}</p>
          </div>
        </div>

        <nav className="nav-items">
          <div className="nav-item active">🚀 Apply</div>
          <div className="nav-item" onClick={onEditProfile}>👤 Profile</div>
          <div className="nav-item logout" onClick={onLogout}>⎋ Sign Out</div>
        </nav>

        <div className="divider" />

        <div className="profile-summary">
          <div className="ps-name">{profile.firstName} {profile.lastName}</div>
          <div className="ps-sub">{profile.email}</div>
          <div className="ps-sub">{profile.phone} · {profile.location}</div>
          <button className="edit-profile-btn" onClick={onEditProfile}>Edit Profile</button>
        </div>

        <div className="divider" />

        <label>Job URL</label>
        <input
          value={jobUrl}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setJobUrl(e.target.value)}
          placeholder="https://boards.greenhouse.io/..."
          disabled={loading || !!applicationId}
        />
        <label>Target Role</label>
        <input
          value={targetRole}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setTargetRole(e.target.value)}
          placeholder="Senior Software Engineer"
          disabled={loading || !!applicationId}
        />

        {error && <div className="inline-error">{error}</div>}

        {!applicationId ? (
          <button className="start-btn" onClick={submitJob} disabled={loading || !jobUrl || !targetRole}>
            {loading ? "⏳ Launching…" : "🚀 Start Application"}
          </button>
        ) : (
          <>
            <button className="new-btn" onClick={newApplication}>＋ New Application</button>
            <div className="control-row">
              <button onClick={pause} disabled={!applicationId || runData?.status === "paused"}>⏸ Pause</button>
              <button onClick={resume} disabled={!applicationId || runData?.status === "running"}>▶ Resume</button>
              <button onClick={refresh} disabled={!applicationId}>↻ Refresh</button>
            </div>
          </>
        )}
      </aside>

      {/* Main panel */}
      <main className="main-panel">
        {/* Status bar */}
        <section className="status-card">
          <div className="status-header">
            <h2>Application Run</h2>
            {isLive && <span className="live-badge">● LIVE</span>}
          </div>
          <div className="status-grid">
            <div>
              <span>Status</span>
              <strong style={{ color: statusColor(runData?.status ?? "idle") }}>
                {runData?.status ?? "idle"}
              </strong>
            </div>
            <div>
              <span>Step</span>
              <strong>{runData?.currentStep ?? "—"}</strong>
            </div>
            <div>
              <span>Progress</span>
              <strong>{progress.toFixed(0)}%</strong>
            </div>
            <div>
              <span>Stream</span>
              <strong>{isLive ? "live" : "polling"}</strong>
            </div>
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>

          {/* Step pipeline */}
          <div className="pipeline">
            {ORDERED_STEPS.map((step) => {
              const currentIdx = ORDERED_STEPS.indexOf(runData?.currentStep ?? "");
              const stepIdx = ORDERED_STEPS.indexOf(step);
              const done = currentIdx > stepIdx;
              const active = currentIdx === stepIdx;
              return (
                <div
                  key={step}
                  className={`pipeline-step ${done ? "done" : ""} ${active ? "active" : ""}`}
                  title={step}
                >
                  <div className="pip-dot" />
                  <span>{step.replace(/_/g, " ")}</span>
                </div>
              );
            })}
          </div>
        </section>

        {/* Browser preview + logs */}
        <section className="log-card">
          <h2>Live Automation Preview</h2>
          <div className="preview-frame">
            {latestPreview
              ? <img key={latestPreview} src={latestPreview} alt="Live browser view" />
              : <p>Browser preview will appear when automation starts.</p>
            }
          </div>

          <h2 style={{ marginTop: 20 }}>Execution Logs</h2>
          <div className="log-list">
            {(runData?.events ?? []).length === 0
              ? <p className="empty-logs">No logs yet. Start an application to see live progress.</p>
              : [...(runData?.events ?? [])].reverse().map((ev) => (
                <article key={ev.id} className="log-item">
                  <header>
                    <strong className="step-tag">{ev.step}</strong>
                    <span>{new Date(ev.createdAt).toLocaleTimeString()}</span>
                  </header>
                  <p>{ev.message}</p>
                </article>
              ))
            }
          </div>
        </section>
      </main>
    </div>
  );
}

// ──────────────────────────────────────────────
// Root App
// ──────────────────────────────────────────────

export function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [profile, setProfile] = useState<UserProfile>(EMPTY_PROFILE);
  const [screen, setScreen] = useState<Screen>("auth");
  const [bootstrapping, setBootstrapping] = useState(true);

  // On mount: check for existing token/session
  useEffect(() => {
    const token = getStoredToken();
    if (!token) { setBootstrapping(false); return; }

    getMe()
      .then((me) => {
        setUser(me);
        const stored = getStoredProfile();
        if (stored) {
          setProfile(stored);
          setScreen("apply");
        } else {
          setProfile({ ...EMPTY_PROFILE, firstName: me.firstName, lastName: me.lastName, email: me.email });
          setScreen("profile");
        }
      })
      .catch(() => {
        // Token expired or invalid
        localStorage.removeItem("autoapply_token");
        setScreen("auth");
      })
      .finally(() => setBootstrapping(false));
  }, []);

  const handleAuth = (u: AuthUser) => {
    setUser(u);
    const existing = getStoredProfile();
    if (existing && profileComplete(existing)) {
      setProfile(existing);
      setScreen("apply");
    } else {
      setProfile({ ...EMPTY_PROFILE, firstName: u.firstName, lastName: u.lastName, email: u.email });
      setScreen("profile");
    }
  };

  const handleProfileSave = (p: UserProfile) => {
    setProfile(p);
    if (profileComplete(p)) setScreen("apply");
  };

  const handleLogout = () => {
    logout();
    setUser(null);
    setProfile(EMPTY_PROFILE);
    setScreen("auth");
  };

  if (bootstrapping) {
    return (
      <div className="boot-screen">
        <span className="logo-icon">⚡</span>
        <p>Loading AutoApply…</p>
      </div>
    );
  }

  if (screen === "auth" || !user) {
    return <AuthScreen onAuth={handleAuth} />;
  }

  if (screen === "profile") {
    return (
      <ProfileScreen
        user={user}
        initial={profile}
        onSave={handleProfileSave}
      />
    );
  }

  return (
    <ApplyScreen
      user={user}
      profile={profile}
      onEditProfile={() => setScreen("profile")}
      onLogout={handleLogout}
    />
  );
}
