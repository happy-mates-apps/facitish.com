// /forbind — consent for an MCP client (Claude, Copilot, ChatGPT …). Reached from /mcp/authorize after the
// normal login. Approving sends the browser back to the client with a one-time code.
import { useState } from "react";
import { useLocation } from "react-router-dom";
import { api, errorText } from "../api";
import { useAuth } from "../auth";
import { Alert, Loading, PageHeader, useLoad } from "../ui";

type Info = { client: { id: string; name: string }; scope: "mcp" | "mcp:admin"; redirect_host: string; allowed: boolean };

const CAN: Record<Info["scope"], string[]> = {
  mcp: [
    "Se dit navn, dine sessioner og hvilke features du har",
    "Læse, søge i og gemme dine klip",
    "Se dine filer og lave links til at hente dem",
    "Bede om sletning af et klip eller en GDPR-eksport — kun efter din bekræftelse",
  ],
  "mcp:admin": [
    "Se statistik, brugere, logs, GDPR-forespørgsler og indstillinger for hele instansen",
    "Foreslå ændringer af brugere, roller, features og indstillinger som kladder",
    "Intet ændres, før en kladde er bekræftet, og alt skrives i audit-loggen med dig som aktør",
    "Læse databasen med en bruger, der kun må læse",
  ],
};

export default function McpConsent() {
  const { search } = useLocation();
  const { user } = useAuth();
  const params = Object.fromEntries(new URLSearchParams(search));
  const info = useLoad(() => api.get<Info>(`/api/mcp/consent${search}`), [search]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ redirect: string }>("/api/mcp/consent", { ...params, approve });
      window.location.assign(r.redirect);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div className="page" style={{ maxWidth: 560 }}>
      <PageHeader eyebrow={info.data?.scope === "mcp:admin" ? "/mcp/admin" : "/mcp"} title="Forbind en AI-klient" />
      <Alert>{info.error ?? error}</Alert>
      {info.loading && !info.data && <Loading />}
      {info.data && (
        <div className="card">
          <p>
            <strong>{info.data.client.name}</strong> vil forbinde til din konto{user?.display_name ? ` (${user.display_name})` : ""} og
            sender dig tilbage til <span className="mono">{info.data.redirect_host}</span> bagefter.
          </p>
          <span className="eyebrow">Klienten må</span>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {CAN[info.data.scope].map((t) => <li key={t} className="small">{t}</li>)}
          </ul>
          <p className="muted small">
            Klienten handler altid som dig og ser aldrig dit telefonnummer i klartekst. Du kan fjerne den igen under Konto → Aktive logins.
          </p>
          {!info.data.allowed && <Alert kind="warn">Kun brugere med admin-rollen kan forbinde /mcp/admin.</Alert>}
          <div className="row" style={{ "--gap": "8px" } as React.CSSProperties}>
            <button className="btn btn-primary" disabled={busy || !info.data.allowed} onClick={() => answer(true)}>Tillad</button>
            <button className="btn btn-outline" disabled={busy} onClick={() => answer(false)}>Afvis</button>
          </div>
        </div>
      )}
    </div>
  );
}
