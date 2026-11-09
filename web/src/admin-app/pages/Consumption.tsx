// /admin/consumption → AI-forbrug. Tabs Overblik · Budgetter · Priser (?tab=). Overblik: tokens, requests and estimated
// price per period (today, 7 days, 30 days, 12 months or a chosen period), per model, per surface, per weekday/hour
// and per user against what applies to them this month. Budgetter: a cap per user per month with warning levels,
// hard or soft, an optional total for the period and a start and end date (or none). Priser: price per model, only
// used for the estimate. Server: server/app/routes/consumption.py, app/consumption.py.
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, Gauge, Plus } from "lucide-react";
import { api, errorText, query } from "../../api";
import { card, dateLabel, fmt, initials, input, label as labelStyle, MONO, sectionLabel, select, type Tone } from "../theme";
import { Btn, CloseBtn, Drawer, Empty, ErrorBox, PageTitle, Pill, useLoad, useToast } from "../ui";

type Range = "day" | "week" | "month" | "year" | "custom";
type Status = "ok" | "warning" | "over" | "blocked" | "off";
type Policy = {
  source: "budget" | "user" | "default"; limit: number; warn_pcts: number[]; hard: boolean; used: number; pct: number | null;
  warning: number | null; status: Status; blocked: string | null;
  budget: { id: number; starts_on: string; ends_on: string | null; total_tokens: number | null; total_used: number | null } | null;
};
type UserRow = {
  id: number; display_name: string | null; email: string | null; phone: string | null; requests: number; tokens: number;
  cost: number; top_model: string | null; last_used: string | null; policy: Policy;
};
type Report = {
  enabled: boolean; model: string; defaults: { monthly_tokens: number; warn_pct: number; warning_mail: boolean };
  period: { range: Range; start: string; end: string; bucket: "hour" | "day" | "month" };
  totals: { requests: number; prompt_tokens: number; completion_tokens: number; users: number; estimated: number; cost: number };
  previous: { requests: number; tokens: number; cost: number };
  series: { start: string; models: Record<string, number>; tokens: number }[];
  models: { model: string; requests: number; prompt_tokens: number; completion_tokens: number; users: number; cost: number; priced: boolean; last_used: string }[];
  surfaces: { surface: string; requests: number; tokens: number }[];
  heat: { dow: number; hour: number; tokens: number }[];
  users: UserRow[];
  alerts: Record<string, number>;
  month_status: { warning: number; over: number; blocked: number };
};
type Budget = {
  id: number; user_id: number; display_name: string | null; email: string | null; phone: string | null; monthly_tokens: number;
  warn_pcts: number[]; hard: boolean; total_tokens: number | null; starts_on: string; ends_on: string | null; note: string;
  status: "planned" | "active" | "expired"; current: boolean; month_used: number; total_used: number | null;
  user_status: Status | null; created_by_name: string | null; updated_at: string;
};
type Price = { model: string; input_per_million: number; output_per_million: number; priced: boolean; last_used: string | null; requests: number };
type AdminUser = { id: number; display_name: string | null; email: string | null; phone: string | null };

const TABS = [["overview", "Overblik"], ["budgets", "Budgetter"], ["prices", "Priser pr. model"]] as const;
type Tab = (typeof TABS)[number][0];
const RANGES: [Range, string][] = [["day", "I dag"], ["week", "7 dage"], ["month", "30 dage"], ["year", "12 måneder"], ["custom", "Periode"]];
const PREV: Record<Range, string> = { day: "i går", week: "forrige 7 dage", month: "forrige 30 dage", year: "forrige 12 måneder", custom: "forrige periode" };
const COLORS = ["#2563eb", "#0d9488", "#f59e0b", "#7c3aed", "#e11d48", "#64748b"];
const SURFACE: Record<string, string> = { app: "Web-appen", extension: "Udvidelsen", word: "Word", outlook: "Outlook", document: "Excel og PowerPoint", mobile: "Mobil", knowledge: "Viden" };
const STATUS: Record<Status, [string, Tone]> = {
  ok: ["OK", "green"], warning: ["Advarsel", "orange"], over: ["Over loft · kun advarsel", "orange"], blocked: ["Over loft · blokeret", "red"], off: ["AI slået fra", "gray"],
};
const SOURCE: Record<Policy["source"], string> = { budget: "Budget", user: "Eget loft fra /admin/ai", default: "Standard" };
const BUDGET_STATUS: Record<Budget["status"], [string, Tone]> = { planned: ["Planlagt", "blue"], active: ["Aktiv", "green"], expired: ["Udløbet", "gray"] };
const WD = ["man", "tir", "ons", "tor", "fre", "lør", "søn"];
const MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

