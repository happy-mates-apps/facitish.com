// <TreeSelect>: choose one or more nodes in a tree — a dropdown (or an open panel) with search, an optional start node,
// check boxes with "only the node" or "the whole branch", and creating a node where the server allows it.
// The value is node ids. Design: the canvas "Træstrukturer i Gær" (artboards 2–4).
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { errorText } from "../api";
import { metaApi, trailText, type MetaNode } from "./api";
import { TreeView, type CheckState } from "./TreeView";
import { useTree } from "./useTree";
import "./tree.css";

type Common = {
  /** The tree: a dimension slug, or "~" for the user's own tree. */
  dimension: string;
  /** Start node: only nodes below it are shown and can be chosen. Limits the view, not access. */
  root?: number | null;
  /** May the start node itself be chosen? */
  includeRoot?: boolean;
  /** Which nodes can be chosen; the others are groups. */
  selectable?: "any" | "leaf" | ((node: MetaNode) => boolean);
  /** Offer "Opret …" when a search finds nothing. The server's can_create decides where. */
  allowCreate?: boolean;
  /** The visible label; required for screen readers. */
  label: string;
  hideLabel?: boolean;
  placeholder?: string;
  disabled?: boolean;
  error?: string | null;
  hint?: ReactNode;
  /** "dropdown" in forms; "inline" shows the tree open (panels, filters). */
  variant?: "dropdown" | "inline";
  /** Create through /api/admin/meta (the admin app). */
  admin?: boolean;
};

type Single = Common & { multiple?: false; value: number | null; onChange: (value: number | null, node: MetaNode | null) => void };
type Multi = Common & {
  multiple: true;
  /** "node": each node means itself (tags). "subtree": a parent covers its whole branch (filters, access). */
  cascade?: "node" | "subtree";
  max?: number;
  value: number[];
  onChange: (value: number[], nodes: MetaNode[]) => void;
};

export type TreeSelectProps = Single | Multi;

const CHIPS = 4;

