-- TAS (Terminal Assistance Simulator, app/tas.py): the virtual payment terminal on /w/ and its Admin Portal in
-- /backoffice. The simulator keeps its data as documents in named collections (models, menu nodes, knowledge,
-- troubleshooting, releases …), the shape the original artifact used, so its code runs unchanged on top of
-- /api/tas. Images (accessories, terminal models, the TAS avatar) are small and live next to the documents.

create table tas_docs (
    collection  text not null,
    id          text not null,
    data        jsonb not null,
    updated_by  bigint references users (id) on delete set null,
    updated_at  timestamptz not null default now(),
    primary key (collection, id)
);

create table tas_assets (
    id            text primary key,
    content_type  text not null,
    data          bytea not null,
    size          integer not null,
    created_by    bigint references users (id) on delete set null,
    created_at    timestamptz not null default now()
);

-- Grants are re-applied by gaer_apply_grants() after the run.

-- TAS asks the AI for grounded answers in the simulator's chat and in its Admin Portal; counted like the other surfaces.
alter table ai_usage drop constraint if exists ai_usage_surface_check;
alter table ai_usage add constraint ai_usage_surface_check
    check (surface in ('app', 'extension', 'word', 'outlook', 'document', 'mobile', 'knowledge', 'tas'));
