// /developer/studio/mcp — MCP Studio: define MCP endpoints on /mcp/<key>, choose the tools each one offers (Code
// tools with an app handler, Data tools from the catalog), try a tool, read the log and copy what a client needs
// to connect. Server: /api/admin/studio/mcp-endpoints (routes/studio.py) and /api/admin/data/tools.
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, errorText } from "../api";
import { Alert, fmtDate, fmtNumber, useLoad } from "../ui";
import { Calls, Empty, MONO, StatusPill, copy, gap } from "./parts";
import type { EndpointDetail, EndpointList, EndpointSummary, LogItem, MapTool, ToolSpec } from "./types";

const BASE = "/api/admin/studio/mcp-endpoints";

type Form = { key: string; name: string; description: string; instructions: string; audience: string; enabled: boolean };
const empty = (): Form => ({ key: "", name: "", description: "", instructions: "", audience: "all", enabled: true });
const formOf = (e: EndpointSummary): Form => ({ key: e.key, name: e.name, description: e.description, instructions: e.instructions, audience: e.audience, enabled: e.enabled });

export default function McpStudio() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const list = useLoad(() => api.get<EndpointList>(BASE));
  const key = params.get("endpoint");
  const isNew = params.get("new") === "1";
  const [detail, setDetail] = useState<EndpointDetail | null>(null);
  const [form, setForm] = useState<Form>(empty());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadDetail = async (k: string) => setDetail(await api.get<EndpointDetail>(`${BASE}/${k}`));

  useEffect(() => {
    setError(null); setNotice(null); setDetail(null);
    if (key) loadDetail(key).catch((e) => setError(errorText(e)));
    else setForm(empty());
  }, [key, isNew]);
  useEffect(() => {
    if (detail) setForm(formOf(detail.endpoint));
  }, [detail]);

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

  const create = (e: FormEvent) => {
    e.preventDefault();
    run("create", async () => {
      const made = await api.post<EndpointSummary>(BASE, form);
      await list.reload();
      navigate(`/developer/studio/mcp?endpoint=${made.key}`, { replace: true });
    });
  };

  const saveForm = () => run("save", async () => {
    if (!detail) return;
    const { key: _k, ...body } = form;
    await api.patch(`${BASE}/${detail.endpoint.key}`, body);
    await Promise.all([loadDetail(detail.endpoint.key), list.reload()]);
    setNotice("Endpointet er gemt");
  });

  const toggleEnabled = () => run("toggle", async () => {
    if (!detail) return;
    await api.patch(`${BASE}/${detail.endpoint.key}`, { enabled: !detail.endpoint.enabled });
    await Promise.all([loadDetail(detail.endpoint.key), list.reload()]);
  });

  const remove = () => {
    if (!detail || !confirm(`Slet ${detail.endpoint.path}? Forbundne klienter mister adgangen med det samme. Loggen bliver.`)) return;
    run("delete", async () => {
      await api.del(`${BASE}/${detail.endpoint.key}`);
      await list.reload();
      setParams({});
    });
  };

  const setTools = (ids: number[]) => run("tools", async () => {
    if (!detail) return;
    await api.put(`${BASE}/${detail.endpoint.key}/tools`, { tool_ids: ids });
    await Promise.all([loadDetail(detail.endpoint.key), list.reload()]);
    setNotice("Værktøjerne er gemt");
  });

  const changed = detail && JSON.stringify(form) !== JSON.stringify(formOf(detail.endpoint));

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
      <aside className="card" style={{ flex: "1 1 240px", maxWidth: 320, padding: 14, gap: 6 }} aria-label="MCP-endpoints">
        <div className="spread">
          <strong>Endpoints</strong>
          <Link to="/developer/studio/mcp?new=1" className="btn btn-primary btn-sm">+ Nyt</Link>
        </div>
        {list.error && <Alert>{list.error}</Alert>}
        {list.data?.endpoints.map((e) => (
          <Link key={e.key} to={`/developer/studio/mcp?endpoint=${e.key}`} className="list-row" aria-current={e.key === key ? "page" : undefined}
                style={{ textDecoration: "none", padding: "8px 6px", borderRadius: 8, borderTop: 0, background: e.key === key ? "var(--hm-muted)" : undefined }}>
            <div className="stack" style={{ ...gap(2), minWidth: 0, flex: 1 }}>
              <span style={{ fontWeight: 600 }}>{e.name}</span>
              <span className="tiny muted" style={MONO}>{e.path}</span>
            </div>
            {!e.live && <span className="pill red" title="Slået fra">fra</span>}
            <span className="pill">{e.tools}</span>
          </Link>
        ))}
        <p className="tiny muted" style={{ marginTop: 8 }}>
          <code>/mcp</code> og <code>/mcp/admin</code> er indbyggede; deres værktøjer styres under <a href="/admin/data/tools">MCP-værktøjer</a>.
        </p>
      </aside>

      <section style={{ flex: "999 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }} data-deeplink="mcp-studio-editor">
        {error && <Alert>{error}</Alert>}
        {notice && <Alert kind="success">{notice}</Alert>}

        {!key && !isNew && <Empty>Vælg et endpoint til venstre, eller <Link to="/developer/studio/mcp?new=1">opret et nyt</Link>.</Empty>}

        {isNew && !key && (
          <form className="card" style={{ gap: 12 }} onSubmit={create}>
            <h2 style={{ margin: 0, fontSize: 20 }}>Nyt MCP-endpoint</h2>
            <p className="muted small" style={{ margin: 0 }}>
              Endpointet svarer på <code>{list.data?.origin ?? ""}/mcp/{form.key || "<nøgle>"}</code>. Klienten logger brugeren ind
              som altid (engangskode, passkey hvor det kræves) og handler derefter som den bruger. Det starter med kerneværktøjerne;
              resten vælger du bagefter.
            </p>
            <EndpointFields form={form} setForm={setForm} audiences={list.data?.audiences ?? []} isNew />
            <div className="row" style={gap(8)}>
              <button className="btn btn-primary" disabled={!!busy || !form.key || !form.name}>{busy === "create" ? "Opretter …" : "Opret endpoint"}</button>
              <Link to="/developer/studio/mcp" className="btn btn-ghost">Fortryd</Link>
            </div>
          </form>
        )}

        {key && detail && (
          <>
            <div className="spread">
              <div className="stack" style={gap(2)}>
                <h2 style={{ margin: 0, fontSize: 20 }}>{detail.endpoint.name}</h2>
                <span className="tiny muted" style={MONO}>{detail.connect.url}</span>
              </div>
              <div className="row" style={gap(6)}>
                {detail.endpoint.builtin ? <span className="pill">indbygget</span> : <span className="pill blue">{detail.endpoint.audienceLabel}</span>}
                <span className={`pill ${detail.endpoint.live ? "green" : "red"}`}>{detail.endpoint.live ? "aktiv" : "slået fra"}</span>
                <Calls calls={detail.endpoint.calls7d} errors={detail.endpoint.errors7d} />
              </div>
            </div>

            {detail.endpoint.builtin ? (
              <div className="card" style={{ gap: 8 }}>
                <p className="muted small" style={{ margin: 0 }}>{detail.endpoint.description}</p>
                <p className="small" style={{ margin: 0 }}>
                  Det indbyggede endpoint defineres i koden (<code>specs/mcp/catalog.json</code>). Hvilke værktøjer det tilbyder, og hvem der må kalde
                  dem, styres under <a href="/admin/data/tools">MCP-værktøjer ↗</a>; kladder, klienter og monitor i <a href="/admin/mcp">MCP-hubben ↗</a>.
                </p>
              </div>
            ) : (
              <div className="card" style={{ gap: 12 }}>
                <EndpointFields form={form} setForm={setForm} audiences={list.data?.audiences ?? []} />
                <div className="row" style={gap(8)}>
                  <button className="btn btn-primary btn-sm" disabled={!!busy || !changed} onClick={saveForm}>{busy === "save" ? "Gemmer …" : "Gem"}</button>
                  <button className="btn btn-outline btn-sm" disabled={!!busy} onClick={toggleEnabled}>{detail.endpoint.enabled ? "Slå fra" : "Slå til"}</button>
                  <button className="btn btn-ghost btn-sm" style={{ color: "#b91c1c", marginLeft: "auto" }} disabled={!!busy} onClick={remove}>Slet endpoint</button>
                </div>
              </div>
            )}

            <Connect detail={detail} onCopied={(t) => setNotice(t)} />

            <Tools detail={detail} busy={!!busy} onSave={setTools} onAdded={() => loadDetail(detail.endpoint.key)} onError={setError} />

            <TryTool detail={detail} />

            <Log endpointKey={detail.endpoint.key} />
          </>
        )}
      </section>
    </div>
  );
}

