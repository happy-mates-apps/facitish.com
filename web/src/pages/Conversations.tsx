// /samtaler, /samtaler/:id and /m/samtaler — conversations between users (specs/beskeder, phase 2): Fællessamtalen,
// where every user is a member, and direct conversations between two users. Anyone can report a message to the
// administration or block another user; a block hides their messages from you and stops direct conversations both ways.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, errorText } from "../api";
import { Alert, PageHeader, useLoad } from "../ui";

type Conv = { id: number; kind: "instance" | "direct"; title: string; other_id: number | null; last_message_at: string | null; last_body: string | null; unread: number };
type Msg = { id: number; author_id: number | null; author_name: string; mine: boolean; body: string | null; removed: boolean; reported: boolean; created_at: string };
type Thread = { id: number; kind: "instance" | "direct"; title: string; other: { id: number; display_name: string } | null; items: Msg[]; has_more: boolean };
type Member = { id: number; display_name: string };
type Block = { user_id: number; display_name: string; created_at: string };

const REASONS: [string, string][] = [["harassment", "Chikane"], ["hate", "Hadefuld tale"], ["sexual", "Seksuelt indhold"], ["spam", "Spam"], ["other", "Andet"]];
const when = (iso: string) => new Intl.DateTimeFormat("da-DK", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

export default function Conversations({ base = "/samtaler", compact = false }: { base?: string; compact?: boolean }) {
  const { id } = useParams();
  const list = useLoad(() => api.get<{ items: Conv[] }>("/api/messages/conversations"));
  const current = id ? Number(id) : null;
  const navigate = useNavigate();
  // On a wide page the shared conversation opens by itself; on the phone the list comes first.
  const first = list.data?.items[0]?.id;
  useEffect(() => {
    if (!compact && current === null && first) navigate(`${base}/${first}`, { replace: true });
  }, [compact, current, first, base, navigate]);
  const showList = !compact || current === null;
  const showThread = current !== null;

  return (
    <div className="stack" style={{ ["--gap" as string]: "20px" }}>
      {compact ? (current === null && <h2>Samtaler</h2>) : (
        <PageHeader eyebrow="Samtaler" title="Samtaler">
          Fællessamtalen med alle, og direkte beskeder mellem to. Du kan anmelde en besked til administrationen eller blokere en bruger.
        </PageHeader>
      )}
      <Alert>{list.error}</Alert>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        {showList && (
          <div className="stack" style={{ flex: "1 1 280px", minWidth: 0, ["--gap" as string]: "16px" }}>
            <ConversationList items={list.data?.items ?? []} current={current} base={base} />
            <NewConversation base={base} onStarted={list.reload} />
            <Blocks onChange={list.reload} />
          </div>
        )}
        {showThread && (
          <div style={{ flex: "999 1 480px", minWidth: 0 }}>
            {compact && <Link to={base} className="small">← Alle samtaler</Link>}
            <ThreadView key={current} id={current!} onRead={list.reload} base={base} />
          </div>
        )}
        {!showThread && !compact && (
          <div className="card muted-bg" style={{ flex: "999 1 480px", minWidth: 0 }}>
            <p className="muted">Vælg en samtale, eller start en ny.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ConversationList({ items, current, base }: { items: Conv[]; current: number | null; base: string }) {
  return (
    <ul className="card" style={{ listStyle: "none", margin: 0, padding: 0, gap: 0 }}>
      {items.map((c, i) => (
        <li key={c.id} style={{ borderTop: i ? "1px solid var(--hm-border)" : 0 }}>
          <Link to={`${base}/${c.id}`} aria-current={c.id === current ? "page" : undefined}
            style={{ display: "flex", gap: 10, padding: "12px 16px", color: "inherit", textDecoration: "none",
              background: c.id === current ? "var(--hm-muted)" : "transparent", borderRadius: i === 0 ? "16px 16px 0 0" : 0 }}>
            <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
              <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <strong style={{ fontWeight: c.unread ? 700 : 600 }}>{c.title}</strong>
                {c.unread > 0 && <span className="pill blue" aria-label={`${c.unread} ulæste`}>{c.unread}</span>}
              </span>
              <span className="small muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.last_body ?? (c.kind === "instance" ? "Skriv til alle" : "Ingen beskeder endnu")}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function NewConversation({ base, onStarted }: { base: string; onStarted: () => Promise<void> }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    let alive = true;
    const t = window.setTimeout(() => {
      api.get<{ items: Member[] }>(`/api/messages/members?q=${encodeURIComponent(q.trim())}`).then((r) => alive && setFound(r.items), () => {});
    }, 250);
    return () => { alive = false; window.clearTimeout(t); };
  }, [q]);
  const start = async (m: Member) => {
    setError(null);
    try {
      const r = await api.post<{ id: number }>("/api/messages/conversations/direct", { user_id: m.id });
      setQ(""); setFound([]);
      await onStarted();
      navigate(`${base}/${r.id}`);
    } catch (e) { setError(errorText(e)); }
  };
  return (
    <div className="card">
      <label className="field">Ny direkte samtale
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Søg på navn" />
      </label>
      <Alert>{error}</Alert>
      {found.map((m) => <button key={m.id} className="btn btn-outline btn-sm" style={{ justifyContent: "flex-start" }} onClick={() => start(m)}>{m.display_name}</button>)}
      {q.trim().length >= 2 && found.length === 0 && <span className="tiny muted">Ingen med det navn.</span>}
    </div>
  );
}

function Blocks({ onChange }: { onChange: () => Promise<void> }) {
  const { data, reload } = useLoad(() => api.get<{ items: Block[] }>("/api/messages/blocks"));
  if (!data || data.items.length === 0) return null;
  const unblock = async (b: Block) => {
    await api.del(`/api/messages/blocks/${b.user_id}`);
    await Promise.all([reload(), onChange()]);
  };
  return (
    <div className="card">
      <h3>Blokerede</h3>
      {data.items.map((b) => (
        <div key={b.user_id} className="spread small">
          <span>{b.display_name}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => unblock(b)}>Fjern blokering</button>
        </div>
      ))}
    </div>
  );
}

function ThreadView({ id, onRead, base }: { id: number; onRead: () => Promise<void>; base: string }) {
  const navigate = useNavigate();
  const [thread, setThread] = useState<Thread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [reporting, setReporting] = useState<number | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const lastId = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const t = await api.get<Thread>(`/api/messages/conversations/${id}/messages`);
      setThread(t);
      setError(null);
      const newest = t.items.length ? t.items[t.items.length - 1].id : null;
      if (newest !== lastId.current) {
        lastId.current = newest;
        await api.post(`/api/messages/conversations/${id}/read`);
        await onRead();
        bottom.current?.scrollIntoView({ block: "end" });
      }
    } catch (e) { setError(errorText(e)); }
  }, [id, onRead]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 10000);
    return () => window.clearInterval(t);
  }, [load]);

  const send = async () => {
    if (!draft.trim()) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/api/messages/conversations/${id}/messages`, { body: draft });
      setDraft("");
      await load();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  const block = async (userId: number, name: string) => {
    if (!window.confirm(`Bloker ${name}? Du ser ikke længere ${name}s beskeder, og I kan ikke skrive direkte til hinanden.`)) return;
    try {
      await api.put(`/api/messages/blocks/${userId}`, {});
      await onRead();
      if (thread?.kind === "direct") navigate(base);
      else await load();
    } catch (e) { setError(errorText(e)); }
  };

  if (!thread) return <Alert>{error}</Alert>;
  return (
    <section className="card" aria-label={thread.title} style={{ gap: 14 }}>
      <div className="spread">
        <h3>{thread.title}</h3>
        {thread.other && <button className="btn btn-ghost btn-sm" onClick={() => block(thread.other!.id, thread.other!.display_name)}>Bloker</button>}
      </div>
      <div className="stack" style={{ ["--gap" as string]: "10px" }}>
        {thread.items.length === 0 && <p className="small muted">Ingen beskeder endnu. Skriv den første.</p>}
        {thread.items.map((m) => (
          <div key={m.id} style={{ alignSelf: m.mine ? "flex-end" : "flex-start", maxWidth: "85%", display: "flex", flexDirection: "column",
            gap: 4, alignItems: m.mine ? "flex-end" : "flex-start" }}>
            <span className="tiny muted">{m.mine ? "Dig" : m.author_name} · {when(m.created_at)}</span>
            <span style={{ padding: "10px 14px", borderRadius: 14, whiteSpace: "pre-wrap", lineHeight: 1.45,
              background: m.removed ? "transparent" : m.mine ? "var(--hm-primary)" : "var(--hm-muted)",
              border: m.removed ? "1px dashed var(--hm-border)" : 0,
              color: m.removed ? "var(--hm-muted-foreground)" : m.mine ? "#fff" : "inherit", fontStyle: m.removed ? "italic" : "normal" }}>
              {m.removed ? "Beskeden er fjernet af en moderator." : m.body}
            </span>
            {!m.mine && !m.removed && m.author_id && (
              <span className="row tiny" style={{ ["--gap" as string]: "8px" }}>
                {m.reported ? <span className="muted">Anmeldt</span>
                  : <button className="btn btn-ghost btn-sm" style={{ padding: "2px 6px", fontSize: 12 }} onClick={() => setReporting(m.id)}>Anmeld</button>}
                {thread.kind === "instance" && (
                  <button className="btn btn-ghost btn-sm" style={{ padding: "2px 6px", fontSize: 12 }} onClick={() => block(m.author_id!, m.author_name)}>Bloker {m.author_name}</button>
                )}
              </span>
            )}
            {reporting === m.id && <ReportForm messageId={m.id} onClose={() => setReporting(null)} onDone={load} />}
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <Alert>{error}</Alert>
      <label className="field">Skriv en besked
        <textarea value={draft} maxLength={4000} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(); }} />
      </label>
      <div className="spread">
        <span className="tiny muted">{thread.kind === "instance" ? "Alle brugere kan læse Fællessamtalen." : `Kun du og ${thread.title} ser samtalen.`}</span>
        <button className="btn btn-primary" onClick={send} disabled={busy || !draft.trim()}>Send</button>
      </div>
    </section>
  );
}

function ReportForm({ messageId, onClose, onDone }: { messageId: number; onClose: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState("harassment");
  const [details, setDetails] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true); setError(null);
    try {
      await api.post("/api/messages/reports", { message_id: messageId, reason, details });
      onClose();
      await onDone();
    } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  return (
    <div className="card" style={{ width: "min(420px, 100%)", padding: 16, gap: 10 }}>
      <strong>Anmeld beskeden til administrationen</strong>
      <label className="field">Hvorfor
        <select value={reason} onChange={(e) => setReason(e.target.value)}>
          {REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <label className="field">Uddybning (valgfri)
        <textarea value={details} maxLength={1000} onChange={(e) => setDetails(e.target.value)} style={{ minHeight: 60 }} />
      </label>
      <Alert>{error}</Alert>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>Annuller</button>
        <button className="btn btn-primary btn-sm" onClick={send} disabled={busy}>Send anmeldelse</button>
      </div>
      <span className="tiny muted">Afsenderen får ikke at vide, hvem der anmeldte.</span>
    </div>
  );
}
