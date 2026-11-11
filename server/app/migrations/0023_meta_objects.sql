-- Tagging (app/meta_objects.py): an object is anything that can be referred to — a URL (exact, a prefix pattern ending in
-- * or a bare hostname), an entity in Gær or elsewhere ("clip:12", "runbook:ab12") or a note — and an assignment tags it
-- with a node. One object, many nodes, across dimensions; related nodes are derived from shared objects, never stored.
--
-- Visibility follows the nodes: an object is seen through its assignments to nodes the caller can see, so an object
-- tagged only in someone's private tree is invisible to others. An object without assignments is removed.

create table meta_objects (
    id           bigserial primary key,
    kind         text not null check (kind in ('url', 'entity', 'note')),
    ref          text not null,                    -- normalised URL or pattern, "type:id", or "note:<slug>"
    title        text not null,
    description  text not null default '',
    created_by   bigint references users (id) on delete set null,
    updated_by   bigint references users (id) on delete set null,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    unique (kind, ref)
);

create table meta_assignments (
    object_id   bigint not null references meta_objects (id) on delete cascade,
    node_id     bigint not null references meta_nodes (id) on delete cascade,
    created_by  bigint references users (id) on delete set null,
    created_at  timestamptz not null default now(),
    primary key (object_id, node_id)
);
create index meta_assignments_node_idx on meta_assignments (node_id);

-- Grants are re-applied by gaer_apply_grants() after the run.