function EndpointFields({ form, setForm, audiences, isNew }: { form: Form; setForm: (f: Form) => void; audiences: { id: string; label: string }[]; isNew?: boolean }) {
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <label className="field">Nøgle (sti)
          <input value={form.key} disabled={!isNew} style={MONO} placeholder="salg" pattern="[a-z][a-z0-9-]{1,31}" required
                 onChange={(e) => setForm({ ...form, key: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} />
          <span className="tiny muted" style={{ fontWeight: 400 }}>Små bogstaver, tal og bindestreg · bliver /mcp/{form.key || "…"}</span>
        </label>
        <label className="field">Navn
          <input value={form.name} placeholder="Salg" maxLength={80} required onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="field">Hvem må forbinde
          <select value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })}>
            {audiences.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
          <span className="tiny muted" style={{ fontWeight: 400 }}>Værktøjernes klassifikation afgør derefter, hvem der må kalde hvad.</span>
        </label>
      </div>
      <label className="field">Beskrivelse
        <input value={form.description} maxLength={1000} placeholder="Hvad endpointet er til — vises på samtykkesiden" onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </label>
      <label className="field">Instruktioner til modellen
        <textarea value={form.instructions} maxLength={4000} rows={4} placeholder="Fx: Du hjælper salgsteamet. Svar kort på dansk. Brug klip_data til tal, og spørg før du ændrer noget."
                  onChange={(e) => setForm({ ...form, instructions: e.target.value })} />
        <span className="tiny muted" style={{ fontWeight: 400 }}>Sendes til klienten ved initialize. Tomt = appens standardinstruktion.</span>
      </label>
    </>
  );
}

