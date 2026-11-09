// /admin/adoption/journeys/:id (+ /setup): the selected journey with the tabs Dashboard and Opsætning.
// Dashboard: goal ring with forecast, weekly development, KPIs, funnel with drop-off and exit routes, live hits, cohort
// retention, breakdown by role / surface / language, insights and "Sidder fast" with nudges.
import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { api, errorText } from "../../../api";
import { Btn, ErrorBox, Loading, useLoad, useToast } from "../../ui";
import { card, fmt, MONO, SANS } from "../../theme";
import { Bar, Code, decimal, Empty, Kpi, Panel, periodLabel, Seg, useAdoption, initials, type Journey } from "./shared";
import JourneySetup from "./Setup";

type Funnel = { label: string; pattern: string; reached: number; pct: number; drop: number | null; drop_pct: number | null;
  median_days_to_next: number | null; exits: string[] };
type Dashboard = {
  cohort_size: number; reached_last: number; done_pct: number; goal_pct: number;
  series: { week: string; pct: number }[]; forecast: { week: string; pct: number }[];
  rate_per_week: number; forecast_date: string | null; track: "reached" | "on-track" | "behind";
  kpis: { active_now: number; new_today: number; median_days_to_goal: number | null; stuck: number };
  funnel: Funnel[]; cohorts: { week: string; users: number; cells: (number | null)[] }[];
  breakdown: { dim: Dim; available: boolean; rows: { key: string; users: number; pct: number; delta_pt: number; stuck_at: string | null }[] };
  insights: { tone: "bad" | "warn" | "good"; title: string; text: string }[];
  stuck_total: number; stuck_users: { user_id: number; name: string; detail: string; nudged_at: string | null }[];
  live_hits: { id: number; at: string; path: string; user: string | null; step: number }[];
  nudge_webhooks: number; can_edit: boolean;
};
type Dim = "role" | "surface" | "locale";

const TRACK = {
  reached: ["Mål nået", "#dcfce7", "#166534"],
  "on-track": ["På sporet", "#dbeafe", "#1e40af"],
  behind: ["Bagud", "#fef3c7", "#92400e"],
} as const;
const TONE = { bad: "#ef4444", warn: "#f59e0b", good: "#16a34a" } as const;
const DIMS: { value: Dim; label: string }[] = [{ value: "role", label: "Rolle" }, { value: "surface", label: "Flade" }, { value: "locale", label: "Sprog" }];

/** /admin/adoption/journeys: opens the selected journey, or says there is none yet. */
export function AdoptionJourneys() {
  const { journeys, selectedId } = useAdoption();
  if (!journeys) return <Loading />;
  if (!journeys.length) return <Empty>Der er ingen forløb, du har adgang til. Opret et fra forløbsvælgeren i toppen.</Empty>;
  return <Navigate to={`/adoption/journeys/${selectedId ?? journeys[0]!.id}`} replace />;
}

