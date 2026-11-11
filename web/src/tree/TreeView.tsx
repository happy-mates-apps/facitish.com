// An indented tree with fold-out, selection or check boxes, and the WAI-ARIA tree keyboard pattern:
// ↑ ↓ move, → open / go to first child, ← close / go to parent, Home/End, Enter or Space select.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { MetaNode } from "./api";
import type { TreeState } from "./useTree";
import "./tree.css";

export type CheckState = "on" | "off" | "mixed" | "implied";

export type TreeViewProps = {
  tree: TreeState;
  /** Accessible name of the tree. */
  label: string;
  selectedId?: number | null;
  onSelect?: (node: MetaNode) => void;
  /** Check boxes instead of a selected row (multiple choice). */
  check?: (node: MetaNode) => CheckState;
  /** Nodes that cannot be chosen are shown as groups (a click folds them). */
  isSelectable?: (node: MetaNode) => boolean;
  /** Ids open from the start; by default the first level is open. */
  initiallyOpen?: number[];
  /** Something at the end of each row: a count, a badge, actions. */
  aside?: (node: MetaNode) => ReactNode;
  /** Show only these ids (and their ancestors), e.g. "only selected". */
  filter?: (node: MetaNode) => boolean;
  emptyText?: string;
  dense?: boolean;
};

type Row = { node: MetaNode; level: number; open: boolean; hasChildren: boolean };

export function TreeView({ tree, label, selectedId, onSelect, check, isSelectable, initiallyOpen, aside, filter, emptyText, dense }: TreeViewProps) {
  const [open, setOpen] = useState<Set<number>>(() => new Set(initiallyOpen ?? []));
  const [focus, setFocus] = useState<number | null>(null);
  const refs = useRef(new Map<number, HTMLDivElement>());
  const opened = useRef(false);

  // Open the first level once the tree has loaded (unless the caller decided).
  useEffect(() => {
    if (opened.current || tree.loading || initiallyOpen) return;
    const top = tree.children(null);
    if (!top.length) return;
    opened.current = true;
    setOpen(new Set(top.filter((n) => n.has_children).map((n) => n.id)));
  }, [tree, initiallyOpen]);

  const keep = useMemo(() => {
    if (!filter) return null;
    const ids = new Set<number>();
    for (const n of tree.byId.values()) {
      if (!filter(n)) continue;
      let cur: MetaNode | undefined = n;
      while (cur) {
        ids.add(cur.id);
        cur = cur.parent_id ? tree.byId.get(cur.parent_id) : undefined;
      }
    }
    return ids;
  }, [filter, tree.byId]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (parent: number | null, level: number) => {
      for (const node of tree.children(parent)) {
        if (keep && !keep.has(node.id)) continue;
        const hasChildren = node.has_children !== false && (tree.children(node.id).length > 0 || !tree.loaded(node.id));
        const isOpen = (keep ? true : open.has(node.id)) && hasChildren;
        out.push({ node, level, open: isOpen, hasChildren });
        if (isOpen) walk(node.id, level + 1);
      }
    };
    walk(null, 1);
    return out;
  }, [tree, open, keep]);

  const toggle = (row: Row, to?: boolean) => {
    const next = to ?? !row.open;
    if (next) void tree.ensureChildren(row.node.id);
    setOpen((old) => {
      const s = new Set(old);
      if (next) s.add(row.node.id);
      else s.delete(row.node.id);
      return s;
    });
  };

  const choose = (row: Row) => {
    if (isSelectable && !isSelectable(row.node)) toggle(row);
    else onSelect?.(row.node);
  };

  const move = (id: number) => {
    setFocus(id);
    refs.current.get(id)?.focus();
  };

  const onKey = (e: KeyboardEvent, i: number) => {
    const row = rows[i];
    const keys: Record<string, () => void> = {
      ArrowDown: () => rows[i + 1] && move(rows[i + 1].node.id),
      ArrowUp: () => rows[i - 1] && move(rows[i - 1].node.id),
      Home: () => rows[0] && move(rows[0].node.id),
      End: () => rows.length && move(rows[rows.length - 1].node.id),
      ArrowRight: () => (row.hasChildren && !row.open ? toggle(row, true) : row.open && rows[i + 1] ? move(rows[i + 1].node.id) : undefined),
      ArrowLeft: () => {
        if (row.open) return toggle(row, false);
        const parent = rows.slice(0, i).reverse().find((r) => r.level === row.level - 1);
        if (parent) move(parent.node.id);
      },
      Enter: () => choose(row),
      " ": () => choose(row),
    };
    if (keys[e.key]) {
      e.preventDefault();
      keys[e.key]();
    }
  };

  if (tree.loading) return <div className="tr-note">Henter træet …</div>;
  if (tree.error) return <div className="tr-note tr-error">{tree.error}</div>;
  if (!rows.length) return <div className="tr-note">{emptyText ?? "Ingen noder endnu."}</div>;

  const tabStop = focus !== null && rows.some((r) => r.node.id === focus) ? focus : (rows.find((r) => r.node.id === selectedId) ?? rows[0]).node.id;

  return (
    <div role="tree" aria-label={label} aria-multiselectable={check ? true : undefined} className={`tr-tree${dense ? " tr-dense" : ""}`}>
      {rows.map((row, i) => {
        const { node } = row;
        const can = !isSelectable || isSelectable(node);
        const state = check?.(node);
        const selected = check ? state === "on" || state === "implied" : node.id === selectedId;
        return (
          <div
            key={node.id}
            ref={(el) => {
              if (el) refs.current.set(node.id, el);
              else refs.current.delete(node.id);
            }}
            role="treeitem"
            aria-level={row.level}
            aria-expanded={row.hasChildren ? row.open : undefined}
            aria-selected={check ? undefined : selected}
            aria-checked={check ? (state === "mixed" ? "mixed" : selected) : undefined}
            aria-disabled={state === "implied" || undefined}
            tabIndex={node.id === tabStop ? 0 : -1}
            className={`tr-row${selected && !check ? " tr-selected" : ""}${can ? "" : " tr-group"}${node.archived ? " tr-archived" : ""}`}
            style={{ paddingLeft: `${(row.level - 1) * 20 + 4}px` }}
            onKeyDown={(e) => onKey(e, i)}
            onFocus={() => setFocus(node.id)}
            onClick={() => choose(row)}
          >
            {row.hasChildren ? (
              <span
                className={`tr-chevron${row.open ? " tr-open" : ""}`}
                aria-hidden="true"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(row);
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" /></svg>
              </span>
            ) : (
              <span className="tr-chevron tr-leaf" aria-hidden="true" />
            )}
            {check && <span className={`tr-box tr-box-${state}`} aria-hidden="true">{state === "mixed" ? "–" : state === "on" || state === "implied" ? "✓" : ""}</span>}
            <span className="tr-label">{node.label}</span>
            {node.archived && <span className="tr-tag">arkiveret</span>}
            {!can && <span className="tr-hint">gruppe</span>}
            {state === "implied" && <span className="tr-hint">med i forælder</span>}
            {aside?.(node)}
          </div>
        );
      })}
      {tree.truncated && <div className="tr-note">Træet er for stort til at vise på én gang. Søg for at finde resten.</div>}
    </div>
  );
}
