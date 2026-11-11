-- Træstrukturer (metadata, ported from Surdej's member-meta): dimensions are independent trees, nodes have a
-- materialised path, so a subtree is a prefix scan and ancestors are a split of the path (app/meta.py).
--
--   /org/drift/support      a shared node, depth 2 in the dimension "org"
--   /~/<user id>/projekter  a node in the user's private tree ("Mit træ"), depth 1; dimension_id is null
--
-- Other tables store node ids, never paths: an id survives renames and moves. Top-level nodes (depth 1) in a shared
-- dimension are created by admins only; deeper nodes by every user unless the dimension is locked.

create table meta_dimensions (
    id           bigserial primary key,
    slug         text not null unique check (slug ~ '^[^/~[:space:][:upper:]]+$'),  -- the path root: /org
    label        text not null,
    description  text not null default '',
    color        text,                                     -- badge colour in the UI, #RRGGBB
    locked       boolean not null default false,           -- only admins may add nodes at any depth
    created_by   bigint references users (id) on delete set null,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

create table meta_nodes (
    id            bigserial primary key,
    dimension_id  bigint references meta_dimensions (id) on delete cascade,  -- null: a private node
    owner_id      bigint references users (id) on delete cascade,            -- set exactly on private nodes
    parent_id     bigint references meta_nodes (id) on delete cascade,       -- null: depth 1
    path          text not null unique,
    slug          text not null,
    label         text not null,
    description   text not null default '',
    depth         integer not null check (depth between 1 and 8),
    sort_order    integer not null default 0,
    archived_at   timestamptz,                             -- hidden from pickers; stored values still resolve
    created_by    bigint references users (id) on delete set null,
    updated_by    bigint references users (id) on delete set null,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    check ((dimension_id is null) = (owner_id is not null))
);
create index meta_nodes_path_idx on meta_nodes (path text_pattern_ops);   -- subtree: path like '/org/drift/%'
create index meta_nodes_parent_idx on meta_nodes (parent_id, sort_order);
create index meta_nodes_dimension_idx on meta_nodes (dimension_id, depth);
create index meta_nodes_owner_idx on meta_nodes (owner_id) where owner_id is not null;

-- Grants are re-applied by gaer_apply_grants() after the run.
