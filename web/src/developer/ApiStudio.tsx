// /developer/studio/api — API Studio: register an API with a kildebeskrivelse (YAML), import it from a cURL command
// or an OpenAPI document, test the call, and save it so its datasets land in the data catalog (/admin/data). Uses the
// same server endpoints as Forbind API in /admin (server/app/routes/data.py); the YAML is the developer's artefact.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, errorText } from "../api";
import { EXAMPLE_SPEC, type DatasetSpec, type SourceSpec, emptyDataset, emptySource, fromParsed, slug, toYaml } from "../studio/spec";
import { opToDataset, parseCurl, parseOpenApi, type OpenApiResult } from "../studio/importers";
import { Alert, fmtDate, useLoad } from "../ui";
import { Empty, MONO, copy, gap } from "./parts";
import type { Catalog, CatalogSource, SourceDetail, TestResult } from "./types";

type Import = { kind: "curl" | "openapi"; text: string; result?: OpenApiResult; picked?: Set<string>; error?: string | null };

const cell = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

export default function ApiStudio() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const catalog = useLoad(() => api.get<Catalog>("/api/admin/data/catalog"));
  const sources = useMemo(() => (catalog.data?.sources ?? []).filter((s): s is CatalogSource & { id: number } => s.id !== null), [catalog.data]);

  const sourceId = params.get("source") ? Number(params.get("source")) : null;
  const isNew = params.get("new") === "1";
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [yaml, setYaml] = useState("");
  const [saved, setSaved] = useState("");
  const [parsed, setParsed] = useState<SourceSpec | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [testSet, setTestSet] = useState("");
  const [imp, setImp] = useState<Import | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dirty = yaml !== saved;

  const check = useCallback(async (text: string) => {
    try {
      const p = fromParsed(await api.post<SourceSpec & { datasets: DatasetSpec[] }>("/api/admin/data/sources/parse", { spec_yaml: text }));
      setParsed(p);
      setParseError(null);
      setTestSet((t) => (p.datasets.some((d) => d.key === t) ? t : p.datasets[0]?.key ?? ""));
      return p;
    } catch (e) {
      setParsed(null);
      setParseError(errorText(e));
      return null;
    }
  }, []);

  // Load the chosen source, or start from the example.
  useEffect(() => {
    setTest(null); setImp(null); setError(null); setNotice(null);
    if (sourceId) {
      api.get<SourceDetail>(`/api/admin/data/sources/${sourceId}`).then((d) => {
        setDetail(d); setYaml(d.spec_yaml); setSaved(d.spec_yaml); check(d.spec_yaml);
      }).catch((e) => setError(errorText(e)));
    } else {
      setDetail(null);
      const text = isNew ? EXAMPLE_SPEC : "";
      setYaml(text); setSaved(text); setParsed(null); setParseError(null);
      if (isNew) check(text);
    }
  }, [sourceId, isNew, check]);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what); setError(null); setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const runTest = () => run("test", async () => {
    const p = await check(yaml);
    if (!p) return;
    setTest(await api.post<TestResult>("/api/admin/data/sources/test", { spec_yaml: yaml, dataset: testSet || undefined, source_id: sourceId }));
  });

  const save = () => run("save", async () => {
    const p = await check(yaml);
    if (!p) return;
    if (sourceId) {
      const r = await api.put<{ id: number; added: string[]; removed: string[] }>(`/api/admin/data/sources/${sourceId}`, { spec_yaml: yaml });
      setSaved(yaml);
      setNotice(`Kilden er gemt${r.added.length ? ` · nye datasæt: ${r.added.join(", ")}` : ""}${r.removed.length ? ` · fjernet: ${r.removed.join(", ")}` : ""}`);
      setDetail(await api.get<SourceDetail>(`/api/admin/data/sources/${sourceId}`));
    } else {
      const r = await api.post<{ id: number; added: string[] }>("/api/admin/data/sources", { spec_yaml: yaml });
      setSaved(yaml);
      navigate(`/developer/studio/api?source=${r.id}`, { replace: true });
    }
    await catalog.reload();
  });

  const remove = () => {
    if (!detail || !confirm(`Slet kilden ${detail.key}? Dens ${detail.datasets.length} datasæt forsvinder fra kataloget, og MCP-værktøjer på dem fjernes.`)) return;
    run("delete", async () => {
      await api.del(`/api/admin/data/sources/${detail.id}`);
      await catalog.reload();
      setParams({});
    });
  };

  /** Merge an imported call into the description: new datasets after the existing ones (the example's go). */
  const merge = (patch: Partial<SourceSpec>, datasets: DatasetSpec[]) => {
    const base = parsed && yaml.trim() && yaml !== EXAMPLE_SPEC ? parsed : emptySource();
    const kept = base.datasets.filter((d) => d.key !== "datasaet1");
    const taken = new Set(kept.map((d) => d.key));
    const added = datasets.map((d) => {
      let key = d.key, n = 2;
      while (taken.has(key)) key = `${d.key.slice(0, 36)}-${n++}`;
      taken.add(key);
      return { ...d, key };
    });
    const next: SourceSpec = { ...base, ...patch, datasets: [...kept, ...added] };
    const text = toYaml(next);
    setYaml(text);
    setImp(null);
    check(text);
    setNotice(`${added.length} ${added.length === 1 ? "kald er tilføjet" : "kald er tilføjet"}. Ret felterne efter et testkald, og vælg en hemmelighed, hvis API'et kræver en nøgle.`);
  };

  const importCurl = () => {
    if (!imp) return;
    try {
      const r = parseCurl(imp.text);
      const host = new URL(r.base_url).hostname;
      const key = slug(r.path.split("/").filter(Boolean).pop() ?? "kald");
      const cls = parsed?.classification ?? "yellow";
      merge({ key: parsed?.key || slug(host.split(".").slice(-2, -1)[0] ?? "api"), name: parsed?.name || host, base_url: r.base_url,
              auth: r.auth.type !== "ingen" ? r.auth : parsed?.auth ?? emptySource().auth },
            [{ ...emptyDataset(1), key, name: key, path: r.path, params: r.params, classification: cls }]);
      if (r.notes.length) setNotice(r.notes.join(" "));
    } catch (e) {
      setImp({ ...imp, error: errorText(e) });
    }
  };

  const readOpenApi = (text: string) => {
    try {
      const result = parseOpenApi(text);
      setImp({ kind: "openapi", text, result, picked: new Set(result.ops.slice(0, 5).map((o) => o.id)), error: null });
    } catch (e) {
      setImp({ kind: "openapi", text, error: errorText(e) });
    }
  };

  const importOpenApi = () => {
    if (!imp?.result) return;
    const r = imp.result;
    const cls = parsed?.classification ?? "yellow";
    const picked = r.ops.filter((o) => imp.picked?.has(o.id)).map((o) => opToDataset(o, cls));
    merge({ key: parsed?.key || slug(r.title || "api", "api"), name: parsed?.name || r.title, base_url: r.base_url ?? parsed?.base_url ?? "https://",
            auth: r.auth && (!parsed || parsed.auth.type === "ingen") ? r.auth : parsed?.auth ?? emptySource().auth }, picked);
  };

  const editorOpen = isNew || !!sourceId;
  const okChecks = test?.checks.filter((c) => c.ok).length ?? 0;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
      <aside className="card" style={{ flex: "1 1 240px", maxWidth: 320, padding: 14, gap: 6 }} aria-label="API-kilder">
        <div className="spread">
          <strong>Kilder</strong>
          <Link to="/developer/studio/api?new=1" className="btn btn-primary btn-sm">+ Ny</Link>
        </div>
        {catalog.error && <Alert>{catalog.error}</Alert>}
        {catalog.data && sources.length === 0 && <p className="muted small" style={{ margin: "6px 0" }}>Ingen API-kilder endnu.</p>}
        {sources.map((s) => (
          <Link key={s.id} to={`/developer/studio/api?source=${s.id}`} className="list-row"
                aria-current={s.id === sourceId ? "page" : undefined}
                style={{ textDecoration: "none", padding: "8px 6px", borderRadius: 8, borderTop: 0,
                         background: s.id === sourceId ? "var(--hm-muted)" : undefined }}>
            <div className="stack" style={{ ...gap(2), minWidth: 0, flex: 1 }}>
              <span style={{ fontWeight: 600 }}>{s.name}</span>
              <span className="tiny muted" style={MONO}>{s.key} · {s.hosts[0] ?? ""}</span>
            </div>
            <span className="pill">{s.datasets}</span>
          </Link>
        ))}
        <p className="tiny muted" style={{ marginTop: 8 }}>
          Kildens egen database (<code>gaer</code>) kommer i kataloget fra <a href="/admin/data/explore">Udforsk</a>.
        </p>
      </aside>

      <section style={{ flex: "999 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }} data-deeplink="api-studio-editor">
        {!editorOpen ? (
          <Empty>Vælg en kilde til venstre, eller <Link to="/developer/studio/api?new=1">registrér et nyt API</Link>.</Empty>
        ) : (
          <>
            <div className="spread">
              <div className="stack" style={gap(2)}>
                <h2 style={{ margin: 0, fontSize: 20 }}>{detail ? detail.name : "Nyt API"}</h2>
                <span className="tiny muted" style={MONO}>
                  {detail ? `${detail.key} · ${detail.hosts.join(", ")} · gemt ${fmtDate(detail.updated_at)}` : "Kildebeskrivelsen gemmes først, når du trykker Udstil"}
                </span>
              </div>
              <div className="row" style={gap(8)}>
                <button className="btn btn-outline btn-sm" onClick={() => setImp(imp?.kind === "curl" ? null : { kind: "curl", text: "" })} aria-pressed={imp?.kind === "curl"}>Fra cURL</button>
                <button className="btn btn-outline btn-sm" onClick={() => setImp(imp?.kind === "openapi" ? null : { kind: "openapi", text: "" })} aria-pressed={imp?.kind === "openapi"}>Fra OpenAPI</button>
                {!detail && <button className="btn btn-ghost btn-sm" onClick={() => { setYaml(EXAMPLE_SPEC); check(EXAMPLE_SPEC); }}>Eksempel</button>}
              </div>
            </div>

            {imp?.kind === "curl" && (
              <div className="card" style={{ gap: 8 }}>
                <strong>Fra cURL</strong>
                <p className="muted small" style={{ margin: 0 }}>Indsæt en kommando. Kun GET bliver til et datasæt; nøgler i kommandoen gemmes aldrig — vælg en hemmelighed i beskrivelsen i stedet.</p>
                <textarea value={imp.text} onChange={(e) => setImp({ ...imp, text: e.target.value })} rows={4} spellCheck={false} style={MONO}
                          placeholder='curl -H "Accept: application/json" "https://api.example.dk/v1/kunder?side=1"' />
                {imp.error && <Alert>{imp.error}</Alert>}
                <div className="row" style={gap(8)}>
                  <button className="btn btn-primary btn-sm" disabled={!imp.text.trim()} onClick={importCurl}>Omsæt til beskrivelse</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setImp(null)}>Luk</button>
                </div>
              </div>
            )}
            {imp?.kind === "openapi" && (
              <div className="card" style={{ gap: 8 }}>
                <strong>Fra OpenAPI</strong>
                <p className="muted small" style={{ margin: 0 }}>Indsæt API'ets OpenAPI-dokument (JSON). Det læses her i browseren — intet hentes eller sendes. GET-endpoints uden sti-parametre kan blive til datasæt.</p>
                <textarea value={imp.text} onChange={(e) => readOpenApi(e.target.value)} rows={5} spellCheck={false} style={MONO} placeholder='{"openapi": "3.0.0", "paths": { … }}' />
                {imp.error && imp.text.trim() && <Alert>{imp.error}</Alert>}
                {imp.result && (
                  <>
                    <div className="small">{imp.result.title || "API"} · {imp.result.ops.length} GET-endpoints{imp.result.skipped ? ` · ${imp.result.skipped} sprunget over` : ""}{imp.result.authNote ? ` · ${imp.result.authNote}` : ""}</div>
                    <div className="stack" style={{ ...gap(4), maxHeight: 240, overflow: "auto" }}>
                      {imp.result.ops.map((o) => (
                        <label key={o.id} className="row small" style={gap(8)}>
                          <input type="checkbox" checked={imp.picked?.has(o.id) ?? false} onChange={(e) => {
                            const picked = new Set(imp.picked);
                            if (e.target.checked) picked.add(o.id); else picked.delete(o.id);
                            setImp({ ...imp, picked });
                          }} />
                          <code>{o.path}</code>
                          <span className="muted">{o.summary}</span>
                          <span className="tiny muted">{o.fields.length} felter{o.paged ? " · sider" : ""}</span>
                        </label>
                      ))}
                    </div>
                    <div className="row" style={gap(8)}>
                      <button className="btn btn-primary btn-sm" disabled={!imp.picked?.size} onClick={importOpenApi}>Tilføj {imp.picked?.size ?? 0} valgte</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setImp(null)}>Luk</button>
                    </div>
                  </>
                )}
              </div>
            )}

            <label className="field" style={{ gap: 6 }}>
              <span className="spread"><span>Kildebeskrivelse (YAML)</span>
                <span className="tiny muted" style={{ fontWeight: 400 }}>{dirty ? "ikke gemt" : detail ? "gemt" : ""}</span></span>
              <textarea value={yaml} onChange={(e) => setYaml(e.target.value)} rows={22} spellCheck={false}
                        style={{ ...MONO, fontSize: 12.5, lineHeight: 1.5, minHeight: 320 }} aria-label="Kildebeskrivelse" />
            </label>

            <div className="row" style={gap(8)}>
              <button className="btn btn-outline" disabled={!!busy || !yaml.trim()} onClick={() => run("check", async () => { await check(yaml); })}>Tjek</button>
              <div className="row" style={gap(6)}>
                <button className="btn btn-outline" disabled={!!busy || !yaml.trim()} onClick={runTest}>{busy === "test" ? "Tester …" : "Test kald"}</button>
                {parsed && parsed.datasets.length > 1 && (
                  <select value={testSet} onChange={(e) => setTestSet(e.target.value)} aria-label="Datasæt til testkald" style={{ padding: "7px 10px" }}>
                    {parsed.datasets.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
                  </select>
                )}
              </div>
              <button className="btn btn-primary" disabled={!!busy || !yaml.trim() || (!dirty && !!detail)} onClick={save}>
                {busy === "save" ? "Gemmer …" : detail ? "Gem og opdatér kataloget" : "Udstil i kataloget"}
              </button>
              {detail && <button className="btn btn-ghost" style={{ color: "#b91c1c", marginLeft: "auto" }} disabled={!!busy} onClick={remove}>Slet kilde</button>}
            </div>

            {error && <Alert>{error}</Alert>}
            {notice && <Alert kind="success">{notice}</Alert>}
            {parseError && <Alert kind="warn">Beskrivelsen kan ikke læses: {parseError}</Alert>}

            {parsed && (
              <div className="card" style={{ gap: 8 }}>
                <div className="spread">
                  <strong>{parsed.name} <span className="tiny muted" style={MONO}>{parsed.key}</span></strong>
                  <span className="tiny muted" style={MONO}>{parsed.base_url} · auth: {parsed.auth.type}</span>
                </div>
                <div className="table-wrap" style={{ border: 0 }}>
                  <table className="data">
                    <thead><tr><th>Datasæt</th><th>Kald</th><th>Parametre</th><th>Felter</th><th>Klassifikation</th></tr></thead>
                    <tbody>
                      {parsed.datasets.map((d) => (
                        <tr key={d.key}>
                          <td><strong>{d.name}</strong> <span className="tiny muted" style={MONO}>{d.key}</span></td>
                          <td style={MONO}>GET {d.path}{d.paging ? <span className="tiny muted"> · sider</span> : null}</td>
                          <td className="small">{Object.keys(d.params).join(", ") || "—"}</td>
                          <td className="num">{d.fields.length}</td>
                          <td><span className={`pill ${d.classification === "white" ? "" : d.classification === "green" ? "green" : d.classification === "yellow" ? "amber" : "red"}`}>{d.classification}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {test && (
              <div className="card" style={{ gap: 10 }} aria-live="polite">
                <div className="spread">
                  <strong>Testkald</strong>
                  <span className="tiny muted">{okChecks}/{test.checks.length} tjek OK</span>
                </div>
                <ul style={{ margin: 0, paddingLeft: 18 }} className="small">
                  {test.checks.map((c, i) => <li key={i} style={{ color: c.ok ? "#166534" : "#92400e" }}>{c.ok ? "✓" : "!"} {c.text}</li>)}
                </ul>
                {test.error && <Alert>{test.error}</Alert>}
                {test.preview && (
                  <>
                    <div className="tiny muted" style={MONO}>GET {test.preview.url} · {test.preview.ms} ms · {test.preview.rows.length} rækker</div>
                    <div className="table-wrap">
                      <table className="data">
                        <thead><tr>{test.preview.columns.map((c) => <th key={c.name}>{c.label}{c.masked ? " 🔒" : ""}</th>)}</tr></thead>
                        <tbody>
                          {test.preview.rows.map((r, i) => (
                            <tr key={i}>{test.preview!.columns.map((c) => <td key={c.name} style={MONO}>{cell(r[c.name])}</td>)}</tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            )}

            {detail && (
              <div className="card" style={{ gap: 8 }}>
                <div className="spread">
                  <strong>I kataloget</strong>
                  <div className="row" style={gap(8)}>
                    <a href={`/admin/data?source=${detail.key}`} className="btn btn-outline btn-sm">Åbn i /admin/data ↗</a>
                    <Link to="/developer/studio/mcp" className="btn btn-outline btn-sm">Udstil via MCP →</Link>
                  </div>
                </div>
                {detail.datasets.length === 0 ? <p className="muted small" style={{ margin: 0 }}>Ingen datasæt.</p> : (
                  <div>
                    {detail.datasets.map((d) => (
                      <div key={d.id} className="list-row">
                        <strong style={{ flex: "1 1 160px" }}>{d.name}</strong>
                        <span className="tiny muted" style={MONO}>{d.key}</span>
                        <a href={`/admin/data/${d.id}`} className="small">Felter og klassifikation ↗</a>
                        <a href={`/admin/data/${d.id}?tab=udforsk`} className="small">Udforsk ↗</a>
                      </div>
                    ))}
                  </div>
                )}
                {detail.secrets.length > 0 && (
                  <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                    {detail.secrets.map((s) => <li key={s.ref} style={{ color: s.ok ? "#166534" : "#92400e" }}>{s.ok ? "✓" : "!"} {s.text}</li>)}
                  </ul>
                )}
                <div className="row" style={gap(8)}>
                  <button className="btn btn-ghost btn-sm" onClick={async () => setNotice((await copy(yaml)) ? "Beskrivelsen er kopieret" : "Kunne ikke kopiere")}>Kopiér YAML</button>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
