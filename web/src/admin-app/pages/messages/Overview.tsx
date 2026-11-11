// /admin/messages → Beskeder: what went out in the last 30 days, how recipients were reached, recent broadcasts and
// what needs attention (unanswered replies, failed SMS, SMS held in quiet hours).
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MessageSquare, Reply, Send, ShieldAlert, Smartphone, Timer } from "lucide-react";
import { api } from "../../../api";
import { card } from "../../theme";
import { Btn, Empty, ErrorBox, PageTitle, Pill, useLoad } from "../../ui";
import { grid, kr, muted, split, Stat, when, type Broadcast } from "./shared";

type Overview = {
  broadcasts: number; scheduled: number; reached: number; sms_segments: number; sms_failed: number; held: number;
  open_replies: number; pending_reports: number; sms_cost_minor: number; split: { push: number; sms: number; mail: number; app_only: number };
  recent: Broadcast[];
};

const BAR: [keyof Overview["split"], string, string][] = [
  ["push", "Push", "#1d4ed8"], ["sms", "SMS", "#f59e0b"], ["mail", "E-mail", "#0d9488"], ["app_only", "Kun i appen", "#cbd5e1"],
];

export default function MessagesOverview() {
  const { data, error } = useLoad(() => api.get<Overview>("/api/admin/messages/overview"));
  const navigate = useNavigate();
  const total = data ? Object.values(data.split).reduce((a, b) => a + b, 0) : 0;
  return (
    <>
      <PageTitle title="Beskeder" icon={<MessageSquare size={24} strokeWidth={2} />}
        aside={<Btn kind="primary" icon={Send} onClick={() => navigate("/messages/send")}>Send besked</Btn>}>
        Beskeder fra jer til brugerne. Alt, der sendes, ligger i appen; SMS og e-mail er kanaler oven på, valgt pr. modtager.
        Brugerne kan svare, og svarene lander under Svar.
      </PageTitle>
      {error && <ErrorBox>{error}</ErrorBox>}
      {data && (
        <>
          <div style={grid}>
            <Stat label="Udsendelser · 30 dage" value={data.broadcasts} note={data.scheduled ? `${data.scheduled} planlagt` : "Ingen planlagt"} />
            <Stat label="Modtagere nået" value={data.reached.toLocaleString("da-DK")} note="i appen, seneste 30 dage" />
            <Stat label="SMS · denne måned" value={data.sms_segments.toLocaleString("da-DK")} note={`segmenter · ca. ${kr(data.sms_cost_minor)}`} />
            <Stat label="Svar venter" value={data.open_replies} tone={data.open_replies ? "warn" : undefined}
              note={data.open_replies ? "ubesvarede tråde" : "Alle er besvaret"} />
          </div>

          <section style={{ ...card, padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Sådan blev modtagerne nået · 30 dage</h2>
              <span style={muted}>Én kanal pr. modtager: SMS hvis de har sagt ja, ellers e-mail, ellers kun i appen</span>
            </div>
            {total === 0 ? <Empty>Intet sendt endnu.</Empty> : (
              <>
                <div role="img" aria-label={BAR.map(([k, l]) => `${l} ${Math.round((data.split[k] / total) * 100)} procent`).join(", ")}
                  style={{ display: "flex", height: 14, borderRadius: 9999, overflow: "hidden", background: "#f1f5f9" }}>
                  {BAR.map(([k, , c], i) => data.split[k] > 0 && (
                    <div key={k} style={{ width: `${(data.split[k] / total) * 100}%`, background: c, borderLeft: i ? "2px solid #fff" : 0 }} />
                  ))}
                </div>
                <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 13 }}>
                  {BAR.map(([k, l, c]) => (
                    <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: c }} />{l}
                      <strong style={{ fontVariantNumeric: "tabular-nums" }}>{Math.round((data.split[k] / total) * 100)} %</strong>
                      <span style={{ color: "#64748b" }}>{data.split[k]}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </section>

          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
            <section style={{ ...card, flex: "999 1 520px", minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #e2e8f0" }}>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Seneste udsendelser</h2>
                <Link to="/messages/delivery" style={{ fontSize: 13 }}>Se levering</Link>
              </div>
              {data.recent.length === 0 && <Empty>Ingen udsendelser endnu.</Empty>}
              {data.recent.map((b, i) => (
                <div key={b.id} style={{ padding: "14px 20px", borderTop: i ? "1px solid #e2e8f0" : 0, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <Pill tone="blue">{b.audience_label} · {b.total}</Pill>
                    {b.urgent && <Pill tone="red">Haster</Pill>}
                    {b.status === "scheduled" && <Pill tone="gray">Planlagt {when(b.send_at)}</Pill>}
                    <span style={{ marginLeft: "auto", ...muted, fontSize: 12 }}>{when(b.sent_at ?? b.created_at)} · {b.actor_name ?? "Slettet admin"}</span>
                  </div>
                  <strong style={{ fontWeight: 600 }}>{b.title}</strong>
                  <p style={{ margin: 0, color: "#334155" }}>{b.body.length > 180 ? b.body.slice(0, 177) + "…" : b.body}</p>
                  <span style={{ ...muted, fontSize: 12 }}>
                    {split(b)} · {b.unread_in_app} ulæst i appen
                    {b.replies > 0 && <> · <Link to={`/messages/replies?broadcast=${b.id}`}>{b.replies} svar</Link></>}
                  </span>
                </div>
              ))}
            </section>
            <section style={{ ...card, flex: "1 1 300px", minWidth: 0 }}>
              <div style={{ padding: "16px 20px", borderBottom: "1px solid #e2e8f0" }}>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Kræver handling</h2>
              </div>
              <Todo to="/messages/replies" icon={<Reply size={16} />} tone="blue" title={`${data.open_replies} svar venter på jer`}
                note="Brugere, der har svaret på en udsendelse" />
              <Todo to="/messages/moderation" icon={<ShieldAlert size={16} />} tone="orange" title={`${data.pending_reports} anmeldte beskeder`}
                note="I Fællessamtalen og direkte samtaler" />
              <Todo to="/messages/delivery?status=failed" icon={<Smartphone size={16} />} tone="red" title={`${data.sms_failed} SMS fejlede`}
                note="Seneste døgn" />
              <Todo to="/messages/delivery?status=held" icon={<Timer size={16} />} tone="gray" title={`${data.held} SMS holdes`}
                note="Sendes, når stilletimerne slutter" last />
            </section>
          </div>
        </>
      )}
    </>
  );
}

const TONES = { orange: ["rgba(249,115,22,0.12)", "#9a3412"], blue: ["rgba(37,99,235,0.1)", "#1d4ed8"], red: ["rgba(220,38,38,0.1)", "#b91c1c"], gray: ["#f1f5f9", "#475569"] } as const;

function Todo({ to, icon, tone, title, note, last }: { to: string; icon: ReactNode; tone: keyof typeof TONES; title: string; note: string; last?: boolean }) {
  return (
    <Link to={to} className="tg-row" style={{ display: "flex", gap: 12, alignItems: "center", padding: "14px 20px", color: "inherit",
      textDecoration: "none", borderBottom: last ? 0 : "1px solid #e2e8f0" }}>
      <span style={{ width: 32, height: 32, flex: "none", borderRadius: 8, background: TONES[tone][0], color: TONES[tone][1],
        display: "flex", alignItems: "center", justifyContent: "center" }}>{icon}</span>
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <strong style={{ fontWeight: 600 }}>{title}</strong><span style={{ ...muted, fontSize: 12 }}>{note}</span>
      </span>
    </Link>
  );
}