function Connect({ detail, onCopied }: { detail: EndpointDetail; onCopied: (text: string) => void }) {
  const c = detail.connect;
  const snippet = `claude mcp add --transport http ${detail.endpoint.key === "app" ? "gaer" : detail.endpoint.key} ${c.url}`;
  const copyIt = async (text: string, what: string) => onCopied((await copy(text)) ? `${what} er kopieret` : "Kunne ikke kopiere");
  return (
    <div className="card" style={{ gap: 8 }} data-deeplink="mcp-studio-connect">
      <div className="spread">
        <strong>Forbind en klient</strong>
        <span className="tiny muted">OAuth 2 · scope {c.scope} · dynamisk klientregistrering</span>
      </div>
      <dl className="small" style={{ margin: 0, display: "grid", gridTemplateColumns: "max-content 1fr auto", gap: "6px 12px", alignItems: "center" }}>
        <dt className="muted">URL</dt><dd style={{ ...MONO, margin: 0, wordBreak: "break-all" }}>{c.url}</dd>
        <dd style={{ margin: 0 }}><button className="btn btn-ghost btn-sm" onClick={() => copyIt(c.url, "URL'en")}>Kopiér</button></dd>
        <dt className="muted">Metadata</dt><dd style={{ ...MONO, margin: 0, wordBreak: "break-all" }}>{c.metadata}</dd>
        <dd style={{ margin: 0 }}><button className="btn btn-ghost btn-sm" onClick={() => copyIt(c.metadata, "Metadata-URL'en")}>Kopiér</button></dd>
        <dt className="muted">Claude Code</dt><dd style={{ ...MONO, margin: 0, wordBreak: "break-all" }}>{snippet}</dd>
        <dd style={{ margin: 0 }}><button className="btn btn-ghost btn-sm" onClick={() => copyIt(snippet, "Kommandoen")}>Kopiér</button></dd>
      </dl>
      <p className="tiny muted" style={{ margin: 0 }}>
        Klienten finder selv {c.authorization.replace(/^https?:\/\//, "")} og {c.token.replace(/^https?:\/\//, "")} via metadata, registrerer sig på /mcp/register
        og sender brugeren til login. Ingen nøgler at dele.
        {detail.clients.length > 0 && <> Forbundet nu: {detail.clients.map((k) => `${k.name} (${k.sessions})`).join(", ")}.</>}
      </p>
    </div>
  );
}

function Tools({ detail, busy, onSave, onAdded, onError }: { detail: EndpointDetail; busy: boolean; onSave: (ids: number[]) => void; onAdded: () => void; onError: (e: string) => void }) {
  const offered = new Set(detail.tools.map((t) => t.name));
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [dataset, setDataset] = useState<number | "">("");
  const [name, setName] = useState("");
  useEffect(() => {
    setPicked(new Set(detail.available.filter((t) => offered.has(t.name)).map((t) => t.id)));
  }, [detail]);
  const core = new Set(detail.core);
  const builtin = detail.endpoint.builtin;
  const q = filter.trim().toLowerCase();
  const shown = detail.available.filter((t) => !q || `${t.name} ${t.title} ${t.description} ${t.datasetName ?? ""}`.toLowerCase().includes(q));
  const groups: [string, MapTool[]][] = [
    ["Dataværktøjer · datasæt fra kataloget", shown.filter((t) => t.kind === "data")],
    ["Kodeværktøjer · appens handlers", shown.filter((t) => t.kind === "code")],
  ];
  const dirty = !builtin && JSON.stringify([...picked].sort()) !== JSON.stringify(detail.available.filter((t) => offered.has(t.name)).map((t) => t.id).sort());

  const addDataTool = async (e: FormEvent) => {
    e.preventDefault();
    if (!dataset || !name) return;
    try {
      await api.post("/api/admin/data/tools", { name, dataset_id: dataset, endpoints: [detail.endpoint.key] });
      setAdding(false); setName(""); setDataset("");
      onAdded();
    } catch (err) {
      onError(errorText(err));
    }
  };

  return (
    <div className="card" style={{ gap: 10 }} data-deeplink="mcp-studio-tools">
      <div className="spread">
        <strong>Værktøjer <span className="muted small">· {detail.tools.length} på endpointet</span></strong>
        <div className="row" style={gap(8)}>
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find værktøj" style={{ padding: "6px 10px", fontSize: 14 }} aria-label="Find værktøj" />
          {!builtin && <button className="btn btn-outline btn-sm" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>+ Dataværktøj</button>}
        </div>
      </div>
      {builtin && <p className="muted small" style={{ margin: 0 }}>Værktøjerne på det indbyggede endpoint ændres under <a href="/admin/data/tools">MCP-værktøjer ↗</a>.</p>}

      {adding && (
        <form className="row" style={{ ...gap(8), alignItems: "flex-end", padding: 12, background: "var(--hm-muted)", borderRadius: 10 }} onSubmit={addDataTool}>
          <label className="field" style={{ flex: "1 1 200px" }}>Datasæt
            <select value={dataset} onChange={(e) => { const id = e.target.value ? Number(e.target.value) : ""; setDataset(id);
              const d = detail.datasets.find((x) => x.id === id); if (d && !name) setName(`${d.key.replace(/[^a-z0-9_]/g, "_")}_data`.slice(0, 48)); }} required>
              <option value="">Vælg datasæt</option>
              {detail.datasets.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.source ?? "egen database"} · {d.classification}{d.personal_data ? " · persondata" : ""}</option>)}
            </select>
          </label>
          <label className="field" style={{ flex: "1 1 160px" }}>Værktøjsnavn
            <input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} style={MONO} pattern="[a-z][a-z0-9_]{1,47}" placeholder="klip_data" required />
          </label>
          <button className="btn btn-primary btn-sm">Opret og tilføj</button>
          <span className="tiny muted" style={{ flexBasis: "100%" }}>Et dataværktøj læser datasættet med katalogets maskering; klassifikationen følger datasættet. Kræver en frisk anden faktor.</span>
        </form>
      )}

      {groups.map(([label, tools]) => tools.length > 0 && (
        <div key={label} className="stack" style={gap(2)}>
          <span className="eyebrow" style={{ fontSize: 11 }}>{label}</span>
          {tools.map((t) => {
            const isCore = core.has(t.name);
            const on = picked.has(t.id);
            return (
              <label key={t.id} className="list-row" style={{ padding: "8px 0", cursor: builtin || isCore ? "default" : "pointer" }}>
                <input type="checkbox" checked={builtin ? offered.has(t.name) : on} disabled={builtin || isCore}
                       onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(t.id); else n.delete(t.id); setPicked(n); }} />
                <span style={{ ...MONO, fontWeight: 600, flex: "0 1 220px" }}>{t.name}</span>
                <span className="small muted" style={{ flex: "1 1 240px" }}>{t.kind === "data" ? `Datasæt: ${t.datasetName ?? t.title}` : t.description}</span>
                <span className={`pill ${t.classification === "white" ? "" : t.classification === "green" ? "green" : t.classification === "yellow" ? "amber" : "red"}`}>{t.classificationLabel.split(" · ")[0]}</span>
                {isCore && <span className="pill" title="Kerneværktøj: altid med, så man kan bede om adgang">kerne</span>}
                {!t.enabled && <span className="pill red">slået fra</span>}
              </label>
            );
          })}
        </div>
      ))}
      {shown.length === 0 && <p className="muted small" style={{ margin: 0 }}>Ingen værktøjer matcher.</p>}
      {!builtin && (
        <div className="row" style={gap(8)}>
          <button className="btn btn-primary btn-sm" disabled={busy || !dirty} onClick={() => onSave([...picked])}>Gem værktøjer</button>
          <span className="tiny muted">Hvem der må kalde et værktøj, afgøres af dets klassifikation (hvid: alle · grøn: interne · gul/rød: med godkendelse). Ret den under <a href="/admin/data/tools">MCP-værktøjer</a>.</span>
        </div>
      )}
    </div>
  );
}

