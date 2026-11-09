// /admin/data/tools — MCP-værktøjer (server/app/mcp/toolmap.py). The data catalog decides who may use which tool:
// which endpoint (/mcp, /mcp/admin) offers it, whether it is on, and its classification. A Code tool is a handler in
// the code; a Data tool reads a dataset from the catalog and follows that dataset's classification.
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, errorText } from "../../../api";
import { Alert, Loading, PageHeader, useLoad } from "../../ui";

type Tool = {
  id: number; name: string; kind: "code" | "data"; title: string; description: string; classification: string;
  classificationLabel: string; datasetId: number | null; datasetName: string | null; enabled: boolean;
  endpoints: string[]; possibleEndpoints: string[]; core: boolean; requestLevel: string | null;
};
type Resp = {
  tools: Tool[]; datasets: { id: number; name: string; classification: string }[];
  endpoints: { id: string; path: string }[]; classifications: { id: string; label: string }[];
};

const DOT: Record<string, string> = { white: "#e2e8f0", green: "#16a34a", yellow: "#eab308", red: "#dc2626" };
const NEEDS: Record<string, string> = { internal: "Brugeren godkender", confidential: "Bruger + godkender" };

export default function Tools() {
  const data = useLoad(() => api.get<Resp>("/api/admin/data/tools"));
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "code" | "data">("all");
  const [q, setQ] = useState("");
  const [form, setForm] = useState({ name: "", dataset_id: "", title: "", endpoints: ["app"] as string[] });

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await data.reload();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const patch = (t: Tool, body: object) => act(() => api.patch(`/api/admin/data/tools/${t.id}`, body));
  const toggleEndpoint = (t: Tool, e: string) =>
    patch(t, { endpoints: t.endpoints.includes(e) ? t.endpoints.filter((x) => x !== e) : [...t.endpoints, e] });

  const tools = (data.data?.tools ?? []).filter((t) => (filter === "all" || t.kind === filter) && (!q || t.name.includes(q.toLowerCase())));

  return (
    <>
      <PageHeader eyebrow="/admin/data/tools" title="MCP-værktøjer">
        Her bestemmer kataloget, hvilke værktøjer /mcp og /mcp/admin tilbyder, og hvem der må bruge dem.
        Hvid: alle. Grøn: interne brugere. Gul: interne, når brugeren har godkendt en anmodning. Rød: interne, når både brugeren
        og en godkender har sagt ja (i Adgangsanmodninger). Et dataværktøj følger datasættets klassifikation, og dets felter
        maskeres efter deres egen.
      </PageHeader>
      <Alert>{error ?? data.error}</Alert>

      <div className="card" data-deeplink="data-tool-new">
        <strong>Nyt dataværktøj</strong>
        <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="field">Navn (a–z, 0–9, _)
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="kunder_crm" />
          </label>
          <label className="field">Datasæt
            <select value={form.dataset_id} onChange={(e) => setForm({ ...form, dataset_id: e.target.value })}>
              <option value="">Vælg …</option>
              {data.data?.datasets.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.classification})</option>)}
            </select>
          </label>
          <label className="field" style={{ flex: "1 1 200px" }}>Titel
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </label>
          {data.data?.endpoints.map((e) => (
            <label key={e.id} className="row small">
              <input type="checkbox" checked={form.endpoints.includes(e.id)}
                     onChange={() => setForm({ ...form, endpoints: form.endpoints.includes(e.id) ? form.endpoints.filter((x) => x !== e.id) : [...form.endpoints, e.id] })} />
              {e.path}
            </label>
          ))}
          <button className="btn btn-primary btn-sm" disabled={!form.name || !form.dataset_id}
                  onClick={() => act(async () => {
                    await api.post("/api/admin/data/tools", { ...form, dataset_id: Number(form.dataset_id) });
                    setForm({ name: "", dataset_id: "", title: "", endpoints: ["app"] });
                  })}>Opret</button>
        </div>
      </div>

      <div className="row">
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label="Type">
          <option value="all">Alle værktøjer</option><option value="code">Kodeværktøjer</option><option value="data">Dataværktøjer</option>
        </select>
        <input placeholder="Søg på navn" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Søg" />
      </div>

      {data.loading && !data.data ? <Loading /> : (
        <div className="table-wrap" data-deeplink="data-tools">
          <table style={{ minWidth: 820 }}>
            <thead><tr><th>Værktøj</th><th>Type</th>{data.data?.endpoints.map((e) => <th key={e.id}>{e.path}</th>)}<th>Klassifikation</th><th>Kræver</th><th>Til</th><th></th></tr></thead>
            <tbody>
              {tools.map((t) => (
                <tr key={t.id} style={t.enabled ? undefined : { opacity: 0.55 }}>
                  <td><code>{t.name}</code>{t.core && <span className="pill" style={{ marginLeft: 6 }}>Kerne</span>}
                    {t.datasetId && <div className="tiny muted"><Link to={`/data/${t.datasetId}`}>{t.datasetName}</Link></div>}</td>
                  <td>{t.kind === "code" ? "Kode" : "Data"}</td>
                  {data.data?.endpoints.map((e) => (
                    <td key={e.id}>
                      <input type="checkbox" aria-label={`${t.name} på ${e.path}`} checked={t.endpoints.includes(e.id)}
                             disabled={t.core || !t.possibleEndpoints.includes(e.id)} onChange={() => toggleEndpoint(t, e.id)} />
                    </td>
                  ))}
                  <td>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 999, background: DOT[t.classification], border: "1px solid #94a3b8" }} />
                      {t.kind === "code" ? (
                        <select value={t.classification} disabled={t.core} aria-label={`Klassifikation for ${t.name}`}
                                onChange={(e) => patch(t, { classification: e.target.value })}>
                          {data.data?.classifications.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                        </select>
                      ) : <span className="small">{t.classificationLabel} <span className="muted">(datasæt)</span></span>}
                    </span>
                  </td>
                  <td className="small">{t.requestLevel ? NEEDS[t.requestLevel] : "—"}</td>
                  <td><input type="checkbox" aria-label={`${t.name} slået til`} checked={t.enabled} disabled={t.core} onChange={() => patch(t, { enabled: !t.enabled })} /></td>
                  <td>{t.kind === "data" && (
                    <button className="btn btn-ghost btn-sm" onClick={() => confirm(`Slet dataværktøjet ${t.name}?`) && act(() => api.del(`/api/admin/data/tools/${t.id}`))}>Slet</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
