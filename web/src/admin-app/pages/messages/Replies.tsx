// /admin/messages/replies → Svar. Users' replies to broadcasts: one private thread per recipient with the
// administration. Answers reach the user in the app, and by SMS or e-mail by the same rules as a broadcast.
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Reply, Send } from "lucide-react";
import { api, errorText, query } from "../../../api";
import { card, input, select } from "../../theme";
import { useAdmin } from "../../context";
import { Btn, Empty, ErrorBox, PageTitle, Pill, useLoad, useToast } from "../../ui";
import { CHANNEL, muted, when, type Broadcast } from "./shared";

type ThreadRow = {
  id: number; broadcast_id: number; user_id: number; display_name: string; broadcast_title: string; last_body: string | null;
  last_message_at: string | null; last_from_admin: boolean; closed_at: string | null; unanswered: boolean;
};
type Thread = {
  id: number; closed_at: string | null; user: { id: number; display_name: string }; notify_by: string;
  broadcast: { id: number; title: string; body: string; sent_at: string | null; created_at: string };
  messages: { id: number; author_name: string | null; from_admin: boolean; body: string; created_at: string }[];
};
type State = "open" | "all" | "closed";

export default function Replies() {
  const say = useToast();
  const { refreshReplies } = useAdmin();
  const [params, setParams] = useSearchParams();
  const broadcast = params.get("broadcast") ?? "";
  const [state, setState] = useState<State>("open");
  const list = useLoad(() => api.get<{ items: ThreadRow[]; unanswered: number }>(
    `/api/admin/messages/replies${query({ state, broadcast })}`), [state, broadcast]);
  const broadcasts = useLoad(() => api.get<{ items: Broadcast[] }>("/api/admin/messages/broadcast/log?limit=50"));
  const [selected, setSelected] = useState<number | null>(null);
  const items = list.data?.items ?? [];
  const current = selected ?? items[0]?.id ?? null;
  const thread = useLoad(() => current ? api.get<Thread>(`/api/admin/messages/replies/${current}`) : Promise.resolve(null), [current]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(""), [current]);

  const answer = async () => {
    if (!current || !draft.trim()) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ channel: string | null }>(`/api/admin/messages/replies/${current}`, { body: draft });
      setDraft("");
      say(r.channel ? `Svaret er sendt i appen og på ${CHANNEL[r.channel]}` : "Svaret er sendt i appen");
      await Promise.all([thread.reload(), list.reload(), refreshReplies()]);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  const close = async () => {
    if (!current) return;
    try {
      await api.post(`/api/admin/messages/replies/${current}/close`);
      say("Tråden er afsluttet. Skriver brugeren igen, åbner den sig.");
      await Promise.all([thread.reload(), list.reload(), refreshReplies()]);
    } catch (e) { setError(errorText(e)); }
  };

  const t = thread.data;
  return (
    <>
      <PageTitle title="Svar" icon={<Reply size={24} strokeWidth={2} />}
        aside={(
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <select aria-label="Udsendelse" value={broadcast} style={{ ...select, minWidth: 220 }}
              onChange={(e) => { setSelected(null); setParams(e.target.value ? { broadcast: e.target.value } : {}); }}>
              <option value="">Alle udsendelser</option>
              {broadcasts.data?.items.filter((b) => b.allow_replies).map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
            </select>
            <select aria-label="Vis" value={state} style={select} onChange={(e) => { setSelected(null); setState(e.target.value as State); }}>
              <option value="open">Åbne</option><option value="closed">Afsluttede</option><option value="all">Alle</option>
            </select>
          </div>
        )}>
        Svar fra brugerne på jeres udsendelser. Hver modtager har sin egen tråd med administrationen; de andre modtagere ser den
        ikke. Brugeren ser jeres svar fra »Administrationen« med navnet på den, der skrev.
      </PageTitle>
      {(error || list.error) && <ErrorBox>{error || list.error}</ErrorBox>}

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "stretch" }}>
        <div style={{ ...card, flex: "1 1 320px", minWidth: 0, overflow: "hidden", alignSelf: "flex-start" }}>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "14px 16px", borderBottom: "1px solid #e2e8f0" }}>
            <strong style={{ fontSize: 13 }}>Tråde</strong>
            <span style={{ ...muted, fontSize: 12 }}>{list.data?.unanswered ?? 0} ubesvarede</span>
          </div>
          {items.length === 0 && !list.loading && <Empty>Ingen svar her.</Empty>}
          {items.map((r) => (
            <button key={r.id} type="button" aria-pressed={r.id === current} onClick={() => setSelected(r.id)} className={r.id === current ? undefined : "tg-row"}
              style={{ display: "flex", flexDirection: "column", gap: 2, width: "100%", textAlign: "left", padding: "12px 16px", border: 0,
                borderBottom: "1px solid #e2e8f0", background: r.id === current ? "#eff6ff" : "#fff", cursor: "pointer", font: "14px var(--hm-font-sans)" }}>
              <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <strong style={{ fontWeight: 600 }}>{r.display_name}</strong>
                <span style={{ ...muted, fontSize: 12 }}>{when(r.last_message_at)}</span>
              </span>
              <span style={{ fontSize: 12, color: "#475569" }}>Re: {r.broadcast_title}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#334155" }}>
                {r.unanswered && <span aria-label="Ubesvaret" style={{ width: 8, height: 8, flex: "none", borderRadius: 9999, background: "#2563eb" }} />}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.last_from_admin ? "Jer: " : ""}{r.last_body}</span>
              </span>
            </button>
          ))}
        </div>

        <section aria-label="Tråd" style={{ ...card, flex: "999 1 520px", minWidth: 0, display: "flex", flexDirection: "column" }}>
          {!t ? <Empty>Vælg en tråd.</Empty> : (
            <>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", padding: "14px 20px", borderBottom: "1px solid #e2e8f0" }}>
                <strong style={{ fontSize: 16 }}>{t.user.display_name}</strong>
                {t.closed_at ? <Pill tone="gray">Afsluttet</Pill> : null}
                <span style={{ ...muted, fontSize: 12 }}>får svar {t.notify_by === "app" ? "i appen" : `i appen og på ${CHANNEL[t.notify_by]}`}</span>
                {!t.closed_at && <Btn kind="ghost" height={30} onClick={close} style={{ marginLeft: "auto" }}>Afslut tråden</Btn>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20, flex: 1 }}>
                <div style={{ padding: "10px 14px", borderRadius: 10, background: "#f8fafc", border: "1px dashed #cbd5e1", display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#64748b" }}>
                    Udsendelse · {when(t.broadcast.sent_at ?? t.broadcast.created_at)}
                  </span>
                  <strong>{t.broadcast.title}</strong>
                  <span style={{ ...muted, whiteSpace: "pre-wrap" }}>{t.broadcast.body}</span>
                </div>
                {t.messages.map((m) => (
                  <div key={m.id} style={{ alignSelf: m.from_admin ? "flex-end" : "flex-start", maxWidth: "75%", display: "flex", flexDirection: "column",
                    gap: 4, alignItems: m.from_admin ? "flex-end" : "flex-start" }}>
                    <span style={{ ...muted, fontSize: 12 }}>
                      {m.from_admin ? `Administrationen${m.author_name ? ` · ${m.author_name}` : ""}` : t.user.display_name} · {when(m.created_at)}
                    </span>
                    <span style={{ padding: "10px 14px", borderRadius: m.from_admin ? "14px 14px 4px 14px" : "14px 14px 14px 4px", lineHeight: 1.45,
                      whiteSpace: "pre-wrap", background: m.from_admin ? "#2563eb" : "#f1f5f9", color: m.from_admin ? "#fff" : "#020817" }}>{m.body}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "16px 20px", borderTop: "1px solid #e2e8f0" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, fontWeight: 500 }}>Svar til {t.user.display_name}
                  <textarea rows={3} value={draft} maxLength={4000} onChange={(e) => setDraft(e.target.value)} placeholder="Skriv et svar"
                    style={{ ...input, height: "auto", padding: "9px 10px", lineHeight: 1.5, resize: "vertical" }} />
                </label>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ ...muted, fontSize: 12, flex: 1, minWidth: 220 }}>
                    Brugeren får svaret i appen, og på SMS eller e-mail efter de samme regler som udsendelser. Aldrig i stilletimerne.
                  </span>
                  <Btn kind="primary" icon={Send} onClick={answer} disabled={busy || !draft.trim()}>Send svar</Btn>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
