// /godkend?t=… — the link in the e-mail about an access request from an MCP client. The link belongs to the person
// it was sent to; they must be logged in as themselves (RequireUser). The decision is the same as in Konto → MCP-adgang.
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, errorText } from "../api";
import { Alert, fmtDate, Loading, useLoad } from "../ui";
import { LevelPill, type AccessRequest } from "./McpAccess";

export default function Approve() {
  const [params] = useSearchParams();
  const t = params.get("t") ?? "";
  const req = useLoad(() => api.get<AccessRequest>(`/api/me/mcp-access/link?t=${encodeURIComponent(t)}`), [t]);
  const [done, setDone] = useState<AccessRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const r = done ?? req.data;

  const decide = async (approve: boolean) => {
    setError(null);
    try {
      setDone(await api.post<AccessRequest>("/api/me/mcp-access/link", { t, approve }));
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="stack" style={{ maxWidth: 640, margin: "0 auto", "--gap": "16px" } as React.CSSProperties}>
      <h2>Godkend adgang</h2>
      <Alert>{error ?? req.error}</Alert>
      {req.loading && !r && <Loading />}
      {r && (
        <div className="card" data-deeplink="approve-request">
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <strong>{r.client}</strong><LevelPill level={r.level} label={r.levelLabel} />
          </div>
          <dl className="small" style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "6px 16px", margin: 0 }}>
            <dt className="muted">Data</dt><dd style={{ margin: 0 }}>{r.what}</dd>
            <dt className="muted">Begrundelse</dt><dd style={{ margin: 0 }}>{r.reason}</dd>
            <dt className="muted">Endpoint</dt><dd style={{ margin: 0 }}>{r.endpoint === "admin" ? "/mcp/admin" : "/mcp"}</dd>
            <dt className="muted">Anmodet</dt><dd style={{ margin: 0 }}>{fmtDate(r.createdAt)}</dd>
            <dt className="muted">Status</dt><dd style={{ margin: 0 }}>{r.statusLabel}</dd>
          </dl>
          {r.status === "awaiting_user" ? (
            <>
              {r.level === "confidential" && <p className="small muted">Dataene er fortrolige. Når du har godkendt, skal en godkender i /admin også sige ja.</p>}
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button className="btn btn-outline" onClick={() => decide(false)}>Afvis</button>
                <button className="btn btn-primary" disabled={!r.sessionActive} onClick={() => decide(true)}>
                  {r.level === "confidential" ? "Godkend og send videre" : `Godkend i ${r.durationDays} dage`}
                </button>
              </div>
            </>
          ) : (
            <p className="small">Der er ikke mere at gøre her. Se alle anmodninger under <Link to="/konto">Konto → MCP-adgang</Link>.</p>
          )}
        </div>
      )}
    </div>
  );
}
