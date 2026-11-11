// /admin/data/connect → Forbind API: describe an API source as a form, in YAML, from an OpenAPI document or from a cURL
// command; sign in with secrets from Hemmeligheder ("Brug i kilde", approved by the secret's A, R and C); test and save.
// ?source=<id> edits an existing source. Design: the canvas "Data · Udforsk og Forbind API".
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Check, FileJson, KeyRound, Play, Plus, Save, Terminal, Trash2, TriangleAlert } from "lucide-react";
import { api, errorText } from "../../../api";
import { Btn, ErrorBox, IconBtn, PageTitle, fmtDay, useToast } from "../../ui";
import { card, input, MONO, sectionLabel, select } from "../../theme";
import { CLS, CLS_KEYS, type Cls, cell, EXAMPLE_SPEC, srOnly } from "./types";
import {
  AUTH_TYPES, type AuthType, DATA_TYPES, type DataType, type DatasetSpec, emptyDataset, emptySource, fieldName, fromParsed,
  isEnvRef, secretRefs, slug, type SourceSpec, toYaml,
} from "./connect/model";
import { opToDataset, parseCurl, parseOpenApi, type CurlResult, type OpenApiResult } from "./connect/importers";
import SecretPicker, { rotationLabel, type SecretItem, secretState } from "./connect/SecretPicker";

type SecretStatus = {
  ref: string; used_as: string; kind: "env" | "vault"; ok: boolean; how: "source" | "own" | "env" | null; text: string;
  secret_id: number | null; grant_expires_at: string | null; pending: { id: number; approved: number; total: number } | null;
};
type TestResult = {
  source: { key: string; name: string; host: string; hosts: string[]; auth: string };
  datasets: { key: string; name: string; call: string; fields: number; paged: boolean }[];
  secrets: SecretStatus[];
  preview: { dataset: string; url: string; ms: number; rows: Record<string, unknown>[]; columns: { name: string; label: string; masked: boolean }[] } | null;
  error: string | null;
  checks: { ok: boolean; text: string }[];
};
type SourceData = { id: number; key: string; name: string; spec_yaml: string; hosts: string[]; datasets: { id: number; key: string; name: string }[]; secrets: SecretStatus[] };
type Mode = "form" | "yaml" | "openapi" | "curl";
type Target = { kind: "auth" } | { kind: "header"; index: number };

const MODES: { mode: Mode; label: string }[] = [
  { mode: "form", label: "Formular" }, { mode: "yaml", label: "YAML" }, { mode: "openapi", label: "Importér OpenAPI" }, { mode: "curl", label: "Fra cURL" },
];
const SECRET_LABEL: Record<AuthType, string> = { ingen: "", bearer: "Token", header: "Nøgle", basic: "Adgangskode", oauth2: "Client secret" };
const lbl: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, fontSize: 13, fontWeight: 500, minWidth: 0 };
const mono: CSSProperties = { ...input, fontFamily: MONO, fontSize: 13, width: "100%" };
const txt: CSSProperties = { ...input, width: "100%" };

function hostOf(url: string | null | undefined): string | null {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}

