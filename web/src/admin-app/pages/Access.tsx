// /admin/access — access requests from MCP clients (server/app/access.py). Confidential (red) access needs an approver
// after the user: from this list, or from the link in the e-mail (?request=…&t=…), which opens the request on top.
// Approving needs a fresh second factor (the step-up dialog asks for it). You cannot approve your own request.
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, errorText } from "../../api";
import { Alert, fmtDate, fmtDay, Loading, PageHeader, useLoad } from "../ui";

type Req = {
  id: number; userId: number; userName: string | null; userEmail: string | null; userAudience: "internal" | "external";
  endpoint: "app" | "admin"; client: string; what: string; level: string; levelLabel: string; reason: string;
  status: string; statusLabel: string; sessionActive: boolean; expiresAt: string | null; createdAt: string;
  approverName: string | null; note: string | null; own: boolean;
};
type List = { items: Req[]; counts: { open: number; user: number; active: number }; days: number[]; defaultDays: number };

const TABS = [["open", "Afventer godkender"], ["user", "Afventer brugeren"], ["active", "Aktive"], ["all", "Alle"]] as const;
const TONE: Record<string, string> = { approved: "green", awaiting_approver: "amber", awaiting_user: "blue", denied: "red" };

function Decide({ r, days, defaultDays, token, onDone }: { r: Req; days: number[]; defaultDays: number; token?: string; onDone: () => void }) {
  const [d, setD] = useState(defaultDays);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const decide = async (approve: boolean) => {
    setError(null);
    try {
      await api.post(`/api/admin/access/${r.id}/decide`, { approve, days: approve ? d : null, note: note || null, t: token || null });
      onDone();
    } catch (e) {
      setError(errorText(e));
    }
  };
  if (r.own) return <p className="small muted">Du kan ikke godkende din egen anmodning.</p>;
  return (
    <div className="stack" style={{ "--gap": "10px" } as React.CSSProperties}>
      <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
        <label className="field">Gyldig i
          <select value={d} onChange={(e) => setD(Number(e.target.value))}>
            {days.map((x) => <option key={x} value={x}>{x} {x === 1 ? "dag" : "dage"}</option>)}
          </select>
        </label>
        <label className="field" style={{ flex: "1 1 260px" }}>Bemærkning (gemmes i audit-loggen, skal udfyldes ved afvisning)
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </label>
      </div>
      <Alert>{error}</Alert>
      <div className="row">
        <button className="btn btn-outline btn-sm" onClick={() => decide(false)}>Afvis</button>
        <button className="btn btn-primary btn-sm" disabled={!r.sessionActive || r.userAudience !== "internal"} onClick={() => decide(true)}>
          Godkend i {d} {d === 1 ? "dag" : "dage"}
        </button>
      </div>
      {!r.sessionActive && <p className="small muted">MCP-klienten er ikke længere forbundet. Anmodningen kan kun afvises.</p>}
      {r.userAudience !== "internal" && <p className="small muted">Brugeren er ekstern og kan ikke få adgang til fortrolige data.</p>}
    </div>
  );
}

function Card({ r, list, token, onChange }: { r: Req; list: List; token?: string; onChange: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const revoke = async () => {
    const reason = prompt("Hvorfor tilbagekalder du adgangen?");
    if (!reason) return;
    try {
      await api.post(`/api/admin/access/${r.id}/revoke`, { reason });
      onChange();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="card">
      <div className="spread">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <strong>{r.userName || r.userEmail || `#${r.userId}`}{r.own && " (dig)"}</strong>
          <span className={`pill ${r.userAudience === "internal" ? "blue" : ""}`}>{r.userAudience === "internal" ? "Intern" : "Ekstern"}</span>
          <span className={`pill ${r.level === "confidential" ? "amber" : ""}`}>{r.levelLabel}</span>
          <span className={`pill ${TONE[r.status] ?? ""}`}>{r.statusLabel}</span>
        </div>
        <span className="muted small">{fmtDate(r.createdAt)}</span>
      </div>
      <div className="small">{r.client} på {r.endpoint === "admin" ? "/mcp/admin" : "/mcp"} vil have adgang til <strong>{r.what}</strong></div>
      <div className="small muted">Begrundelse: „{r.reason}“</div>
      {r.approverName && <div className="small muted">Godkender: {r.approverName}{r.note && ` · „${r.note}“`}</div>}
      {r.status === "approved" && r.expiresAt && <div className="small muted">Udløber {fmtDay(r.expiresAt)}</div>}
      <Alert>{error}</Alert>
      {r.status === "awaiting_approver" && <Decide r={r} days={list.days} defaultDays={list.defaultDays} token={token} onDone={onChange} />}
      {r.status === "approved" && <div className="row"><button className="btn btn-outline btn-sm" onClick={revoke}>Tilbagekald</button></div>}
    </div>
  );
}

export default function Access() {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<string>("open");
  const token = params.get("t") ?? undefined;
  const list = useLoad(() => api.get<List>(`/api/admin/access?status=${tab}`), [tab]);
  const linked = useLoad(() => (token ? api.get<Req>(`/api/admin/access/link?t=${encodeURIComponent(token)}`) : Promise.resolve(null)), [token]);
  const reload = () => {
    if (token) setParams({}, { replace: true });
    void list.reload();
  };

  return (
    <>
      <PageHeader eyebrow="/admin/access" title="Adgangsanmodninger">
        MCP-klienter beder om adgang til værktøjer og data, som kataloget i /admin/data har klassificeret gule eller røde.
        Brugeren godkender altid først. Fortrolige (røde) data kræver desuden din godkendelse. Adgangen gælder kun den
        MCP-session, der bad om den, og udløber af sig selv. Alt bliver logget.
      </PageHeader>
      {token && (linked.error ? <Alert>{linked.error}</Alert> : linked.data && list.data && (
        <div className="glow"><Card r={linked.data} list={list.data} token={token} onChange={reload} /></div>
      ))}
      <div className="row" role="tablist" data-deeplink="access-requests">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`btn btn-sm ${tab === k ? "btn-primary" : "btn-outline"}`} onClick={() => setTab(k)}>
            {label}{list.data && k !== "all" ? ` · ${list.data.counts[k as "open" | "user" | "active"]}` : ""}
          </button>
        ))}
      </div>
      <Alert>{list.error}</Alert>
      {list.loading && !list.data ? <Loading /> : list.data?.items.length === 0 ? <p className="muted">Ingen anmodninger.</p> : (
        <div className="stack" style={{ "--gap": "16px" } as React.CSSProperties}>
          {list.data?.items.map((r) => <Card key={`${r.id}-${r.status}`} r={r} list={list.data!} onChange={reload} />)}
        </div>
      )}
    </>
  );
}
