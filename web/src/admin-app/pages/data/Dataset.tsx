// /admin/data/:id → one dataset with the tabs Beskrivelse, Felter, Udforsk and MCP (DATA.md, DataDataset.dc.html).
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Trash2 } from "lucide-react";
import { api, errorText } from "../../../api";
import { Btn, ErrorBox, PageTitle, Pill, Toggle, useLoad, useToast } from "../../ui";
import { card, input, label, MONO, sectionLabel, tableHead } from "../../theme";
import { type Dataset as DatasetData, type Field } from "./types";
import { ClsBadge, ClsSelect } from "./parts";
import Explorer from "./Explorer";

const TABS = [
  { key: "beskrivelse", label: "Beskrivelse" },
  { key: "felter", label: "Felter" },
  { key: "udforsk", label: "Udforsk" },
  { key: "mcp", label: "MCP" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export default function Dataset() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t.key === params.get("tab")) ? params.get("tab") : "beskrivelse") as Tab;
  const { data, error, reload, setData } = useLoad(() => api.get<DatasetData>(`/api/admin/data/datasets/${id}`), [id]);

  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!data) return null;
  return (
    <>
      <nav aria-label="Brødkrumme" style={{ fontSize: 13, color: "#64748b", display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Link to="/data">Katalog</Link><span>/</span><span>{data.source_name}</span><span>/</span>
        <span style={{ color: "#020817", fontWeight: 500 }}>{data.name}</span>
      </nav>
      <PageTitle title={data.name} aside={
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <ClsBadge value={data.classification} />
          {data.personal_data && <Pill tone="red">Persondata</Pill>}
          {data.mcp_exposed && <Pill tone="blue">MCP</Pill>}
        </div>
      }>
        {data.description || "Ingen beskrivelse endnu."}{" "}
        <span style={{ font: `13px ${MONO}` }}>{data.source_kind === "gaer" ? `public.${data.key}` : `${data.source_key}.${data.key}`}</span>
      </PageTitle>

      <div role="tablist" aria-label="Datasæt" style={{ display: "flex", gap: 22, borderBottom: "1px solid #e2e8f0", overflowX: "auto" }}>
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
            onClick={() => setParams(t.key === "beskrivelse" ? {} : { tab: t.key }, { replace: true })}
            style={{ all: "unset", cursor: "pointer", padding: "10px 0", fontSize: 14, whiteSpace: "nowrap", fontWeight: tab === t.key ? 600 : 500,
              color: tab === t.key ? "#020817" : "#64748b", borderBottom: tab === t.key ? "2px solid #2563eb" : "2px solid transparent", marginBottom: -1 }}>
            {t.key === "felter" ? `Felter (${data.fields.length})` : t.label}
          </button>
        ))}
      </div>

      {tab === "beskrivelse" && <Description data={data} onSaved={setData} />}
      {tab === "felter" && <Fields data={data} onChanged={reload} />}
      {tab === "udforsk" && <Explorer dataset={data} onUnmasked={reload} />}
      {tab === "mcp" && <Mcp data={data} onSaved={setData} />}
    </>
  );
}

function Description({ data, onSaved }: { data: DatasetData; onSaved: (d: DatasetData) => void }) {
  const say = useToast();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: data.name, description: data.description, owner: data.owner, classification: data.classification,
    personal_data: data.personal_data });
  useEffect(() => setForm({ name: data.name, description: data.description, owner: data.owner, classification: data.classification,
    personal_data: data.personal_data }), [data]);

  const save = async () => {
    try {
      onSaved(await api.patch<DatasetData>(`/api/admin/data/datasets/${data.id}`, form));
      say("Gemt");
    } catch (e) {
      say(errorText(e));
    }
  };
  const remove = async () => {
    if (!confirm(`Fjern ${data.name} fra kataloget? Tabellen og dens rækker bliver, hvor de er; kun beskrivelserne slettes.`)) return;
    try {
      await api.del(`/api/admin/data/datasets/${data.id}`);
      say("Fjernet fra kataloget");
      navigate("/data");
    } catch (e) {
      say(errorText(e));
    }
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
      <section style={{ ...card, flex: "999 1 480px", padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
        <label style={label}>Navn
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={input} maxLength={120} />
        </label>
        <label style={label}>Beskrivelse
          <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={5} maxLength={4000}
            style={{ ...input, height: "auto", padding: 10, resize: "vertical" }} />
        </label>
        <label style={label}>Dataejer
          <input value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} style={input} maxLength={120}
            placeholder="Fx Kundeservice" />
        </label>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ ...label, flexDirection: "row", alignItems: "center", gap: 8 }}>Klassifikation
            <ClsSelect label="Klassifikation" value={form.classification} onChange={(c) => setForm({ ...form, classification: c })} />
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 500 }}>
            <Toggle label="Persondata" on={form.personal_data} onChange={() => setForm({ ...form, personal_data: !form.personal_data })} /> Indeholder persondata
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn kind="primary" onClick={save}>Gem</Btn>
          {data.source_kind === "gaer" && <Btn icon={Trash2} onClick={remove}>Fjern fra kataloget</Btn>}
        </div>
      </section>
      <aside style={{ ...card, flex: "1 1 260px", padding: 16, display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
        <span style={sectionLabel}>Kilde</span>
        {data.source_kind === "gaer" ? (
          <span>Tabellen <code style={{ fontFamily: MONO }}>{data.key}</code> i containerens egen database. Udforsk læser den i en
            transaktion, der kun må læse.</span>
        ) : (
          <>
            <span>{data.source_name}: <code style={{ fontFamily: MONO }}>{data.call?.method} {data.call?.path}</code></span>
            <Link to={`/data/connect?source=${data.source_id}`}>Redigér kildebeskrivelsen →</Link>
          </>
        )}
        <span style={{ color: "#64748b" }}>Persondata i tabeller fra databasen er med i GDPR-eksport og -sletning gennem de eksisterende regler;
          markeringen her er en hjælp til den, der læser kataloget.</span>
      </aside>
    </div>
  );
}

