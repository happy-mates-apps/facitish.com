import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "./auth";
import { getConsent, setConsent } from "./tracker";

export default function ConsentBanner() {
  const { config } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!config) return;
    const consent = getConsent();
    // Ask again when the admin has changed the texts and chosen to ask again (new version).
    setOpen(!consent || consent.version < config.consent_version);
  }, [config]);

  useEffect(() => {
    const reopen = () => setOpen(true);
    window.addEventListener("gaer:consent", reopen);
    return () => window.removeEventListener("gaer:consent", reopen);
  }, []);

  if (!open || !config || location.pathname.startsWith("/admin") || window.self !== window.top) return null;

  const answer = async (statistics: boolean) => {
    setOpen(false);
    await setConsent(statistics, config.consent_version);
  };

  return (
    <div className="consent" role="dialog" aria-label={config.consent_title}>
      <div className="card">
        <h3>{config.consent_title}</h3>
        <p className="small muted">
          {config.consent_text} <Link to="/privatliv">Læs mere</Link>
        </p>
        <div className="row">
          <button className="btn btn-primary" onClick={() => answer(true)}>
            {config.consent_accept}
          </button>
          <button className="btn btn-outline" onClick={() => answer(false)}>
            {config.consent_decline}
          </button>
        </div>
      </div>
    </div>
  );
}

export function openConsent() {
  window.dispatchEvent(new Event("gaer:consent"));
}
