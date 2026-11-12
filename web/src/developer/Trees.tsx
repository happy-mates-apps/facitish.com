// /develop/trae — examples of trees in the UI, against the real /api/meta: four renderings of the same tree and the
// input fields (one node, a start node, tags, a subtree filter, creating). Design: the canvas "Træstrukturer i Gær".
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { errorText } from "../api";
import { metaApi, pathString, PRIVATE, type MetaDimension, type MetaNode } from "../tree/api";
import { TreeSelect } from "../tree/TreeSelect";
import { TreeView } from "../tree/TreeView";
import { useTree, type TreeState } from "../tree/useTree";
import TreesTagging from "./TreesTagging";

type View = "tree" | "cols" | "drill" | "path";
const VIEWS: { id: View; name: string; use: string }[] = [
  { id: "tree", name: "Indrykket træ", use: "Sidebar og admin. Fold ud og ind." },
  { id: "cols", name: "Kolonner", use: "Dybe træer på desktop. Hele stien ses på én gang." },
  { id: "drill", name: "Drill-down", use: "Mobil og side-panel. Ét niveau ad gangen." },
  { id: "path", name: "Sti og chips", use: "Visning af en valgt værdi." },
];

function ancestors(tree: TreeState, id: number | null): MetaNode[] {
  const out: MetaNode[] = [];
  let cur = id ? tree.byId.get(id) : undefined;
  while (cur) {
    out.unshift(cur);
    cur = cur.parent_id ? tree.byId.get(cur.parent_id) : undefined;
  }
  return out;
}

