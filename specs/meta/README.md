# Træstrukturer (metadata)

Ported from Surdej's `member-meta`. Design and examples: the Design canvas „Træstrukturer i Gær“ (five artboards:
renderings, single select, multi select, creating a node, component and API), built on the Surdej canvas
„Surdej Metadata-system“.

## Decided

| Question | Decision |
| --- | --- |
| What do other tables store? | **Node ids.** A path (`/org/drift/support`) is for showing, for URLs and for MCP; it changes when a node is renamed (slug) or moved. |
| What does a checked parent mean? | Per field: `cascade="node"` for **tags** (the node only), `cascade="subtree"` for **filters and access** (the whole branch, also nodes created later). The server expands a subtree with `GET /api/meta/expand` or `meta.expand_subtree()`. |
| Who creates the top level? | **Admins** with the admin role Indhold (or Fuld) and a valid second factor. Everyone creates below that, unless the dimension is **locked** (then admins only). |
| Private trees | `~/…` = `/~/<user id>/…`, only the owner sees and edits it. Exported and erased with the user (GDPR). |
| Deleting | Archive keeps stored values readable (hidden from pickers). Delete needs `force` when there are nodes below. |

## In the code

- `server/app/migrations/0022_meta.sql` — `meta_dimensions`, `meta_nodes` (materialised `path`, `depth` 1–8, `owner_id` for private nodes).
- `server/app/meta.py` — paths and slugs, rules (`create_rule`), tree/search/resolve/expand, create/update (move rewrites the subtree)/delete.
- `server/app/routes/meta.py` — `/api/meta/*` for users; `routes/admin_meta.py` — `/api/admin/meta/*` (section `/meta`).
- `web/src/tree/` — `TreeView` (ARIA tree, keyboard), `TreeSelect` (single/multi, `root`, `includeRoot`, `selectable`, `cascade`, `max`, `allowCreate`, `variant`), `useTree` (lazy loading), `api.ts`.
- `/develop/trae` — examples against the real API; `/admin/meta` — dimensions and editing shared nodes.
- Audit: `create`/`update`/`delete` on `meta_nodes` and `meta_dimensions`. Webhooks: `meta.node.created|updated|deleted` (shared nodes, ids only). Event: `meta.node_created`.

## Not yet (from Surdej, or open)

- Objects and assignments (tagging URLs and entities with paths), `/context` with parents, siblings, children and related.
- URL resolution for the browser extension, AI path suggestions (`/suggest`, optional through `ai.py`).
- The generation DSL and YAML paste in `/admin/meta`, manual drag-and-drop ordering, merging nodes.
- Labels per language (`labels`), `childSort` per parent (today: `sort_order`, then label).
- Proposals from users who may not create (a „Foreslå til admin“ flow), MCP tools for search and tagging.
- Visibility per branch beyond private trees.
