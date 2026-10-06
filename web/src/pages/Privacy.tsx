import { useState, type FormEvent } from "react";
import { api, errorText } from "../api";
import { useAuth } from "../auth";
import { openConsent } from "../ConsentBanner";
import { getConsent } from "../tracker";
import { Alert, fmtDay, PageHeader, useLoad } from "../ui";

type Kind = "access" | "rectification" | "erasure";
const KINDS: Record<Kind, string> = { access: "Indsigt", rectification: "Rettelse", erasure: "Sletning" };
const STATUS: Record<string, string> = { received: "Modtaget", in_progress: "Under behandling", completed: "Afsluttet", rejected: "Afvist" };

type MyRequest = { id: number; kind: Kind; status: string; received_at: string; due_at: string };

export default function Privacy() {
  const { user, scope, config } = useAuth();
  const loggedIn = !!user && scope === "full";
  const consent = getConsent();
  const mine = useLoad(() => (loggedIn ? api.get<MyRequest[]>("/api/me/gdpr") : Promise.resolve([])), [loggedIn]);
  const [kind, setKind] = useState<Kind>("access");
  const [contact, setContact] = useState("");
  const [message, setMessage] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = loggedIn
        ? await api.post<{ due_at: string }>("/api/me/gdpr", { kind, message })
        : await api.post<{ due_at: string }>("/api/public/gdpr", { kind, contact, message });
      setDone(`Din anmodning er modtaget. Du får svar senest ${fmtDay(res.due_at)}.`);
      setMessage("");
      mine.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <PageHeader eyebrow="Privatliv" title={`Sådan behandler ${config?.app_name ?? "vi"} dine data`}>
        Alle data ligger hos OVHcloud i Europa. Vi bruger ingen analyseværktøjer fra tredjepart. Statistik og heatmaps
        samler vi selv ind, og kun hvis du har sagt ja.
      </PageHeader>

      <div className="card">
        <span className="eyebrow">Statistik og cookies</span>
        <p className="small">
          {consent?.statistics
            ? "Du har sagt ja til statistik. Vi gemmer et tilfældigt id i din browser og ser, hvilke sider du besøger, og hvor du klikker."
            : "Du har ikke sagt ja til statistik. Vi tæller kun anonyme sidevisninger uden at gemme noget i din browser."}
        </p>
        <div><button className="btn btn-outline" onClick={openConsent}>Skift valg</button></div>
      </div>

      <form className="card" onSubmit={submit}>
        <span className="eyebrow">Dine rettigheder</span>
        <p className="small">Du kan få indsigt i dine data, få dem rettet eller få dem slettet. Vi svarer inden for 30 dage.</p>
        <label className="field">
          Hvad vil du?
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {Object.entries(KINDS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </label>
        {!loggedIn && (
          <label className="field">
            Telefonnummer eller e-mail, vi kan kontakte dig på
            <input value={contact} onChange={(e) => setContact(e.target.value)} required minLength={3} />
          </label>
        )}
        <label className="field">
          Uddyb gerne (valgfrit)
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={4000} />
        </label>
        <Alert kind="success">{done}</Alert>
        <Alert>{error}</Alert>
        <div><button className="btn btn-primary">Send anmodning</button></div>
      </form>

      {loggedIn && !!mine.data?.length && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Anmodning</th><th>Status</th><th>Modtaget</th><th>Frist</th></tr></thead>
            <tbody>
              {mine.data.map((r) => (
                <tr key={r.id}><td>{KINDS[r.kind]}</td><td>{STATUS[r.status]}</td><td>{fmtDay(r.received_at)}</td><td>{fmtDay(r.due_at)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
