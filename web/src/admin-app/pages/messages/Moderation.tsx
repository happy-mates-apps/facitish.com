// /admin/messages/moderation → Moderering. Messages users reported in conversations between users: dismiss the reports,
// or remove the message (users then see only that it was removed; the text stays for the audit trail). The three
// messages before a reported one can be shown while a report is open — each look is audited. Blocks are shown as
// counts per user, never who blocked whom.
import { useState } from "react";
import { Link } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { api, errorText } from "../../../api";
import { card } from "../../theme";
import { useAdmin } from "../../context";
import { Btn, Empty, ErrorBox, PageTitle, Pill, useLoad, useToast } from "../../ui";
import { muted, Section, when } from "./shared";

type Report = { id: number; reporter: string; reason: string; reason_label: string; details: string; status: string; created_at: string };
type Item = {
  message_id: number; body: string; message_at: string; removed: boolean; author_id: number | null; author_name: string;
  where: string; reports: Report[]; first_at: string; reviewed_at: string | null;
};
type Ctx = { id: number; author_name: string; body: string | null; removed: boolean; created_at: string };
type BlockRow = { id: number; display_name: string; blocked_by: number; reported: number; latest: string };
type Status = "pending" | "removed" | "dismissed";
const STATUS: [Status, string][] = [["pending", "Åbne"], ["removed", "Fjernede"], ["dismissed", "Afviste"]];

