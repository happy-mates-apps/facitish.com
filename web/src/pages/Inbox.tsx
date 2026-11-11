// /beskeder, /beskeder/:id and /m/beskeder — messages from the administration (specs/beskeder). The inbox always has
// every message; SMS and e-mail are only a nudge. You can reply when the sender allowed it: the reply goes to the
// administration alone, never to the other recipients. SMS messages need your own yes (a login number is not one).
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, errorText } from "../api";
import { Alert, Loading, PageHeader, useLoad } from "../ui";

type Item = {
  id: number; title: string; excerpt: string; allow_replies: boolean; delivered_at: string; read_at: string | null;
  conversation_id: number | null; closed_at: string | null; unread_replies: number; thread_length: number; unread: boolean;
};
type ThreadMessage = { id: number; author: string | null; admin_name: string | null; from_admin: boolean; body: string; created_at: string };
type Message = { id: number; title: string; body: string; allow_replies: boolean; delivered_at: string; read_at: string | null; thread: ThreadMessage[]; closed: boolean };
type Prefs = { sms: boolean; sms_consent_at: string | null; mail: boolean; has_phone: boolean; has_email: boolean; sms_available: boolean; mail_available: boolean };

const when = (iso: string) => new Intl.DateTimeFormat("da-DK", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

export default function Inbox({ base = "/beskeder", compact = false }: { base?: string; compact?: boolean }) {
  const { id } = useParams();
  return id ? <MessageView id={Number(id)} base={base} /> : <InboxList base={base} compact={compact} />;
}

function InboxList({ base, compact }: { base: string; compact: boolean }) {
  const { data, error, loading } = useLoad(() => api.get<{ items: Item[] }>("/api/messages/inbox"));
  return (
    <div className="stack" style={{ ["--gap" as string]: "20px" }}>
      {compact ? <h2>Beskeder</h2> : (
        <PageHeader eyebrow="Beskeder" title="Beskeder">
          Beskeder fra administrationen. Du kan svare på dem, hvor afsenderen har slået svar til; dit svar går kun til administrationen.
        </PageHeader>
      )}
      <Alert>{error}</Alert>
      {loading && !data && <Loading />}
      {data && data.items.length === 0 && <p className="muted">Ingen beskeder endnu.</p>}
      {data && data.items.length > 0 && (
        <ul className="card" style={{ listStyle: "none", margin: 0, padding: 0, gap: 0 }}>
          {data.items.map((m, i) => (
            <li key={m.id} style={{ borderTop: i ? "1px solid var(--hm-border)" : 0 }}>
              <Link to={`${base}/${m.id}`} style={{ display: "flex", gap: 12, padding: "14px 18px", color: "inherit", textDecoration: "none" }}>
                <span aria-label={m.unread ? "Ulæst" : undefined} style={{ width: 8, height: 8, marginTop: 7, flex: "none", borderRadius: 9999,
                  background: m.unread ? "var(--hm-primary)" : "transparent" }} />
                <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                  <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <strong style={{ fontWeight: m.unread ? 700 : 600 }}>{m.title}</strong>
                    <span className="tiny muted" style={{ whiteSpace: "nowrap" }}>{when(m.delivered_at)}</span>
                  </span>
                  <span className="small muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.excerpt}</span>
                  {m.thread_length > 0 && (
                    <span className="tiny" style={{ color: m.unread_replies ? "var(--hm-primary)" : "var(--hm-muted-foreground)" }}>
                      {m.unread_replies ? `Nyt svar fra administrationen` : `${m.thread_length} besked${m.thread_length === 1 ? "" : "er"} i tråden`}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <PrefsCard />
    </div>
  );
}

function MessageView({ id, base }: { id: number; base: string }) {
  const { data, error, reload } = useLoad(() => api.get<Message>(`/api/messages/inbox/${id}`), [id]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  useEffect(() => {
    api.post(`/api/messages/inbox/${id}/read`).catch(() => {});
  }, [id]);

  const reply = async () => {
    if (!draft.trim()) return;
    setBusy(true); setSendError(null);
    try {
      await api.post(`/api/messages/inbox/${id}/reply`, { body: draft });
      setDraft("");
      await reload();
    } catch (e) { setSendError(errorText(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="stack" style={{ ["--gap" as string]: "16px", maxWidth: 720 }}>
      <Link to={base} className="small">← Alle beskeder</Link>
      <Alert>{error}</Alert>
      {data && (
        <>
          <article className="card">
            <span className="tiny muted">Fra administrationen · {when(data.delivered_at)}</span>
            <h2 style={{ fontSize: 22 }}>{data.title}</h2>
            <p style={{ whiteSpace: "pre-wrap" }}>{data.body}</p>
          </article>
          {data.thread.length > 0 && (
            <div className="stack" aria-label="Svar">
              {data.thread.map((m) => (
                <div key={m.id} style={{ alignSelf: m.from_admin ? "flex-start" : "flex-end", maxWidth: "85%", display: "flex", flexDirection: "column",
                  gap: 4, alignItems: m.from_admin ? "flex-start" : "flex-end" }}>
                  <span className="tiny muted">{m.from_admin ? `Administrationen${m.admin_name ? ` · ${m.admin_name}` : ""}` : "Dig"} · {when(m.created_at)}</span>
                  <span style={{ padding: "10px 14px", borderRadius: 14, whiteSpace: "pre-wrap", lineHeight: 1.45,
                    background: m.from_admin ? "var(--hm-muted)" : "var(--hm-primary)", color: m.from_admin ? "inherit" : "#fff" }}>{m.body}</span>
                </div>
              ))}
            </div>
          )}
          {data.allow_replies ? (
            <div className="card">
              <label className="field">Svar administrationen
                <textarea value={draft} maxLength={4000} onChange={(e) => setDraft(e.target.value)} placeholder="Skriv dit svar" />
              </label>
              <Alert>{sendError}</Alert>
              <div className="spread">
                <span className="tiny muted">Kun administrationen ser dit svar.</span>
                <button className="btn btn-primary" onClick={reply} disabled={busy || !draft.trim()}>Send svar</button>
              </div>
            </div>
          ) : <p className="small muted">Der kan ikke svares på denne besked.</p>}
        </>
      )}
    </div>
  );
}

function PrefsCard() {
  const { data, error, setData } = useLoad(() => api.get<Prefs>("/api/messages/prefs"));
  const [saveError, setSaveError] = useState<string | null>(null);
  const save = async (change: Partial<Pick<Prefs, "sms" | "mail">>) => {
    setSaveError(null);
    try { setData(await api.put<Prefs>("/api/messages/prefs", change)); }
    catch (e) { setSaveError(errorText(e)); }
  };
  if (!data) return <Alert>{error}</Alert>;
  return (
    <section className="card" aria-labelledby="prefs-h">
      <h3 id="prefs-h">Sådan får du besked</h3>
      <p className="small muted">Beskeder ligger altid her. Vil du også have dem uden for appen, vælger du det her.</p>
      <Alert>{saveError}</Alert>
      {data.sms_available && (
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <input type="checkbox" checked={data.sms} disabled={!data.has_phone && !data.sms} onChange={(e) => save({ sms: e.target.checked })}
            style={{ marginTop: 4 }} />
          <span className="stack" style={{ ["--gap" as string]: "2px" }}>
            <strong>SMS</strong>
            <span className="small muted">
              {data.has_phone
                ? data.sms && data.sms_consent_at
                  ? `Du sagde ja ${when(data.sms_consent_at)}. Du kan altid sige nej igen.`
                  : "Ja tak, send beskeder fra administrationen på SMS. Dit nummer til login bruges ikke til beskeder, før du siger ja."
                : <>Tilføj et telefonnummer under <Link to="/konto">Konto</Link> først.</>}
            </span>
          </span>
        </label>
      )}
      {data.mail_available && (
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <input type="checkbox" checked={data.mail && data.has_email} disabled={!data.has_email} onChange={(e) => save({ mail: e.target.checked })} style={{ marginTop: 4 }} />
          <span className="stack" style={{ ["--gap" as string]: "2px" }}>
            <strong>E-mail</strong>
            <span className="small muted">{data.has_email ? "Når du ikke får beskeden på SMS." : "Du har ingen e-mailadresse på din konto."}</span>
          </span>
        </label>
      )}
    </section>
  );
}
