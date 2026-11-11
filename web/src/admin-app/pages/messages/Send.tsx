// /admin/messages/send → Send besked. Pick recipients, write, see "X får SMS (ca. Y kr) · Z får e-mail" before
// sending, then confirm (two steps: the first call returns the estimate and a token that sends once). A broadcast to
// everyone asks for a fresh second factor (the step-up dialog opens by itself).
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Send as SendIcon, X } from "lucide-react";
import { api, errorText, query } from "../../../api";
import { input, label as labelStyle } from "../../theme";
import { Btn, ErrorBox, Modal, PageTitle, useLoad, useToast } from "../../ui";
import type { AdminUser, UsersResponse } from "../../users";
import { kr, muted, people, Section, type Audience, type Channel, type Estimate, type MessageSettings } from "./shared";

type Chip = { audience: Audience; label: string; count: number };
type Proposal = { proposal: { estimate: Estimate }; confirmation_token: string };

const TITLE_MAX = 120;
const BODY_MAX = 1000;
const same = (a: Audience, b: Audience) => JSON.stringify(a) === JSON.stringify(b);

export default function SendMessage() {
  const say = useToast();
  const chips = useLoad(() => api.get<{ items: Chip[]; settings: MessageSettings }>("/api/admin/messages/broadcast/audiences"));
  const [audience, setAudience] = useState<Audience>({ kind: "all" });
  const [picked, setPicked] = useState<AdminUser[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [channels, setChannels] = useState<Channel[]>(["sms", "mail"]);
  const [urgent, setUrgent] = useState(false);
  const [allowReplies, setAllowReplies] = useState(true);
  const [later, setLater] = useState(false);
  const [sendAt, setSendAt] = useState("");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ id: number; scheduled: boolean; est: Estimate } | null>(null);

  const effective: Audience = audience.kind === "users" ? { kind: "users", user_ids: picked.map((u) => u.id) } : audience;
  const settings = chips.data?.settings;

  useEffect(() => {
    if (effective.kind === "users" && effective.user_ids.length === 0) {
      setEstimate(null);
      return;
    }
    let alive = true;
    const id = window.setTimeout(() => {
      api.post<Estimate>("/api/admin/messages/broadcast/estimate", { audience: effective, channels, title, body })
        .then((e) => alive && setEstimate(e), () => alive && setEstimate(null));
    }, 250);
    return () => { alive = false; window.clearTimeout(id); };
  }, [JSON.stringify(effective), channels.join(), title, body]);

  const payload = () => ({
    title, body, audience: effective, channels, urgent, allow_replies: allowReplies,
    send_at: later && sendAt ? new Date(sendAt).toISOString() : null,
  });

  const ask = async () => {
    setBusy(true); setError(null); setSent(null);
    try { setProposal(await api.post<Proposal>("/api/admin/messages/broadcast", payload())); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!proposal) return;
    setBusy(true);
    try {
      const r = await api.post<{ id: number; status: string; estimate: Estimate }>("/api/admin/messages/broadcast",
        { ...payload(), confirmation_token: proposal.confirmation_token });
      setSent({ id: r.id, scheduled: r.status === "scheduled", est: r.estimate });
      setTitle(""); setBody(""); setUrgent(false); setLater(false); setSendAt("");
    } catch (e) { setError(errorText(e)); }
    finally { setProposal(null); setBusy(false); }
  };
  const test = async () => {
    setBusy(true); setError(null);
    try {
      await api.post("/api/admin/messages/broadcast/test", { title, body, channels });
      say("Prøven er sendt til dig. Se den under Beskeder i appen.");
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };

  const toggle = (c: Channel) => setChannels((cs) => cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]);
  const ready = title.trim() && body.trim() && estimate && estimate.total > 0 && (!later || sendAt);
  const est = proposal?.proposal.estimate;

  return (
    <>
      <PageTitle title="Send besked" icon={<SendIcon size={24} strokeWidth={2} />}>
        Vælg modtagere og skriv beskeden. Før den går afsted, ser du hvor mange der får den på SMS og e-mail, og hvad SMS'erne
        koster. Alle får den i appen.
      </PageTitle>
      {error && <ErrorBox>{error}</ErrorBox>}
      {chips.error && <ErrorBox>{chips.error}</ErrorBox>}
      {sent && (
        <div role="status" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", padding: "12px 16px", borderRadius: 12,
          background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534" }}>
          <span style={{ flex: 1, minWidth: 240 }}>
            {sent.scheduled ? "Planlagt til " : "Sendt til "}{people(sent.est.total)}: {sent.est.sms} får SMS og {sent.est.mail} får e-mail.
          </span>
          <Link to={`/messages/delivery?broadcast=${sent.id}`} style={{ color: "#166534", fontWeight: 600 }}>Følg leveringen</Link>
        </div>
      )}

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "999 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
          <Section title="1 · Modtagere">
            <div role="radiogroup" aria-label="Modtagere" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {[...(chips.data?.items ?? []), { audience: { kind: "users", user_ids: [] } as Audience, label: "Udvalgte brugere", count: picked.length }]
                .map((c) => {
                  const on = c.audience.kind === "users" ? audience.kind === "users" : same(c.audience, audience);
                  return (
                    <button key={c.label} type="button" role="radio" aria-checked={on} onClick={() => setAudience(c.audience)}
                      style={{ height: 36, padding: "0 14px", borderRadius: 9999, cursor: "pointer", font: "500 13px var(--hm-font-sans)",
                        border: `1px solid ${on ? "#2563eb" : "#e2e8f0"}`, background: on ? "#2563eb" : "#fff", color: on ? "#fff" : "#020817" }}>
                      {c.label} <span style={{ opacity: on ? 0.8 : 1, color: on ? undefined : "#64748b" }}>{c.count}</span>
                    </button>
                  );
                })}
            </div>
            {audience.kind === "users" && <UserPicker picked={picked} setPicked={setPicked} />}
            <p style={{ ...muted, fontSize: 12, margin: 0 }}>
              Spærrede brugere og testkonti er aldrig med. Ringe kommer fra Features og ringe.
            </p>
          </Section>

          <Section title="2 · Besked">
            <label style={labelStyle}>Overskrift
              <input value={title} maxLength={TITLE_MAX} onChange={(e) => setTitle(e.target.value)} style={input} />
            </label>
            <label style={labelStyle}>Tekst
              <textarea value={body} maxLength={BODY_MAX} rows={5} onChange={(e) => setBody(e.target.value)}
                style={{ ...input, height: "auto", padding: "9px 10px", lineHeight: 1.5, resize: "vertical" }} />
            </label>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", ...muted, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
              <span>{body.length} / {BODY_MAX} tegn</span>
              {estimate && <span>{estimate.segments} SMS-segment{estimate.segments === 1 ? "" : "er"} · {estimate.encoding}</span>}
              {estimate?.encoding === "UCS-2" && <span style={{ color: "#92400e" }}>Teksten har tegn uden for SMS-alfabetet (fx – eller emoji), så hver SMS rummer færre tegn.</span>}
            </div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                <input type="checkbox" checked={later} onChange={(e) => setLater(e.target.checked)} />Planlæg til senere
              </label>
              {later && <input type="datetime-local" aria-label="Tidspunkt" value={sendAt} onChange={(e) => setSendAt(e.target.value)} style={input} />}
              <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />Haster: gå uden om stilletimer
              </label>
              <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                <input type="checkbox" checked={allowReplies} onChange={(e) => setAllowReplies(e.target.checked)} />Modtagerne kan svare
              </label>
            </div>
          </Section>

          <Section title="3 · Kanaler">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
              <ChannelBox label="I appen" note="Altid. Indbakken på /beskeder og /m/beskeder." checked disabled />
              <ChannelBox label="SMS" note={settings?.sms_enabled === false ? "Slået fra under Kanaler og regler." : "Kun til dem, der selv har sagt ja til SMS."}
                checked={channels.includes("sms")} disabled={settings?.sms_enabled === false} onChange={() => toggle("sms")} />
              <ChannelBox label="E-mail" note={settings?.mail_enabled === false ? "Slået fra under Kanaler og regler." : "Til resten, der har en e-mailadresse."}
                checked={channels.includes("mail")} disabled={settings?.mail_enabled === false} onChange={() => toggle("mail")} />
            </div>
          </Section>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", padding: "16px 20px", borderRadius: 16, background: "#0f172a", color: "#fff" }}>
            <span style={{ flex: 1, minWidth: 260, display: "flex", flexDirection: "column", gap: 2 }}>
              {estimate ? (
                <>
                  <strong style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                    {people(estimate.total)} · {estimate.sms} får SMS (ca. {kr(estimate.price_minor)}) · {estimate.mail} får e-mail
                  </strong>
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.75)" }}>
                    {estimate.app_only} kun i appen. {estimate.total === 1 ? "Modtageren får" : `Alle ${estimate.total} får`} beskeden i indbakken.
                  </span>
                </>
              ) : <span style={{ color: "rgba(255,255,255,0.75)" }}>Vælg modtagere for at se overslaget.</span>}
            </span>
            <Btn kind="ghost" onClick={test} disabled={busy || !title.trim() || !body.trim()}
              style={{ color: "#fff", border: "1px solid rgba(255,255,255,0.3)", height: 40 }}>Send prøve til mig</Btn>
            <Btn kind="primary" icon={SendIcon} onClick={ask} disabled={busy || !ready} style={{ height: 40 }}>Send…</Btn>
          </div>
        </div>

        <aside aria-label="Forhåndsvisning" style={{ flex: "1 1 320px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
          <Section title="Forhåndsvisning">
            <span style={{ fontSize: 12, fontWeight: 600, color: "#475569" }}>SMS</span>
            <div style={{ alignSelf: "flex-start", maxWidth: "100%", padding: "10px 12px", borderRadius: "14px 14px 14px 4px", background: "#e2e8f0",
              fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
              {`${title || "Overskrift"}\n${body || "Tekst"}\n\nLæs i appen: …/beskeder/…`}
            </div>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#475569" }}>Indbakken i appen</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: 12, border: "1px solid #e2e8f0", borderRadius: 12 }}>
              <span style={{ ...muted, fontSize: 12 }}>Fra administrationen · nu</span>
              <strong style={{ fontWeight: 600 }}>{title || "Overskrift"}</strong>
              <span style={{ fontSize: 13, color: "#334155", whiteSpace: "pre-wrap" }}>{body || "Tekst"}</span>
              {allowReplies && <span style={{ alignSelf: "flex-start", marginTop: 6, fontSize: 13, padding: "4px 10px", borderRadius: 8, border: "1px solid #e2e8f0" }}>Svar administrationen</span>}
            </div>
          </Section>
          <div style={{ padding: "14px 16px", borderRadius: 12, background: "#eff6ff", border: "1px solid #bfdbfe", color: "#1e3a8a", fontSize: 13, lineHeight: 1.5 }}>
            Afsendelsen sker i to trin: først et overslag og en bekræftelse, der gælder i 10 minutter og kun én gang. Et dobbeltklik kan
            ikke sende to gange. Til alle brugere skal du bekræfte med din passkey.
          </div>
        </aside>
      </div>

      {proposal && est && (
        <Modal width={460} onClose={() => !busy && setProposal(null)}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Send til {est.label}?</h2>
          <p style={{ margin: 0, color: "#475569", lineHeight: 1.5 }}>
            {people(est.total)}. {est.sms} får SMS (ca. {kr(est.price_minor)}) og {est.mail} får e-mail; alle får den i appen.
            {later && sendAt ? ` Den sendes ${new Date(sendAt).toLocaleString("da-DK")}.` : ""} En udsendelse kan ikke trækkes tilbage.
          </p>
          <div style={{ padding: "10px 12px", borderRadius: 8, background: "#f1f5f9", display: "flex", flexDirection: "column", gap: 4 }}>
            <strong>{title}</strong><span style={{ whiteSpace: "pre-wrap", color: "#334155" }}>{body}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Btn kind="ghost" onClick={() => setProposal(null)} disabled={busy}>Annuller</Btn>
            <Btn kind="primary" icon={SendIcon} onClick={confirm} disabled={busy}>{later && sendAt ? "Planlæg" : "Send nu"}</Btn>
          </div>
        </Modal>
      )}
    </>
  );
}

function ChannelBox({ label, note, checked, disabled, onChange }: { label: string; note: string; checked: boolean; disabled?: boolean; onChange?: () => void }) {
  return (
    <label style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: 12, border: "1px solid #e2e8f0", borderRadius: 12,
      background: disabled ? "#f8fafc" : "#fff", cursor: disabled ? "default" : "pointer" }}>
      <input type="checkbox" checked={checked && !(disabled && onChange)} disabled={disabled} onChange={onChange} style={{ marginTop: 2 }} />
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <strong style={{ fontWeight: 600 }}>{label}</strong><span style={{ ...muted, fontSize: 12 }}>{note}</span>
      </span>
    </label>
  );
}

function UserPicker({ picked, setPicked }: { picked: AdminUser[]; setPicked: (u: AdminUser[]) => void }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<AdminUser[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    let alive = true;
    const id = window.setTimeout(() => {
      api.get<UsersResponse>(`/api/admin/users${query({ q, limit: 10 })}`).then((r) => alive && setFound(r.items), () => {});
    }, 250);
    return () => { alive = false; window.clearTimeout(id); };
  }, [q]);
  const ids = useMemo(() => new Set(picked.map((u) => u.id)), [picked]);
  const name = (u: AdminUser) => u.display_name || u.email || u.phone || `#${u.id}`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <label style={labelStyle}>Find brugere
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Navn, e-mail eller telefon" style={{ ...input, maxWidth: 420 }} />
      </label>
      {found.filter((u) => !ids.has(u.id)).length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {found.filter((u) => !ids.has(u.id)).map((u) => (
            <Btn key={u.id} height={30} onClick={() => setPicked([...picked, u])}>+ {name(u)}</Btn>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {picked.map((u) => (
          <span key={u.id} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600, padding: "4px 6px 4px 10px",
            borderRadius: 9999, background: "#f1f5f9" }}>
            {name(u)}
            <button type="button" aria-label={`Fjern ${name(u)}`} onClick={() => setPicked(picked.filter((x) => x.id !== u.id))}
              style={{ border: 0, background: "transparent", cursor: "pointer", padding: 2, display: "flex", color: "#475569" }}><X size={12} /></button>
          </span>
        ))}
      </div>
    </div>
  );
}
