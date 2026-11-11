// Objects and the context of a node, shared by /develop/trae and the browser extension's Tags tab.
// ObjectRow: one tagged object with its tags. ContextView: GET /api/meta/context — parents, children, siblings,
// the objects at the node and related nodes (the same objects tagged elsewhere).
import { useEffect, useState } from "react";
import { errorText } from "../api";
import { metaApi, type MetaContext, type MetaObject, type ObjectKind } from "./api";
import { TagChips } from "./TagEditor";
import "./tree.css";

export const KIND_LABEL: Record<ObjectKind, string> = { url: "URL", entity: "Entitet", note: "Note" };
export const MATCH_LABEL = { exact: "denne side", pattern: "mønster", host: "hele domænet" } as const;

export function ObjectRow({ o, onUntag, onOpen, onTag }: {
  o: MetaObject;
  /** Show × on the tags. */
  onUntag?: (nodeId: number) => void;
  /** Make the title a link (the extension opens URLs in a tab). */
  onOpen?: (o: MetaObject) => void;
  /** Click on a tag (e.g. show its context). */
  onTag?: (nodeId: number) => void;
}) {
  const openable = onOpen && o.kind === "url" && o.ref.includes("://") && !o.ref.endsWith("*");
  return (
    <div className="tr-object">
      <div className="tr-object-head">
        <span className="tr-kind">{KIND_LABEL[o.kind]}</span>
        {openable ? (
          <button type="button" className="tr-title-link" onClick={() => onOpen!(o)}>{o.title}</button>
        ) : (
          <b className="tr-ellipsis">{o.title}</b>
        )}
        {o.match && <span className="tr-hint">{MATCH_LABEL[o.match]}</span>}
      </div>
      {o.kind !== "note" && <span className="tr-ref">{o.ref}</span>}
      {onTag ? (
        <span className="tr-values" style={{ minHeight: 0 }}>
          {o.nodes.map((n) => (
            <button key={n.id} type="button" className="tr-chip tr-chip-btn" onClick={() => onTag(n.id)}
              title={[n.dimension_label, ...(n.trail ?? []).map((t) => t.label), n.label].join(" › ")}>
              <span className="tr-dot" style={{ background: n.color ?? (n.private ? "#4b5262" : "#94a3b8") }} aria-hidden="true" />
              {n.trail?.length ? <span className="tr-chip-ctx">{n.trail[n.trail.length - 1].label} ›</span> : null}
              <b>{n.label}</b>
            </button>
          ))}
        </span>
      ) : (
        <TagChips nodes={o.nodes} onRemove={onUntag} />
      )}
    </div>
  );
}

export function ContextView({ node, onSelect, onOpen, version = 0, onChanged, compact }: {
  node: number;
  onSelect: (id: number) => void;
  onOpen?: (o: MetaObject) => void;
  version?: number;
  /** Given: tags on the objects can be removed here, then this is called. */
  onChanged?: () => void;
  compact?: boolean;
}) {
  const [ctx, setCtx] = useState<MetaContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    metaApi.context(node).then(setCtx, (e) => setError(errorText(e)));
  }, [node, version]);

  if (error) return <div className="tr-note tr-error">{error}</div>;
  if (!ctx || ctx.node.id !== node) return <div className="tr-note">Henter …</div>;

  const untag = (o: MetaObject) => async (nodeId: number) => {
    try {
      await metaApi.untag(o.id, nodeId);
      onChanged?.();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const bucket = (title: string, hint: string, rows: { id: number; label: string; extra: string }[]) => (
    <div className="tr-bucket">
      <div className="tr-bucket-title">{title}<span>{hint}</span></div>
      {rows.length ? (
        <div className="tr-values" style={{ minHeight: 0 }}>
          {rows.map((r) => (
            <button key={r.id} type="button" className="tr-link" onClick={() => onSelect(r.id)}>{r.label} <span className="tr-hint">· {r.extra}</span></button>
          ))}
        </div>
      ) : <span className="tr-hint">—</span>}
    </div>
  );

  return (
    <div className="tr-context">
      <div className="tr-objects">
        <div className="tr-bucket-title">Objekter ved noden<span>{ctx.objects.length}</span></div>
        {ctx.objects.map((o) => (
          <ObjectRow key={o.id} o={o} onOpen={onOpen} onUntag={onChanged ? untag(o) : undefined} onTag={compact ? onSelect : undefined} />
        ))}
        {!ctx.objects.length && <span className="tr-hint">Intet er tagget direkte her.</span>}
      </div>
      {bucket("Forældre", "fra stien", ctx.parents.map((p) => ({ id: p.id, label: p.label, extra: "op" })))}
      {bucket("Børn", "næste niveau", ctx.children.map((c) => ({ id: c.id, label: c.label, extra: `${c.objects}` })))}
      {bucket("Søskende", "samme forælder", ctx.siblings.map((c) => ({ id: c.id, label: c.label, extra: `${c.objects}` })))}
      {bucket("Relateret", "samme objekter, andre steder", ctx.related.map((r) => ({
        id: r.node.id, label: `${r.node.dimension_label} › ${r.node.label}`, extra: r.objects.map((o) => o.title).join(" · "),
      })))}
    </div>
  );
}

/** The heading line of a node in context: "Organisation › Drift › Support". */
export function useNodeTitle(node: number | null): { label: string; trail: string } | null {
  const [t, setT] = useState<{ label: string; trail: string } | null>(null);
  useEffect(() => {
    if (!node) return setT(null);
    metaApi.resolve([node]).then(([n]) => setT(n ? { label: n.label, trail: (n.trail ?? []).map((x) => x.label).join(" › ") } : null), () => setT(null));
  }, [node]);
  return t;
}