const FIELD_COLS = "minmax(140px,1fr) minmax(160px,1.2fr) minmax(200px,2fr) 110px 100px";

function Fields({ data, onChanged }: { data: DatasetData; onChanged: () => void }) {
  const say = useToast();
  const patch = async (f: Field, body: Partial<Field>) => {
    try {
      await api.patch(`/api/admin/data/datasets/${data.id}/fields/${f.id}`, body);
      onChanged();
    } catch (e) {
      say(errorText(e));
    }
  };
  return (
    <section style={{ ...card, overflowX: "auto" }}>
      <div style={{ minWidth: 760 }}>
        <div style={{ ...tableHead, gridTemplateColumns: FIELD_COLS }}>
          <span>Felt</span><span>Dansk navn</span><span>Beskrivelse</span><span>Type</span><span>Klassifikation</span>
        </div>
        {data.fields.map((f) => (
          <div key={f.id} style={{ display: "grid", gridTemplateColumns: FIELD_COLS, gap: 10, alignItems: "center", padding: "8px 16px",
            borderBottom: "1px solid #f1f5f9" }}>
            <span style={{ font: `12px ${MONO}`, overflow: "hidden", textOverflow: "ellipsis" }} title={f.path ?? f.name}>{f.name}</span>
            <input aria-label={`Dansk navn for ${f.name}`} defaultValue={f.label} maxLength={80} style={{ ...input, height: 32 }}
              onBlur={(e) => e.target.value !== f.label && patch(f, { label: e.target.value })} />
            <input aria-label={`Beskrivelse af ${f.name}`} defaultValue={f.description} maxLength={1000} style={{ ...input, height: 32 }}
              onBlur={(e) => e.target.value !== f.description && patch(f, { description: e.target.value })} />
            <span style={{ fontSize: 12, color: "#64748b" }}>{f.data_type}</span>
            <ClsSelect label={`Klassifikation for ${f.name}`} value={f.classification} onChange={(c) => patch(f, { classification: c })} />
          </div>
        ))}
      </div>
      <p style={{ margin: 0, padding: "10px 16px", fontSize: 12, color: "#64748b" }}>
        Gule og røde felter vises maskeret i Udforsk. Nye felter fra databasen starter som gule. Kolonner, der ligner hemmeligheder (koder,
        nøgler, tokens, telefonnumre), kommer aldrig med i kataloget.
      </p>
    </section>
  );
}

function Mcp({ data, onSaved }: { data: DatasetData; onSaved: (d: DatasetData) => void }) {
  const say = useToast();
  const toggle = async () => {
    try {
      onSaved(await api.patch<DatasetData>(`/api/admin/data/datasets/${data.id}`, { mcp_exposed: !data.mcp_exposed }));
    } catch (e) {
      say(errorText(e));
    }
  };
  const visible = data.fields.filter((f) => f.classification === "white" || f.classification === "green").length;
  return (
    <section style={{ ...card, padding: 18, display: "flex", flexDirection: "column", gap: 12, maxWidth: 720 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Toggle label="Markér til MCP" on={data.mcp_exposed} onChange={toggle} />
        <span style={{ fontWeight: 600 }}>Markér datasættet til MCP</span>
      </div>
      <p style={{ margin: 0, color: "#475569", fontSize: 14, lineHeight: 1.5 }}>
        Markerede datasæt bliver læseværktøjer på endpointet <code style={{ fontFamily: MONO }}>/mcp/data</code>, når MCP-appen er bygget
        (specs/mcp/APP.md). Indtil da gemmes kun markeringen. Gule og røde felter maskeres også dér: {visible} af {data.fields.length} felter
        vil kunne læses.
      </p>
    </section>
  );
}