function Columns({ tree, selected, onSelect }: { tree: TreeState; selected: number | null; onSelect: (n: MetaNode) => void }) {
  const path = ancestors(tree, selected);
  const cols: { title: string; items: MetaNode[] }[] = [{ title: tree.dimension?.label ?? "", items: tree.children(null) }];
  for (const a of path) if (a.has_children !== false) cols.push({ title: a.label, items: tree.children(a.id) });
  const shown = cols.slice(-4);
  while (shown.length < 4) shown.push({ title: "", items: [] });
  const on = new Set(path.map((n) => n.id));
  return (
    <div className="tr-cols">
      {shown.map((c, i) => (
        <div key={i} className="tr-col" role="group" aria-label={c.title || undefined}>
          <div className="tr-col-title">{c.title || " "}</div>
          {c.items.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`tr-col-item${on.has(n.id) ? " tr-on" : ""}`}
              onClick={() => {
                onSelect(n);
                void tree.ensureChildren(n.id);
              }}
            >
              <span className="tr-label">{n.label}</span>
              {n.has_children !== false && <span aria-hidden="true">›</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function Drill({ tree, selected, onSelect }: { tree: TreeState; selected: number | null; onSelect: (n: MetaNode) => void }) {
  const [at, setAt] = useState<number | null>(null);
  const here = at ? tree.byId.get(at) ?? null : null;
  const parent = here?.parent_id ? tree.byId.get(here.parent_id) ?? null : null;
  return (
    <div className="tr-drill">
      <div className="tr-drill-head">
        {here && (
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setAt(parent?.id ?? null)}>
            ‹ {parent?.label ?? tree.dimension?.label}
          </button>
        )}
        <b style={{ flex: 1, minWidth: 0 }}>{here?.label ?? tree.dimension?.label}</b>
      </div>
      {here && (
        <button type="button" className="tr-drill-item" style={{ color: "#1d4ed8", fontWeight: 600 }} onClick={() => onSelect(here)}>
          Vælg „{here.label}“ {selected === here.id && "✓"}
        </button>
      )}
      {(here ? tree.children(here.id) : tree.children(null)).map((n) => (
        <button
          key={n.id}
          type="button"
          className="tr-drill-item"
          onClick={() => {
            if (n.has_children === false) return onSelect(n);
            void tree.ensureChildren(n.id);
            setAt(n.id);
          }}
        >
          <span style={{ flex: 1, fontWeight: selected === n.id ? 700 : 500 }}>{n.label}</span>
          <span aria-hidden="true" className="muted">{n.has_children === false ? (selected === n.id ? "✓" : "") : "›"}</span>
        </button>
      ))}
    </div>
  );
}

function PathView({ tree, selected, onSelect }: { tree: TreeState; selected: number | null; onSelect: (n: MetaNode) => void }) {
  const path = ancestors(tree, selected);
  if (!path.length) return <p className="muted">Vælg en node i en af de andre visninger.</p>;
  const node = path[path.length - 1];
  const labels = [tree.dimension?.label ?? "", ...path.map((n) => n.label)];
  const short = labels.length > 4 ? `${labels[0]} › … › ${labels.slice(-2).join(" › ")}` : labels.join(" › ");
  return (
    <div className="stack" style={{ "--gap": "16px" } as React.CSSProperties}>
      <nav aria-label="Sti" className="tr-crumbs">
        <span className="muted">{tree.dimension?.label} ›</span>
        {path.map((n, i) => (
          <span key={n.id} className="row" style={{ "--gap": "2px" } as React.CSSProperties}>
            {i > 0 && <span className="muted" aria-hidden="true">›</span>}
            <button type="button" aria-current={n.id === node.id ? "page" : undefined} onClick={() => onSelect(n)}>{n.label}</button>
          </span>
        ))}
      </nav>
      <div className="grid" style={{ "--min": "220px" } as React.CSSProperties}>
        <div className="card muted-bg"><span className="tiny muted">Forkortet</span>{short}</div>
        <div className="card muted-bg"><span className="tiny muted">Rå sti</span><code>{node.display_path}</code></div>
        <div className="card muted-bg">
          <span className="tiny muted">Chip</span>
          <span className="tr-chip" style={{ alignSelf: "flex-start" }}>
            {path.length > 1 && <span className="tr-chip-ctx">{path[path.length - 2].label} ›</span>}<b>{node.label}</b>
          </span>
        </div>
      </div>
    </div>
  );
}

function Value({ value }: { value: unknown }) {
  return <pre className="tiny" style={{ margin: 0, padding: "10px 12px", background: "var(--hm-muted)", borderRadius: 8, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{JSON.stringify(value)}</pre>;
}

export default function Trees() {
  const [dims, setDims] = useState<MetaDimension[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dim, setDim] = useState<string>("");
  const [view, setView] = useState<View>("tree");
  const [selected, setSelected] = useState<number | null>(null);
  const [one, setOne] = useState<number | null>(null);
  const [scoped, setScoped] = useState<number | null>(null);
  const [tags, setTags] = useState<number[]>([]);
  const [tagNodes, setTagNodes] = useState<MetaNode[]>([]);
  const [filter, setFilter] = useState<number[]>([]);
  const [covered, setCovered] = useState<number | null>(null);

  useEffect(() => {
    metaApi.dimensions().then((d) => {
      setDims(d);
      setDim((cur) => cur || (d.find((x) => !x.private && (x.nodes ?? 0) > 0) ?? d.find((x) => x.private))?.slug || PRIVATE);
    }, (e) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    setSelected(null);
    setOne(null);
    setScoped(null);
    setTags([]);
    setTagNodes([]);
    setFilter([]);
  }, [dim]);

  useEffect(() => {
    if (!filter.length) return setCovered(null);
    metaApi.expand(filter).then((r) => setCovered(r.ids.length), () => setCovered(null));
  }, [filter]);

  const tree = useTree({ dimension: dim || undefined, depth: 3 });
  const current = useMemo(() => dims?.find((d) => d.slug === dim), [dims, dim]);
  const shared = dims?.filter((d) => !d.private) ?? [];

  return (
    <>
      <p className="muted" style={{ maxWidth: 760, margin: 0 }}>
        Komponenterne <code>TreeView</code> og <code>TreeSelect</code> (<code>web/src/tree/</code>) kan bruges både her og i{" "}
        <code>/admin</code>. Værdier gemmes som node-id'er.
      </p>

      {error && <div className="card" role="alert">{error}</div>}

      <div className="row" style={{ "--gap": "12px", alignItems: "flex-end" } as React.CSSProperties}>
        <label className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
          <span className="small" style={{ fontWeight: 600 }}>Træ</span>
          <select value={dim} onChange={(e) => setDim(e.target.value)}>
            {dims?.map((d) => (
              <option key={d.slug} value={d.slug}>{d.label}{d.private ? " (kun dig)" : ""} · {d.nodes ?? 0} noder</option>
            ))}
          </select>
        </label>
        {current && <span className="small muted">{current.can_create ? "Du kan oprette på øverste niveau." : current.create_denied}</span>}
      </div>
      {dims && shared.length === 0 && (
        <div className="card muted-bg small">
          Der er ingen delte træer endnu. En admin opretter dem i <a href="/admin/meta">/admin/meta</a>. Indtil da kan du prøve med
          „Mit træ“, som kun du kan se: skriv et navn i et af felterne nedenfor for at oprette den første node.
        </div>
      )}

      <section className="stack" style={{ "--gap": "14px" } as React.CSSProperties}>
        <h2>Ét træ, fire visninger</h2>
        <div className="row" role="group" aria-label="Visning">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" className={`btn btn-sm ${view === v.id ? "btn-primary" : "btn-outline"}`} aria-pressed={view === v.id} onClick={() => setView(v.id)} title={v.use}>
              {v.name}
            </button>
          ))}
          <span className="small muted">{VIEWS.find((v) => v.id === view)?.use}</span>
        </div>
        <div className="card" key={dim}>
          {view === "tree" && <TreeView tree={tree} label={current?.label ?? "Træ"} selectedId={selected} onSelect={(n) => setSelected(n.id)}
            aside={(n) => (n.objects ? <span className="tr-hint" title="Objekter tagget direkte her">{n.objects}</span> : null)} />}
          {view === "cols" && <Columns tree={tree} selected={selected} onSelect={(n) => setSelected(n.id)} />}
          {view === "drill" && <Drill tree={tree} selected={selected} onSelect={(n) => setSelected(n.id)} />}
          {view === "path" && <PathView tree={tree} selected={selected} onSelect={(n) => setSelected(n.id)} />}
        </div>
      </section>

      {dim && (
        <section className="stack" style={{ "--gap": "14px" }  as React.CSSProperties}>
          <h2>Inputfelter</h2>
          <div className="grid" style={{ "--min": "320px", "--gap": "20px" } as React.CSSProperties}>
            <div className="card">
              <h3>Vælg én node</h3>
              <TreeSelect key={`one-${dim}`} dimension={dim} label="Afdeling" value={one} onChange={(v) => setOne(v)} allowCreate />
              <Value value={one} />
            </div>
            <div className="card">
              <h3>Afgrænset til en startnode</h3>
              {one ? (
                <TreeSelect key={`scoped-${one}`} dimension={dim} root={one} includeRoot label="Underafdeling" value={scoped} onChange={(v) => setScoped(v)} allowCreate
                  hint="Startnoden er den node, du valgte til venstre." />
              ) : (
                <p className="small muted">Vælg først en node i feltet „Afdeling“. Den bliver startnode her.</p>
              )}
              <Value value={scoped} />
            </div>
            <div className="card">
              <h3>Tags · flere noder</h3>
              <TreeSelect key={`tags-${dim}`} dimension={dim} multiple cascade="node" max={8} label="Tags" value={tags}
                onChange={(v, nodes) => { setTags(v); setTagNodes(nodes); }} allowCreate />
              <Value value={tags} />
              {tagNodes.length > 0 && <code className="tiny muted">{pathString(tagNodes)}</code>}
            </div>
            <div className="card">
              <h3>Filter · hele grenen</h3>
              <TreeSelect key={`filter-${dim}`} dimension={dim} multiple cascade="subtree" variant="inline" label="Filtrér på" value={filter} onChange={(v) => setFilter(v)} />
              <Value value={filter} />
              {covered !== null && <span className="small muted">Dækker {covered} noder (<code>GET /api/meta/expand</code>).</span>}
            </div>
          </div>
          {one && tree.byId.get(one) && <p className="small muted">Valgt afdeling: {[current?.label, ...ancestors(tree, one).map((n) => n.label)].join(" › ")}</p>}
        </section>
      )}

      {dim && <TreesTagging selected={selected} onSelect={setSelected} />}

      <p className="small muted">
        Design og krav: lærredet „Træstrukturer i Gær“. Tilbage til <Link to="/developer">Udvikler</Link>.
      </p>
    </>
  );
}
