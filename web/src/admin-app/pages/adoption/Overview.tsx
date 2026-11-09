// /admin/adoption → Overblik: KPIs with sparklines, a card per journey (a bar per step), top routes and the live feed.
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../../api";
import { ErrorBox, useLoad } from "../../ui";
import { card, fmt, MONO } from "../../theme";
import { Bar, Code, Empty, Kpi, Panel, pct, Spark, StatusPill, Trend, useAdoption, type Journey } from "./shared";
import { useLiveLines } from "./Console";

type Overview = {
  tracking: boolean; days: number;
  active_users: { value: number; trend: number | null; series: number[] };
  tracked_visits: { value: number; trend: number | null; series: number[] };
  avg_completion: number; journeys_active: number; journeys_total: number; tracked_routes: number;
  top_routes: { route: string; visits: number }[];
};

export default function AdoptionOverview() {
  const { days, journeys, select } = useAdoption();
  const { data: o, error } = useLoad(() => api.get<Overview>(`/api/admin/adoption/overview?days=${days}`), [days]);
  const navigate = useNavigate();
  const { lines, connected } = useLiveLines();
  const maxRoute = Math.max(1, ...(o?.top_routes.map((r) => r.visits) ?? [1]));

  return (
    <>
      {error && <ErrorBox>{error}</ErrorBox>}
      {o && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
          <Kpi label="Aktive brugere" value={fmt(o.active_users.value)} sub={<><Trend value={o.active_users.trend} /> unikke · {days} d</>}>
            <Spark values={o.active_users.series} />
          </Kpi>
          <Kpi label="Gennemført i aktive forløb" value={`${o.avg_completion} %`} sub="gennemsnit på tværs">
            <Spark values={[o.avg_completion, o.avg_completion]} />
          </Kpi>
          <Kpi label="Forløb i gang" value={`${o.journeys_active} / ${o.journeys_total}`}
            sub={`${o.journeys_total - o.journeys_active} kladde eller pauset`}>
            <Spark values={[o.journeys_active, o.journeys_active]} />
          </Kpi>
          <Kpi label="Sporede rutebesøg" value={fmt(o.tracked_visits.value)} sub={<><Trend value={o.tracked_visits.trend} /> {o.tracked_routes} ruter</>}>
            <Spark values={o.tracked_visits.series} />
          </Kpi>
        </div>
      )}

      <section style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Forløb</h2>
          <span style={{ fontSize: 14, color: "#64748b" }}>hvor langt er hver målgruppe nået — trin for trin</span>
        </div>
        {journeys && journeys.length === 0 && <Empty>Ingen forløb endnu. Opret det første fra forløbsvælgeren i toppen.</Empty>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 16 }}>
          {(journeys ?? []).map((j) => (
            <JourneyCard key={j.id} j={j} onOpen={() => { select(j.id); navigate(`/adoption/journeys/${j.id}`); }} />
          ))}
        </div>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 16 }}>
        <Panel title="Mest besøgte ruter" sub={`Sidevisninger pr. rute, ${days} dage`}>
          {o && o.top_routes.length === 0 && <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>Ingen rutebesøg i perioden.</p>}
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 9, fontSize: 13 }}>
            {o?.top_routes.map((r) => (
              <li key={r.route} style={{ display: "grid", gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr) 56px", alignItems: "center", gap: 12 }}>
                <Code style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.route}</Code>
                <Bar value={Math.max(2, (r.visits / maxRoute) * 100)} />
                <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmt(r.visits)}</span>
              </li>
            ))}
          </ul>
          <Link to="/adoption/routes" style={{ alignSelf: "flex-start", fontSize: 13, fontWeight: 500 }}>Se alle ruter →</Link>
        </Panel>
        <Panel dark title="Live nu" sub="Seneste rutebesøg på tværs af appen" action={<LiveDot on={connected} />}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 7, fontFamily: MONO, fontSize: 12 }}>
            {lines.length === 0 && <span style={{ color: "#94a3b8" }}>Venter på næste rutebesøg …</span>}
            {lines.slice(0, 7).map((l) => (
              <div key={l.id} style={{ display: "flex", gap: 10, minWidth: 0 }}>
                <span style={{ color: "#94a3b8" }}>{new Date(l.at).toLocaleTimeString("da-DK")}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.path}</span>
                {l.hits[0] && <span style={{ color: "#86efac", whiteSpace: "nowrap" }}>✓ trin {l.hits[0].step}</span>}
              </div>
            ))}
          </div>
          <Link to="/adoption/console" style={{ alignSelf: "flex-start", fontSize: 13, fontWeight: 500, color: "#93c5fd" }}>Åbn live-strømmen →</Link>
        </Panel>
      </div>
    </>
  );
}

export function LiveDot({ on }: { on: boolean }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: on ? "#86efac" : "#fcd34d" }}>
      <span style={{ width: 8, height: 8, borderRadius: 9999, background: on ? "#22c55e" : "#f59e0b" }} />{on ? "live" : "forbinder …"}
    </span>
  );
}

function JourneyCard({ j, onOpen }: { j: Journey; onOpen: () => void }) {
  const draft = j.status === "draft";
  return (
    <button type="button" onClick={onOpen} className="tg-hover"
      style={{ all: "unset", cursor: "pointer", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 12, padding: 18, ...card,
        borderStyle: draft ? "dashed" : "solid" }}>
      <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <StatusPill status={j.status} />
        <span style={{ fontSize: 12, color: "#64748b" }}>{fmt(j.cohort_size)} i målgruppen</span>
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <b style={{ fontSize: 16, fontWeight: 600 }}>{j.name}</b>
        <span style={{ fontSize: 13, color: "#64748b" }}>{j.audience_text}</span>
      </span>
      <span style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 44 }} aria-hidden="true">
        {(j.steps.length ? j.steps : [null]).map((s, i) => (
          <span key={i} title={s ? `${s.label} · ${pct(j.reached[i] ?? 0, j.cohort_size)} %` : "Ingen trin"}
            style={{ flex: 1, minHeight: 3, borderRadius: "4px 4px 2px 2px", background: draft ? "#cbd5e1" : "#2563eb",
              height: `${Math.max(6, s ? pct(j.reached[i] ?? 0, j.cohort_size) : 0)}%` }} />
        ))}
      </span>
      <span style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", fontSize: 13, color: "#64748b" }}>
        <span>{j.steps.length} trin · mål {j.goal_pct} %</span>
        <b style={{ fontSize: 20, color: !draft && j.done_pct >= j.goal_pct && j.steps.length ? "#16a34a" : "#020817", fontVariantNumeric: "tabular-nums" }}>
          {j.done_pct} %
        </b>
      </span>
    </button>
  );
}