const n = (v: unknown) => Number(v ?? 0);
const kr = (v: unknown) => new Intl.NumberFormat("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n(v)) + " kr.";
const compact = (v: number) => (v >= 1e6 ? `${(v / 1e6).toLocaleString("da-DK", { maximumFractionDigits: 1 })} mio.` : v >= 1e3 ? `${Math.round(v / 1e3)} k` : String(Math.round(v)));
const who = (u: { display_name: string | null; email: string | null; phone: string | null; id?: number }) => u.display_name || u.email || u.phone || `Bruger ${u.id ?? ""}`;
const today = () => new Date().toISOString().slice(0, 10);

function bucketLabel(iso: string, bucket: Report["period"]["bucket"]): string {
  const d = new Date(iso);
  if (bucket === "hour") return String(d.getHours()).padStart(2, "0");
  if (bucket === "month") return MONTHS[d.getMonth()];
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function trend(now: number, before: number): string | null {
  if (!before) return null;
  const p = Math.round(((now - before) / before) * 100);
  return `${p >= 0 ? "+" : ""}${p} %`;
}

export default function Consumption() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some(([t]) => t === params.get("tab")) ? params.get("tab") : "overview") as Tab;
  const pick = (t: Tab) => setParams((p) => { const q = new URLSearchParams(p); if (t === "overview") q.delete("tab"); else q.set("tab", t); return q; });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <PageTitle title="AI-forbrug" icon={<Gauge size={24} strokeWidth={2} />}>
        Tokens, forespørgsler og anslået pris pr. periode, pr. model og pr. bruger, og budgetter med loft og advarsler.
        Kun forbrug gemmes, aldrig prompts eller svar.
      </PageTitle>
      <div role="tablist" aria-label="Faner" style={{ display: "flex", gap: 4, borderBottom: "1px solid #e2e8f0", flexWrap: "wrap" }}>
        {TABS.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => pick(t)} data-deeplink={`consumption-tab-${t}`}
            style={{ padding: "10px 14px", border: 0, background: "transparent", cursor: "pointer", font: `${tab === t ? 600 : 500} 14px var(--hm-font-sans)`,
              color: tab === t ? "#020817" : "#475569", boxShadow: tab === t ? "inset 0 -2px 0 #2563eb" : "none" }}>{label}</button>
        ))}
      </div>
      {tab === "overview" && <Overview onBudgets={() => pick("budgets")} />}
      {tab === "budgets" && <Budgets />}
      {tab === "prices" && <Prices />}
    </div>
  );
}

// ── Overblik ────────────────────────────────────────────────────────────────

