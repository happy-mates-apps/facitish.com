// /admin/adoption/routes → Ruter og URL'er: every tracked route, which journeys measure it, and a shortcut that starts a
// step in the selected journey from a route nobody measures yet.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../../api";
import { ErrorBox, Loading, useLoad } from "../../ui";
import { card, fmt, input, MONO, SANS } from "../../theme";
import { routeToPattern } from "./match";
import { Code, Trend, useAdoption } from "./shared";

type RouteRow = { route: string; surface: string; visits: number; users: number; trend: number | null; journeys: { id: number; name: string }[] };

const COLS = "minmax(0,2fr) 100px 90px 90px 80px minmax(0,1.6fr)";

export default function AdoptionRoutes() {
  const { days, selectedId, journeys, setDraft } = useAdoption();
  const { data, error, loading } = useLoad(() => api.get<{ rows: RouteRow[]; total: number }>(`/api/admin/adoption/routes?days=${days}`), [days]);
  const navigate = useNavigate();
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const rows = (data?.rows ?? []).filter((r) => !q || r.route.toLowerCase().includes(q) || r.surface.toLowerCase().includes(q));
  const editable = (journeys ?? []).find((j) => j.id === selectedId && j.can_edit) ?? (journeys ?? []).find((j) => j.can_edit);

  const startStep = (route: string) => {
    if (!editable) return;
    setDraft({ label: "", match_type: route.includes(":") ? "glob" : "exact", pattern: routeToPattern(route) });
    navigate(`/adoption/journeys/${editable.id}/setup`);
  };
  const shortcut = (value: string) => (
    <button type="button" aria-pressed={q === value} onClick={() => setFilter(q === value ? "" : value)}
      style={{ height: 36, padding: "0 12px", border: "1px solid #e2e8f0", borderRadius: 8, cursor: "pointer", font: `12px ${MONO}`,
        background: q === value ? "#020817" : "#ffffff", color: q === value ? "#ffffff" : "#020817" }}>
      {value}
    </button>
  );

  return (
    <>
      {error && <ErrorBox>{error}</ErrorBox>}
      <section style={{ ...card, overflow: "hidden" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "16px 20px", borderBottom: "1px solid #e2e8f0" }}>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtrér ruter" placeholder="Filtrér ruter, fx /klip"
            style={{ ...input, flex: "1 1 220px", fontFamily: MONO }} />
          {shortcut("/m")}
          {shortcut("/extension")}
          <span style={{ fontSize: 13, color: "#64748b" }}>{rows.length} ruter · {fmt(data?.total ?? 0)} besøg på {days} dage</span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 760 }}>
            <div style={{ display: "grid", gridTemplateColumns: COLS, gap: 12, padding: "10px 20px", borderBottom: "1px solid #e2e8f0",
              background: "#f8fafc", fontSize: 12, fontWeight: 500, color: "#64748b" }}>
              <span>Rute</span><span>Flade</span><span style={{ textAlign: "right" }}>Besøg</span><span style={{ textAlign: "right" }}>Brugere</span>
              <span style={{ textAlign: "right" }}>Trend</span><span>Måles i forløb</span>
            </div>
            {loading && !data && <div style={{ padding: 20 }}><Loading /></div>}
            {data && rows.length === 0 && (
              <p style={{ margin: 0, padding: "32px 20px", textAlign: "center", fontSize: 14, color: "#64748b" }}>
                Ingen ruter i perioden{q ? " matcher filteret" : ""}.
              </p>
            )}
            {rows.map((r) => (
              <div key={r.route} className="tg-row" style={{ display: "grid", gridTemplateColumns: COLS, alignItems: "center", gap: 12,
                padding: "12px 20px", borderBottom: "1px solid #e2e8f0", fontSize: 13 }}>
                <Code style={{ wordBreak: "break-all" }}>{r.route}</Code>
                <span style={{ color: "#64748b" }}>{r.surface}</span>
                <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmt(r.visits)}</span>
                <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmt(r.users)}</span>
                <span style={{ textAlign: "right" }}>{r.trend === null ? <b style={{ color: "#64748b", fontWeight: 600 }}>ny</b> : <Trend value={r.trend} />}</span>
                <span style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {r.journeys.map((j) => (
                    <span key={j.id} style={{ padding: "2px 8px", borderRadius: 9999, background: "rgba(37,99,235,0.1)", color: "#1d4ed8", fontSize: 11 }}>{j.name}</span>
                  ))}
                  {r.journeys.length === 0 && editable && (
                    <button type="button" onClick={() => startStep(r.route)} title={`Tilføj som trin i ${editable.name}`}
                      style={{ padding: "2px 8px", border: "1px dashed #cbd5e1", borderRadius: 9999, background: "transparent", color: "#475569",
                        font: `11px ${SANS}`, cursor: "pointer" }}>
                      + brug i forløb
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>
      <p style={{ margin: 0, fontSize: 12, color: "#64748b" }}>
        Id'er og tal i stien vises som <code style={{ fontFamily: MONO }}>:id</code>. Login-sider, /admin og det offentlige website spores ikke.
      </p>
    </>
  );
}
