// /admin/data → Katalog: datakilder and every dataset with classification, fields, rows and MCP (DATA.md, Main.dc.html).
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Database, Globe, Plug, Search, Table2 } from "lucide-react";
import { api } from "../../../api";
import { Btn, ErrorBox, PageTitle, useLoad } from "../../ui";
import { card, fmt, input, MONO, sectionLabel, tableHead } from "../../theme";
import { CLS, CLS_KEYS, srOnly, type Catalog as CatalogData, type Cls } from "./types";
import { ClsBadge } from "./parts";

const COLS = "minmax(180px,2.2fr) minmax(120px,1.3fr) 110px 70px 90px 90px 90px";

export default function Catalog() {
  const { data, error } = useLoad(() => api.get<CatalogData>("/api/admin/data/catalog"), []);
  const [q, setQ] = useState("");
  const [cls, setCls] = useState<Cls | "">("");
  const [mcpOnly, setMcpOnly] = useState(false);
  const [source, setSource] = useState<string>("");

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.datasets ?? []).filter((d) =>
      (!needle || `${d.name} ${d.key} ${d.description}`.toLowerCase().includes(needle))
      && (!cls || d.classification === cls) && (!mcpOnly || d.mcp_exposed)
      && (!source || String(d.source_id ?? "gaer") === source));
  }, [data, q, cls, mcpOnly, source]);

  const stat = (labelText: string, value: string, sub: ReactNode) => (
    <div style={{ ...card, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: "#64748b" }}>{labelText}</span>
      <span style={{ fontSize: 26, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</span>
      <span style={{ fontSize: 12, color: "#64748b" }}>{sub}</span>
    </div>
  );

  return (
    <>
      <PageTitle title="Katalog" aside={
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link to="/data/explore" style={{ textDecoration: "none" }}><Btn icon={Table2}>Udforsk</Btn></Link>
          <Link to="/data/connect" style={{ textDecoration: "none" }}><Btn kind="primary" icon={Plug}>Forbind API</Btn></Link>
        </div>
      }>
        Alle datasæt i instansen — fra egen database og fra API'er. Vælg et datasæt for at læse beskrivelsen, se felterne eller udforske rækkerne.
      </PageTitle>
      {error && <ErrorBox>{error}</ErrorBox>}
      {data && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
          {stat("Datasæt", fmt(data.stats.datasets), `i ${data.stats.sources} datakilder`)}
          {stat("Felter beskrevet", `${data.stats.described_pct} %`, `af ${fmt(data.stats.fields)} felter`)}
          {stat("Markeret til MCP", fmt(data.stats.mcp), "bliver værktøjer på /mcp/data")}
          {stat("Afmaskeringer, 30 dage", fmt(data.stats.unmasks_30d), <Link to="/logs/audit">se audit-loggen →</Link>)}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
        <section aria-label="Datakilder" style={{ ...card, flex: "1 1 240px", maxWidth: "100%", padding: 14, display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ ...sectionLabel, padding: "0 6px 6px" }}>Datakilder</span>
          {[{ id: "", name: "Alle", kind: "", datasets: data?.datasets.length ?? 0, hosts: [] as string[] },
            ...(data?.sources ?? []).map((s) => ({ ...s, id: String(s.id ?? "gaer") }))].map((s) => {
            const on = source === s.id;
            const Icon = s.kind === "rest" ? Globe : Database;
            return (
              <button key={s.id || "all"} type="button" onClick={() => setSource(s.id)} className={on ? undefined : "tg-hover"}
                style={{ all: "unset", cursor: "pointer", display: "flex", gap: 10, alignItems: "center", padding: "9px 10px", borderRadius: 10,
                  background: on ? "#eff6ff" : "transparent" }}>
                <span style={{ width: 30, height: 30, flex: "none", borderRadius: 8, background: "#f1f5f9", color: "#475569", display: "inline-flex",
                  alignItems: "center", justifyContent: "center" }}><Icon size={15} /></span>
                <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</span>
                  <span style={{ fontSize: 12, color: "#64748b" }}>
                    {s.kind === "rest" ? `API · ${s.hosts.join(", ")}` : s.kind === "gaer" ? "Containerens egen Postgres" : "Alle kilder"}
                  </span>
                </span>
                <span style={{ fontSize: 12, color: "#475569" }}>{s.datasets}</span>
              </button>
            );
          })}
          <Link to="/data/connect" style={{ marginTop: 6, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, height: 34,
            borderRadius: 8, border: "1px dashed #93c5fd", background: "#eff6ff", color: "#1d4ed8", fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
            + Forbind API
          </Link>
          <p style={{ margin: "8px 0 0", padding: 10, borderRadius: 10, background: "#f8fafc", fontSize: 12, color: "#475569", lineHeight: 1.5 }}>
            Kataloget beskriver data. Rækkerne bliver, hvor de er — i databasen eller bag et API — og serveren henter dem kun til læsning.
          </p>
        </section>

        <section aria-label="Datasæt" style={{ ...card, flex: "999 1 560px", minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", padding: "14px 16px", borderBottom: "1px solid #e2e8f0" }}>
            <label style={{ position: "relative", flex: "1 1 260px", display: "flex" }}>
              <span style={srOnly}>Søg</span>
              <Search size={16} color="#64748b" style={{ position: "absolute", left: 10, top: 10 }} />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Søg i datasæt og beskrivelser"
                style={{ ...input, width: "100%", paddingLeft: 34 }} />
            </label>
            <div role="group" aria-label="Klassifikation" style={{ display: "flex", gap: 2, padding: 2, borderRadius: 8, background: "#f1f5f9" }}>
              {(["", ...CLS_KEYS] as const).map((k) => (
                <button key={k || "all"} type="button" aria-pressed={cls === k} onClick={() => setCls(k)}
                  style={{ height: 30, padding: "0 10px", border: 0, borderRadius: 6, cursor: "pointer", fontSize: 12,
                    fontWeight: cls === k ? 600 : 500, background: cls === k ? "#ffffff" : "transparent", color: cls === k ? "#020817" : "#475569",
                    boxShadow: cls === k ? "var(--hm-shadow-sm)" : "none" }}>
                  {k ? CLS[k].label : "Alle"}
                </button>
              ))}
            </div>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#475569" }}>
              <input type="checkbox" checked={mcpOnly} onChange={(e) => setMcpOnly(e.target.checked)} /> Kun MCP
            </label>
          </div>
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 760 }}>
              <div style={{ ...tableHead, gridTemplateColumns: COLS }}>
                <span>Datasæt</span><span>Datakilde</span><span>Klassifikation</span><span>Felter</span><span>Rækker</span><span>MCP</span><span />
              </div>
              {rows.map((d) => (
                <div key={d.id} className="tg-row" style={{ display: "grid", gridTemplateColumns: COLS, gap: 10, alignItems: "center", padding: "11px 16px",
                  borderBottom: "1px solid #f1f5f9" }}>
                  <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <Link to={`/data/${d.id}`} style={{ fontWeight: 600, color: "#020817", textDecoration: "none" }}>{d.name}</Link>
                    <span style={{ font: `12px ${MONO}`, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis" }}>{d.key}</span>
                  </span>
                  <span style={{ fontSize: 13, color: "#475569" }}>{d.source_name}</span>
                  <span><ClsBadge value={d.classification} /></span>
                  <span style={{ color: "#475569", fontVariantNumeric: "tabular-nums" }}>{d.fields}</span>
                  <span style={{ color: "#475569", fontVariantNumeric: "tabular-nums" }}>{d.approx_rows === null ? "via API" : `ca. ${fmt(d.approx_rows)}`}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: d.mcp_exposed ? "#1d4ed8" : "#94a3b8" }}>{d.mcp_exposed ? "Markeret" : "Nej"}</span>
                  <span style={{ textAlign: "right" }}><Link to={`/data/${d.id}?tab=udforsk`} style={{ fontSize: 13, fontWeight: 500 }}>Udforsk →</Link></span>
                </div>
              ))}
              {data && rows.length === 0 && (
                <p style={{ margin: 0, padding: 16, color: "#64748b" }}>
                  {data.datasets.length === 0
                    ? <>Kataloget er tomt. Tilføj tabeller fra databasen under <Link to="/data/explore">Udforsk</Link>, eller <Link to="/data/connect">forbind et API</Link>.</>
                    : "Ingen datasæt matcher."}
                </p>
              )}
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