function TryTool({ detail }: { detail: EndpointDetail }) {
  const [name, setName] = useState(detail.tools[0]?.name ?? "");
  const [args, setArgs] = useState<Record<string, string>>({});
  const [out, setOut] = useState<{ result: unknown; isError: boolean; ms: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (!detail.tools.some((t) => t.name === name)) setName(detail.tools[0]?.name ?? ""); }, [detail]);
  const tool: ToolSpec | undefined = detail.tools.find((t) => t.name === name);
  const invoke = async (e: FormEvent) => {
    e.preventDefault();
    if (!tool) return;
    setBusy(true); setErr(null);
    try {
      const body = Object.fromEntries(Object.entries(args).filter(([k, v]) => v !== "" && tool.params.some((p) => p.name === k)));
      setOut(await api.post(`${BASE}/${detail.endpoint.key}/tools/${tool.name}/invoke`, { args: body }));
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card" style={{ gap: 10 }} onSubmit={invoke} data-deeplink="mcp-studio-try">
      <div className="spread">
        <strong>Prøv et værktøj</strong>
        <span className="tiny muted">Kører som dig · logges på endpointet som fra en klient</span>
      </div>
      <div className="row" style={{ ...gap(8), alignItems: "flex-end" }}>
        <label className="field" style={{ flex: "1 1 220px" }}>Værktøj
          <select value={name} onChange={(e) => { setName(e.target.value); setArgs({}); setOut(null); }} style={MONO}>
            {detail.tools.map((t) => <option key={t.name} value={t.name}>{t.name}{t.mode !== "read" ? ` · ${t.mode}` : ""}</option>)}
          </select>
        </label>
        {tool?.params.map((p) => (
          <label key={p.name} className="field" style={{ flex: "1 1 160px" }}>
            <span style={MONO}>{p.name}{p.optional ? "" : " *"}</span>
            <input value={args[p.name] ?? ""} onChange={(e) => setArgs({ ...args, [p.name]: e.target.value })} placeholder={p.desc ?? p.type} required={!p.optional} />
          </label>
        ))}
        <button className="btn btn-outline" disabled={busy || !tool}>{busy ? "Kører …" : "Kør"}</button>
      </div>
      {tool && <p className="tiny muted" style={{ margin: 0 }}>{tool.description}</p>}
      {err && <Alert>{err}</Alert>}
      {out && (
        <div className="stack" style={gap(6)}>
          <div className="row" style={gap(8)}>
            <StatusPill status={out.isError ? "error" : "ok"} />
            <span className="tiny muted num">{out.ms} ms</span>
          </div>
          <pre className="json" style={{ maxHeight: 360, overflow: "auto", background: "var(--hm-muted)", padding: 12, borderRadius: 10 }}>{JSON.stringify(out.result, null, 1)}</pre>
        </div>
      )}
    </form>
  );
}

