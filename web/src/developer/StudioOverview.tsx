// /developer/studio — the roll-up of the two studios: what is registered, what is exposed, and where to go next.
import { Link } from "react-router-dom";
import { api } from "../api";
import { Alert, Loading, fmtNumber, useLoad } from "../ui";
import { Calls, Empty, MONO, SectionTitle, When, gap } from "./parts";
import type { Overview } from "./types";

export default function StudioOverview() {
  const ov = useLoad(() => api.get<Overview>("/api/admin/studio/overview"));
  const d = ov.data;
  if (ov.error) return <Alert>{ov.error}</Alert>;
  if (!d) return <Loading />;
  const steps = [
    { n: 1, title: "Registrér et API", text: "Skriv eller importér en kildebeskrivelse i API Studio og test kaldet.", to: "/developer/studio/api", done: d.sources.count > 0 },
    { n: 2, title: "Udstil i kataloget", text: "Gem kilden: hvert datasæt kommer i /admin/data med felter og klassifikation.", to: "/admin/data", done: d.catalog.fromApi > 0, external: true },
    { n: 3, title: "Definér et MCP-endpoint", text: "Opret /mcp/<nøgle> i MCP Studio og vælg værktøjer — også datasættene fra trin 2.", to: "/developer/studio/mcp", done: d.endpoints.dynamic > 0 },
    { n: 4, title: "Forbind en klient", text: "Klienten registrerer sig selv, brugeren logger ind som altid og godkender.", to: "/developer/studio/mcp", done: d.endpoints.clients > 0 },
  ];
  return (
    <>
      <div className="grid" style={{ "--min": "320px" } as React.CSSProperties}>
        <section className="card glow" aria-labelledby="h-s-api">
          <SectionTitle action={<Link to="/developer/studio/api" className="btn btn-primary btn-sm">Åbn API Studio</Link>}>
            <span id="h-s-api">API Studio</span>
          </SectionTitle>
          <div className="row" style={gap(18)}>
            <div><div className="stat">{fmtNumber(d.sources.count)}</div><div className="tiny muted">kilder</div></div>
            <div><div className="stat">{fmtNumber(d.catalog.fromApi)}</div><div className="tiny muted">datasæt fra API'er</div></div>
            <div><div className="stat">{fmtNumber(d.sources.calls7d)}</div><div className="tiny muted">kald, 7 dage{d.sources.errors7d ? ` · ${fmtNumber(d.sources.errors7d)} fejl` : ""}</div></div>
          </div>
          {d.sources.items.length === 0 ? <Empty>Ingen kilder endnu.</Empty> : (
            <div>
              {d.sources.items.slice(0, 5).map((s) => (
                <Link key={s.id} to={`/developer/studio/api?source=${s.id}`} className="list-row" style={{ textDecoration: "none" }}>
                  <strong style={{ flex: "1 1 140px" }}>{s.name}</strong>
                  <span className="tiny muted" style={MONO}>{s.host ?? s.key}</span>
                  <span className="pill">{s.datasets} datasæt</span>
                  <Calls calls={s.calls7d} errors={s.errors7d} />
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className="card glow" aria-labelledby="h-s-mcp">
          <SectionTitle action={<Link to="/developer/studio/mcp" className="btn btn-primary btn-sm">Åbn MCP Studio</Link>}>
            <span id="h-s-mcp">MCP Studio</span>
          </SectionTitle>
          <div className="row" style={gap(18)}>
            <div><div className="stat">{fmtNumber(d.endpoints.count)}</div><div className="tiny muted">endpoints · {fmtNumber(d.endpoints.dynamic)} egne</div></div>
            <div><div className="stat">{fmtNumber(d.tools.total)}</div><div className="tiny muted">værktøjer · {fmtNumber(d.tools.data)} data</div></div>
            <div><div className="stat">{fmtNumber(d.endpoints.calls7d)}</div><div className="tiny muted">kald, 7 dage{d.endpoints.errors7d ? ` · ${fmtNumber(d.endpoints.errors7d)} fejl` : ""}</div></div>
          </div>
          <div>
            {d.endpoints.items.map((e) => (
              <Link key={e.key} to={`/developer/studio/mcp?endpoint=${e.key}`} className="list-row" style={{ textDecoration: "none" }}>
                <strong style={{ flex: "1 1 140px" }}>{e.name}</strong>
                <span className="tiny muted" style={MONO}>{e.path}</span>
                <span className="pill">{e.tools} værktøjer</span>
                {!e.live && <span className="pill red">slået fra</span>}
                <When value={e.lastAt} />
              </Link>
            ))}
          </div>
        </section>
      </div>

      <section className="card" aria-labelledby="h-flow">
        <h2 id="h-flow" style={{ margin: 0, fontSize: 18 }}>Fra API til AI-klient</h2>
        <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>
          {steps.map((s) => (
            <li key={s.n} className="stack" style={{ ...gap(6), padding: 14, border: "1px solid var(--hm-border)", borderRadius: "var(--hm-radius-lg)", background: s.done ? "#f0fdf4" : "#fff" }}>
              <div className="row" style={gap(8)}>
                <span className="step-num" aria-hidden>{s.done ? "✓" : s.n}</span>
                <strong>{s.title}</strong>
              </div>
              <span className="small muted">{s.text}</span>
              {s.external ? <a href={s.to} className="small">Åbn ↗</a> : <Link to={s.to} className="small">Åbn →</Link>}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
