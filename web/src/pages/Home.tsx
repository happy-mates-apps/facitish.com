import { Link } from "react-router-dom";
import { useAuth } from "../auth";
import { PasskeyNudge } from "../security";

export default function Home() {
  const { user, scope, config, loading } = useAuth();
  const name = config?.app_name ?? "Gær";

  if (loading) return null;
  if (!user || scope !== "full") {
    // Anonymous visitors belong on the public website (the server redirects / there as well).
    window.location.replace("/w/");
    return null;
  }

  return (
    <div className="page">
      <div className="stack" style={{ "--gap": "8px" } as React.CSSProperties}>
        <div className="eyebrow">{name}</div>
        <h1>Hej{user.display_name ? ` ${user.display_name}` : ""}</h1>
      </div>
      <PasskeyNudge />
      <div className="grid">
        <Link to="/filer" className="card">
          <span className="eyebrow">Object Storage</span>
          <h3>Mine filer</h3>
          <p className="muted small">Upload, hent og slet dine filer.</p>
        </Link>
        <Link to="/konto" className="card">
          <span className="eyebrow">Konto</span>
          <h3>Profil og sikkerhed</h3>
          <p className="muted small">Profil, passkeys, godkendelsesapp, aktive logins og dine data.</p>
        </Link>
        {user.role === "admin" && (
          <a href="/admin" className="card">
            <span className="eyebrow mono">/admin</span>
            <h3>Administration</h3>
            <p className="muted small">Brugere, logs, analytics, heatmaps, GDPR og indstillinger.</p>
          </a>
        )}
      </div>
    </div>
  );
}