function Overview({ onBudgets }: { onBudgets: () => void }) {
  const [range, setRange] = useState<Range>("month");
  const [from, setFrom] = useState(() => new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const [search, setSearch] = useState("");
  const q = query({ range, from: range === "custom" ? from : null, to: range === "custom" ? to : null });
  const { data, error } = useLoad(() => api.get<Report>(`/api/admin/consumption${q}`), [q]);

  const models = useMemo(() => (data?.models ?? []).map((m, i) => ({ ...m, color: COLORS[Math.min(i, COLORS.length - 1)] })), [data]);
  const color = (model: string) => models.find((m) => m.model === model)?.color ?? COLORS[COLORS.length - 1];
  const tokens = data ? n(data.totals.prompt_tokens) + n(data.totals.completion_tokens) : 0;
  const users = (data?.users ?? []).filter((u) => !search || `${who(u)} ${u.email ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const attention = data ? data.month_status.warning + data.month_status.over + data.month_status.blocked : 0;

  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
        <div role="group" aria-label="Periode" style={{ display: "flex", padding: 3, gap: 2, background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, flexWrap: "wrap" }}>
          {RANGES.map(([r, label]) => (
            <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}
              style={{ height: 32, padding: "0 12px", border: 0, borderRadius: 7, cursor: "pointer", font: `${range === r ? 600 : 500} 13px var(--hm-font-sans)`,
                background: range === r ? "#0f172a" : "transparent", color: range === r ? "#ffffff" : "#475569" }}>{label}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {range === "custom" && (
            <>
              <label style={{ ...labelStyle, flexDirection: "row", alignItems: "center" }}>Fra <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={input} /></label>
              <label style={{ ...labelStyle, flexDirection: "row", alignItems: "center" }}>Til <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} style={input} /></label>
            </>
          )}
          <a href={`/api/admin/consumption/export.csv${q}`} download style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 36, padding: "0 14px", borderRadius: 8,
            border: "1px solid #e2e8f0", background: "#ffffff", color: "#020817", font: "500 13px var(--hm-font-sans)", textDecoration: "none" }}>
            <Download size={14} strokeWidth={2} /> Eksportér CSV
          </a>
        </div>
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      {data && !data.enabled && (
        <div style={{ ...card, padding: "12px 16px", background: "#f8fafc", color: "#475569", fontSize: 13 }}>
          AI er ikke slået til på denne instans (AI_API_KEY mangler). Forbrug fra tidligere vises stadig.
        </div>
      )}

      <section aria-label="Nøgletal" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
        <Kpi label="Tokens" value={data ? fmt(tokens) : "…"} sub={data && trend(tokens, n(data.previous.tokens)) ? `${trend(tokens, n(data.previous.tokens))} mod ${PREV[range]}` : `ind ${data ? fmt(n(data.totals.prompt_tokens)) : "…"} · ud ${data ? fmt(n(data.totals.completion_tokens)) : "…"}`} />
        <Kpi label="Forespørgsler" value={data ? fmt(n(data.totals.requests)) : "…"} sub={data && n(data.totals.requests) ? `${fmt(tokens / n(data.totals.requests))} tokens i snit` : "—"} />
        <Kpi label="Anslået pris" value={data ? kr(data.totals.cost) : "…"} sub={data?.models.some((m) => !m.priced) ? "Nogle modeller har ingen pris" : "ud fra priser pr. model"} />
        <Kpi label="Aktive brugere" value={data ? fmt(n(data.totals.users)) : "…"} sub="brugte AI i perioden" />
        <button type="button" onClick={onBudgets} style={{ ...card, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 6, textAlign: "left", cursor: "pointer",
          font: "inherit", color: "#020817", ...(attention ? { background: "#fff7ed", borderColor: "#fed7aa" } : {}) }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: attention ? "#9a3412" : "#64748b" }}>Budgetter denne måned</span>
          <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>
            {data ? `${data.month_status.warning} ${data.month_status.warning === 1 ? "advarsel" : "advarsler"} · ${data.month_status.over + data.month_status.blocked} over` : "…"}
          </span>
          <span style={{ fontSize: 12, color: attention ? "#9a3412" : "#64748b" }}>Se budgetter →</span>
        </button>
      </section>

      <section aria-labelledby="c-chart" style={{ ...card, padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "space-between", alignItems: "center" }}>
          <h2 id="c-chart" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Tokens over tid</h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 14, fontSize: 12, color: "#334155" }}>
            {models.map((m) => (
              <li key={m.model} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span aria-hidden style={{ width: 10, height: 10, borderRadius: 3, background: m.color }} />{m.model}
              </li>
            ))}
          </ul>
        </div>
        {data && <Chart data={data} color={color} />}
      </section>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "stretch" }}>
        <section aria-labelledby="c-models" style={{ ...card, flex: "3 1 560px", minWidth: 0, display: "flex", flexDirection: "column" }}>
          <h2 id="c-models" style={{ margin: 0, padding: "18px 20px 10px", fontSize: 16, fontWeight: 600 }}>Pr. model</h2>
          <Table minWidth={640} head={["Model", "Forespørgsler", "Input", "Output", "Andel", "Pris"]} align={["left", "right", "right", "right", "left", "right"]}>
            {models.map((m) => {
              const t = n(m.prompt_tokens) + n(m.completion_tokens);
              const pct = tokens ? Math.round((t / tokens) * 100) : 0;
              return (
                <tr key={m.model}>
                  <Td><span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span aria-hidden style={{ width: 10, height: 10, borderRadius: 3, background: m.color, flex: "none" }} />
                    <span style={{ fontFamily: MONO, fontSize: 12 }}>{m.model}</span>
                    {!m.priced && <Pill tone="gray" size={10}>Ingen pris</Pill>}
                  </span></Td>
                  <Td num>{fmt(n(m.requests))}</Td>
                  <Td num>{fmt(n(m.prompt_tokens))}</Td>
                  <Td num>{fmt(n(m.completion_tokens))}</Td>
                  <Td><Bar pct={pct} color={m.color} label={`${pct} %`} /></Td>
                  <Td num strong>{kr(m.cost)}</Td>
                </tr>
              );
            })}
          </Table>
          {data && models.length === 0 && <Empty>Intet AI-forbrug i perioden.</Empty>}
        </section>
        <section aria-labelledby="c-surf" style={{ ...card, flex: "2 1 300px", minWidth: 0, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          <h2 id="c-surf" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Pr. overflade</h2>
          {(data?.surfaces ?? []).map((s) => (
            <div key={s.surface} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <span>{SURFACE[s.surface] ?? s.surface}</span>
                <span style={{ color: "#475569", fontVariantNumeric: "tabular-nums" }}>{fmt(n(s.tokens))} · {fmt(n(s.requests))} kald</span>
              </div>
              <Bar pct={n(data!.surfaces[0].tokens) ? (n(s.tokens) / n(data!.surfaces[0].tokens)) * 100 : 0} color="#2563eb" />
            </div>
          ))}
          {data && data.surfaces.length === 0 && <span style={{ fontSize: 13, color: "#64748b" }}>Intet forbrug.</span>}
        </section>
      </div>

      <section aria-labelledby="c-heat" style={{ ...card, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <h2 id="c-heat" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Hvornår bruges AI</h2>
          <span style={{ fontSize: 12, color: "#64748b" }}>Ugedag × time i perioden · mørkere = flere tokens</span>
        </div>
        {data && <Heat heat={data.heat} />}
      </section>

      <section aria-labelledby="c-users" style={{ ...card, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "18px 20px 10px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <h2 id="c-users" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Pr. bruger</h2>
            <span style={{ fontSize: 13, color: "#64748b" }}>Forbrug i perioden, og denne måned mod det loft, der gælder for brugeren</span>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#475569" }}>Søg
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Navn eller e-mail" style={{ ...input, width: 220 }} />
          </label>
        </div>
        <Table minWidth={900} head={["Bruger", "Tokens", "Kald", "Pris", "Mest brugte model", "Denne måned mod loft", "Status"]}
          align={["left", "right", "right", "right", "left", "left", "left"]}>
          {users.map((u) => <UserLine key={u.id} u={u} />)}
        </Table>
        {data && users.length === 0 && <Empty>Ingen brugere.</Empty>}
      </section>
    </>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div style={{ ...card, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, color: "#64748b", fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>{value}</span>
      <span style={{ fontSize: 12, color: "#64748b" }}>{sub}</span>
    </div>
  );
}

function Chart({ data, color }: { data: Report; color: (m: string) => string }) {
  const max = Math.max(1, ...data.series.map((s) => s.tokens));
  const H = 200;
  const every = data.series.length > 24 ? 5 : data.series.length > 12 ? 3 : 1;
  const gap = data.series.length > 20 ? 3 : 8;
  return (
    <div style={{ display: "flex", gap: 10 }}>
      <div aria-hidden style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", height: H, fontSize: 11, color: "#64748b", textAlign: "right", minWidth: 44 }}>
        <span>{compact(max)}</span><span>{compact(max / 2)}</span><span>0</span>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        <div role="img" aria-label="Søjlediagram over tokens pr. periode, stablet pr. model"
          style={{ height: H, display: "flex", alignItems: "flex-end", gap, borderBottom: "1px solid #e2e8f0" }}>
          {data.series.map((s) => (
            <div key={s.start} title={`${bucketLabel(s.start, data.period.bucket)} · ${fmt(s.tokens)} tokens`}
              style={{ flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column-reverse", gap: 1 }}>
              {Object.entries(s.models).sort((a, b) => b[1] - a[1]).map(([m, t]) => (
                <div key={m} style={{ height: Math.max(1, Math.round((t / max) * (H - 4))), background: color(m), borderRadius: 2 }} />
              ))}
            </div>
          ))}
        </div>
        <div aria-hidden style={{ display: "flex", gap, fontSize: 11, color: "#64748b" }}>
          {data.series.map((s, i) => (
            <span key={s.start} style={{ flex: 1, minWidth: 0, textAlign: "center", whiteSpace: "nowrap", overflow: "visible" }}>
              {i % every === 0 ? bucketLabel(s.start, data.period.bucket) : ""}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Heat({ heat }: { heat: Report["heat"] }) {
  const max = Math.max(1, ...heat.map((h) => n(h.tokens)));
  const at = (d: number, h: number) => n(heat.find((x) => x.dow === d && x.hour === h)?.tokens);
  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ minWidth: 640, display: "flex", flexDirection: "column", gap: 3 }}>
        {WD.map((day, i) => (
          <div key={day} style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <span style={{ width: 34, fontSize: 11, color: "#64748b" }}>{day}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const t = at(i + 1, h);
              return <span key={h} title={`${day} kl. ${String(h).padStart(2, "0")} · ${fmt(t)} tokens`}
                style={{ flex: 1, height: 18, borderRadius: 3, background: `rgba(37, 99, 235, ${(0.05 + (t / max) * 0.95).toFixed(2)})` }} />;
            })}
          </div>
        ))}
        <div aria-hidden style={{ display: "flex", gap: 3, paddingLeft: 37, fontSize: 10, color: "#64748b" }}>
          {Array.from({ length: 24 }, (_, h) => <span key={h} style={{ flex: 1 }}>{h % 3 === 0 ? String(h).padStart(2, "0") : ""}</span>)}
        </div>
      </div>
    </div>
  );
}

function UserLine({ u }: { u: UserRow }) {
  const p = u.policy;
  const pct = p.limit > 0 ? (p.used / p.limit) * 100 : 0;
  const low = p.warn_pcts.length ? Math.min(...p.warn_pcts) : 101;
  const [text, tone] = STATUS[p.status];
  return (
    <tr>
      <Td><span style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span aria-hidden style={{ width: 30, height: 30, flex: "none", borderRadius: 9999, background: "#0f172a", color: "#ffffff", fontSize: 11, fontWeight: 700,
          display: "flex", alignItems: "center", justifyContent: "center" }}>{initials(who(u))}</span>
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>{who(u)}</span>
          {u.email && u.display_name && <span style={{ fontSize: 12, color: "#64748b" }}>{u.email}</span>}
        </span>
      </span></Td>
      <Td num>{fmt(n(u.tokens))}</Td>
      <Td num>{fmt(n(u.requests))}</Td>
      <Td num>{kr(u.cost)}</Td>
      <Td><span style={{ fontFamily: MONO, fontSize: 12, color: "#334155" }}>{u.top_model ?? "—"}</span></Td>
      <Td>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 200 }}>
          <div style={{ position: "relative" }}>
            <Bar pct={pct} color={pct >= 100 ? "#dc2626" : pct >= low ? "#f97316" : "#2563eb"} />
            {p.warn_pcts.map((w) => <span key={w} aria-hidden style={{ position: "absolute", top: 0, bottom: 0, left: `${w}%`, width: 2, background: "#0f172a", opacity: 0.3 }} />)}
          </div>
          <span style={{ fontSize: 12, color: "#475569", fontVariantNumeric: "tabular-nums" }}>
            {fmt(p.used)} af {p.limit > 0 ? fmt(p.limit) : "0"} · {SOURCE[p.source]}{p.budget?.ends_on ? ` til ${dateLabel(p.budget.ends_on)}` : ""}
          </span>
        </div>
      </Td>
      <Td><Pill tone={tone}>{p.status === "warning" && p.warning ? `${text} · ${p.warning} %` : text}</Pill></Td>
    </tr>
  );
}

// ── Budgetter ───────────────────────────────────────────────────────────────

type Form = { id: number | null; user_id: string; monthly_tokens: string; warn_pcts: number[]; hard: boolean; total_tokens: string; starts_on: string; ends_on: string; no_end: boolean; note: string };
const EMPTY: Form = { id: null, user_id: "", monthly_tokens: "", warn_pcts: [80], hard: true, total_tokens: "", starts_on: today(), ends_on: "", no_end: true, note: "" };
const digits = (s: string) => s.replace(/[^\d]/g, "");

function Budgets() {
  const say = useToast();
  const list = useLoad(() => api.get<{ items: Budget[]; warn_choices: number[] }>("/api/admin/consumption/budgets"));
  const overview = useLoad(() => api.get<Report>("/api/admin/consumption?range=day"));
  const users = useLoad(() => api.get<{ items: AdminUser[] }>("/api/admin/users"));
  const [filter, setFilter] = useState<"all" | Budget["status"]>("all");
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [def, setDef] = useState<{ monthly_tokens: string; warn_pct: string; warning_mail: boolean } | null>(null);
  const defaults = def ?? (overview.data ? { monthly_tokens: String(overview.data.defaults.monthly_tokens), warn_pct: String(overview.data.defaults.warn_pct), warning_mail: overview.data.defaults.warning_mail } : null);
  const choices = list.data?.warn_choices ?? [50, 75, 80, 90];
  const items = (list.data?.items ?? []).filter((b) => filter === "all" || b.status === filter);

  const edit = (b: Budget) => setForm({ id: b.id, user_id: String(b.user_id), monthly_tokens: String(b.monthly_tokens), warn_pcts: b.warn_pcts, hard: b.hard,
    total_tokens: b.total_tokens ? String(b.total_tokens) : "", starts_on: b.starts_on, ends_on: b.ends_on ?? "", no_end: !b.ends_on, note: b.note });

  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      const body = { user_id: Number(form.user_id), monthly_tokens: Number(digits(form.monthly_tokens) || 0), warn_pcts: form.warn_pcts, hard: form.hard,
        total_tokens: digits(form.total_tokens) ? Number(digits(form.total_tokens)) : null, starts_on: form.starts_on,
        ends_on: form.no_end || !form.ends_on ? null : form.ends_on, note: form.note };
      if (form.id) await api.put(`/api/admin/consumption/budgets/${form.id}`, body);
      else await api.post("/api/admin/consumption/budgets", body);
      say(form.id ? "Budgettet er gemt." : "Budgettet er oprettet.");
      setForm(null);
      await list.reload();
    } catch (e) {
      say(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!form?.id || !window.confirm("Slet budgettet? Brugeren får standardloftet igen.")) return;
    try {
      await api.del(`/api/admin/consumption/budgets/${form.id}`);
      say("Budgettet er slettet.");
      setForm(null);
      await list.reload();
    } catch (e) {
      say(errorText(e));
    }
  };

  const saveDefaults = async () => {
    if (!defaults) return;
    try {
      await api.put("/api/admin/consumption/defaults", { monthly_tokens: Number(digits(defaults.monthly_tokens) || 0), warn_pct: Number(defaults.warn_pct), warning_mail: defaults.warning_mail });
      say("Standarden er gemt.");
      setDef(null);
      await overview.reload();
    } catch (e) {
      say(errorText(e));
    }
  };

  return (
    <>
      <section aria-labelledby="b-def" style={{ ...card, padding: "18px 20px", display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
        <div style={{ flex: "1 1 260px", display: "flex", flexDirection: "column", gap: 4 }}>
          <h2 id="b-def" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Standard for alle brugere</h2>
          <span style={{ fontSize: 13, color: "#475569" }}>Gælder brugere uden budget eller eget loft, og når et budget er udløbet. 0 slår AI fra. Mail ved advarsler gælder alle brugere med en e-mailadresse.</span>
        </div>
        <label style={labelStyle}>Månedligt loft (tokens)
          <input inputMode="numeric" value={defaults ? fmt(Number(digits(defaults.monthly_tokens) || 0)) : ""} onChange={(e) => setDef({ ...(defaults ?? { warn_pct: "80", warning_mail: true }), monthly_tokens: digits(e.target.value) })} style={{ ...input, width: 160 }} />
        </label>
        <label style={labelStyle}>Advar ved
          <select value={defaults?.warn_pct ?? "80"} onChange={(e) => setDef({ ...(defaults ?? { monthly_tokens: "0", warning_mail: true }), warn_pct: e.target.value })} style={{ ...select, width: 120 }}>
            <option value="0">Aldrig</option>
            {choices.map((c) => <option key={c} value={c}>{c} %</option>)}
          </select>
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, height: 36 }} data-deeplink="consumption-warning-mail">
          <input type="checkbox" checked={defaults?.warning_mail ?? true}
            onChange={(e) => setDef({ ...(defaults ?? { monthly_tokens: "0", warn_pct: "80" }), warning_mail: e.target.checked })} />
          Send mail ved advarsler
        </label>
        <Btn onClick={saveDefaults} disabled={!def}>Gem</Btn>
      </section>

      <section aria-labelledby="b-list" style={{ ...card, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "18px 20px 10px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h2 id="b-list" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Budgetter pr. bruger</h2>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {([["all", "Alle"], ["active", "Aktive"], ["planned", "Planlagte"], ["expired", "Udløbne"]] as const).map(([k, label]) => (
              <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}
                style={{ height: 30, padding: "0 12px", borderRadius: 9999, cursor: "pointer", font: "500 12px var(--hm-font-sans)",
                  border: `1px solid ${filter === k ? "#0f172a" : "#e2e8f0"}`, background: filter === k ? "#0f172a" : "#ffffff", color: filter === k ? "#ffffff" : "#334155" }}>{label}</button>
            ))}
            <Btn kind="primary" icon={Plus} onClick={() => setForm({ ...EMPTY })} deeplink="consumption-new-budget">Nyt budget</Btn>
          </div>
        </div>
        {list.error && <div style={{ padding: "0 20px 12px" }}><ErrorBox>{list.error}</ErrorBox></div>}
        <Table minWidth={900} head={["Bruger", "Loft pr. md.", "Advarsler", "Ved loftet", "Periode", "Denne måned", ""]} align={["left", "right", "left", "left", "left", "left", "right"]}>
          {items.map((b) => {
            const pct = b.monthly_tokens > 0 ? (b.month_used / b.monthly_tokens) * 100 : 0;
            const low = b.warn_pcts.length ? Math.min(...b.warn_pcts) : 101;
            const [st, tone] = BUDGET_STATUS[b.status];
            return (
              <tr key={b.id} style={{ background: form?.id === b.id ? "#eff6ff" : undefined }}>
                <Td><span style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontWeight: 600 }}>{who({ ...b, id: b.user_id })}</span>
                  <span style={{ fontSize: 12, color: "#64748b" }}>{b.note || (b.display_name ? b.email : "") || ""}</span>
                </span></Td>
                <Td num>{fmt(b.monthly_tokens)}</Td>
                <Td>{b.warn_pcts.length ? b.warn_pcts.map((w) => `${w} %`).join(" · ") : "Ingen"}</Td>
                <Td>{b.hard ? "Bloker" : "Kun advarsel"}</Td>
                <Td><span style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-start" }}>
                  <span>{dateLabel(b.starts_on)} – {b.ends_on ? dateLabel(b.ends_on) : "ingen slutdato"}</span>
                  <Pill tone={tone} size={10}>{st}</Pill>
                </span></Td>
                <Td>{b.current ? (
                  <span style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 160 }}>
                    <Bar pct={pct} color={pct >= 100 ? "#dc2626" : pct >= low ? "#f97316" : "#2563eb"} />
                    <span style={{ fontSize: 12, color: "#475569", fontVariantNumeric: "tabular-nums" }}>
                      {fmt(b.month_used)} · {Math.round(pct)} %{b.total_tokens ? ` · i alt ${fmt(b.total_used ?? 0)} af ${fmt(b.total_tokens)}` : ""}
                    </span>
                  </span>
                ) : <span style={{ color: "#64748b" }}>—</span>}</Td>
                <Td align="right"><Btn height={32} onClick={() => edit(b)}>Redigér</Btn></Td>
              </tr>
            );
          })}
        </Table>
        {list.data && items.length === 0 && <Empty>Ingen budgetter{filter === "all" ? " endnu" : " her"}. Brugere uden budget følger standarden.</Empty>}
      </section>

      {form && (
        <Drawer width={440} label={form.id ? "Redigér budget" : "Nyt budget"} onClose={() => setForm(null)} deeplink="consumption-budget">
          <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={sectionLabel}>{form.id ? "Redigér budget" : "Nyt budget"}</span>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
                  {form.user_id ? who(users.data?.items.find((u) => String(u.id) === form.user_id) ?? { display_name: null, email: null, phone: null, id: Number(form.user_id) }) : "Vælg bruger"}
                </h2>
              </div>
              <CloseBtn onClick={() => setForm(null)} />
            </div>
            {!form.id && (
              <label style={labelStyle}>Bruger
                <select value={form.user_id} onChange={(e) => setForm({ ...form, user_id: e.target.value })} style={select}>
                  <option value="">Vælg …</option>
                  {(users.data?.items ?? []).map((u) => <option key={u.id} value={u.id}>{who(u)}{u.email && u.display_name ? ` · ${u.email}` : ""}</option>)}
                </select>
              </label>
            )}
            <label style={labelStyle}>Månedligt loft (tokens)
              <input inputMode="numeric" value={form.monthly_tokens ? fmt(Number(digits(form.monthly_tokens))) : ""} onChange={(e) => setForm({ ...form, monthly_tokens: digits(e.target.value) })} style={input} />
              <span style={{ fontWeight: 400, color: "#64748b", fontSize: 12 }}>Nulstilles den 1. i hver måned. 0 slår AI fra for brugeren i perioden.</span>
            </label>
            <fieldset style={{ margin: 0, padding: 0, border: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              <legend style={{ fontSize: 13, fontWeight: 500, padding: "0 0 6px" }}>Advar brugeren ved</legend>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {choices.map((w) => {
                  const on = form.warn_pcts.includes(w);
                  return (
                    <button key={w} type="button" aria-pressed={on} onClick={() => setForm({ ...form, warn_pcts: on ? form.warn_pcts.filter((x) => x !== w) : [...form.warn_pcts, w].sort((a, b) => a - b) })}
                      style={{ height: 32, minWidth: 52, padding: "0 10px", borderRadius: 8, cursor: "pointer", font: "600 13px var(--hm-font-sans)",
                        border: `1px solid ${on ? "#2563eb" : "#e2e8f0"}`, background: on ? "#eff6ff" : "#ffffff", color: on ? "#1d4ed8" : "#475569" }}>{w} %</button>
                  );
                })}
              </div>
              <span style={{ fontSize: 12, color: "#64748b" }}>Brugeren ser advarslen på Mit AI-forbrug og får en mail, hvis »Send mail ved advarsler« er slået til. Hver grænse sendes én gang pr. måned, også som webhook (ai.budget.warning).</span>
            </fieldset>
            <fieldset style={{ margin: 0, padding: 0, border: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              <legend style={{ fontSize: 13, fontWeight: 500, padding: "0 0 6px" }}>Når loftet er nået</legend>
              <Choice on={form.hard} onPick={() => setForm({ ...form, hard: true })} title="Bloker AI" text="Resten af måneden svarer AI, at kvoten er brugt." />
              <Choice on={!form.hard} onPick={() => setForm({ ...form, hard: false })} title="Kun advarsel" text="AI virker videre; forbruget over loftet markeres." />
            </fieldset>
            <label style={labelStyle}>Samlet budget for perioden (valgfrit)
              <input inputMode="numeric" placeholder="Intet samlet budget" value={form.total_tokens ? fmt(Number(digits(form.total_tokens))) : ""} onChange={(e) => setForm({ ...form, total_tokens: digits(e.target.value) })} style={input} />
              <span style={{ fontWeight: 400, color: "#64748b", fontSize: 12 }}>Tokens i alt fra start til slut, oven i månedsloftet.</span>
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
              <label style={labelStyle}>Starter
                <input type="date" value={form.starts_on} onChange={(e) => setForm({ ...form, starts_on: e.target.value })} style={input} />
              </label>
              <label style={labelStyle}>Slutter
                {form.no_end
                  ? <span style={{ ...input, display: "flex", alignItems: "center", border: "1px dashed #cbd5e1", color: "#64748b", fontWeight: 400 }}>Ingen slutdato</span>
                  : <input type="date" value={form.ends_on} min={form.starts_on} onChange={(e) => setForm({ ...form, ends_on: e.target.value })} style={input} />}
              </label>
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
              <input type="checkbox" checked={form.no_end} onChange={(e) => setForm({ ...form, no_end: e.target.checked })} />
              Ingen slutdato — budgettet gælder, til det ændres
            </label>
            <label style={labelStyle}>Note (kun for admins)
              <input value={form.note} maxLength={200} placeholder="Fx projekt eller aftale" onChange={(e) => setForm({ ...form, note: e.target.value })} style={input} />
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "space-between", flexWrap: "wrap", paddingTop: 12, borderTop: "1px solid #f1f5f9" }}>
              {form.id ? <Btn kind="ghost" onClick={remove} style={{ color: "#b91c1c" }}>Slet budget</Btn> : <span />}
              <div style={{ display: "flex", gap: 8 }}>
                <Btn onClick={() => setForm(null)}>Annullér</Btn>
                <Btn kind="primary" onClick={save} disabled={busy || !form.user_id || form.monthly_tokens === ""}>Gem budget</Btn>
              </div>
            </div>
            <span style={{ fontSize: 12, color: "#64748b" }}>Ændringen skrives i audit-loggen.</span>
          </div>
        </Drawer>
      )}
    </>
  );
}

function Choice({ on, onPick, title, text }: { on: boolean; onPick: () => void; title: string; text: string }) {
  return (
    <label style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", border: `1px solid ${on ? "#2563eb" : "#e2e8f0"}`, borderRadius: 10, cursor: "pointer" }}>
      <input type="radio" name="budget-mode" checked={on} onChange={onPick} style={{ marginTop: 3 }} />
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{title}</span>
        <span style={{ fontSize: 12, color: "#64748b" }}>{text}</span>
      </span>
    </label>
  );
}

// ── Priser ──────────────────────────────────────────────────────────────────

function Prices() {
  const say = useToast();
  const { data, error, reload } = useLoad(() => api.get<{ items: Price[]; current_model: string }>("/api/admin/consumption/prices"));
  const [edits, setEdits] = useState<Record<string, { input: string; output: string }>>({});
  const value = (p: Price) => edits[p.model] ?? { input: String(n(p.input_per_million)).replace(".", ","), output: String(n(p.output_per_million)).replace(".", ",") };
  const num = (s: string) => s.replace(/\s/g, "").replace(",", ".");

  const save = async () => {
    try {
      await api.put("/api/admin/consumption/prices", { items: Object.entries(edits).map(([model, v]) => ({ model, input_per_million: num(v.input) || "0", output_per_million: num(v.output) || "0" })) });
      say("Priserne er gemt.");
      setEdits({});
      await reload();
    } catch (e) {
      say(errorText(e));
    }
  };

  return (
    <section aria-labelledby="p-h" style={{ ...card, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "18px 20px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
        <h2 id="p-h" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Priser pr. model</h2>
        <span style={{ fontSize: 13, color: "#475569" }}>Kroner pr. 1 mio. tokens. Bruges kun til at anslå pris i overblikket. Modeller dukker op her, så snart de er brugt.</span>
      </div>
      {error && <div style={{ padding: "0 20px 12px" }}><ErrorBox>{error}</ErrorBox></div>}
      <Table minWidth={640} head={["Model", "Input, kr. pr. 1 mio.", "Output, kr. pr. 1 mio.", "Kald i alt", "Sidst brugt"]} align={["left", "left", "left", "right", "left"]}>
        {(data?.items ?? []).map((p) => {
          const v = value(p);
          return (
            <tr key={p.model}>
              <Td><span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontFamily: MONO, fontSize: 12 }}>{p.model}</span>
                {p.model === data?.current_model && <Pill tone="blue" size={10}>I brug nu</Pill>}
              </span></Td>
              <Td><input aria-label={`Inputpris for ${p.model}`} inputMode="decimal" value={v.input} onChange={(e) => setEdits({ ...edits, [p.model]: { ...v, input: e.target.value } })} style={{ ...input, width: 110 }} /></Td>
              <Td><input aria-label={`Outputpris for ${p.model}`} inputMode="decimal" value={v.output} onChange={(e) => setEdits({ ...edits, [p.model]: { ...v, output: e.target.value } })} style={{ ...input, width: 110 }} /></Td>
              <Td num>{fmt(n(p.requests))}</Td>
              <Td>{p.last_used ? dateLabel(p.last_used) : "Aldrig"}</Td>
            </tr>
          );
        })}
      </Table>
      <div style={{ padding: "14px 20px", display: "flex", justifyContent: "flex-end" }}>
        <Btn kind="primary" onClick={save} disabled={!Object.keys(edits).length}>Gem priser</Btn>
      </div>
    </section>
  );
}

// ── Small parts ─────────────────────────────────────────────────────────────

function Table({ head, align, minWidth, children }: { head: string[]; align: ("left" | "right")[]; minWidth: number; children: ReactNode }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="tg-ctable" style={{ width: "100%", minWidth, borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" style={{ padding: i === 0 ? "8px 10px 8px 20px" : i === head.length - 1 ? "8px 20px 8px 10px" : "8px 10px", textAlign: align[i],
                fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "#64748b", borderBottom: "1px solid #e2e8f0" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Td({ children, num, strong, align }: { children: ReactNode; num?: boolean; strong?: boolean; align?: "left" | "right" }) {
  const style: CSSProperties = { borderBottom: "1px solid #f1f5f9", textAlign: align ?? (num ? "right" : "left"),
    fontVariantNumeric: num ? "tabular-nums" : undefined, whiteSpace: num ? "nowrap" : undefined, fontWeight: strong ? 600 : undefined, verticalAlign: "middle" };
  return <td style={style}>{children}</td>;
}

function Bar({ pct, color, label }: { pct: number; color: string; label?: string }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ flex: 1, minWidth: 80, height: 8, background: "#f1f5f9", borderRadius: 9999, overflow: "hidden", display: "block" }}>
        <span style={{ display: "block", width: `${Math.min(100, Math.max(0, pct))}%`, height: "100%", background: color, borderRadius: 9999 }} />
      </span>
      {label && <span style={{ fontSize: 12, color: "#475569", width: 36, textAlign: "right" }}>{label}</span>}
    </span>
  );
}
