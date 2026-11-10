// Træstrukturer: the client for /api/meta (server/app/meta.py). Shared by the app on / and the admin app.
// Values are node ids (numbers); a path is only for showing.
import { api, query } from "../api";

export type MetaNode = {
  id: number;
  parent_id: number | null;
  path: string;
  display_path: string;
  slug: string;
  label: string;
  description: string;
  depth: number;
  sort_order: number;
  dimension: string;
  private: boolean;
  archived: boolean;
  has_children?: boolean;
  /** Objects tagged directly with the node (in /api/meta/tree). */
  objects?: number;
  trail?: { id: number; label: string }[];
  can_create?: boolean;
  create_denied?: string | null;
};

export type MetaDimension = {
  id: number | null;
  slug: string;
  label: string;
  description: string;
  color: string | null;
  locked: boolean;
  private: boolean;
  can_create: boolean;
  create_denied: string | null;
  nodes?: number;
};

export type TreeResponse = {
  dimension: MetaDimension;
  root: MetaNode | null;
  nodes: MetaNode[];
  truncated: boolean;
};

export const PRIVATE = "~";

export type ObjectKind = "url" | "entity" | "note";
export type TagNode = MetaNode & { dimension_label: string; color: string | null };

export type MetaObject = {
  id: number;
  kind: ObjectKind;
  ref: string;
  title: string;
  description: string;
  mine: boolean;
  created_at: string;
  updated_at: string;
  /** The tags you can see (others' private tags are left out). */
  nodes: TagNode[];
  created?: boolean;
  match?: "exact" | "pattern" | "host";
};

export type MetaContext = {
  node: MetaNode;
  parents: { id: number; label: string }[];
  siblings: (MetaNode & { objects: number })[];
  children: (MetaNode & { objects: number })[];
  objects: MetaObject[];
  related: { node: TagNode; objects: { id: number; title: string }[] }[];
};

export const metaApi = {
  dimensions: () => api.get<MetaDimension[]>("/api/meta/dimensions"),
  tree: (p: { dimension?: string; root?: number | null; depth?: number; includeArchived?: boolean }) =>
    api.get<TreeResponse>(
      "/api/meta/tree" +
        query({ dimension: p.root ? undefined : p.dimension, root: p.root ?? undefined, depth: p.depth ?? 2, include_archived: p.includeArchived || undefined }),
    ),
  search: (q: string, p: { dimension?: string; root?: number | null; limit?: number }) =>
    api.get<MetaNode[]>("/api/meta/search" + query({ q, dimension: p.root ? undefined : p.dimension, root: p.root ?? undefined, limit: p.limit })),
  resolve: (ids: number[]) => (ids.length ? api.get<MetaNode[]>("/api/meta/nodes" + query({ ids: ids.join(",") })) : Promise.resolve([])),
  expand: (ids: number[]) => api.get<{ ids: number[] }>("/api/meta/expand" + query({ ids: ids.join(",") })),
  create: (body: { dimension: string; parent_id: number | null; label: string; slug?: string }, admin = false) =>
    api.post<MetaNode>(admin ? "/api/admin/meta/nodes" : "/api/meta/nodes", body),

  // Objects and tags
  objects: (node: number, p: { subtree?: boolean; kind?: ObjectKind; q?: string; limit?: number } = {}) =>
    api.get<MetaObject[]>("/api/meta/objects" + query({ node, subtree: p.subtree || undefined, kind: p.kind, q: p.q, limit: p.limit })),
  object: (id: number) => api.get<MetaObject>(`/api/meta/objects/${id}`),
  byRef: (kind: ObjectKind, ref: string) => api.get<MetaObject>("/api/meta/objects/by-ref" + query({ kind, ref })),
  tag: (body: { kind: ObjectKind; ref?: string | null; title: string; description?: string; node_ids: number[] }) =>
    api.post<MetaObject>("/api/meta/objects", body),
  setTags: (id: number, nodeIds: number[]) => api.put<MetaObject | { id: number; deleted: true }>(`/api/meta/objects/${id}/nodes`, { node_ids: nodeIds }),
  untag: (id: number, nodeId: number) => api.del<MetaObject | { id: number; deleted: true }>(`/api/meta/objects/${id}/nodes/${nodeId}`),
  updateObject: (id: number, body: { title?: string; description?: string }) => api.patch<MetaObject>(`/api/meta/objects/${id}`, body),
  context: (node: number) => api.get<MetaContext>("/api/meta/context" + query({ node })),
  resolveUrl: (url: string) => api.get<{ url: string; matches: MetaObject[] }>("/api/meta/resolve-url" + query({ url })),
  normalizeUrl: (url: string) => api.get<{ url: string }>("/api/meta/normalize-url" + query({ url })),
};

/** "Organisation › Drift" for a node with a trail (from search, resolve or create). */
export function trailText(node: Pick<MetaNode, "trail">, sep = " › "): string {
  return (node.trail ?? []).map((t) => t.label).join(sep);
}

/** The ;-string form of a value (forms, URLs, MCP): node ids, or paths with /** for a subtree. */
export function pathString(nodes: MetaNode[], subtree = false): string {
  return nodes.map((n) => (subtree ? `${n.path}/**` : n.path)).join(";");
}
