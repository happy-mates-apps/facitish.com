// /extension/meta — the Tags tab in the browser extension's side panel: what the current page is tagged with
// (GET /api/meta/resolve-url: this page › a pattern › the whole domain), tagging the page, and browsing the context
// of a tag (parents, children, siblings, related). Privacy: the address is only sent automatically on domains the
// user has allowed (the same per-domain consent as reading pages); elsewhere only when they ask.
import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "../api";
import { useAuth } from "../auth";
import { domainOf, extension, isExtension, type PageInfo } from "../bridge/extension";
import { metaApi, type MetaObject } from "../tree/api";
import { ContextView, ObjectRow, useNodeTitle } from "../tree/MetaContext";
import { TagEditor } from "../tree/TagEditor";
import { Alert, Loading } from "../ui";

type Scope = "exact" | "pattern" | "host";

/** The three ways to tag the current page: the page itself, everything under its folder, the whole domain. */
export function scopesFor(url: string): { scope: Scope; ref: string; label: string }[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const out: { scope: Scope; ref: string; label: string }[] = [{ scope: "exact", ref: url, label: "Kun denne side" }];
  const dir = u.pathname.replace(/\/[^/]*$/, "/");
  if (dir !== "/") out.push({ scope: "pattern", ref: `${u.origin}${dir}*`, label: "Alt under denne mappe" });
  out.push({ scope: "host", ref: u.hostname.replace(/^www\./, ""), label: "Hele domænet" });
  return out;
}

export default function ExtensionMeta() {
  const { config } = useAuth();
  const [inExtension, setInExtension] = useState<boolean | null>(null);
  const [tab, setTab] = useState<PageInfo | null>(null);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [res, setRes] = useState<{ url: string; matches: MetaObject[] } | null>(null);
  const [looking, setLooking] = useState(false);
  const [ctxNode, setCtxNode] = useState<number | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const domain = tab ? domainOf(tab.url) : "";

  useEffect(() => {
    isExtension().then(async (yes) => {
      setInExtension(yes);
      if (yes) setTab(await extension.pageInfo().catch(() => null));
    });
    return extension.onTabChanged((info) => {
      setTab(info);
      setRes(null);
      setCtxNode(null);
      setHistory([]);
      setEditing(false);
      setNotice(null);
      setError(null);
    });
  }, []);

  useEffect(() => {
    setAllowed(null);
    if (!domain || !tab?.readable) return;
    api.get<{ allowed: boolean }>(`/api/bridge-consent/check?domain=${encodeURIComponent(domain)}`)
      .then((r) => setAllowed(r.allowed), () => setAllowed(false));
  }, [domain, tab?.readable]);

  const lookup = useCallback(async () => {
    if (!tab?.readable) return;
    setLooking(true);
    setError(null);
    try {
      setRes(await metaApi.resolveUrl(tab.url));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLooking(false);
    }
  }, [tab]);

  // Automatically only where the user has allowed the domain.
  useEffect(() => {
    if (allowed) void lookup();
  }, [allowed, lookup, version]);

  const show = (id: number) => {
    if (ctxNode) setHistory((h) => [...h, ctxNode]);
    setCtxNode(id);
  };
  const back = () => {
    setCtxNode(history[history.length - 1] ?? null);
    setHistory((h) => h.slice(0, -1));
  };
  const open = (o: MetaObject) => void extension.openUrl(o.ref).catch(() => window.open(o.ref, "_blank", "noopener"));

  if (inExtension === null) return <Loading />;
  if (!inExtension) {
    return (
      <div className="card">
        <span className="eyebrow">Browserudvidelse</span>
        <p className="small">Fanen Tags vises i sidepanelet i browserudvidelsen. Prøv tagging på <a href="/developer/trae">/developer/trae</a>.</p>
      </div>
    );
  }
  if (ctxNode) return <ContextPanel node={ctxNode} onSelect={show} onBack={back} onOpen={open} onClose={() => { setCtxNode(null); setHistory([]); }} />;

  const exact = res?.matches.find((m) => m.match === "exact") ?? null;

  return (
    <div className="stack">
      <div className="card">
        <span className="eyebrow">Aktuel side</span>
        <strong style={{ wordBreak: "break-word" }}>{tab?.title || "—"}</strong>
        <span className="muted tiny" style={{ wordBreak: "break-all" }}>{tab?.url}</span>
        {!tab?.readable && <Alert kind="info">Kun almindelige websider (http og https) kan tagges.</Alert>}
      </div>

      {tab?.readable && allowed === false && !res && (
        <div className="card">
          <span className="eyebrow">Tags for siden</span>
          <p className="small">
            Adressen sendes kun automatisk til {config?.app_name ?? "appen"} på domæner, du har tilladt. Slå {domain} op én gang, eller tillad domænet.
          </p>
          <div className="row">
            <button className="btn btn-primary btn-sm" onClick={lookup} disabled={looking}>Slå siden op</button>
            <button className="btn btn-outline btn-sm" onClick={async () => {
              try {
                await api.post("/api/bridge-consent", { domain });
                setAllowed(true);
              } catch (e) {
                setError(errorText(e));
              }
            }}>Tillad {domain}</button>
          </div>
        </div>
      )}

      {looking && !res && <Loading />}

      {res && (
        <div className="card">
          <span className="eyebrow">Tagget som</span>
          {res.matches.length ? (
            <div className="tr-objects">
              {res.matches.map((m) => <ObjectRow key={m.id} o={m} onTag={show} onOpen={m.match === "exact" ? undefined : open} />)}
              <span className="tiny muted">Tryk på et tag for at se forældre, børn og hvad der ellers er tagget.</span>
            </div>
          ) : (
            <p className="small muted">Siden er ikke tagget endnu.</p>
          )}
        </div>
      )}

      {res && tab && (editing || !exact ? (
        <TagPage key={`${tab.url}-${exact?.id ?? "new"}`} tab={tab} existing={exact} also={res.matches.length > 0}
          onDone={(text) => { setNotice(text); setEditing(false); setVersion((v) => v + 1); }}
          onCancel={exact ? () => setEditing(false) : undefined} />
      ) : (
        <div><button className="btn btn-outline btn-sm" onClick={() => setEditing(true)}>Ret tags for denne side</button></div>
      ))}

      <Alert kind="success">{notice}</Alert>
      <Alert>{error}</Alert>
    </div>
  );
}

