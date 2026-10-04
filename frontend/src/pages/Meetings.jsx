import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Link2, Video } from "lucide-react";
import { apiUrl, createMeeting } from "../services/socket";
import { useAuth } from "../services/AuthContext";

export default function Meetings() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [meetingId, setMeetingId] = useState("");
  const [error, setError] = useState("");
  const [authError, setAuthError] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverAvailable, setServerAvailable] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let checking = false;
    const checkServer = async () => {
      if (checking) return;
      checking = true;
      try {
        const response = await fetch(`${apiUrl}/api/health`);
        if (!response.ok) throw new Error("Signaling server is unavailable.");
        const health = await response.json();
        if (!cancelled) {
          setServerAvailable(health.status === "ok");
          if (health.status === "ok") {
            setError((current) => current.startsWith("Cannot reach the meeting service.") ? "" : current);
          }
        }
      } catch {
        if (!cancelled) setServerAvailable(false);
      } finally {
        checking = false;
      }
    };
    checkServer();
    const interval = window.setInterval(checkServer, 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  async function startMeeting() {
    setError("");
    setBusy(true);
    try {
      const meeting = await createMeeting();
      sessionStorage.setItem(`vmeet-host:${meeting.id}`, meeting.hostToken);
      navigate(`/room/${meeting.id}`);
    } catch (err) {
      setError(err.message || "Unable to create a meeting.");
    } finally {
      setBusy(false);
    }
  }

  function joinMeeting(event) {
    event.preventDefault();
    if (meetingId.trim()) navigate(`/room/${encodeURIComponent(meetingId.trim())}`);
  }

  async function signOut() {
    setAuthError("");
    try {
      await logout();
    } catch (logoutError) {
      setAuthError(logoutError.message);
    }
  }

  return (
    <main className="home-shell">
      <header className="home-nav">
        <a className="brand" href="/" aria-label="VMeet home"><span className="brand-mark"><Video size={20} /></span>vmeet</a>
        <div className="home-nav-actions">
          <span className="secure-note"><span className="secure-dot" /> Private by design</span>
          {user ? <>
            <span className="account-greeting">Hi, {user.name}</span>
            <button className="auth-nav-link" onClick={signOut}>Sign out</button>
          </> : <>
            <a className="auth-nav-link" href="/login">Log in</a>
            <a className="auth-nav-link auth-nav-primary" href="/register">Sign up</a>
          </>}
        </div>
      </header>
      {authError && <p className="form-error auth-nav-error" role="alert">{authError}</p>}
      <section className="home-content">
        <div className="hero-copy">
          <span className="eyebrow">VIDEO MEETINGS, MADE SIMPLE</span>
          <h1>Make room for<br /><span>great conversations.</span></h1>
          <p>Create a private meeting and invite anyone with a link. No downloads, just a browser and a camera.</p>
          <button className="primary-button create-button" onClick={startMeeting} disabled={busy || serverAvailable === false}>
            <Video size={19} /> {busy ? "Creating meeting…" : serverAvailable === false ? "Meeting service unavailable" : "Start a new meeting"} <ArrowRight size={18} />
          </button>
          <div className="home-divider"><span>or join with a code</span></div>
          <form className="join-form" onSubmit={joinMeeting}>
            <label className="input-wrap">
              <Link2 size={18} />
              <input
                aria-label="Meeting code"
                value={meetingId}
                onChange={(event) => setMeetingId(event.target.value)}
                placeholder="Enter meeting code"
                maxLength={80}
              />
            </label>
            <button className="secondary-button" type="submit" disabled={!meetingId.trim() || serverAvailable === false}>Join meeting</button>
          </form>
          {serverAvailable === false && <p className="form-error" role="alert">The meeting service is offline. Start the backend server and try again.</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <aside className="home-card">
          <div className="illustration">
            <div className="illustration-glow" />
            <div className="person-card person-back"><span className="avatar avatar-purple">J</span><span className="wave"><i /><i /><i /><i /><i /></span></div>
            <div className="person-card person-front"><div className="avatar avatar-orange">A</div><span className="person-caption"><i /> Alex is speaking</span></div>
            <div className="floating-call"><Video size={17} /><span>You're in the right place</span></div>
          </div>
          <div className="home-card-copy"><strong>Face-to-face, wherever you are.</strong><span>Clear conversations start with a simple click.</span></div>
        </aside>
      </section>
      <footer className="home-footer"><span>© {new Date().getFullYear()} VMeet · srusti yogesh jogalekar</span><span>Peer-to-peer calls support up to 8 participants</span></footer>
    </main>
  );
}