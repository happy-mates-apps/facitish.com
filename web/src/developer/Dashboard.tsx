// /developer — the dashboard: API sources, catalog, MCP endpoints and tools at a glance, the latest MCP calls, and
// the two things a developer does most: register an API and define an MCP endpoint.
import { Link } from "react-router-dom";
import { api } from "../api";
import { Alert, Loading, fmtNumber, useLoad } from "../ui";
import { Calls, Empty, Kpi, MONO, SectionTitle, StatusPill, When, gap } from "./parts";
import type { Overview } from "./types";

export default function Dashboard() {
  const ov = useLoad(() => api.get<Overview>("/api/admin/studio/overview"));
  const d = ov.data;
  if (ov.error) return <Alert>{ov.error}</Alert>;
  if (!d) return <Loading />;
  return (
    <>
      <div className="kpis">
        <Kpi label="API-kilder" value={fmtNumber(d.sources.count)} to="/developer/studio/api"
             hint={<Calls calls={d.sources.calls7d} errors={d.sources.errors7d} />} />
        <Kpi label="Datasæt i kataloget" value={fmtNumber(d.catalog.datasets)}
             hint={`${fmtNumber(d.catalog.fromApi)} fra API'er · ${fmtNumber(d.catalog.mcpExposed)} udstillet til MCP`} />
        <Kpi label="MCP-endpoints" value={fmtNumber(d.endpoints.count)} to="/developer/studio/mcp"
             hint={`${fmtNumber(d.endpoints.dynamic)} egne · ${fmtNumber(d.endpoints.clients)} forbundne klienter`} />
        <Kpi label="MCP-kald, 7 dage" value={fmtNumber(d.endpoints.calls7d)}
             hint={<>{fmtNumber(d.endpoints.errors7d)} fejl · {fmtNumber(d.tools.total)} værktøjer ({fmtNumber(d.tools.data)} data)</>} />
      </div>

      <div className="grid" style={{ "--min": "320px" } as React.CSSProperties}>
        <section className="card" aria-labelledby="h-api" data-deeplink="developer-api-sources">
          <SectionTitle action={<Link to="/developer/studio/api?new=1" className="btn btn-primary btn-sm">Registrér API</Link>}>
            <span id="h-api">API-kilder</span>
          </SectionTitle>
          <p className="muted small" style={{ margin: 0 }}>
            En kildebeskrivelse (YAML) bliver til datasæt i kataloget. Serveren kalder API'et og maskerer felter efter
            klassifikation.
          </p>
          {d.sources.items.length === 0 ? <Empty>Ingen API-kilder endnu. Start med eksemplet i API Studio.</Empty> : (
            <div>
              {d.sources.items.slice(0, 6).map((s) => (
                <Link key={s.id} to={`/developer/studio/api?source=${s.id}`} className="list-row" style={{ textDecoration: "none" }}>
                  <div className="stack" style={{ ...gap(2), flex: "1 1 160px", minWidth: 0 }}>
                    <strong>{s.name}</strong>
                    <span className="tiny muted" style={MONO}>{s.key}{s.host ? ` · ${s.host}` : ""}</span>
                  </div>
                  <span className="pill">{s.datasets} datasæt</span>
                  <Calls calls={s.calls7d} errors={s.errors7d} />
                  <When value={s.lastAt} />
                </Link>
              ))}
            </div>
          )}
          <div className="row" style={gap(8)}>
            <Link to="/developer/studio/api" className="btn btn-outline btn-sm">Alle kilder</Link>
            <a href="/admin/data" className="btn btn-ghost btn-sm">Kataloget i /admin ↗</a>
          </div>
        </section>

        <section className="card" aria-labelledby="h-mcp" data-deeplink="developer-mcp-endpoints">
          <SectionTitle action={<Link to="/developer/studio/mcp?new=1" className="btn btn-primary btn-sm">Nyt endpoint</Link>}>
            <span id="h-mcp">MCP-endpoints</span>
          </SectionTitle>
          <p className="muted small" style={{ margin: 0 }}>
            Hvert endpoint svarer på <code>/mcp/&lt;nøgle&gt;</code>, logger brugeren ind som altid og tilbyder de værktøjer,
            du vælger.
          </p>
          <div>
            {d.endpoints.items.map((e) => (
              <Link key={e.key} to={`/developer/studio/mcp?endpoint=${e.key}`} className="list-row" style={{ textDecoration: "none" }}>
                <div className="stack" style={{ ...gap(2), flex: "1 1 160px", minWidth: 0 }}>
                  <strong>{e.name}</strong>
                  <span className="tiny muted" style={MONO}>{e.path}</span>
                </div>
                {e.builtin ? <span className="pill">indbygget</span> : <span className="pill blue">{e.audienceLabel}</span>}
                {!e.live && <span className="pill red">slået fra</span>}
                <span className="pill">{e.tools} værktøjer</span>
                <Calls calls={e.calls7d} errors={e.errors7d} />
              </Link>
            ))}
          </div>
          <div className="row" style={gap(8)}>
            <Link to="/developer/studio/mcp" className="btn btn-outline btn-sm">Alle endpoints</Link>
            <a href="/admin/mcp" className="btn btn-ghost btn-sm">MCP-hub i /admin ↗</a>
          </div>
        </section>
      </div>

      <section className="data-card" aria-labelledby="h-recent">
        <div className="spread" style={{ padding: "14px 18px" }}>
          <h2 id="h-recent" style={{ margin: 0, fontSize: 18 }}>Seneste MCP-kald</h2>
          <span className="tiny muted">Alle endpoints · tools/call</span>
        </div>
        {d.recent.length === 0 ? <p className="muted small" style={{ padding: "0 18px 16px" }}>Ingen kald endnu.</p> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Tid</th><th>Endpoint</th><th>Værktøj</th><th>Status</th><th>Hvem</th><th>ms</th></tr></thead>
              <tbody>
                {d.recent.map((r, i) => (
                  <tr key={i}>
                    <td className="num tiny muted">{new Date(r.ts).toLocaleString("da-DK")}</td>
                    <td style={MONO}>{r.path}</td>
                    <td style={MONO}>{r.tool ?? "—"}</td>
                    <td><StatusPill status={r.status} /></td>
                    <td>{r.who ?? "—"}</td>
                    <td className="num">{r.ms ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid" style={{ "--min": "240px" } as React.CSSProperties}>
        <Link to="/developer/prompts" className="card" style={{ textDecoration: "none" }}>
          <strong>Promptkatalog</strong>
          <span className="muted small">Prompts til Claude og Claude Code, der følger projektets workflows.</span>
        </Link>
        <Link to="/developer/trae" className="card" style={{ textDecoration: "none" }}>
          <strong>Træstrukturer</strong>
          <span className="muted small">TreeView og TreeSelect mod /api/meta — til at bygge egne skærme.</span>
        </Link>
        <a href="/admin/data/tools" className="card" style={{ textDecoration: "none" }}>
          <strong>MCP-værktøjer ↗</strong>
          <span className="muted small">Klassifikation og endpoint-kort for alle værktøjer, i /admin.</span>
        </a>
      </div>
    </>
  );
}
