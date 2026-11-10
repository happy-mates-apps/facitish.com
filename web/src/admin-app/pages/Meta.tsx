// /admin/meta — Træstrukturer: the dimensions (the roots of the trees) and the shared nodes in them. Admins build the top
// level and may lock a dimension; users add nodes below (app/meta.py). Every change is audited on the server.
import { useEffect, useState } from "react";
import { api, errorText } from "../../api";
import { metaApi, type MetaNode, type MetaObject } from "../../tree/api";
import { TreeSelect } from "../../tree/TreeSelect";
import { TreeView } from "../../tree/TreeView";
import { useTree } from "../../tree/useTree";
import { Alert, Loading, PageHeader, Pill, Toggle, fmtNumber, useLoad } from "../ui";

type Dim = { id: number; slug: string; label: string; description: string; color: string | null; locked: boolean; nodes: number; archived: number };
type Data = { dimensions: Dim[]; private: { nodes: number; owners: number } };

const slugify = (s: string) => s.trim().toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 64);

export default function Meta() {
  const data = useLoad(() => api.get<Data>("/api/admin/meta/dimensions"));
  const [dimId, setDimId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ label: "", slug: "", color: "#2563EB", locked: false });

  const dims = data.data?.dimensions ?? [];
  const dim = dims.find((d) => d.id === dimId) ?? dims[0] ?? null;

  const act = async (fn: () => Promise<unknown>, label: string, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return false;
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(label);
      await data.reload();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  };

  return (
    <>
      <PageHeader eyebrow="/admin/meta" title="Træstrukturer">
        Dimensioner er uafhængige træer, fx organisation, produkter eller geografi. Admin opretter dimensionerne og det
        øverste niveau; alle brugere kan tilføje noder længere nede, medmindre dimensionen er låst. Andre data gemmer
        node-id'er, så en node kan omdøbes og flyttes uden at miste sine tildelinger.
      </PageHeader>
      <Alert kind="success">{notice}</Alert>
      <Alert>{error || data.error}</Alert>
      {!data.data ? <Loading /> : (
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 300px", maxWidth: 380, display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="card">
              <span className="eyebrow">Dimensioner</span>
              {dims.length === 0 && <p className="small muted">Ingen endnu. Opret den første nedenfor.</p>}
              {dims.map((d) => (
                <button key={d.id} type="button" onClick={() => setDimId(d.id)} className="tg-hover"
                  style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", minHeight: 44, padding: "6px 10px", borderRadius: 8, cursor: "pointer", textAlign: "left", font: "inherit",
                    border: d.id === dim?.id ? "2px solid #2563eb" : "1px solid #e2e8f0", background: d.id === dim?.id ? "#eef3fe" : "#fff" }}>
                  <span style={{ width: 10, height: 10, borderRadius: 5, background: d.color ?? "#94a3b8", flex: "none" }} />
                  <span style={{ flex: 1, minWidth: 0 }}><b>{d.label}</b> <code className="tiny muted">/{d.slug}</code></span>
                  {d.locked && <Pill tone="orange">låst</Pill>}
                  <span className="tiny muted">{fmtNumber(d.nodes)}</span>
                </button>
              ))}
              <p className="tiny muted">Private træer („Mit træ“): {fmtNumber(data.data.private.nodes)} noder hos {fmtNumber(data.data.private.owners)} brugere. Kun ejeren kan se dem.</p>
            </div>
            <form className="card" onSubmit={async (e) => {
              e.preventDefault();
              const ok = await act(() => api.post("/api/admin/meta/dimensions", { ...draft, slug: draft.slug || slugify(draft.label) }), `Dimensionen „${draft.label}“ er oprettet.`);
              if (ok) setDraft({ label: "", slug: "", color: "#2563EB", locked: false });
            }}>
              <span className="eyebrow">Ny dimension</span>
              <label className="field">Navn<input required maxLength={120} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Organisation" /></label>
              <label className="field">Slug (stiens rod)<input maxLength={64} value={draft.slug} placeholder={slugify(draft.label) || "org"} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} /></label>
              <div className="row">
                <label className="field" style={{ flex: 1 }}>Farve<input type="color" value={draft.color} style={{ width: 64, height: 40, padding: 2 }} onChange={(e) => setDraft({ ...draft, color: e.target.value })} /></label>
                <span className="row small"><Toggle on={draft.locked} onChange={() => setDraft({ ...draft, locked: !draft.locked })} label="Låst" /> Låst</span>
              </div>
              <div><button className="btn btn-primary" type="submit" disabled={!draft.label.trim()}>Opret dimension</button></div>
            </form>
          </div>
          {dim && <DimensionPanel key={dim.id} dim={dim} act={act} />}
        </div>
      )}
    </>
  );
}

