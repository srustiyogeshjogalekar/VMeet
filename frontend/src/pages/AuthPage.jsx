import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { ArrowRight, Video } from "lucide-react";
import { loginAccount, registerAccount } from "../services/auth";
import { useAuth } from "../services/AuthContext";

export default function AuthPage({ mode }) {
  const isRegister = mode === "register";
  const navigate = useNavigate();
  const { user, setUser } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = isRegister
        ? await registerAccount({ name, email, password })
        : await loginAccount({ email, password });
      setUser(result.user);
      navigate("/", { replace: true });
    } catch (requestError) {
      setError(requestError.message || "Could not complete your request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="join-shell auth-shell">
      <header className="home-nav">
        <Link className="brand" to="/" aria-label="VMeet home"><span className="brand-mark"><Video size={20} /></span>vmeet</Link>
        <span className="secure-note">Secure account access</span>
      </header>
      <section className="join-card auth-card">
        <div className="join-icon"><Video size={24} /></div>
        <span className="eyebrow">{isRegister ? "JOIN VMEET" : "WELCOME BACK"}</span>
        <h1>{isRegister ? "Create your account" : "Sign in to VMeet"}</h1>
        <p>{isRegister ? "Create an account to get started." : "Sign in to continue to your meetings."}</p>
        <form onSubmit={submit}>
          {isRegister && <>
            <label className="field-label" htmlFor="account-name">Full name</label>
            <input id="account-name" className="text-input auth-input" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" minLength={2} maxLength={60} required />
          </>}
          <label className="field-label" htmlFor="account-email">Email address</label>
          <input id="account-email" className="text-input auth-input" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" maxLength={254} required />
          <label className="field-label" htmlFor="account-password">Password</label>
          <input id="account-password" className="text-input auth-input" type="password" autoComplete={isRegister ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={isRegister ? "At least 8 characters" : "Your password"} minLength={isRegister ? 8 : undefined} maxLength={72} required />
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button join-submit" type="submit" disabled={busy}>
            {busy ? "Please wait…" : isRegister ? "Create account" : "Sign in"} <ArrowRight size={17} />
          </button>
        </form>
        <div className="auth-switch">
          {isRegister ? "Already have an account?" : "New to VMeet?"}{" "}
          <Link to={isRegister ? "/login" : "/register"}>{isRegister ? "Sign in" : "Create an account"}</Link>
        </div>
      </section>
    </main>
  );
}