export default function Connect() {
  const say = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const sourceId = params.get("source");
  const [mode, setMode] = useState<Mode>("form");
  const [model, setModel] = useState<SourceSpec>(emptySource);
  const [yaml, setYaml] = useState("");
  const [source, setSource] = useState<SourceData | null>(null);
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [test, setTest] = useState<TestResult | null>(null);
  const [testSet, setTestSet] = useState("");
  const [current, setCurrent] = useState(0);
  const [picker, setPicker] = useState<Target | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const loadSecrets = useCallback(async (id: number | null) => {
    try {
      setSecrets((await api.get<{ items: SecretItem[] }>(`/api/admin/data/secrets${id ? `?source_id=${id}` : ""}`)).items);
    } catch {
      setSecrets([]); // without the Drift role or Hemmeligheder the picker is just empty
    }
  }, []);

  const parse = useCallback(async (text: string) => fromParsed(await api.post<SourceSpec & { datasets: DatasetSpec[] }>("/api/admin/data/sources/parse", { spec_yaml: text })), []);

  useEffect(() => {
    (async () => {
      try {
        let text = EXAMPLE_SPEC;
        if (sourceId) {
          const s = await api.get<SourceData>(`/api/admin/data/sources/${sourceId}`);
          setSource(s);
          text = s.spec_yaml;
        }
        setYaml(text);
        await loadSecrets(sourceId ? Number(sourceId) : null);
        try {
          setModel(await parse(text));
        } catch (e) {
          setMode("yaml");
          setError(`Beskrivelsen kan ikke vises som formular: ${errorText(e)}`);
        }
      } catch (e) {
        setError(errorText(e));
      } finally {
        setLoaded(true);
      }
    })();
  }, [sourceId, loadSecrets, parse]);

  // The form is the truth in form mode; the YAML follows it.
  const update = (next: SourceSpec) => {
    setModel(next);
    setYaml(toYaml(next));
  };
  const patch = (p: Partial<SourceSpec>) => update({ ...model, ...p });
  const patchAuth = (p: Partial<SourceSpec["auth"]>) => update({ ...model, auth: { ...model.auth, ...p } });
  const patchSet = (i: number, p: Partial<DatasetSpec>) => update({ ...model, datasets: model.datasets.map((d, j) => (j === i ? { ...d, ...p } : d)) });

  const switchMode = async (next: Mode) => {
    if (next === mode) return;
    if (mode === "yaml" && next !== "yaml") {
      try {
        setModel(await parse(yaml));
        setError(null);
      } catch (e) {
        setError(`Ret YAML'en først: ${errorText(e)}`);
        return;
      }
    }
    setMode(next);
  };

  const dirty = source ? yaml.trim() !== source.spec_yaml.trim() : true;
  const byRef = useMemo(() => new Map(secrets.map((s) => [s.ref.toLowerCase(), s])), [secrets]);
  const refs = secretRefs(model);

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<TestResult>("/api/admin/data/sources/test", { spec_yaml: yaml, dataset: testSet || null, source_id: source?.id ?? null });
      setTest(r);
      setError(null);
    } catch (e) {
      setTest(null);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const saveText = async (text: string): Promise<number> => {
    if (source) {
      const r = await api.put<{ added: string[]; removed: string[] }>(`/api/admin/data/sources/${source.id}`, { spec_yaml: text });
      say(`Gemt${r.added.length ? ` · nye datasæt: ${r.added.join(", ")}` : ""}${r.removed.length ? ` · fjernet: ${r.removed.join(", ")}` : ""}`);
      const s = await api.get<SourceData>(`/api/admin/data/sources/${source.id}`);
      setSource(s);
      await loadSecrets(s.id);
      return s.id;
    }
    const r = await api.post<{ id: number }>("/api/admin/data/sources", { spec_yaml: text });
    say("Kilden er gemt, og dens datasæt er i kataloget");
    navigate(`/data/connect?source=${r.id}`, { replace: true });
    return r.id;
  };

  const save = async () => {
    setBusy(true);
    try {
      await saveText(yaml);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!source || !confirm(`Slet kilden ${source.name}? Dens datasæt forsvinder fra kataloget, og dens adgange til hemmeligheder ophører. API'et selv berøres ikke.`)) return;
    try {
      await api.del(`/api/admin/data/sources/${source.id}`);
      say("Kilden er slettet");
      navigate("/data");
    } catch (e) {
      say(errorText(e));
    }
  };

  const withRef = (m: SourceSpec, t: Target, ref: string): SourceSpec =>
    t.kind === "auth" ? { ...m, auth: { ...m.auth, secret: ref } }
      : { ...m, auth: { ...m.auth, headers: m.auth.headers.map((h, i) => (i === t.index ? { ...h, secret: ref } : h)) } };

  const pick = (ref: string) => {
    if (!picker) return;
    update(withRef(model, picker, ref));
    setPicker(null);
  };

  const requestUse = async (s: SecretItem, days: number, reason: string) => {
    const next = picker ? withRef(model, picker, s.ref) : model;
    const text = toYaml(next);
    update(next);
    let id = source?.id ?? null;
    if (!id || text.trim() !== source?.spec_yaml.trim()) id = await saveText(text);
    try {
      await api.post(`/api/admin/data/sources/${id}/secret-requests`, { secret_id: s.id, days, reason });
    } catch (e) {
      throw new Error(errorText(e));
    }
    say(`Anmodningen er sendt til ${s.approvers.map((a) => a.name).join(", ") || "en administrator"}`);
    setPicker(null);
    await loadSecrets(id);
  };

  const askFor = async (ref: string) => {
    const s = byRef.get(ref.toLowerCase());
    if (!s) return;
    setPicker(refs.find((r) => r.ref === ref)?.usedAs === "auth" ? { kind: "auth" } : { kind: "header", index: model.auth.headers.findIndex((h) => h.secret === ref) });
  };

  // ── Steps ──
  const hosts = [hostOf(model.base_url), model.auth.type === "oauth2" ? hostOf(model.auth.token_url) : null].filter((h, i, a): h is string => !!h && a.indexOf(h) === i);
  const secretOk = (ref: string) => isEnvRef(ref) || secretState(byRef.get(ref.toLowerCase()), !!source).testable
    || !!byRef.get(ref.toLowerCase())?.source_request;
  const steps: { id: string; label: string; ok: boolean; warn?: boolean }[] = [
    { id: "kilde", label: "Kilde", ok: !!model.key && !!model.name && hosts.length > 0 },
    { id: "auth", label: "Godkendelse", ok: refs.every((r) => r.ref && secretOk(r.ref)) && (model.auth.type === "ingen" || !!model.auth.secret),
      warn: refs.some((r) => r.ref && !secretState(byRef.get(r.ref.toLowerCase()), !!source).usable && !isEnvRef(r.ref)) },
    { id: "endpoints", label: "Endpoints", ok: model.datasets.length > 0 && model.datasets.every((d) => d.path.startsWith("/")) },
    { id: "felter", label: "Felter", ok: model.datasets.every((d) => d.fields.length > 0 && d.fields.every((f) => f.label)) },
    { id: "graenser", label: "Grænser", ok: true },
    { id: "test", label: "Test og gem", ok: !!test?.preview && !dirty },
  ];
  const go = (id: string) => document.getElementById(`k-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const ds = model.datasets[current] ?? model.datasets[0];

  return (
    <>
      <nav aria-label="Brødkrumme" style={{ fontSize: 13, color: "#64748b", display: "flex", gap: 6 }}>
        <Link to="/data/explore">Udforsk</Link><span>/</span><span style={{ color: "#020817", fontWeight: 500 }}>Forbind API</span>
      </nav>
      <PageTitle title={source ? `Redigér ${source.name}` : "Forbind et API"}
        aside={<div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {source && <span style={{ fontSize: 12, color: dirty ? "#9a3412" : "#64748b" }}>{dirty ? "Ændringer er ikke gemt" : "Gemt"}</span>}
          <Btn icon={Play} onClick={run} disabled={busy || !yaml.trim()}>Test kald</Btn>
          <Btn kind="primary" icon={Save} onClick={save} disabled={busy || !yaml.trim() || (!!source && !dirty)}>{source ? "Gem ændringer" : "Gem kilde"}</Btn>
        </div>}>
        Serveren kalder API'et med nøgler fra Hemmeligheder. Kilden gemmer kun navnet på hemmeligheden — værdien kommer aldrig i browseren,
        beskrivelsen, loggen eller testsvaret. Hvert endpoint bliver et datasæt, du kan udforske og klassificere.
      </PageTitle>
      {error && <ErrorBox>{error}</ErrorBox>}

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <div role="tablist" aria-label="Beskriv kilden som" style={{ display: "inline-flex", padding: 4, gap: 2, background: "#f1f5f9", borderRadius: 10, flexWrap: "wrap" }}>
          {MODES.map((m) => (
            <button key={m.mode} type="button" role="tab" aria-selected={mode === m.mode} onClick={() => switchMode(m.mode)}
              style={{ border: 0, cursor: "pointer", padding: "7px 14px", borderRadius: 8, font: "inherit", fontSize: 13,
                background: mode === m.mode ? "#ffffff" : "transparent", fontWeight: mode === m.mode ? 600 : 400, color: mode === m.mode ? "#020817" : "#475569",
                boxShadow: mode === m.mode ? "0 1px 2px rgba(15,23,42,0.08)" : "none" }}>{m.label}</button>
          ))}
        </div>
        {mode === "form" && (
          <ol aria-label="Trin" style={{ listStyle: "none", margin: "0 0 0 auto", padding: 0, display: "flex", flexWrap: "wrap", gap: 6 }}>
            {steps.map((s, i) => (
              <li key={s.id}>
                <button type="button" onClick={() => go(s.id)} style={{ border: 0, cursor: "pointer", font: "inherit", display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "5px 10px", borderRadius: 9999, fontSize: 12, fontWeight: 600,
                  background: s.ok ? (s.warn ? "rgba(249,115,22,0.12)" : "rgba(22,163,74,0.12)") : "#f1f5f9", color: s.ok ? (s.warn ? "#9a3412" : "#166534") : "#475569" }}>
                  <span aria-hidden style={{ width: 18, height: 18, borderRadius: 9999, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11,
                    background: s.ok ? (s.warn ? "#ea580c" : "#16a34a") : "#ffffff", color: s.ok ? "#ffffff" : "#475569" }}>{s.ok && !s.warn ? <Check size={11} strokeWidth={3} /> : i + 1}</span>
                  {s.label}<span style={srOnly}>{s.ok ? (s.warn ? " (afventer)" : " (klar)") : " (mangler)"}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>

      {loaded && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
          <div style={{ flex: "999 1 600px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
            {mode === "yaml" && <YamlEditor value={yaml} onChange={setYaml} />}
            {mode === "openapi" && <OpenApiImport onUse={(r, picked) => {
              const merged = model.datasets.length === 1 && model.datasets[0].key === "datasaet1" ? [] : model.datasets;
              const taken = new Set(merged.map((d) => d.key));
              const added = picked.map((op) => {
                const d = opToDataset(op, model.classification ?? "yellow");
                let key = d.key, n = 2;
                while (taken.has(key)) key = `${d.key.slice(0, 36)}-${n++}`;
                taken.add(key);
                return { ...d, key };
              });
              update({
                ...model, key: model.key || slug(r.title || "api", "api"), name: model.name || r.title, base_url: r.base_url ?? model.base_url,
                auth: r.auth && model.auth.type === "ingen" ? r.auth : model.auth, datasets: [...merged, ...added],
              });
              say(`${added.length} endpoints er tilføjet. Vælg en hemmelighed, og tjek felterne`);
              setMode("form");
            }} />}
            {mode === "curl" && <CurlImport onUse={(r) => {
              const merged = model.datasets.length === 1 && model.datasets[0].key === "datasaet1" ? [] : model.datasets;
              const key = slug(r.path.split("/").filter(Boolean).pop() ?? "kald");
              update({
                ...model, key: model.key || slug(new URL(r.base_url).hostname.split(".").slice(-2, -1)[0] ?? "api"), name: model.name || new URL(r.base_url).hostname,
                base_url: r.base_url, auth: r.auth.type !== "ingen" ? r.auth : model.auth,
                datasets: [...merged, { ...emptyDataset(merged.length + 1), key, name: key, path: r.path, params: r.params }],
              });
              say("Kaldet er tilføjet. Vælg en hemmelighed, og ret felterne efter et testkald");
              setMode("form");
            }} />}
            {mode === "form" && (
              <>
                <Section id="kilde" title="1 · Kilde" ok={steps[0].ok}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                    <label style={lbl}>Nøgle<input value={model.key} disabled={!!source} onChange={(e) => patch({ key: e.target.value.toLowerCase() })} style={mono} placeholder="cvr" /></label>
                    <label style={lbl}>Navn<input value={model.name} onChange={(e) => patch({ name: e.target.value })} style={txt} placeholder="Virk · CVR-registret" /></label>
                    <label style={lbl}>Standardklassifikation
                      <select value={model.classification ?? "yellow"} onChange={(e) => {
                        const c = e.target.value as Cls, old = model.classification ?? "yellow";
                        update({ ...model, classification: c, datasets: model.datasets.map((d) => (d.classification === old ? { ...d, classification: c } : d)) });
                      }} style={select}>
                        {CLS_KEYS.map((c) => <option key={c} value={c}>{CLS[c].label}</option>)}
                      </select>
                    </label>
                  </div>
                  <label style={lbl}>Base-URL<input value={model.base_url} onChange={(e) => patch({ base_url: e.target.value.trim() })} style={mono} placeholder="https://api.example.dk" /></label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>Tilladte værter</span>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {hosts.map((h) => <span key={h} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", border: "1px solid #e2e8f0", borderRadius: 9999, font: `12px ${MONO}` }}>
                        <span aria-hidden style={{ width: 7, height: 7, borderRadius: 9999, background: "#16a34a" }} />{h}</span>)}
                      {hosts.length === 0 && <span style={{ fontSize: 12, color: "#9a3412" }}>Skriv en https-adresse</span>}
                    </div>
                    <span style={{ fontSize: 12, color: "#64748b" }}>Kun https · værter, der peger på interne adresser, afvises · omdirigeringer følges ikke. Token-værten for OAuth 2 kommer med automatisk.</span>
                  </div>
                </Section>

                <Section id="auth" title="2 · Godkendelse" ok={steps[1].ok} warn={steps[1].warn} highlight>
                  <div role="radiogroup" aria-label="Metode" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {AUTH_TYPES.map((a) => {
                      const on = model.auth.type === a.type;
                      return (
                        <button key={a.type} type="button" role="radio" aria-checked={on} title={a.hint} onClick={() => patchAuth({ type: a.type })}
                          style={{ cursor: "pointer", font: "inherit", padding: "7px 12px", borderRadius: 8, fontSize: 13, border: `1px solid ${on ? "#2563eb" : "#e2e8f0"}`,
                            background: on ? "#eff6ff" : "#ffffff", color: on ? "#1d4ed8" : "#334155", fontWeight: on ? 600 : 500 }}>{a.label}</button>
                      );
                    })}
                  </div>
                  {model.auth.type === "header" && (
                    <label style={lbl}>Headernavn<input value={model.auth.header ?? ""} onChange={(e) => patchAuth({ header: e.target.value })} style={mono} placeholder="X-Api-Key" /></label>
                  )}
                  {model.auth.type === "basic" && (
                    <label style={lbl}>Brugernavn<input value={model.auth.username ?? ""} onChange={(e) => patchAuth({ username: e.target.value })} style={txt} /></label>
                  )}
                  {model.auth.type === "oauth2" && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                      <label style={lbl}>Token-URL<input value={model.auth.token_url ?? ""} onChange={(e) => patchAuth({ token_url: e.target.value.trim() })} style={mono} placeholder="https://auth.example.dk/oauth2/token" /></label>
                      <label style={lbl}>Client-id<input value={model.auth.client_id ?? ""} onChange={(e) => patchAuth({ client_id: e.target.value })} style={mono} /></label>
                      <label style={lbl}>Scope (valgfri)<input value={model.auth.scope ?? ""} onChange={(e) => patchAuth({ scope: e.target.value || null })} style={mono} /></label>
                    </div>
                  )}
                  {model.auth.type !== "ingen" && (
                    <SecretSlot label={SECRET_LABEL[model.auth.type]} value={model.auth.secret} item={model.auth.secret ? byRef.get(model.auth.secret.toLowerCase()) : undefined}
                      saved={!!source} dirty={dirty} onChoose={() => setPicker({ kind: "auth" })} onAsk={() => model.auth.secret && askFor(model.auth.secret)} />
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>Ekstra headers fra hemmeligheder</span>
                    {model.auth.headers.map((h, i) => (
                      <div key={i} style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: 12, borderLeft: "2px solid #e2e8f0" }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                          <label style={{ ...lbl, flex: 1 }}>Headernavn<input value={h.name} onChange={(e) => patchAuth({ headers: model.auth.headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} style={mono} placeholder="X-Partner-Id" /></label>
                          <IconBtn icon={Trash2} label={`Fjern ${h.name || "header"}`} onClick={() => patchAuth({ headers: model.auth.headers.filter((_, j) => j !== i) })} />
                        </div>
                        <SecretSlot label={h.name || "Header"} value={h.secret || null} item={h.secret ? byRef.get(h.secret.toLowerCase()) : undefined}
                          saved={!!source} dirty={dirty} onChoose={() => setPicker({ kind: "header", index: i })} onAsk={() => askFor(h.secret)} />
                      </div>
                    ))}
                    {model.auth.headers.length < 5 && (
                      <div><Btn icon={Plus} height={32} onClick={() => patchAuth({ headers: [...model.auth.headers, { name: "", secret: "" }] })}>Tilføj header</Btn></div>
                    )}
                  </div>
                </Section>

                <Section id="endpoints" title="3 · Endpoints → datasæt" ok={steps[2].ok}
                  aside={<div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
                    <Btn height={32} icon={FileJson} onClick={() => switchMode("openapi")}>Fra OpenAPI</Btn>
                    <Btn height={32} icon={Plus} onClick={() => { update({ ...model, datasets: [...model.datasets, { ...emptyDataset(model.datasets.length + 1), classification: model.classification ?? "yellow" }] }); setCurrent(model.datasets.length); }}>Tilføj endpoint</Btn>
                  </div>}>
                  <div style={{ overflowX: "auto", margin: "0 -20px", minWidth: 0, position: "relative" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
                      <thead><tr style={{ background: "#f8fafc", textAlign: "left" }}>
                        {["Kald", "Datasæt", "Sider", "Felter", ""].map((h, i) => <th key={i} scope="col" style={{ padding: "8px 12px", paddingLeft: i === 0 ? 20 : 12, ...th }}>{h}</th>)}
                      </tr></thead>
                      <tbody>
                        {model.datasets.map((d, i) => (
                          <tr key={i} style={{ borderTop: "1px solid #f1f5f9", background: i === current ? "#eff6ff" : "#ffffff", cursor: "pointer" }} onClick={() => setCurrent(i)}>
                            <td style={{ padding: "10px 12px 10px 20px", whiteSpace: "nowrap" }}>
                              <span style={{ font: `600 11px ${MONO}`, padding: "2px 6px", borderRadius: 6, background: "rgba(37,99,235,0.1)", color: "#1d4ed8" }}>GET</span>{" "}
                              <code style={{ fontSize: 12.5 }}>{d.path}</code>
                            </td>
                            <td style={{ padding: "10px 12px" }}><button type="button" onClick={() => setCurrent(i)} style={{ all: "unset", cursor: "pointer", fontWeight: 600 }}>{d.name}</button></td>
                            <td style={{ padding: "10px 12px", color: "#475569" }}>{d.paging ? `side for side · ${d.paging.max} maks.` : "—"}</td>
                            <td style={{ padding: "10px 12px" }}>{d.fields.length}</td>
                            <td style={{ padding: "6px 12px", textAlign: "right" }}>
                              {model.datasets.length > 1 && <IconBtn icon={Trash2} label={`Fjern ${d.name}`} onClick={() => { update({ ...model, datasets: model.datasets.filter((_, j) => j !== i) }); setCurrent(0); }} />}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Section>

                {ds && <DatasetEditor key={current} ds={ds} onChange={(p) => patchSet(model.datasets.indexOf(ds), p)} />}

                <Section id="graenser" title="5 · Grænser" ok>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
                    <label style={lbl}>Kald pr. minut<input type="number" min={1} max={600} value={model.limits.per_minute} onChange={(e) => patch({ limits: { ...model.limits, per_minute: Number(e.target.value) } })} style={txt} /></label>
                    <label style={lbl}>Timeout (sekunder)<input type="number" min={1} max={30} value={model.limits.timeout} onChange={(e) => patch({ limits: { ...model.limits, timeout: Number(e.target.value) } })} style={txt} /></label>
                    <label style={lbl}>Cache (minutter)<input type="number" min={0} max={1440} value={model.limits.cache_min} onChange={(e) => patch({ limits: { ...model.limits, cache_min: Number(e.target.value) } })} style={txt} /></label>
                  </div>
                  <span style={{ fontSize: 12, color: "#64748b" }}>Svar over 5 MB eller 1.000 rækker afvises. Cachen gælder kun svar; adgangen til hemmeligheder tjekkes ved hvert kald.</span>
                </Section>
              </>
            )}
          </div>

          <aside id="k-test" aria-label="Test og resultat" style={{ flex: "1 1 380px", maxWidth: "100%", display: "flex", flexDirection: "column", gap: 16 }}>
            <TestPanel test={test} busy={busy} datasets={model.datasets} testSet={testSet} setTestSet={setTestSet} onRun={run} />
            <div style={{ ...card, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
              <span style={sectionLabel}>Når du gemmer</span>
              <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "#334155", lineHeight: 1.45 }}>
                <li>{model.datasets.length} {model.datasets.length === 1 ? "datasæt" : "datasæt"} i kataloget; felter, du har klassificeret som gule eller røde, vises maskeret</li>
                <li>Serveren må kun kalde {hosts.join(" og ") || "værten i base-URL'en"}</li>
                {refs.length > 0 && <li>Kilden nævner {refs.map((r) => r.ref).filter(Boolean).join(", ")}. Den kan først bruge en hemmelighed, når A, R og C har godkendt Brug i kilde</li>}
                <li>Audit: kilden og navnene på dens hemmeligheder — aldrig værdier</li>
              </ul>
              {source && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Link to="/data" style={{ fontSize: 13, fontWeight: 600 }}>Se datasættene i kataloget →</Link>
                <Btn height={32} icon={Trash2} onClick={remove} disabled={busy} style={{ marginLeft: "auto" }}>Slet kilde</Btn>
              </div>}
            </div>
            {mode === "form" && (
              <details style={{ ...card, overflow: "hidden" }}>
                <summary style={{ cursor: "pointer", padding: "12px 16px", background: "#f8fafc", font: `600 12px ${MONO}`, color: "#334155" }}>Kildebeskrivelse (YAML)</summary>
                <pre style={{ margin: 0, padding: "12px 16px", font: `12px/1.65 ${MONO}`, color: "#1e293b", whiteSpace: "pre", overflowX: "auto", maxHeight: 420 }}>{yaml}</pre>
              </details>
            )}
          </aside>
        </div>
      )}

      {picker && (
        <SecretPicker
          title={picker.kind === "auth" ? SECRET_LABEL[model.auth.type].toLowerCase() : `headeren ${model.auth.headers[picker.index]?.name || ""}`}
          current={picker.kind === "auth" ? model.auth.secret : model.auth.headers[picker.index]?.secret ?? null}
          items={secrets} sourceSaved={!!source} onPick={pick} onRequest={requestUse} onClose={() => setPicker(null)} />
      )}
    </>
  );
}

const th: CSSProperties = { fontSize: 11, letterSpacing: "0.05em", textTransform: "uppercase", color: "#64748b", fontWeight: 600 };

function Section({ id, title, ok, warn, highlight, aside, children }: { id: string; title: string; ok?: boolean; warn?: boolean; highlight?: boolean; aside?: ReactNode; children: ReactNode }) {
  return (
    <section id={`k-${id}`} aria-labelledby={`k-${id}-h`} style={{ ...card, border: highlight && warn ? "2px solid #fdba74" : card.border, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 14, scrollMarginTop: 16, minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <h2 id={`k-${id}-h`} style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{title}</h2>
        {ok !== undefined && <span style={{ fontSize: 12, fontWeight: 600, padding: "2px 8px", borderRadius: 9999,
          background: ok ? (warn ? "rgba(249,115,22,0.12)" : "rgba(22,163,74,0.12)") : "#f1f5f9", color: ok ? (warn ? "#9a3412" : "#166534") : "#475569" }}>
          {ok ? (warn ? "Afventer adgang" : "OK") : "Mangler"}</span>}
        {aside}
      </div>
      {children}
    </section>
  );
}

function SecretSlot({ label, value, item, saved, dirty, onChoose, onAsk }: {
  label: string; value: string | null; item: SecretItem | undefined; saved: boolean; dirty: boolean; onChoose: () => void; onAsk: () => void;
}) {
  if (!value) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{label}</span>
        <button type="button" onClick={onChoose} style={{ cursor: "pointer", font: "inherit", display: "flex", alignItems: "center", gap: 10, padding: 14, borderRadius: 12,
          border: "1px dashed #94a3b8", background: "#f8fafc", color: "#1d4ed8", fontWeight: 600, fontSize: 13 }}>
          <KeyRound size={16} aria-hidden />Vælg hemmelighed fra Hemmeligheder
        </button>
      </div>
    );
  }
  if (isEnvRef(value)) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{label}</span>
        <div style={{ border: "1px solid #fed7aa", background: "#fff7ed", borderRadius: 12, padding: 14, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <TriangleAlert size={16} color="#9a3412" aria-hidden />
          <code style={{ fontWeight: 600 }}>{value}</code>
          <span style={{ fontSize: 12, fontWeight: 600, padding: "2px 8px", borderRadius: 9999, background: "rgba(249,115,22,0.16)", color: "#9a3412" }}>Miljøvariabel</span>
          <span style={{ fontSize: 12, color: "#475569", flex: "1 1 100%" }}>Ingen version, ansvarlig eller påmindelse om rotation. Opret værdien i Hemmeligheder, og vælg den her i stedet.</span>
          <Btn height={32} onClick={onChoose}>Vælg fra Hemmeligheder</Btn>
        </div>
      </div>
    );
  }
  const st = secretState(item, saved);
  const rot = item ? rotationLabel(item) : null;
  const canAsk = !!item && !item.source_grant && !item.source_request && item.status !== "orphaned";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 500 }}>{label}</span>
      <div style={{ border: `1px solid ${st.usable ? "#e2e8f0" : "#fed7aa"}`, background: st.usable ? "#f8fafc" : "#fff7ed", borderRadius: 12, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <KeyRound size={16} color={st.usable ? "#166534" : "#9a3412"} aria-hidden />
          <code style={{ fontSize: 14, fontWeight: 600 }}>{value}</code>
          {item && <span style={{ fontSize: 12, color: "#475569" }}>version {item.version}</span>}
          <span style={{ fontSize: 12, fontWeight: 600, padding: "2px 8px", borderRadius: 9999, background: st.bg, color: st.fg }}>{st.label}</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {item && <Link to={`/secrets/${item.id}`} style={{ fontSize: 13, fontWeight: 600, alignSelf: "center" }}>Åbn</Link>}
            <Btn height={32} onClick={onChoose}>Skift</Btn>
          </span>
        </div>
        {item && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, fontSize: 12 }}>
            <Info k="Ejer" v={`Gruppen ${item.group.name}`} />
            <Info k="Accountable" v={item.accountable?.name ?? "Ingen"} />
            <Info k="Regel" v={item.rule_label} />
            <Info k={item.source_grant ? "Adgang udløber" : "Rotation"} v={item.source_grant ? fmtDay(item.source_grant.expires_at) : rot ?? "Ingen plan"} warn={!!rot && rot.includes("overskredet")} />
          </div>
        )}
        {item?.source_request && (
          <span style={{ fontSize: 12, color: "#334155" }}>Anmodning om Brug i kilde afventer: {item.source_request.approved} af {item.source_request.total} har godkendt · udløber {fmtDay(item.source_request.expires_at)}.
            {item.my_level ? " Du kan teste med din egen adgang imens." : " Endpoints, der kræver den, kan ikke kaldes endnu."}</span>
        )}
        {canAsk && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "#9a3412", flex: "1 1 260px" }}>
              Kilden har ikke adgang. {item?.my_level ? "Du kan teste med din egen adgang, men datasættene virker først, når A, R og C har godkendt." : "Anmod om Brug i kilde, så A, R og C kan tage stilling."}
              {saved && dirty ? " Kilden gemmes først." : ""}
            </span>
            <Btn kind="primary" height={32} onClick={onAsk}>Anmod om Brug i kilde</Btn>
          </div>
        )}
        {!item && <span style={{ fontSize: 12, color: "#b91c1c" }}>Hemmeligheden findes ikke — eller du har ikke adgang til listen over hemmeligheder. Tjek navnet (gruppe/navn).</span>}
        {st.usable && <span style={{ fontSize: 12, color: "#475569" }}>Testkald og datasæt bruger altid nyeste version. Når R skifter værdien, følger kilden med uden ny godkendelse.</span>}
      </div>
    </div>
  );
}

function Info({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 2 }}><span style={{ color: "#64748b" }}>{k}</span><span style={{ fontWeight: 600, color: warn ? "#9a3412" : "#020817" }}>{v}</span></div>;
}

function DatasetEditor({ ds, onChange }: { ds: DatasetSpec; onChange: (p: Partial<DatasetSpec>) => void }) {
  const setField = (i: number, p: Partial<DatasetSpec["fields"][number]>) => onChange({ fields: ds.fields.map((f, j) => (j === i ? { ...f, ...p } : f)) });
  const params = Object.entries(ds.params);
  const setParams = (list: [string, { label: string; data_type: DataType }][]) => onChange({ params: Object.fromEntries(list) });
  return (
    <Section id="felter" title={`4 · ${ds.name}: kald og felter`} ok={ds.fields.length > 0 && ds.fields.every((f) => f.label)}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        <label style={lbl}>Id<input value={ds.key} onChange={(e) => onChange({ key: e.target.value.toLowerCase() })} style={mono} /></label>
        <label style={lbl}>Navn<input value={ds.name} onChange={(e) => onChange({ name: e.target.value })} style={txt} /></label>
        <label style={lbl}>Sti (GET)<input value={ds.path} onChange={(e) => onChange({ path: e.target.value.trim() })} style={mono} /></label>
        <label style={lbl}>Rækker (JSONPath)<input value={ds.rows} onChange={(e) => onChange({ rows: e.target.value.trim() })} style={mono} placeholder="$[*]" /></label>
        <label style={lbl}>Nøglefelt<select value={ds.id_field ?? ""} onChange={(e) => onChange({ id_field: e.target.value || null })} style={select}>
          <option value="">Intet</option>{ds.fields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}</select></label>
        <label style={lbl}>Klassifikation<select value={ds.classification} onChange={(e) => onChange({ classification: e.target.value as Cls })} style={select}>
          {CLS_KEYS.map((c) => <option key={c} value={c}>{CLS[c].label}</option>)}</select></label>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={!!ds.paging} onChange={(e) => onChange({ paging: e.target.checked ? { param: "side", size_param: "per_side", max: 100 } : null })} />
          Side for side
        </label>
        {ds.paging && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
            <label style={lbl}>Sideparameter<input value={ds.paging.param} onChange={(e) => onChange({ paging: { ...ds.paging!, param: e.target.value } })} style={mono} /></label>
            <label style={lbl}>Størrelsesparameter<input value={ds.paging.size_param} onChange={(e) => onChange({ paging: { ...ds.paging!, size_param: e.target.value } })} style={mono} /></label>
            <label style={lbl}>Højst pr. side<input type="number" min={1} max={1000} value={ds.paging.max} onChange={(e) => onChange({ paging: { ...ds.paging!, max: Number(e.target.value) } })} style={txt} /></label>
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>Parametre (bliver filtre i Udforsk)</span>
        {params.map(([name, p], i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ display: "flex", flex: "1 1 140px" }}><span style={srOnly}>Parameter</span>
              <input value={name} onChange={(e) => setParams(params.map((x, j) => (j === i ? [fieldName(e.target.value), x[1]] : x)))} style={mono} /></label>
            <label style={{ display: "flex", flex: "1 1 160px" }}><span style={srOnly}>Navn</span>
              <input value={p.label} onChange={(e) => setParams(params.map((x, j) => (j === i ? [x[0], { ...x[1], label: e.target.value }] : x)))} style={txt} placeholder="Dansk navn" /></label>
            <label style={{ display: "flex" }}><span style={srOnly}>Type</span>
              <select value={p.data_type} onChange={(e) => setParams(params.map((x, j) => (j === i ? [x[0], { ...x[1], data_type: e.target.value as DataType }] : x)))} style={select}>
                {DATA_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}</select></label>
            <IconBtn icon={Trash2} label={`Fjern ${name}`} onClick={() => setParams(params.filter((_, j) => j !== i))} />
          </div>
        ))}
        <div><Btn height={30} icon={Plus} onClick={() => setParams([...params, [`p${params.length + 1}`, { label: "", data_type: "text" }]])}>Tilføj parameter</Btn></div>
      </div>

      <div style={{ overflowX: "auto", margin: "0 -20px", borderTop: "1px solid #e2e8f0", minWidth: 0, position: "relative" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead><tr style={{ background: "#f8fafc", textAlign: "left" }}>
            {["Felt", "Sti i svaret", "Dansk navn", "Type", "Klassifikation", ""].map((h, i) => <th key={i} scope="col" style={{ padding: "8px 8px", paddingLeft: i === 0 ? 20 : 8, ...th }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {ds.fields.map((f, i) => (
              <tr key={i} style={{ borderTop: "1px solid #f1f5f9" }}>
                <td style={{ padding: "6px 8px 6px 20px" }}><label style={{ display: "flex" }}><span style={srOnly}>Felt</span><input value={f.name} onChange={(e) => setField(i, { name: fieldName(e.target.value) })} style={{ ...mono, minWidth: 110 }} /></label></td>
                <td style={{ padding: "6px 8px" }}><label style={{ display: "flex" }}><span style={srOnly}>Sti</span><input value={f.path} onChange={(e) => setField(i, { path: e.target.value.trim() })} style={{ ...mono, minWidth: 160 }} /></label></td>
                <td style={{ padding: "6px 8px" }}><label style={{ display: "flex" }}><span style={srOnly}>Dansk navn</span><input value={f.label} onChange={(e) => setField(i, { label: e.target.value })} style={{ ...txt, minWidth: 120, borderColor: f.label ? "#e2e8f0" : "#fdba74" }} /></label></td>
                <td style={{ padding: "6px 8px" }}><label style={{ display: "flex" }}><span style={srOnly}>Type</span><select value={f.data_type} onChange={(e) => setField(i, { data_type: e.target.value as DataType })} style={select}>
                  {DATA_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}</select></label></td>
                <td style={{ padding: "6px 8px" }}><label style={{ display: "flex" }}><span style={srOnly}>Klassifikation</span>
                  <select value={f.classification} onChange={(e) => setField(i, { classification: e.target.value as Cls })} style={{ ...select, background: CLS[f.classification].bg, color: CLS[f.classification].fg, fontWeight: 600 }}>
                    {CLS_KEYS.map((c) => <option key={c} value={c}>{CLS[c].label}</option>)}</select></label></td>
                <td style={{ padding: "6px 12px 6px 8px", textAlign: "right" }}>{ds.fields.length > 1 && <IconBtn icon={Trash2} label={`Fjern ${f.name}`} onClick={() => onChange({ fields: ds.fields.filter((_, j) => j !== i) })} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div><Btn height={30} icon={Plus} onClick={() => onChange({ fields: [...ds.fields, { name: `felt${ds.fields.length + 1}`, path: `felt${ds.fields.length + 1}`, label: "", description: "", data_type: "text", classification: ds.classification }] })}>Tilføj felt</Btn></div>
    </Section>
  );
}

function YamlEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <section aria-label="Kildebeskrivelse" style={{ ...card, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1px solid #e2e8f0", background: "#f8fafc", borderRadius: "16px 16px 0 0", fontSize: 12, color: "#64748b", flexWrap: "wrap" }}>
        <span style={{ font: `600 12px ${MONO}`, color: "#334155" }}>Kildebeskrivelse (YAML)</span>
        <span style={{ marginLeft: "auto" }}>auth.type: ingen · bearer · header · basic · oauth2 · hemmelighed: gruppe/navn</span>
      </div>
      <label style={{ display: "flex" }}>
        <span style={srOnly}>Kildebeskrivelse</span>
        <textarea value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} rows={30}
          style={{ width: "100%", boxSizing: "border-box", border: 0, padding: "14px 16px", resize: "vertical", outline: "none", font: `12.5px/1.65 ${MONO}`, color: "#1e293b", whiteSpace: "pre", overflow: "auto", minHeight: 420 }} />
      </label>
    </section>
  );
}

function OpenApiImport({ onUse }: { onUse: (r: OpenApiResult, picked: OpenApiResult["ops"]) => void }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<OpenApiResult | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const read = () => {
    try {
      const r = parseOpenApi(text);
      setResult(r);
      setChosen(new Set(r.ops.slice(0, 5).map((o) => o.id)));
      setError(null);
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section aria-label="Importér OpenAPI" style={{ ...card, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>Importér fra OpenAPI</h2>
      <p style={{ margin: 0, fontSize: 13, color: "#475569" }}>Indsæt API'ets OpenAPI-dokument (JSON). Det læses her i browseren — intet hentes eller sendes. GET-endpoints uden sti-parametre kan blive til datasæt.</p>
      <label style={{ display: "flex" }}><span style={srOnly}>OpenAPI-dokument</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} spellCheck={false} placeholder='{"openapi": "3.0.0", "paths": { … }}'
          style={{ ...input, height: "auto", width: "100%", padding: 12, font: `12px/1.6 ${MONO}`, resize: "vertical" }} /></label>
      <div><Btn icon={FileJson} onClick={read} disabled={!text.trim()}>Læs dokumentet</Btn></div>
      {error && <ErrorBox>{error}</ErrorBox>}
      {result && (
        <>
          <div style={{ fontSize: 13, color: "#334155", display: "flex", flexDirection: "column", gap: 4 }}>
            <span><strong>{result.title || "API"}</strong> · {result.base_url ?? "ingen https-server i dokumentet — skriv base-URL'en i formularen"}</span>
            {result.authNote && <span>Godkendelse: {result.authNote}. Hemmeligheden vælger du bagefter.</span>}
            {result.skipped > 0 && <span style={{ color: "#64748b" }}>{result.skipped} endpoints med sti-parametre ({"{id}"}) er sprunget over.</span>}
          </div>
          <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, maxHeight: 360, overflowY: "auto" }}>
            {result.ops.map((op) => (
              <label key={op.id} style={{ display: "flex", gap: 10, padding: "9px 12px", borderBottom: "1px solid #f1f5f9", alignItems: "flex-start", fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={chosen.has(op.id)} onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(op.id); else next.delete(op.id);
                  setChosen(next);
                }} />
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <code style={{ fontSize: 12.5 }}>GET {op.path}</code>
                  <span style={{ color: "#475569", fontSize: 12 }}>{op.summary || "Uden beskrivelse"} · {op.fields.length} felter · rækker {op.rows}{Object.keys(op.params).length ? ` · ${Object.keys(op.params).length} parametre` : ""}</span>
                </span>
              </label>
            ))}
            {result.ops.length === 0 && <p style={{ margin: 0, padding: 12, fontSize: 13, color: "#64748b" }}>Ingen GET-endpoints at importere.</p>}
          </div>
          <div><Btn kind="primary" icon={Plus} disabled={chosen.size === 0} onClick={() => onUse(result, result.ops.filter((o) => chosen.has(o.id)))}>Tilføj {chosen.size} endpoints</Btn></div>
        </>
      )}
    </section>
  );
}

function CurlImport({ onUse }: { onUse: (r: CurlResult) => void }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<CurlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = () => {
    try {
      setResult(parseCurl(text));
      setError(null);
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section aria-label="Fra cURL" style={{ ...card, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>Fra en cURL-kommando</h2>
      <p style={{ margin: 0, fontSize: 13, color: "#475569" }}>Indsæt et kald, der virker i terminalen. Adresse, parametre og godkendelsesmetode tages med; nøgler og tokens i kommandoen gemmes aldrig — du vælger hemmeligheden bagefter.</p>
      <label style={{ display: "flex" }}><span style={srOnly}>cURL-kommando</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} spellCheck={false} placeholder={'curl -H "Authorization: Bearer …" "https://api.example.dk/v1/kunder?side=1"'}
          style={{ ...input, height: "auto", width: "100%", padding: 12, font: `12px/1.6 ${MONO}`, resize: "vertical" }} /></label>
      <div><Btn icon={Terminal} onClick={read} disabled={!text.trim()}>Læs kommandoen</Btn></div>
      {error && <ErrorBox>{error}</ErrorBox>}
      {result && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
          <code style={{ fontSize: 12.5 }}>GET {result.base_url}{result.path}</code>
          <span>Godkendelse: {AUTH_TYPES.find((a) => a.type === result.auth.type)?.label}{result.auth.header ? ` (${result.auth.header})` : ""}
            {Object.keys(result.params).length ? ` · parametre: ${Object.keys(result.params).join(", ")}` : ""}</span>
          {result.notes.map((n, i) => <span key={i} style={{ color: "#9a3412" }}>{n}</span>)}
          <div><Btn kind="primary" icon={Plus} onClick={() => onUse(result)}>Brug som datasæt</Btn></div>
        </div>
      )}
    </section>
  );
}

function TestPanel({ test, busy, datasets, testSet, setTestSet, onRun }: {
  test: TestResult | null; busy: boolean; datasets: DatasetSpec[]; testSet: string; setTestSet: (v: string) => void; onRun: () => void;
}) {
  return (
    <>
      <section aria-label="Testkald" style={{ background: "#0f172a", color: "#e2e8f0", borderRadius: 16, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ ...sectionLabel, color: "#94a3b8" }}>Testkald</span>
          {test?.preview && <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 600, padding: "2px 8px", borderRadius: 9999, background: "rgba(34,197,94,0.18)", color: "#86efac" }}>{test.preview.ms} ms · {test.preview.rows.length} rækker</span>}
          {test?.error && <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 600, padding: "2px 8px", borderRadius: 9999, background: "rgba(248,113,113,0.2)", color: "#fca5a5" }}>Fejl</span>}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {datasets.length > 1 && (
            <label style={{ display: "flex", flex: 1 }}><span style={srOnly}>Datasæt til testkald</span>
              <select value={testSet} onChange={(e) => setTestSet(e.target.value)} style={{ ...select, width: "100%" }}>
                {datasets.map((d, i) => <option key={d.key} value={i === 0 ? "" : d.key}>{d.name}</option>)}
              </select></label>
          )}
          <Btn icon={Play} onClick={onRun} disabled={busy}>Test kald</Btn>
        </div>
        {test?.preview && <code style={{ font: `12px/1.6 ${MONO}`, wordBreak: "break-all", color: "#e2e8f0" }}>GET {test.preview.url}</code>}
        {test?.secrets.map((s) => (
          <span key={s.ref + s.used_as} style={{ font: `12px ${MONO}`, color: s.ok ? "#cbd5e1" : "#fca5a5" }}>
            {s.used_as === "auth" ? "auth" : s.used_as.replace("header:", "")} ← <span style={{ color: "#fbbf24" }}>{s.ref}</span> {s.ok ? `(${s.how === "source" ? "kildens adgang" : s.how === "own" ? "din adgang" : "miljø"})` : "(ingen adgang)"}
          </span>
        ))}
        {test?.error && <span style={{ fontSize: 13, color: "#fca5a5" }}>{test.error}</span>}
        <span style={{ fontSize: 12, color: "#94a3b8" }}>{test ? "Værdier og tokens vises aldrig og skrives aldrig i loggen." : "Testkaldet ændrer intet. Bruger det din egen adgang til en hemmelighed, skrives det i hemmelighedens audit-log."}</span>
      </section>
      {test?.preview && (
        <section aria-label="Rækker" style={{ ...card, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={sectionLabel}>Rækker · {test.preview.rows.length}</span>
          <div style={{ overflowX: "auto", border: "1px solid #f1f5f9", borderRadius: 10 }}>
            <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
              <thead><tr style={{ background: "#f8fafc" }}>
                {test.preview.columns.map((c) => <th key={c.name} scope="col" style={{ textAlign: "left", padding: "6px 10px", color: "#64748b", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>{c.label}</th>)}
              </tr></thead>
              <tbody>
                {test.preview.rows.map((r, i) => (
                  <tr key={i} style={{ borderTop: "1px solid #f1f5f9" }}>
                    {test.preview!.columns.map((c) => <td key={c.name} style={{ padding: "6px 10px", whiteSpace: "nowrap", color: c.masked ? "#64748b" : undefined }}>{cell(r[c.name])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {test && (
        <section aria-label="Tjek" style={{ ...card, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={sectionLabel}>Tjek</span>
          {test.checks.map((c, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
              <span aria-label={c.ok ? "OK" : "Bemærk"} style={{ width: 18, height: 18, flex: "none", borderRadius: 9999, display: "inline-flex", alignItems: "center", justifyContent: "center",
                fontSize: 11, fontWeight: 700, background: c.ok ? "rgba(22,163,74,0.12)" : "rgba(249,115,22,0.12)", color: c.ok ? "#166534" : "#9a3412" }}>{c.ok ? "✓" : "!"}</span>
              <span style={{ color: "#334155", lineHeight: 1.45 }}>{c.text}</span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