export default function AdoptionJourney({ setup = false }: { setup?: boolean }) {
  const id = Number(useParams().id);
  const { journeys, select } = useAdoption();
  const navigate = useNavigate();
  useEffect(() => { if (id) select(id); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!journeys) return <Loading />;
  const journey = journeys.find((j) => j.id === id);
  if (!journey) return <Empty>Forløbet findes ikke, eller du har ikke adgang til det.</Empty>;
  if (setup && !journey.can_edit && !journey.can_manage) return <Navigate to={`/adoption/journeys/${id}`} replace />;

  const tabs = [{ label: "Dashboard", on: !setup, to: `/adoption/journeys/${id}` },
    ...(journey.can_edit ? [{ label: "Opsætning", on: setup, to: `/adoption/journeys/${id}/setup` }] : [])];
  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 4, borderBottom: "1px solid #e2e8f0" }}>
        {tabs.map((t) => (
          <button key={t.label} type="button" onClick={() => navigate(t.to)} aria-current={t.on ? "page" : undefined}
            style={{ marginBottom: -1, padding: "10px 14px", border: 0, borderBottom: `2px solid ${t.on ? "#2563eb" : "transparent"}`, background: "transparent",
              cursor: "pointer", font: `${t.on ? 600 : 400} 14px ${SANS}`, color: t.on ? "#020817" : "#64748b" }}>
            {t.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <span style={{ padding: "10px 0", fontSize: 12, color: "#64748b" }}>
          {journey.audience_text} · {periodLabel(journey.start_at, journey.end_at)} · {fmt(journey.cohort_size)} i målgruppen
        </span>
      </div>
      {setup ? <JourneySetup key={journey.id} journey={journey} /> : <JourneyDashboard journey={journey} />}
    </>
  );
}

const RING_R = 54;
const RING_C = 2 * Math.PI * RING_R;

function JourneyDashboard({ journey }: { journey: Journey }) {
  const [dim, setDim] = useState<Dim>("role");
  const { data: d, error, reload } = useLoad(() => api.get<Dashboard>(`/api/admin/adoption/journeys/${journey.id}/dashboard?dim=${dim}`),
    [journey.id, dim, journey.steps.length]);
  const say = useToast();
  const [sending, setSending] = useState(false);

  if (journey.steps.length === 0) {
    return (
      <Empty>
        Forløbet har ingen målepunkter endnu.{" "}
        {journey.can_edit && <Link to={`/adoption/journeys/${journey.id}/setup`}>Gå til Opsætning og tilføj det første trin.</Link>}
      </Empty>
    );
  }
  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!d) return <Loading />;

  const nudge = async (ids: number[]) => {
    setSending(true);
    try {
      const r = await api.post<{ sent: number; webhooks: number }>(`/api/admin/adoption/journeys/${journey.id}/nudges`, { user_ids: ids });
      say(r.webhooks ? `Skub sendt til ${r.sent} ${r.sent === 1 ? "bruger" : "brugere"}` : `Skub registreret for ${r.sent} — ingen webhook modtager det endnu`);
      await reload();
    } catch (e) {
      say(errorText(e));
    } finally {
      setSending(false);
    }
  };

  const [trackLabel, trackBg, trackFg] = TRACK[d.track];
  const goalPos = (d.goal_pct / 100) * RING_C;
  const points = [...d.series, ...d.forecast.slice(1)];
  const N = Math.max(1, points.length - 1);
  const maxY = Math.max(d.goal_pct, ...d.forecast.map((f) => f.pct), ...d.series.map((s) => s.pct), 10) * 1.15;
  const X = (i: number) => ((i / N) * 300).toFixed(1);
  const Y = (v: number) => (120 - (v / maxY) * 112).toFixed(1);
  const line = d.series.map((s, i) => `${X(i)},${Y(s.pct)}`).join(" ");
  const lastX = X(Math.max(0, d.series.length - 1));
  const fcLine = d.forecast.map((f, i) => `${X(d.series.length - 1 + i)},${Y(f.pct)}`).join(" ");
  const open = d.stuck_users.filter((u) => !u.nudged_at).map((u) => u.user_id);
  const forecastText = d.track === "reached"
    ? `Målet er nået — ${d.done_pct - d.goal_pct} pt over`
    : d.forecast_date ? `Når målet omkring ${new Date(d.forecast_date).toLocaleDateString("da-DK", { day: "numeric", month: "short" })}`
      : "Ingen prognose endnu — for lidt fremdrift";

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))", gap: 16 }}>
        <section style={{ ...card, borderColor: "rgba(37,99,235,0.2)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 22, padding: 22 }}>
          <div style={{ position: "relative", width: 140, height: 140, flex: "none" }}>
            <svg viewBox="0 0 140 140" style={{ width: 140, height: 140, transform: "rotate(-90deg)" }} aria-hidden="true">
              <circle cx="70" cy="70" r={RING_R} fill="none" stroke="#f1f5f9" strokeWidth={14} />
              <circle cx="70" cy="70" r={RING_R} fill="none" stroke="#2563eb" strokeWidth={14} strokeLinecap="round"
                strokeDasharray={`${((d.done_pct / 100) * RING_C).toFixed(1)} 999`} />
              <circle cx="70" cy="70" r={RING_R} fill="none" stroke="#0f172a" strokeWidth={16}
                strokeDasharray={`3 ${(RING_C - 3).toFixed(1)}`} strokeDashoffset={(-(goalPos - 1.5)).toFixed(1)} />
            </svg>
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
              <b style={{ fontSize: 26, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{d.done_pct} %</b>
              <span style={{ fontSize: 11, color: "#64748b" }}>gennemført</span>
            </div>
          </div>
          <div style={{ flex: "1 1 160px", display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ alignSelf: "flex-start", padding: "2px 8px", borderRadius: 9999, fontSize: 11, fontWeight: 600, background: trackBg, color: trackFg }}>{trackLabel}</span>
            <b style={{ fontSize: 16, lineHeight: 1.35 }}>{forecastText}</b>
            <span style={{ fontSize: 13, color: "#64748b" }}>
              Mål {d.goal_pct} % · {fmt(d.reached_last)} af {fmt(d.cohort_size)} har nået sidste trin. Tempo {decimal(d.rate_per_week)} pt pr. uge.
            </span>
          </div>
        </section>

        <Panel title="Udvikling" sub="Andel der har gennemført, pr. uge siden start" action={
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 12, color: "#64748b" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}><i style={{ width: 14, height: 3, borderRadius: 2, background: "#2563eb" }} />Faktisk</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}><i style={{ width: 14, borderTop: "2px dashed #93c5fd" }} />Prognose</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}><i style={{ width: 14, borderTop: "2px dashed #0f172a" }} />Mål</span>
          </div>
        }>
          <svg viewBox="0 0 300 120" preserveAspectRatio="none" style={{ width: "100%", height: 170, overflow: "visible" }} role="img"
            aria-label={`Gennemført pr. uge: nu ${d.done_pct} %, mål ${d.goal_pct} %`}>
            <line x1="0" x2="300" y1={Y(d.goal_pct)} y2={Y(d.goal_pct)} stroke="#0f172a" strokeWidth={1.2} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
            <polygon points={`0,120 ${line} ${lastX},120`} fill="#2563eb" opacity={0.12} />
            <polyline points={line} fill="none" stroke="#2563eb" strokeWidth={2.4} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            <polyline points={fcLine} fill="none" stroke="#93c5fd" strokeWidth={2.4} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
          </svg>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b" }}>
            {points.filter((_, i) => i % 2 === 0).map((p, i) => <span key={`${p.week}-${i}`}>{p.week}</span>)}
          </div>
        </Panel>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
        <Kpi label="Aktive nu" dot="#22c55e" value={fmt(d.kpis.active_now)} sub="sidste 15 minutter" />
        <Kpi label="Nye i dag" dot="#2563eb" value={fmt(d.kpis.new_today)} sub="første besøg på trin 1" />
        <Kpi label="Median tid til mål" dot="#0d9488" value={d.kpis.median_days_to_goal === null ? "—" : `${decimal(d.kpis.median_days_to_goal)} d`}
          sub="fra første til sidste trin" />
        <Kpi label="Sidder fast" dot="#f59e0b" value={fmt(d.kpis.stuck)} sub="ingen fremdrift i 7+ dage" />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 16 }}>
        <Panel title="Tragt" sub="Hvor mange når hvert trin — og hvor de andre går hen i stedet" style={{ flex: "2 1 520px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {d.funnel.map((f, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0,180px) minmax(0,1fr) 54px", alignItems: "center", gap: 14 }}>
                  <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                    <b style={{ fontSize: 13, fontWeight: 600 }}>{i + 1}. {f.label}</b>
                    <Code style={{ fontSize: 11, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.pattern}</Code>
                  </span>
                  <span style={{ position: "relative", height: 30, borderRadius: 8, background: "#f1f5f9", overflow: "hidden" }}>
                    <span style={{ display: "block", height: "100%", width: `${Math.max(3, f.pct)}%`, borderRadius: 8, background: "#2563eb", transition: "width .6s" }} />
                    <b style={{ position: "absolute", inset: "0 auto 0 10px", display: "flex", alignItems: "center", fontSize: 12,
                      color: f.pct > 12 ? "#ffffff" : "#020817", fontVariantNumeric: "tabular-nums" }}>{fmt(f.reached)}</b>
                  </span>
                  <b style={{ textAlign: "right", fontSize: 14, fontVariantNumeric: "tabular-nums" }}>{f.pct} %</b>
                </div>
                {f.drop !== null && (
                  <div style={{ display: "grid", gridTemplateColumns: "minmax(0,180px) minmax(0,1fr)", gap: 14, padding: "2px 0 8px" }}>
                    <span />
                    <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, fontSize: 12, color: "#64748b" }}>
                      <b style={{ fontWeight: 600, color: (f.drop_pct ?? 0) > 50 ? "#dc2626" : "#020817" }}>↓ −{fmt(f.drop)} faldt fra ({f.drop_pct} %)</b>
                      {f.median_days_to_next !== null && <span>· median {decimal(f.median_days_to_next)} d til næste trin</span>}
                      {f.exits.length > 0 && <span>· gik i stedet til</span>}
                      {f.exits.map((e) => (
                        <code key={e} style={{ padding: "1px 6px", borderRadius: 9999, background: "#f1f5f9", fontFamily: MONO, fontSize: 11, color: "#020817" }}>{e}</code>
                      ))}
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Panel>
        <Panel dark title="Live i forløbet" style={{ flex: "1 1 300px" }}
          action={<span style={{ fontSize: 12, color: "#86efac" }}>{fmt(d.kpis.active_now)} aktive nu</span>}>
          <div style={{ display: "flex", flexDirection: "column", gap: 9, fontFamily: MONO, fontSize: 12 }}>
            {d.live_hits.length === 0 && <span style={{ color: "#94a3b8" }}>Ingen målepunkter det seneste døgn.</span>}
            {d.live_hits.map((h) => (
              <div key={h.id} style={{ display: "flex", flexDirection: "column", gap: 1, paddingLeft: 10, borderLeft: "2px solid #2563eb" }}>
                <span style={{ color: "#94a3b8" }}>{new Date(h.at).toLocaleTimeString("da-DK")} · {h.user ?? "—"}</span>
                <span style={{ color: "#86efac" }}>✓ trin {h.step} · <span style={{ color: "#e2e8f0" }}>{h.path}</span></span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", alignItems: "start", gap: 16 }}>
        <Panel title="Fastholdelse pr. kohorte" sub="Andel der stadig besøger forløbets ruter, uger efter første besøg">
          <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
            <div style={{ display: "grid", gridTemplateColumns: "64px repeat(7, minmax(0,1fr))", gap: 3, color: "#64748b", textAlign: "center" }}>
              <span />{Array.from({ length: 7 }, (_, i) => <span key={i}>U+{i}</span>)}
            </div>
            {d.cohorts.map((row) => (
              <div key={row.week} style={{ display: "grid", gridTemplateColumns: "64px repeat(7, minmax(0,1fr))", gap: 3 }}>
                <span style={{ display: "flex", flexDirection: "column", justifyContent: "center", lineHeight: 1.2, color: "#64748b" }}>
                  {row.week}<span style={{ fontSize: 10 }}>{fmt(row.users)} brugere</span>
                </span>
                {row.cells.map((v, c) => v === null ? <span key={c} /> : (
                  <span key={c} title={`${row.week}, uge +${c}: ${v} %`} style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 32,
                    borderRadius: 6, fontWeight: 600, background: `rgba(37,99,235,${(0.06 + (v / 100) * 0.84).toFixed(2)})`,
                    color: v >= 88 ? "#ffffff" : "#172554" }}>
                    {row.users ? v : ""}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </Panel>
        <Panel title={`Pr. ${DIMS.find((x) => x.value === dim)!.label.toLowerCase()}`} sub="Gennemført i hver gruppe i forhold til hele målgruppen"
          action={<Seg<Dim> label="Opdeling" value={dim} onChange={setDim} options={DIMS} />}>
          {!d.breakdown.available && <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>Ingen data til opdelingen endnu.</p>}
          {d.breakdown.rows.map((r) => (
            <div key={r.key} style={{ display: "grid", gridTemplateColumns: "minmax(0,1.2fr) minmax(0,1fr) 44px 52px", alignItems: "center", gap: 12, padding: "4px 0", fontSize: 13 }}>
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontWeight: 500 }}>{r.key}</span>
                <span style={{ fontSize: 11, color: "#64748b" }}>{fmt(r.users)} brugere{r.stuck_at ? ` · stopper oftest ved »${r.stuck_at}«` : ""}</span>
              </span>
              <Bar value={r.pct} fill="#0d9488" />
              <b style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.pct} %</b>
              <span style={{ textAlign: "right", fontSize: 12, fontWeight: 600, color: r.delta_pt >= 0 ? "#16a34a" : "#dc2626", fontVariantNumeric: "tabular-nums" }}>
                {r.delta_pt >= 0 ? "+" : "−"}{Math.abs(r.delta_pt)} pt
              </span>
            </div>
          ))}
        </Panel>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", alignItems: "start", gap: 16 }}>
        <section style={{ ...card, borderColor: "rgba(37,99,235,0.2)", display: "flex", flexDirection: "column", gap: 12, padding: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 32, height: 32, borderRadius: 10, background: "rgba(37,99,235,0.1)", color: "#2563eb", display: "flex",
              alignItems: "center", justifyContent: "center" }}><Sparkles size={18} /></span>
            <div>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Indsigt</h3>
              <p style={{ margin: "2px 0 0", fontSize: 13, color: "#64748b" }}>Det dashboardet lægger mærke til lige nu</p>
            </div>
          </div>
          {d.insights.length === 0 && <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>Ingen data i perioden endnu.</p>}
          {d.insights.map((i) => (
            <div key={i.title} style={{ display: "flex", gap: 12, padding: "12px 14px", borderRadius: 12, background: "#f8fafc" }}>
              <span style={{ flex: "none", width: 6, borderRadius: 9999, background: TONE[i.tone] }} />
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <b style={{ fontSize: 13 }}>{i.title}</b>
                <span style={{ fontSize: 13, color: "#64748b", textWrap: "pretty" }}>{i.text}</span>
              </div>
            </div>
          ))}
        </section>
        <Panel title="Sidder fast" sub="Ingen fremdrift i over 7 dage — send et skub"
          action={d.can_edit && <Btn height={32} disabled={open.length === 0 || sending} onClick={() => nudge(open)}>Skub alle</Btn>}>
          {d.can_edit && d.nudge_webhooks === 0 && (
            <p style={{ margin: 0, fontSize: 12, color: "#92400e" }}>
              Skub sendes som webhook-hændelsen <code style={{ fontFamily: MONO }}>adoption.nudge.sent</code>, men ingen webhook modtager den endnu.{" "}
              <a href="/admin/webhooks">Opret en under Webhooks.</a>
            </p>
          )}
          <div style={{ display: "flex", flexDirection: "column" }}>
            {d.stuck_users.length === 0 && <p style={{ margin: 0, padding: "12px 0", borderTop: "1px solid #e2e8f0", fontSize: 13, color: "#64748b" }}>Ingen sidder fast lige nu.</p>}
            {d.stuck_users.map((u) => (
              <div key={u.user_id} style={{ display: "grid", gridTemplateColumns: "32px minmax(0,1fr) auto", alignItems: "center", gap: 12, padding: "8px 0", borderTop: "1px solid #e2e8f0" }}>
                <span style={{ width: 32, height: 32, borderRadius: 9999, background: "#f1f5f9", display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 12, fontWeight: 600 }}>{initials(u.name)}</span>
                <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <b style={{ fontSize: 13, fontWeight: 500 }}>{u.name}</b>
                  <span style={{ fontSize: 12, color: "#64748b" }}>{u.detail}</span>
                </span>
                {d.can_edit && (
                  <button type="button" disabled={!!u.nudged_at || sending} onClick={() => nudge([u.user_id])}
                    style={{ padding: "5px 10px", borderRadius: 9999, font: `500 12px ${SANS}`, cursor: u.nudged_at ? "default" : "pointer",
                      border: `1px solid ${u.nudged_at ? "#bbf7d0" : "#e2e8f0"}`, background: u.nudged_at ? "#dcfce7" : "#ffffff",
                      color: u.nudged_at ? "#166534" : "#020817" }}>
                    {u.nudged_at ? "Sendt ✓" : "Send skub"}
                  </button>
                )}
              </div>
            ))}
            {d.stuck_total > d.stuck_users.length && (
              <span style={{ paddingTop: 8, borderTop: "1px solid #e2e8f0", fontSize: 12, color: "#64748b" }}>+ {fmt(d.stuck_total - d.stuck_users.length)} flere</span>
            )}
          </div>
        </Panel>
      </div>
    </>
  );
}