export default function Moderation() {
  const [tab, setTab] = useState<"reports" | "blocks">("reports");
  const [status, setStatus] = useState<Status>("pending");
  const list = useLoad(() => api.get<{ items: Item[]; pending: number }>(`/api/admin/messages/moderation/reports?status=${status}`), [status]);
  const blocks = useLoad(() => tab === "blocks" ? api.get<{ items: BlockRow[] }>("/api/admin/messages/moderation/blocks") : Promise.resolve(null), [tab]);
  const pending = list.data?.pending ?? 0;
  const tabStyle = (on: boolean) => ({ border: 0, padding: "6px 12px", borderRadius: 6, cursor: "pointer",
    font: `${on ? 600 : 500} 13px var(--hm-font-sans)`, background: on ? "#fff" : "transparent", color: on ? "#020817" : "#475569",
    boxShadow: on ? "0 1px 2px rgba(0,0,0,0.08)" : "none" });

  return (
    <>
      <PageTitle title="Moderering" icon={<ShieldAlert size={24} strokeWidth={2} />}>
        Beskeder, som brugere har anmeldt i Fællessamtalen og direkte samtaler. Du ser den anmeldte besked og, mens anmeldelsen er
        åben, de tre beskeder før den; aldrig resten af samtalen. En fjernet besked står som fjernet hos brugerne; teksten gemmes til
        audit-loggen.
      </PageTitle>
      <div role="tablist" aria-label="Moderering" style={{ display: "flex", gap: 2, padding: 2, borderRadius: 8, background: "#e2e8f0", alignSelf: "flex-start" }}>
        <button type="button" role="tab" aria-selected={tab === "reports"} onClick={() => setTab("reports")} style={tabStyle(tab === "reports")}>
          Anmeldelser{pending ? ` · ${pending}` : ""}</button>
        <button type="button" role="tab" aria-selected={tab === "blocks"} onClick={() => setTab("blocks")} style={tabStyle(tab === "blocks")}>Blokeringer</button>
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "999 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          {tab === "reports" && (
            <>
              <div style={{ display: "flex", gap: 6 }}>
                {STATUS.map(([s, l]) => <Btn key={s} kind={status === s ? "dark" : "outline"} height={30} onClick={() => setStatus(s)}
                  style={status === s ? { background: "#0f172a" } : undefined}>{l}</Btn>)}
              </div>
              {list.error && <ErrorBox>{list.error}</ErrorBox>}
              {list.data?.items.length === 0 && <div style={card}><Empty>{status === "pending" ? "Ingen åbne anmeldelser." : "Ingen her."}</Empty></div>}
              {list.data?.items.map((it) => <ReportCard key={it.message_id} item={it} open={status === "pending"} onDone={list.reload} />)}
            </>
          )}
          {tab === "blocks" && (
            <div style={{ ...card, overflowX: "auto" }}>
              {blocks.error && <ErrorBox>{blocks.error}</ErrorBox>}
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead><tr style={{ textAlign: "left", fontSize: 11, letterSpacing: "0.05em", textTransform: "uppercase", color: "#64748b" }}>
                  <th style={{ padding: "10px 20px" }}>Bruger</th><th style={{ padding: 10 }}>Blokeret af</th><th style={{ padding: 10 }}>Anmeldt</th>
                  <th style={{ padding: 10 }}>Seneste</th><th style={{ padding: "10px 20px" }}><span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Handling</span></th>
                </tr></thead>
                <tbody>
                  {blocks.data?.items.map((b) => (
                    <tr key={b.id} style={{ borderTop: "1px solid #e2e8f0" }}>
                      <td style={{ padding: "12px 20px", fontWeight: 600 }}>{b.display_name}</td>
                      <td style={{ padding: 10 }}>{b.blocked_by} {b.blocked_by === 1 ? "bruger" : "brugere"}</td>
                      <td style={{ padding: 10 }}>{b.reported} {b.reported === 1 ? "gang" : "gange"}</td>
                      <td style={{ padding: 10, color: "#64748b" }}>{when(b.latest)}</td>
                      <td style={{ padding: "12px 20px", textAlign: "right" }}><Link to={`/users?q=${encodeURIComponent(b.display_name)}`}>Åbn bruger</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {blocks.data?.items.length === 0 && <Empty>Ingen har blokeret nogen.</Empty>}
              <p style={{ ...muted, fontSize: 12, margin: 0, padding: "12px 20px", borderTop: "1px solid #e2e8f0" }}>
                Du ser hvor mange der har blokeret en bruger, ikke hvem. Brugerne styrer selv deres blokeringer. Spær en bruger under Brugere og roller.
              </p>
            </div>
          )}
        </div>

        <aside style={{ flex: "1 1 300px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
          <Section title="Ordfilter">
            <p style={{ margin: 0, fontSize: 13, color: "#475569", lineHeight: 1.5 }}>
              Beskeder med ord fra listen bliver ikke sendt; afsenderen får at vide hvorfor. Listen gælder samtaler, svar og udsendelser.
            </p>
            <Link to="/messages/settings" style={{ fontSize: 13 }}>Ret listen under Kanaler og regler</Link>
          </Section>
          <Section title="Hvem må moderere">
            <p style={{ margin: 0, fontSize: 13, color: "#475569", lineHeight: 1.5 }}>
              Admins med rollen Support, Privatliv eller Fuld adgang. Hver afgørelse og hvert kig på konteksten står i audit-loggen og
              sendes som webhook <code style={{ fontSize: 12 }}>message.report.reviewed</code>.
            </p>
          </Section>
        </aside>
      </div>
    </>
  );
}

function ReportCard({ item, open, onDone }: { item: Item; open: boolean; onDone: () => Promise<void> }) {
  const say = useToast();
  const { refreshReports } = useAdmin();
  const [ctx, setCtx] = useState<Ctx[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasons = [...new Set(item.reports.map((r) => r.reason_label))];

  const showContext = async () => {
    setError(null);
    try { setCtx((await api.get<{ items: Ctx[] }>(`/api/admin/messages/moderation/reports/${item.message_id}/context`)).items); }
    catch (e) { setError(errorText(e)); }
  };
  const decide = async (action: "dismiss" | "remove") => {
    setBusy(true); setError(null);
    try {
      await api.post(`/api/admin/messages/moderation/reports/${item.message_id}`, { action });
      say(action === "remove" ? "Beskeden er fjernet" : "Anmeldelsen er afvist; beskeden bliver stående");
      await Promise.all([onDone(), refreshReports()]);
    } catch (e) { setError(errorText(e)); setBusy(false); }
  };

  return (
    <article style={{ ...card, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {reasons.map((r) => <Pill key={r} tone="red">{r}</Pill>)}
        <span style={{ ...muted, fontSize: 12 }}>{item.where}</span>
        {item.removed && <Pill tone="green">Fjernet</Pill>}
        <span style={{ marginLeft: "auto", ...muted, fontSize: 12 }}>{when(item.first_at)}</span>
      </div>
      {ctx && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px", borderRadius: 8, background: "#f8fafc", border: "1px dashed #cbd5e1" }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#64748b" }}>De tre beskeder før</span>
          {ctx.length === 0 && <span style={muted}>Ingen. Den anmeldte besked er den første i samtalen.</span>}
          {ctx.map((m) => (
            <div key={m.id} style={{ fontSize: 13 }}>
              <strong style={{ fontWeight: 600 }}>{m.author_name}</strong> <span style={{ ...muted, fontSize: 12 }}>{when(m.created_at)}</span>
              <div style={{ color: m.removed ? "#64748b" : "#334155", fontStyle: m.removed ? "italic" : "normal" }}>{m.removed ? "Fjernet af en moderator." : m.body}</div>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <strong style={{ fontWeight: 600 }}>{item.author_name} <span style={{ ...muted, fontWeight: 400, fontSize: 12 }}>{when(item.message_at)}</span></strong>
        <p style={{ margin: 0, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{item.body}</p>
      </div>
      <div style={{ padding: "10px 12px", borderRadius: 8, background: "#f8fafc", fontSize: 13, color: "#334155", display: "flex", flexDirection: "column", gap: 4 }}>
        {item.reports.map((r) => (
          <span key={r.id}>Anmeldt af <strong style={{ fontWeight: 600 }}>{r.reporter}</strong> · {r.reason_label}{r.details ? `: »${r.details}«` : ""}</span>
        ))}
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      {open && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {!ctx && <Btn kind="ghost" onClick={showContext} style={{ color: "#2563eb" }}>Vis 3 beskeder før</Btn>}
          <span style={{ flex: 1 }} />
          <Btn onClick={() => decide("dismiss")} disabled={busy}>Afvis anmeldelse</Btn>
          <Btn onClick={() => decide("remove")} disabled={busy} style={{ border: "1px solid #fecaca", color: "#b91c1c", fontWeight: 600 }}>Fjern besked</Btn>
        </div>
      )}
    </article>
  );
}
