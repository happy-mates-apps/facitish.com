// /admin/data/explore → Udforsk: datasets grouped by source, tables not in the catalog yet, and the explorer (DataExplore.dc.html).
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Plug, Plus } from "lucide-react";
import { api, errorText } from "../../../api";
import { Btn, ErrorBox, IconBtn, PageTitle, useLoad, useToast } from "../../ui";
import { card, fmt, input, MONO, sectionLabel } from "../../theme";
import { CLS, srOnly, type Catalog, type Dataset, type TableRow } from "./types";
import Explorer from "./Explorer";

export default function Explore() {
  const say = useToast();
  const [params, setParams] = useSearchParams();
  const selected = params.get("d");
  const catalog = useLoad(() => api.get<Catalog>("/api/admin/data/catalog"), []);
  const tables = useLoad(() => api.get<TableRow[]>("/api/admin/data/tables"), []);
  const dataset = useLoad(() => (selected ? api.get<Dataset>(`/api/admin/data/datasets/${selected}`) : Promise.resolve(null)), [selected]);
  const [q, setQ] = useState("");

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (s: string) => !needle || s.toLowerCase().includes(needle);
    return (catalog.data?.sources ?? []).map((s) => ({
      ...s,
      items: (catalog.data?.datasets ?? []).filter((d) => (d.source_id ?? null) === s.id && match(`${d.name} ${d.key}`)),
    })).filter((g) => g.items.length > 0 || g.kind === "gaer");
  }, [catalog.data, q]);
  const loose = (tables.data ?? []).filter((t) => !q.trim() || `${t.name} ${t.label}`.toLowerCase().includes(q.trim().toLowerCase()));

  const add = async (table: string) => {
    try {
      const d = await api.post<Dataset>("/api/admin/data/datasets", { table });
      say(`${d.name} er i kataloget. Felterne starter som gule — klassificér dem under Felter`);
      await Promise.all([catalog.reload(), tables.reload()]);
      setParams({ d: String(d.id) });
    } catch (e) {
      say(errorText(e));
    }
  };

  return (
    <>
      <PageTitle title="Udforsk" aside={<Link to="/data/connect" style={{ textDecoration: "none" }}><Btn icon={Plug}>Forbind API</Btn></Link>}>
        Læs rækker i datasæt fra databasen og fra API'er med katalogets navne og maskering. Intet kan ændres herfra.
      </PageTitle>
      {(catalog.error || tables.error) && <ErrorBox>{catalog.error || tables.error}</ErrorBox>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        <aside aria-label="Datasæt" style={{ ...card, flex: "1 1 240px", maxWidth: "100%", padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ display: "flex" }}>
            <span style={srOnly}>Find datasæt</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find datasæt eller tabel" style={{ ...input, width: "100%" }} />
          </label>
          {groups.map((g) => (
            <div key={g.key} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ ...sectionLabel, fontSize: 10, padding: "0 8px 4px" }}>{g.name}</span>
              {g.items.length === 0 && <span style={{ fontSize: 12, color: "#94a3b8", padding: "0 8px" }}>Ingen tabeller i kataloget endnu</span>}
              {g.items.map((d) => {
                const on = String(d.id) === selected;
                return (
                  <button key={d.id} type="button" onClick={() => setParams({ d: String(d.id) })} className={on ? undefined : "tg-hover"}
                    style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: 8,
                      background: on ? "#eff6ff" : "transparent", color: on ? "#1d4ed8" : "#020817", fontWeight: on ? 600 : 400 }}>
                    <span style={{ width: 6, height: 6, borderRadius: 9999, flex: "none", background: CLS[d.classification].dot }} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{d.name}</span>
                    <span style={{ font: `11px ${MONO}`, color: "#94a3b8" }}>{d.key}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {loose.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ ...sectionLabel, fontSize: 10, padding: "0 8px 4px" }}>Ikke i kataloget</span>
              {loose.map((t) => (
                <div key={t.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 4px 4px 8px" }}>
                  <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                    <span style={{ fontSize: 13 }}>{t.label || t.name}</span>
                    <span style={{ font: `11px ${MONO}`, color: "#94a3b8" }}>{t.name} · ca. {fmt(t.approx_rows)} rækker</span>
                  </span>
                  <IconBtn icon={Plus} label={`Tilføj ${t.name} til kataloget`} onClick={() => add(t.name)} />
                </div>
              ))}
            </div>
          )}
          <p style={{ margin: 0, padding: 10, borderRadius: 10, background: "#f8fafc", fontSize: 12, color: "#475569", lineHeight: 1.5 }}>
            Tabeller med koder, nøgler og sessioner kan ikke udforskes. En tabel, der tilføjes, starter med alle felter gule (maskeret).
          </p>
        </aside>

        <div style={{ flex: "999 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
          {dataset.data ? (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 10 }}>
                <span style={sectionLabel}>{dataset.data.source_name}</span>
                <h2 style={{ margin: 0, fontSize: 22 }}>{dataset.data.name}</h2>
                <Link to={`/data/${dataset.data.id}`} style={{ fontSize: 13, fontWeight: 500 }}>Se i kataloget →</Link>
              </div>
              <Explorer dataset={dataset.data} onUnmasked={dataset.reload} />
            </>
          ) : (
            <div style={{ ...card, padding: 24, color: "#64748b" }}>
              {dataset.error ? <ErrorBox>{dataset.error}</ErrorBox> : "Vælg et datasæt til venstre, eller tilføj en tabel fra databasen."}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