export function TreeSelect(props: TreeSelectProps) {
  const { dimension, root = null, includeRoot = false, allowCreate = false, label, hideLabel, placeholder, disabled, error, hint } = props;
  const variant = props.variant ?? "dropdown";
  const multiple = props.multiple === true;
  const cascade = multiple ? (props as Multi).cascade ?? "node" : "node";
  const max = multiple ? (props as Multi).max : undefined;
  const ids = useMemo(() => (multiple ? (props.value as number[]) : props.value != null ? [props.value as number] : []), [multiple, props.value]);

  const id = useId();
  const tree = useTree({ dimension, root });
  const [open, setOpen] = useState(variant === "inline");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<MetaNode[] | null>(null);
  const [onlySelected, setOnlySelected] = useState(false);
  const [known, setKnown] = useState<Map<number, MetaNode>>(new Map());
  const [creating, setCreating] = useState<{ parent: number | null; busy: boolean; error: string | null } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // Labels for the chosen ids (they may be outside what is loaded, or archived).
  useEffect(() => {
    const missing = ids.filter((i) => !known.has(i) && !tree.byId.has(i));
    if (!missing.length) return;
    metaApi.resolve(missing).then((nodes) => setKnown((old) => new Map([...old, ...nodes.map((n) => [n.id, n] as const)])), () => undefined);
  }, [ids, known, tree.byId]);

  const nodeOf = (i: number) => tree.byId.get(i) ?? known.get(i) ?? (tree.root?.id === i ? tree.root : undefined);
  const chosen = ids.map(nodeOf).filter((n): n is MetaNode => !!n);

  // Search on the server (debounced), within the start node.
  useEffect(() => {
    const text = q.trim();
    if (!text) {
      setHits(null);
      return;
    }
    const t = window.setTimeout(() => {
      metaApi.search(text, { dimension, root }).then(setHits, () => setHits([]));
    }, 180);
    return () => window.clearTimeout(t);
  }, [q, dimension, root]);

  // Close the dropdown on a click outside or Escape.
  useEffect(() => {
    if (variant !== "dropdown" || !open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, variant]);

  const selectable = (n: MetaNode) => {
    const s = props.selectable ?? "any";
    if (s === "leaf") return n.has_children === false;
    if (typeof s === "function") return s(n);
    return true;
  };

  const under = (a: MetaNode, b: MetaNode) => a.path.startsWith(b.path + "/");
  const implied = (n: MetaNode) => cascade === "subtree" && chosen.some((c) => under(n, c));
  const full = max !== undefined && ids.length >= max;

  const emit = (next: number[], added?: MetaNode) => {
    const all = new Map(chosen.map((c) => [c.id, c]));
    if (added) all.set(added.id, added);
    const nodes = next.map((i) => all.get(i) ?? nodeOf(i)).filter((n): n is MetaNode => !!n);
    if (multiple) (props as Multi).onChange(next, nodes);
    else (props as Single).onChange(next[0] ?? null, nodes[0] ?? null);
  };

  const pick = (n: MetaNode) => {
    if (!selectable(n)) return;
    if (!tree.byId.has(n.id)) setKnown((old) => new Map(old).set(n.id, n));
    if (!multiple) {
      emit([n.id], n);
      setQ("");
      if (variant === "dropdown") setOpen(false);
      return;
    }
    if (ids.includes(n.id)) return emit(ids.filter((i) => i !== n.id));
    if (implied(n) || full) return;
    let next = [...ids, n.id];
    if (cascade === "subtree") next = next.filter((i) => i === n.id || !chosen.some((c) => c.id === i && under(c, n)));
    emit(next, n);
  };

  const check = (n: MetaNode): CheckState => {
    if (ids.includes(n.id)) return "on";
    if (implied(n)) return "implied";
    return chosen.some((c) => under(c, n)) ? "mixed" : "off";
  };

  // Creating: under the start node or the top level by default; the server's can_create says whether it is allowed.
  const parents = useMemo(() => {
    const list: { id: number | null; label: string; can: boolean; reason: string | null }[] = [];
    if (tree.root) list.push({ id: tree.root.id, label: tree.root.label, can: !!tree.root.can_create, reason: tree.root.create_denied ?? null });
    else if (tree.dimension) list.push({ id: null, label: `${tree.dimension.label} (øverste niveau)`, can: tree.dimension.can_create, reason: tree.dimension.create_denied });
    const walk = (parent: number | null, prefix: string) => {
      for (const n of tree.children(parent)) {
        list.push({ id: n.id, label: prefix + n.label, can: !!n.can_create, reason: n.create_denied ?? null });
        walk(n.id, prefix + n.label + " › ");
      }
    };
    walk(null, "");
    return list;
  }, [tree]);

  const text = q.trim();
  const exact = hits?.some((h) => h.label.toLowerCase() === text.toLowerCase());
  const showCreate = allowCreate && !!text && hits !== null && !exact;
  const defaultParent = (parents.find((x) => x.can) ?? parents[0])?.id ?? null;
  const createParent = parents.find((p) => p.id === (creating ? creating.parent : defaultParent)) ?? parents[0];

  const create = async () => {
    if (!createParent?.can) return;
    setCreating({ parent: createParent.id, busy: true, error: null });
    try {
      const node = await metaApi.create({ dimension: tree.dimension?.slug ?? dimension, parent_id: createParent.id, label: text }, props.admin);
      tree.add(node);
      setKnown((old) => new Map(old).set(node.id, node));
      setCreating(null);
      setQ("");
      if (multiple) {
        if (!full) emit([...ids, node.id], node);
      } else {
        emit([node.id], node);
        if (variant === "dropdown") setOpen(false);
      }
    } catch (e) {
      setCreating({ parent: createParent.id, busy: false, error: errorText(e) });
    }
  };

  const rootSelectable = includeRoot && tree.root && !q;

  const panel = (
    <div className={`tr-panel${variant === "inline" ? " tr-inline" : ""}`}>
      {multiple && (
        <div className="tr-tabs" role="group" aria-label="Visning">
          <button type="button" className={`tr-tab${!onlySelected ? " tr-on" : ""}`} aria-pressed={!onlySelected} onClick={() => setOnlySelected(false)}>Træ</button>
          <button type="button" className={`tr-tab${onlySelected ? " tr-on" : ""}`} aria-pressed={onlySelected} onClick={() => setOnlySelected(true)}>
            Kun valgte ({ids.length})
          </button>
          {tree.root && <span className="tr-scope">Under <b>{tree.root.label}</b></span>}
        </div>
      )}
      {!multiple && tree.root && <div className="tr-scope tr-scope-bar">Afgrænset til <b>{tree.root.label}</b></div>}
      <div className="tr-scroll">
        {rootSelectable && tree.root && (
          <button type="button" className={`tr-rootrow${ids.includes(tree.root.id) ? " tr-selected" : ""}`} onClick={() => pick(tree.root!)}>
            {tree.root.label} <span className="tr-hint">startnode</span>
          </button>
        )}
        {hits === null ? (
          <TreeView
            tree={tree}
            label={label}
            selectedId={multiple ? undefined : (props.value as number | null)}
            onSelect={pick}
            check={multiple ? check : undefined}
            isSelectable={(n) => selectable(n) && !(multiple && full && !ids.includes(n.id) && !implied(n))}
            filter={multiple && onlySelected ? (n) => ids.includes(n.id) || implied(n) : undefined}
            emptyText={multiple && onlySelected ? "Intet valgt endnu." : tree.dimension?.can_create || tree.root?.can_create ? "Ingen noder endnu. Skriv et navn for at oprette den første." : "Ingen noder endnu."}
            dense
          />
        ) : (
          <div role="listbox" aria-label={`Søgeresultater for ${text}`} aria-multiselectable={multiple || undefined} className="tr-hits">
            {hits.filter(selectable).map((h) => {
              const on = ids.includes(h.id) || implied(h);
              return (
                <button key={h.id} type="button" role="option" aria-selected={on} className={`tr-hit${on ? " tr-selected" : ""}`} onClick={() => pick(h)}>
                  <span className="tr-hit-label"><Highlight text={h.label} q={text} />{on && <span className="tr-check" aria-hidden="true">✓</span>}</span>
                  <span className="tr-hit-trail">{[tree.dimension?.label, trailText(h)].filter(Boolean).join(" › ")}</span>
                </button>
              );
            })}
            {hits.length === 0 && !showCreate && <div className="tr-note">Ingen noder matcher „{text}“.</div>}
          </div>
        )}
        {showCreate && createParent && (
          <div className="tr-create">
            <button type="button" className="tr-create-row" disabled={!createParent.can || creating?.busy} onClick={create}>
              <span className="tr-plus" aria-hidden="true">+</span>
              <span>
                Opret „{text}“ under <b>{createParent.label}</b>
              </span>
            </button>
            {parents.length > 1 && (
              <label className="tr-create-parent">
                <span>Placering</span>
                <select value={String(createParent.id)} onChange={(e) => setCreating({ parent: e.target.value === "null" ? null : Number(e.target.value), busy: false, error: null })}>
                  {parents.map((p) => (
                    <option key={String(p.id)} value={String(p.id)} disabled={!p.can}>
                      {p.label}
                      {p.can ? "" : " (ikke tilladt)"}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!createParent.can && createParent.reason && <div className="tr-denied">Du kan ikke oprette her: {createParent.reason}.</div>}
            {creating?.error && <div className="tr-denied">{creating.error}</div>}
          </div>
        )}
      </div>
      {variant === "dropdown" && (
        <div className="tr-keys" aria-hidden="true">
          <span><kbd>↑ ↓</kbd> flyt</span>
          <span><kbd>→ ←</kbd> fold ud/ind</span>
          <span><kbd>Enter</kbd> vælg</span>
          <span><kbd>Esc</kbd> luk</span>
        </div>
      )}
    </div>
  );

  const shown = chosen.slice(0, CHIPS);
  const field = (
    <div className={`tr-field${open && variant === "dropdown" ? " tr-focus" : ""}${error ? " tr-invalid" : ""}${disabled ? " tr-disabled" : ""}`} onClick={() => !disabled && setOpen(true)}>
      <div className="tr-values">
        {multiple ? (
          <>
            {shown.map((n) => (
              <span key={n.id} className="tr-chip">
                {n.trail?.length ? <span className="tr-chip-ctx">{n.trail[n.trail.length - 1].label} ›</span> : null}
                <b>{n.label}</b>
                {cascade === "subtree" && n.has_children !== false && <span className="tr-chip-sub">+ alt under</span>}
                {!disabled && (
                  <button type="button" className="tr-x" aria-label={`Fjern ${n.label}`} onClick={(e) => { e.stopPropagation(); emit(ids.filter((i) => i !== n.id)); }}>
                    ×
                  </button>
                )}
              </span>
            ))}
            {chosen.length > CHIPS && <span className="tr-more">+{chosen.length - CHIPS} til</span>}
          </>
        ) : (
          !q && chosen[0] && (
            <span className="tr-single">
              <b>{chosen[0].label}</b>
              {chosen[0].trail?.length ? <span className="tr-chip-ctx">{trailText(chosen[0])}</span> : null}
            </span>
          )
        )}
        <input
          id={id}
          className="tr-input"
          type="search"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          autoComplete="off"
          disabled={disabled}
          value={q}
          placeholder={chosen.length && !multiple ? "" : placeholder ?? (multiple ? "Vælg …" : "Vælg …")}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setCreating(null);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQ("");
              if (variant === "dropdown") setOpen(false);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              box.current?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"], [role="option"]')?.focus();
            } else if (e.key === "Backspace" && !q && ids.length) {
              emit(ids.slice(0, -1));
            }
          }}
        />
      </div>
      {!disabled && ids.length > 0 && (
        <button type="button" className="tr-x tr-clear" aria-label="Ryd valget" onClick={(e) => { e.stopPropagation(); emit([]); }}>
          ×
        </button>
      )}
    </div>
  );

  return (
    <div className="tr-select" ref={box} onKeyDown={(e) => e.key === "Escape" && variant === "dropdown" && setOpen(false)}>
      <div className="tr-head">
        <label htmlFor={id} className={hideLabel ? "tr-sr" : "tr-labeltext"}>{label}</label>
        {multiple && <span className="tr-count">{max ? `${ids.length} af ${max} valgt` : `${ids.length} valgt`}</span>}
      </div>
      {field}
      {open && !disabled && panel}
      {error ? <div className="tr-errortext">{error}</div> : hint ? <div className="tr-hinttext">{hint}</div> : null}
    </div>
  );
}

function Highlight({ text, q }: { text: string; q: string }) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0 || !q) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}
