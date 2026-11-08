// /admin/data/connect → Forbind API: write or edit a kildebeskrivelse, test it and save it (DATA.md, DataConnect.dc.html).
// ?source=<id> edits an existing source.
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Play, Save, Trash2 } from "lucide-react";
import { api, errorText } from "../../../api";
import { Btn, ErrorBox, PageTitle, useToast } from "../../ui";
import { card, MONO, sectionLabel, select } from "../../theme";
import { cell, EXAMPLE_SPEC, srOnly } from "./types";

type TestResult = {
  source: { key: string; name: string; host: string };
  datasets: { key: string; name: string; call: string; fields: number; paged: boolean }[];
  preview: { dataset: string; url: string; ms: number; rows: Record<string, unknown>[]; columns: { name: string; label: string; masked: boolean }[] } | null;
  error: string | null;
  checks: { ok: boolean; text: string }[];
};
type SourceData = { id: number; key: string; name: string; spec_yaml: string; hosts: string[]; datasets: { id: number; key: string; name: string }[] };

export default function Connect() {
  const say = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const sourceId = params.get("source");
  const [spec, setSpec] = useState(sourceId ? "" : EXAMPLE_SPEC);
  const [source, setSource] = useState<SourceData | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [dataset, setDataset] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!sourceId) return;
    api.get<SourceData>(`/api/admin/data/sources/${sourceId}`).then((s) => {
      setSource(s);
      setSpec(s.spec_yaml);
    }, (e) => setError(errorText(e)));
  }, [sourceId]);

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<TestResult>("/api/admin/data/sources/test",
        { spec_yaml: spec, dataset: dataset || null, source_id: source?.id ?? null });
      setTest(r);
      setError(null);
    } catch (e) {
      setTest(null);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      if (source) {
        const r = await api.put<{ added: string[]; removed: string[] }>(`/api/admin/data/sources/${source.id}`, { spec_yaml: spec });
        say(`Gemt${r.added.length ? ` · nye datasæt: ${r.added.join(", ")}` : ""}${r.removed.length ? ` · fjernet: ${r.removed.join(", ")}` : ""}`);
      } else {
        const r = await api.post<{ id: number }>("/api/admin/data/sources", { spec_yaml: spec });
        say("Kilden er gemt, og dens datasæt er i kataloget");
        navigate(`/data/connect?source=${r.id}`, { replace: true });
      }
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!source || !confirm(`Slet kilden ${source.name}? Dens datasæt forsvinder fra kataloget. API'et selv berøres ikke.`)) return;
    try {
      await api.del(`/api/admin/data/sources/${source.id}`);
      say("Kilden er slettet");
      navigate("/data");
    } catch (e) {
      say(errorText(e));
    }
  };

  return (
    <>
      <nav aria-label="Brødkrumme" style={{ fontSize: 13, color: "#64748b", display: "flex", gap: 6 }}>
        <Link to="/data/explore">Udforsk</Link><span>/</span><span style={{ color: "#020817", fontWeight: 500 }}>Forbind API</span>
      </nav>
      <PageTitle title={source ? `Redigér ${source.name}` : "Forbind et API"}>
        Beskriv hvordan API'et kaldes, og hvordan svaret bliver til rækker. Serveren kalder API'et — nøgler kommer aldrig ud i browseren —
        og hvert endpoint bliver et datasæt, du kan udforske og klassificere.
      </PageTitle>
      {error && <ErrorBox>{error}</ErrorBox>}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        <section aria-label="Kildebeskrivelse" style={{ ...card, flex: "999 1 560px", minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1px solid #e2e8f0", background: "#f8fafc",
            borderRadius: "16px 16px 0 0", fontSize: 12, color: "#64748b", flexWrap: "wrap" }}>
            <span style={{ font: `600 12px ${MONO}`, color: "#334155" }}>Kildebeskrivelse (YAML)</span>
            <span style={{ marginLeft: "auto" }}>Kun type: rest indtil videre. OpenAPI, GraphQL og MCP kommer senere.</span>
          </div>
          <label style={{ display: "flex" }}>
            <span style={srOnly}>Kildebeskrivelse</span>
            <textarea value={spec} onChange={(e) => setSpec(e.target.value)} spellCheck={false} rows={30}
              style={{ width: "100%", boxSizing: "border-box", border: 0, padding: "14px 16px", resize: "vertical", outline: "none",
                font: `12.5px/1.65 ${MONO}`, color: "#1e293b", whiteSpace: "pre", overflow: "auto", minHeight: 420 }} />
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "12px 16px", borderTop: "1px solid #e2e8f0" }}>
            {test && test.datasets.length > 1 && (
              <label style={{ display: "flex" }}>
                <span style={srOnly}>Datasæt til testkald</span>
                <select value={dataset} onChange={(e) => setDataset(e.target.value)} style={select}>
                  <option value="">Test: {test.datasets[0].name}</option>
                  {test.datasets.slice(1).map((d) => <option key={d.key} value={d.key}>Test: {d.name}</option>)}
                </select>
              </label>
            )}
            <Btn icon={Play} onClick={run} disabled={busy || !spec.trim()}>Test kald</Btn>
            {source && <Btn icon={Trash2} onClick={remove} disabled={busy}>Slet kilde</Btn>}
            <Btn kind="primary" icon={Save} onClick={save} disabled={busy || !spec.trim()} style={{ marginLeft: "auto" }}>
              {source ? "Gem ændringer" : "Gem kilde"}
            </Btn>
          </div>
        </section>

        <aside aria-label="Resultat" style={{ flex: "1 1 320px", maxWidth: "100%", display: "flex", flexDirection: "column", gap: 12 }}>
          {!test && (
            <div style={{ ...card, padding: 16, fontSize: 13, color: "#475569", display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={sectionLabel}>Sådan</span>
              <span>1. Skriv eller ret beskrivelsen. 2. Tryk “Test kald”. 3. Gem — datasættene kommer i kataloget.</span>
              <span>En nøgle til API'et lægges i en miljøvariabel, der starter med <code style={{ fontFamily: MONO }}>DATA_SECRET_</code>, og
                nævnes med <code style={{ fontFamily: MONO }}>auth.hemmelighed</code>.</span>
            </div>
          )}
          {test && (
            <>
              <div style={{ ...card, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={sectionLabel}>Bliver til datasæt</span>
                {test.datasets.map((d) => (
                  <div key={d.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: 10, borderRadius: 10, background: "#f8fafc" }}>
                    <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{d.name}</span>
                      <span style={{ font: `11px ${MONO}`, color: "#64748b" }}>{d.call}{d.paged ? " · side for side" : ""}</span>
                    </span>
                    <span style={{ fontSize: 12, color: "#475569" }}>{d.fields} felter</span>
                  </div>
                ))}
              </div>
              {test.preview && (
                <div style={{ ...card, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                  <span style={sectionLabel}>Testkald · {test.preview.ms} ms</span>
                  <code style={{ font: `11px ${MONO}`, color: "#64748b", wordBreak: "break-all" }}>{test.preview.url}</code>
                  <div style={{ overflowX: "auto", border: "1px solid #f1f5f9", borderRadius: 10 }}>
                    <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
                      <thead>
                        <tr style={{ background: "#f8fafc" }}>
                          {test.preview.columns.map((c) => <th key={c.name} scope="col" style={{ textAlign: "left", padding: "6px 10px", color: "#64748b",
                            fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>{c.label}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {test.preview.rows.map((r, i) => (
                          <tr key={i} style={{ borderTop: "1px solid #f1f5f9" }}>
                            {test.preview!.columns.map((c) => <td key={c.name} style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>{cell(r[c.name])}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              <div style={{ ...card, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={sectionLabel}>Tjek</span>
                {test.checks.map((c, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
                    <span aria-label={c.ok ? "OK" : "Bemærk"} style={{ width: 18, height: 18, flex: "none", borderRadius: 9999, display: "inline-flex",
                      alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700,
                      background: c.ok ? "rgba(22,163,74,0.12)" : "rgba(249,115,22,0.12)", color: c.ok ? "#166534" : "#9a3412" }}>{c.ok ? "✓" : "!"}</span>
                    <span style={{ color: "#334155" }}>{c.text}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </aside>
      </div>
    </>
  );
}
