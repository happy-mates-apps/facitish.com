-- Data in /admin (specs/admin-app/DATA.md): the catalog of datasets and the API sources behind some of them.
-- A dataset with source_id null is a table in the container's own database; otherwise it is an endpoint of an
-- API source, described by the source's kildebeskrivelse (YAML). No personal data is stored here: who changed
-- what is in audit_log, and unmasking is an audit_log entry (data.unmask), not a row in these tables.

create table data_sources (
    id          bigserial primary key,
    key         text not null unique check (key ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
    name        text not null,
    kind        text not null check (kind in ('rest')),
    spec_yaml   text not null,                     -- the kildebeskrivelse as written; never contains secrets
    hosts       text[] not null default '{}',      -- the only hosts the server may call for this source
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create table datasets (
    id              bigserial primary key,
    source_id       bigint references data_sources (id) on delete cascade,   -- null: a table in this database
    key             text not null,                 -- table name, or the dataset id in the kildebeskrivelse
    name            text not null,
    description     text not null default '',
    owner           text not null default '',
    classification  text not null default 'yellow' check (classification in ('white', 'green', 'yellow', 'red')),
    personal_data   boolean not null default false,
    mcp_exposed     boolean not null default false,
    version         integer not null default 1,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
create unique index datasets_source_key_idx on datasets (coalesce(source_id, 0), key);

create table dataset_fields (
    id              bigserial primary key,
    dataset_id      bigint not null references datasets (id) on delete cascade,
    name            text not null,                 -- column name, or the field key in the kildebeskrivelse
    path            text,                          -- API sources: dotted path in each row of the response
    label           text not null default '',
    description     text not null default '',
    data_type       text not null default 'text',
    classification  text not null default 'yellow' check (classification in ('white', 'green', 'yellow', 'red')),
    position        integer not null default 0,
    unique (dataset_id, name)
);