function DimensionPanel({ dim, act }: { dim: Dim; act: (fn: () => Promise<unknown>, label: string, confirmText?: string) => Promise<boolean> }) {
  const tree = useTree({ dimension: dim.slug, depth: 3, includeArchived: true });
  const [sel, setSel] = useState<number | null>(null);
  const [label, setLabel] = useState(dim.label);
  const [child, setChild] = useState("");
  const node = sel ? tree.byId.get(sel) ?? null : null;

  const run = async (fn: () => Promise<unknown>, text: string, confirmText?: string) => {
    const ok = await act(fn, text, confirmText);
    if (ok) tree.reload();
    return ok;
  };

  return (
    <div style={{ flex: "3 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="eyebrow">/{dim.slug}</span>
          <span className="row small">
            <Toggle on={dim.locked} label="Låst: kun admin tilføjer noder" onChange={() => act(() => api.patch(`/api/admin/meta/dimensions/${dim.id}`, { locked: !dim.locked }), dim.locked ? "Dimensionen er åbnet." : "Dimensionen er låst.")} />
            Låst
          </span>
        </div>
        <div className="row">
          <input aria-label="Dimensionens navn" value={label} onChange={(e) => setLabel(e.target.value)} style={{ flex: 1 }} />
          <button className="btn btn-outline" disabled={!label.trim() || label === dim.label} onClick={() => act(() => api.patch(`/api/admin/meta/dimensions/${dim.id}`, { label }), "Navnet er gemt.")}>Gem navn</button>
          <button className="btn btn-danger" onClick={() => act(() => api.del(`/api/admin/meta/dimensions/${dim.id}?force=true`), "Dimensionen er slettet.",
            `Slet „${dim.label}“ og alle ${dim.nodes + dim.archived} noder i den? Data, der peger på noderne, mister dem.`)}>Slet</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div className="card" style={{ flex: "1 1 300px", minWidth: 0 }}>
          <span className="eyebrow">Træet · {fmtNumber(dim.nodes)} noder{dim.archived ? ` · ${fmtNumber(dim.archived)} arkiveret` : ""}</span>
          <TreeView tree={tree} label={dim.label} selectedId={sel} onSelect={(n) => setSel(n.id)} emptyText="Ingen noder endnu. Opret det øverste niveau til højre." />
        </div>
        <div className="card" style={{ flex: "1 1 280px", minWidth: 0 }}>
          {node ? <NodeEditor key={node.id} node={node} dim={dim} run={run} onGone={() => setSel(null)} /> : <p className="small muted">Vælg en node for at rette, flytte eller arkivere den.</p>}
          <form className="stack" style={{ "--gap": "8px", borderTop: "1px solid #e2e8f0", paddingTop: 12 } as React.CSSProperties} onSubmit={async (e) => {
            e.preventDefault();
            const ok = await run(() => metaApi.create({ dimension: dim.slug, parent_id: node?.id ?? null, label: child }, true), `„${child}“ er oprettet.`);
            if (ok) setChild("");
          }}>
            <label className="field">{node ? `Ny node under „${node.label}“` : "Ny node på øverste niveau"}
              <input value={child} maxLength={120} onChange={(e) => setChild(e.target.value)} placeholder="Navn" />
            </label>
            <div className="row">
              <button className="btn btn-primary" type="submit" disabled={!child.trim()}>Opret</button>
              {node && <button type="button" className="btn btn-ghost" onClick={() => setSel(null)}>Øverste niveau i stedet</button>}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

function NodeEditor({ node, dim, run, onGone }: { node: MetaNode; dim: Dim; run: (fn: () => Promise<unknown>, text: string, confirmText?: string) => Promise<boolean>; onGone: () => void }) {
  const [label, setLabel] = useState(node.label);
  const [slug, setSlug] = useState(node.slug);
  const [parent, setParent] = useState<number | null>(node.parent_id);
  const [objects, setObjects] = useState<MetaObject[] | null>(null);
  useEffect(() => setParent(node.parent_id), [node.parent_id]);
  useEffect(() => {
    metaApi.objects(node.id, { subtree: true, limit: 21 }).then(setObjects, () => setObjects(null));
  }, [node.id]);
  const patch = (body: Record<string, unknown>, text: string) => run(() => api.patch(`/api/admin/meta/nodes/${node.id}`, body), text);
  const moved = parent !== node.parent_id || slug !== node.slug;

  return (
    <div className="stack" style={{ "--gap": "10px" } as React.CSSProperties}>
      <span className="eyebrow">Node #{node.id}</span>
      <code className="tiny">{node.path}</code>
      <label className="field">Navn<input value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} /></label>
      <div className="row">
        <button className="btn btn-outline" disabled={!label.trim() || label === node.label} onClick={() => patch({ label }, "Navnet er gemt. Stien er uændret.")}>Gem navn</button>
      </div>
      <TreeSelect dimension={dim.slug} label="Flyt under" value={parent} onChange={(v) => setParent(v)} admin
        selectable={(n) => n.id !== node.id && !n.path.startsWith(node.path + "/")} placeholder="Øverste niveau" />
      <label className="field">Slug (sidste del af stien)<input value={slug} maxLength={64} onChange={(e) => setSlug(e.target.value)} /></label>
      <div className="row">
        <button className="btn btn-outline" disabled={!moved} onClick={() => patch({ parent_id: parent, slug }, "Noden og alt under den er flyttet.")}>Flyt</button>
        <button className="btn btn-outline" onClick={() => patch({ archived: !node.archived }, node.archived ? "Noden er taget frem igen." : "Noden er arkiveret. Gemte værdier viser den stadig.")}>
          {node.archived ? "Tag frem igen" : "Arkivér"}
        </button>
        <button className="btn btn-danger" onClick={async () => {
          if (await run(() => api.del(`/api/admin/meta/nodes/${node.id}?force=true`), "Noden er slettet.",
            `Slet „${node.label}“ og alt under den${objects?.length ? `, også tags på ${objects.length > 20 ? "over 20" : objects.length} objekter` : ""}? Arkivér i stedet, hvis data peger på den.`)) onGone();
        }}>Slet</button>
      </div>
      <span className="eyebrow">Tagget her og under · {objects ? (objects.length > 20 ? "over 20" : objects.length) : "…"}</span>
      {objects?.slice(0, 20).map((o) => (
        <div key={o.id} className="small" style={{ display: "flex", gap: 8, minWidth: 0 }}>
          <Pill tone="gray">{o.kind}</Pill>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={o.ref}>{o.title}</span>
        </div>
      ))}
    </div>
  );
}
