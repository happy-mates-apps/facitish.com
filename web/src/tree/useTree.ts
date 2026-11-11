// Loads a tree from /api/meta/tree: two levels at first, then the children of a node when it is opened (lazy), so big
// trees stay fast. Nodes are kept by id; children(parentId) gives them in the server's order.
import { useCallback, useEffect, useMemo, useState } from "react";
import { errorText } from "../api";
import { metaApi, type MetaDimension, type MetaNode } from "./api";

export type TreeState = {
  dimension: MetaDimension | null;
  root: MetaNode | null;
  loading: boolean;
  error: string | null;
  truncated: boolean;
  byId: Map<number, MetaNode>;
  /** Children of a node, or the top level (null = directly under the dimension or the start node). */
  children: (parentId: number | null) => MetaNode[];
  /** True when the node's children are known (loaded, or it has none). */
  loaded: (id: number) => boolean;
  ensureChildren: (id: number) => Promise<void>;
  /** Puts a node the user just created into the tree without a reload. */
  add: (node: MetaNode) => void;
  reload: () => void;
};

export function useTree(p: { dimension?: string; root?: number | null; depth?: number; includeArchived?: boolean }): TreeState {
  const [dimension, setDimension] = useState<MetaDimension | null>(null);
  const [root, setRoot] = useState<MetaNode | null>(null);
  const [nodes, setNodes] = useState<Map<number, MetaNode>>(new Map());
  const [loadedIds, setLoadedIds] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [version, setVersion] = useState(0);
  const depth = p.depth ?? 2;

  useEffect(() => {
    if (!p.dimension && !p.root) {
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    metaApi
      .tree({ dimension: p.dimension, root: p.root, depth, includeArchived: p.includeArchived })
      .then((t) => {
        if (!live) return;
        setDimension(t.dimension);
        setRoot(t.root);
        setNodes(new Map(t.nodes.map((n) => [n.id, n])));
        const base = t.root?.depth ?? 0;
        // Nodes above the deepest loaded level have all their children in the answer.
        setLoadedIds(new Set(t.nodes.filter((n) => n.depth < base + depth).map((n) => n.id)));
        setTruncated(t.truncated);
      })
      .catch((e) => live && setError(errorText(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [p.dimension, p.root, depth, p.includeArchived, version]);

  const byParent = useMemo(() => {
    const m = new Map<number | null, MetaNode[]>();
    const top = root?.id ?? null;
    for (const n of nodes.values()) {
      const key = n.parent_id === top ? null : n.parent_id;
      const list = m.get(key) ?? [];
      list.push(n);
      m.set(key, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label, "da") || a.id - b.id);
    return m;
  }, [nodes, root]);

  const ensureChildren = useCallback(
    async (id: number) => {
      if (loadedIds.has(id) || nodes.get(id)?.has_children === false) return;
      try {
        const t = await metaApi.tree({ root: id, depth: 1, includeArchived: p.includeArchived });
        setNodes((old) => {
          const next = new Map(old);
          for (const n of t.nodes) next.set(n.id, n);
          return next;
        });
        setLoadedIds((old) => new Set(old).add(id));
      } catch (e) {
        setError(errorText(e));
      }
    },
    [loadedIds, nodes, p.includeArchived],
  );

  const add = useCallback((node: MetaNode) => {
    setNodes((old) => {
      const next = new Map(old);
      next.set(node.id, node);
      if (node.parent_id && next.has(node.parent_id)) next.set(node.parent_id, { ...next.get(node.parent_id)!, has_children: true });
      return next;
    });
    setLoadedIds((old) => new Set(old).add(node.id));
  }, []);

  return {
    dimension,
    root,
    loading,
    error,
    truncated,
    byId: nodes,
    children: (parentId) => byParent.get(parentId) ?? [],
    loaded: (id) => loadedIds.has(id) || nodes.get(id)?.has_children === false,
    ensureChildren,
    add,
    reload: () => setVersion((v) => v + 1),
  };
}