function Log({ endpointKey }: { endpointKey: string }) {
  const log = useLoad(() => api.get<{ items: LogItem[] }>(`${BASE}/${endpointKey}/log?limit=30`), [endpointKey]);
  return (
    <div className="data-card">
      <div className="spread" style={{ padding: "12px 16px" }}>
        <strong>Seneste kald</strong>
        <button className="btn btn-ghost btn-sm" onClick={log.reload}>Opdatér</button>
      </div>
      {log.error && <div style={{ padding: "0 16px 12px" }}><Alert>{log.error}</Alert></div>}
      {log.data && log.data.items.length === 0 && <p className="muted small" style={{ padding: "0 16px 14px", margin: 0 }}>Ingen kald endnu.</p>}
      {log.data && log.data.items.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Tid</th><th>Metode</th><th>Værktøj</th><th>Status</th><th>Hvem</th><th>Klient</th><th>ms</th></tr></thead>
            <tbody>
              {log.data.items.map((r, i) => (
                <tr key={i}>
                  <td className="tiny muted num">{fmtDate(r.ts)}</td>
                  <td style={MONO}>{r.method}</td>
                  <td style={MONO}>{r.tool ?? "—"}</td>
                  <td><StatusPill status={r.status} /></td>
                  <td>{r.who ?? "—"}</td>
                  <td className="tiny muted" style={MONO}>{r.client ?? "studio"}</td>
                  <td className="num">{r.ms === null ? "—" : fmtNumber(r.ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
