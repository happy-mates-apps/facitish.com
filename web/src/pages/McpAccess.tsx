// Konto → MCP-adgang: what the user's MCP clients have asked for (server/app/access.py). The user approves or
// denies here or from the link in the e-mail (/godkend); confidential data then also needs an approver in /admin.
import { useState } from "react";
import { api, errorText } from "../api";
import { Alert, fmtDate, fmtDay, useLoad } from "../ui";

export type AccessRequest = {
  id: number; endpoint: "app" | "admin"; client: string; target: string; toolName: string | null; what: string;
  level: "own" | "internal" | "confidential"; levelLabel: string; reason: string; status: string; statusLabel: string;
  sessionActive: boolean; expiresAt: string | null; createdAt: string; approverName: string | null; note: string | null;
  durationDays: number;
};

const OPEN = new Set(["awaiting_user", "awaiting_approver"]);
const TONE: Record<string, string> = { approved: "green", awaiting_approver: "amber", awaiting_user: "blue", denied: "red" };

export function LevelPill({ level, label }: { level: string; label: string }) {
  return <span className={`pill ${level === "confidential" ? "amber" : level === "internal" ? "blue" : ""}`}>{label}</span>;
}

export default function McpAccess() {
  const list = useLoad(() => api.get<{ audience: string; audienceLabel: string; items: AccessRequest[] }>("/api/me/mcp-access"));
  const [error, setError] = useState<string | null>(null);
  const items = list.data?.items ?? [];
  const waiting = items.filter((r) => r.status === "awaiting_user");
  const rest = items.filter((r) => r.status !== "awaiting_user" && (OPEN.has(r.status) || r.status === "approved"));

  const act = async (fn: () => Promise<unknown>, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    setError(null);
    try {
      await fn();
      await list.reload();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="card" data-deeplink="mcp-access">
      <span className="eyebrow">MCP-adgang</span>
      <p className="small muted">
        Det her har dine MCP-klienter bedt om. En klient ser kun de data, du har godkendt, og kun indtil adgangen udløber.
        {list.data && <> Du er registreret som <strong>{list.data.audienceLabel.toLowerCase()}</strong> bruger
          {list.data.audience === "external" && " og kan kun give adgang til dine egne data"}.</>}
      </p>
      <Alert>{error ?? list.error}</Alert>
      {waiting.length > 0 && <strong className="small">Afventer dig ({waiting.length})</strong>}
      {waiting.map((r) => (
        <div key={r.id} className="spread" style={{ borderTop: "1px solid var(--hm-border)", paddingTop: 10, flexWrap: "wrap", gap: 10 }}>
          <div className="stack" style={{ "--gap": "2px", minWidth: 0, flex: "999 1 320px" } as React.CSSProperties}>
            <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <strong className="small">{r.client} vil have adgang til: {r.what}</strong>
              <LevelPill level={r.level} label={r.levelLabel} />
            </span>
            <span className="muted tiny">Begrundelse: „{r.reason}“ · {fmtDate(r.createdAt)}</span>
            {r.level === "confidential" && <span className="tiny">Når du har godkendt, skal en godkender i /admin også sige ja.</span>}
            {!r.sessionActive && <span className="tiny">Klienten er ikke længere forbundet og kan kun afvises.</span>}
          </div>
          <div className="row">
            <button className="btn btn-outline btn-sm" onClick={() => act(() => api.post(`/api/me/mcp-access/${r.id}/decide`, { approve: false }))}>Afvis</button>
            <button className="btn btn-primary btn-sm" disabled={!r.sessionActive}
                    onClick={() => act(() => api.post(`/api/me/mcp-access/${r.id}/decide`, { approve: true }))}>
              {r.level === "confidential" ? "Godkend og send videre" : "Godkend"}
            </button>
          </div>
        </div>
      ))}
      {items.length === 0 && !list.loading && <p className="small muted">Ingen anmodninger endnu.</p>}
      {rest.map((r) => (
        <div key={r.id} className="spread" style={{ borderTop: "1px solid var(--hm-border)", paddingTop: 10, flexWrap: "wrap", gap: 10 }}>
          <div className="stack" style={{ "--gap": "2px", minWidth: 0 } as React.CSSProperties}>
            <strong className="small">{r.client} · {r.what}</strong>
            <span className="muted tiny">
              <span className={`pill ${TONE[r.status] ?? ""}`}>{r.statusLabel}</span>
              {r.expiresAt && r.status === "approved" && <> · udløber {fmtDay(r.expiresAt)}</>}
              {r.approverName && <> · godkender {r.approverName}</>}
            </span>
          </div>
          <button className="btn btn-outline btn-sm" onClick={() => act(() => api.post(`/api/me/mcp-access/${r.id}/revoke`),
            r.status === "approved" ? `Tilbagekald adgangen for ${r.client}?` : undefined)}>
            {r.status === "approved" ? "Tilbagekald" : "Træk tilbage"}
          </button>
        </div>
      ))}
    </div>
  );
}
