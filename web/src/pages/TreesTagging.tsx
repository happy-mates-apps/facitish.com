// /develop/trae, part 2: tagging objects (URLs, entities, notes) with nodes across trees, looking up a URL as the
// browser extension will, and the context of a node: parents, siblings, children, objects and related nodes.
import { useEffect, useState } from "react";
import { ApiError, errorText } from "../api";
import { metaApi, type MetaObject, type ObjectKind } from "../tree/api";
import { ContextView, KIND_LABEL, ObjectRow, useNodeTitle } from "../tree/MetaContext";
import { TagEditor } from "../tree/TagEditor";

function TagForm({ onSaved }: { onSaved: () => void }) {
  const [kind, setKind] = useState<ObjectKind>("url");
  const [ref, setRef] = useState("");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState<number[]>([]);
  const [existing, setExisting] = useState<MetaObject | null>(null);
  const [normalized, setNormalized] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setRef("");
    setTitle("");
    setTags([]);
    setExisting(null);
    setNormalized(null);
  };

  // Is this URL or entity tagged already? Then edit its tags instead of creating a new object.
  const lookup = async () => {
    setMsg(null);
    setExisting(null);
    setNormalized(null);
    if (kind === "note" || !ref.trim()) return;
    try {
      const o = await metaApi.byRef(kind, ref);
      setExisting(o);
      setTitle(o.title);
      setTags(o.nodes.map((n) => n.id));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) return setMsg({ ok: false, text: errorText(e) });
      if (kind === "url") metaApi.normalizeUrl(ref).then((r) => setNormalized(r.url), (err) => setMsg({ ok: false, text: errorText(err) }));
    }
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (existing) {
        if (existing.mine && title.trim() && title !== existing.title) await metaApi.updateObject(existing.id, { title });
        const r = await metaApi.setTags(existing.id, tags);
        setMsg({ ok: true, text: "deleted" in r ? "Alle tags er fjernet, så objektet er slettet." : `Tags på „${r.title}“ er gemt.` });
      } else {
        const r = await metaApi.tag({ kind, ref: kind === "note" ? null : ref, title, node_ids: tags });
        setMsg({ ok: true, text: r.created ? `„${r.title}“ er tagget.` : `„${r.title}“ fandtes allerede; tags er lagt til.` });
      }
      reset();
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>Tag en side, en entitet eller en note</h3>
      <div className="row" role="group" aria-label="Type">
        {(Object.keys(KIND_LABEL) as ObjectKind[]).map((k) => (
          <button key={k} type="button" className={`btn btn-sm ${kind === k ? "btn-primary" : "btn-outline"}`} aria-pressed={kind === k}
            onClick={() => { setKind(k); reset(); setMsg(null); }}>
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      {kind !== "note" && (
        <label className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
          <span className="small" style={{ fontWeight: 600 }}>{kind === "url" ? "Adresse" : "Reference (type:id)"}</span>
          <input value={ref} onChange={(e) => setRef(e.target.value)} onBlur={lookup} spellCheck={false}
            placeholder={kind === "url" ? "https://status.example.com · https://github.com/org/* · example.com" : "clip:12"} />
          {normalized && normalized !== ref.trim() && <span className="tiny muted">Gemmes som <code>{normalized}</code></span>}
          {existing && <span className="tiny" style={{ color: "#0f6b4e" }}>Findes allerede. Du retter dens tags{existing.mine ? " og titel" : ""}.</span>}
        </label>
      )}
      <label className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
        <span className="small" style={{ fontWeight: 600 }}>Titel</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={!!existing && !existing.mine} maxLength={300} />
      </label>
      <TagEditor value={tags} onChange={setTags} />
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={busy || !title.trim() || (!existing && !tags.length) || (kind !== "note" && !ref.trim())} onClick={save}>
          {existing ? "Gem tags" : "Tag"}
        </button>
        {msg && <span className="small" role="status" style={{ color: msg.ok ? "#0f6b4e" : "#9b1c1c" }}>{msg.text}</span>}
      </div>
    </div>
  );
}

function UrlLookup({ version }: { version: number }) {
  const [url, setUrl] = useState("");
  const [res, setRes] = useState<{ url: string; matches: MetaObject[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setError(null);
    try {
      setRes(await metaApi.resolveUrl(url));
    } catch (e) {
      setRes(null);
      setError(errorText(e));
    }
  };
  useEffect(() => {
    if (res) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  return (
    <div className="card">
      <h3>Slå en side op</h3>
      <p className="small muted">Som side-panelet i udvidelsen vil gøre: præcis adresse før mønster før værtsnavn, højst tre.</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <input aria-label="Adresse" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" style={{ flex: 1 }} spellCheck={false} />
        <button className="btn btn-outline" type="submit" disabled={!url.trim()}>Slå op</button>
      </form>
      {error && <span className="small" style={{ color: "#9b1c1c" }}>{error}</span>}
      {res && (
        <div className="tr-objects">
          <span className="tiny muted">Normaliseret: <code>{res.url}</code></span>
          {res.matches.map((m) => <ObjectRow key={m.id} o={m} />)}
          {!res.matches.length && <span className="small muted">Ingen tags på denne side. Udvidelsen vil tilbyde „Tag denne side“.</span>}
        </div>
      )}
    </div>
  );
}

function Context({ node, onSelect, version, onChanged }: { node: number | null; onSelect: (id: number) => void; version: number; onChanged: () => void }) {
  const title = useNodeTitle(node);
  if (!node) return <div className="card"><h3>Konteksten for en node</h3><p className="small muted">Vælg en node i en af visningerne ovenfor.</p></div>;
  return (
    <div className="card">
      <h3>Konteksten for „{title?.label ?? "…"}“</h3>
      <code className="tiny muted">{title?.trail ? `${title.trail} › ` : ""}{title?.label} · GET /api/meta/context</code>
      <ContextView node={node} onSelect={onSelect} version={version} onChanged={onChanged} />
    </div>
  );
}

export default function TreesTagging({ selected, onSelect }: { selected: number | null; onSelect: (id: number) => void }) {
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  return (
    <section className="stack" style={{ "--gap": "14px" } as React.CSSProperties}>
      <h2>Tagging af objekter</h2>
      <p className="muted" style={{ maxWidth: 760 }}>
        Et objekt er en adresse, en entitet i Gær eller andre systemer (<code>clip:12</code>) eller en note. Det tagges med noder i
        alle træer, også dit eget. Andre ser kun de tags, de kan se noden for.
      </p>
      <div className="grid" style={{ "--min": "340px", "--gap": "20px" } as React.CSSProperties}>
        <div className="stack" style={{ "--gap": "20px" } as React.CSSProperties}>
          <TagForm onSaved={bump} />
          <UrlLookup version={version} />
        </div>
        <Context node={selected} onSelect={onSelect} version={version} onChanged={bump} />
      </div>
    </section>
  );
}