function TagPage({ tab, existing, also, onDone, onCancel }: { tab: PageInfo; existing: MetaObject | null; also?: boolean; onDone: (text: string) => void; onCancel?: () => void }) {
  const scopes = scopesFor(tab.url);
  const [scope, setScope] = useState<Scope>("exact");
  const [title, setTitle] = useState(existing?.title ?? tab.title ?? "");
  const [tags, setTags] = useState<number[]>(existing?.nodes.map((n) => n.id) ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = scopes.find((s) => s.scope === scope) ?? scopes[0];

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        if (existing.mine && title.trim() && title !== existing.title) await metaApi.updateObject(existing.id, { title });
        const r = await metaApi.setTags(existing.id, tags);
        onDone("deleted" in r ? "Alle tags er fjernet fra siden." : "Tags er gemt.");
      } else {
        const r = await metaApi.tag({ kind: "url", ref: chosen.ref, title, node_ids: tags });
        onDone(r.created ? "Siden er tagget." : `Tags er lagt til „${r.title}“.`);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <span className="eyebrow">{existing ? "Ret tags for denne side" : also ? "Tag også denne side" : "Tag denne side"}</span>
      {!existing && scopes.length > 1 && (
        <fieldset className="tr-scope-opts" style={{ border: 0, margin: 0, padding: 0 }}>
          <legend className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Hvad skal tagges?</legend>
          {scopes.map((s) => (
            <label key={s.scope} className="tr-scope-opt">
              <input type="radio" name="scope" checked={scope === s.scope} onChange={() => setScope(s.scope)} />
              <span>{s.label}<br /><code>{s.ref}</code></span>
            </label>
          ))}
        </fieldset>
      )}
      <label className="stack" style={{ "--gap": "6px" } as React.CSSProperties}>
        <span className="small" style={{ fontWeight: 600 }}>Titel</span>
        <input value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} disabled={!!existing && !existing.mine} />
      </label>
      <TagEditor value={tags} onChange={setTags} />
      <div className="row">
        <button className="btn btn-primary btn-sm" disabled={busy || !title.trim() || (!existing && !tags.length)} onClick={save}>
          {existing ? "Gem tags" : "Tag siden"}
        </button>
        {onCancel && <button className="btn btn-ghost btn-sm" onClick={onCancel}>Annullér</button>}
      </div>
      <Alert>{error}</Alert>
    </div>
  );
}

function ContextPanel({ node, onSelect, onBack, onOpen, onClose }: {
  node: number; onSelect: (id: number) => void; onBack: () => void; onOpen: (o: MetaObject) => void; onClose: () => void;
}) {
  const title = useNodeTitle(node);
  return (
    <div className="stack">
      <div className="row">
        <button className="btn btn-outline btn-sm" onClick={onBack}>‹ Tilbage</button>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>Til siden</button>
      </div>
      <div className="card">
        <span className="eyebrow">{title?.trail || "Tag"}</span>
        <strong>{title?.label ?? "…"}</strong>
        <ContextView node={node} onSelect={onSelect} onOpen={onOpen} compact />
      </div>
    </div>
  );
}
