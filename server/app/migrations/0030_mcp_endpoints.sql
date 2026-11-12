-- MCP endpoints defined at runtime (/developer/studio/mcp): /mcp/<key> next to the built-in /mcp and /mcp/admin.
--
-- An endpoint is a row here; the tools it offers are rows in mcp_tool_endpoints (the endpoint map from 0016). A
-- dynamic endpoint acts as the user who connects (OAuth scope "mcp", exactly like /mcp): its Code tools are the
-- app's handlers, its Data tools read datasets from the catalog. `audience` says who may connect at all —
-- everyone, internal users or admins; the tool classifications still decide who may call which tool.
-- The two built-in endpoints get rows too (builtin = true), so one table describes every endpoint.

create table mcp_endpoints (
    key           text primary key check (key ~ '^[a-z][a-z0-9-]{1,31}$'),
    name          text not null check (length(name) between 1 and 80),
    description   text not null default '' check (length(description) <= 1000),
    instructions  text not null default '' check (length(instructions) <= 4000),   -- what the model is told on connect
    audience      text not null default 'all' check (audience in ('all', 'internal', 'admin')),
    enabled       boolean not null default true,
    builtin       boolean not null default false,
    created_by    bigint references users (id) on delete set null,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

insert into mcp_endpoints (key, name, description, builtin) values
    ('app',   'Appen', 'Tørgær for den bruger, der loggede ind: egne klip, filer, features og privatliv.', true),
    ('admin', 'Admin', 'Admin af denne instans. Kræver admin-rollen med fuld adgang; alle ændringer er kladder.', true);

-- The endpoint columns from 0010 and 0016 only allowed 'app' and 'admin'.
do $$
declare c record;
begin
    for c in select conrelid::regclass::text as tbl, conname from pg_constraint
             where contype = 'c'
               and conrelid in ('mcp_tool_endpoints'::regclass, 'mcp_access_requests'::regclass, 'mcp_log'::regclass,
                                'mcp_drafts'::regclass)
               and pg_get_constraintdef(oid) like '%''app''%'
    loop
        execute format('alter table %I drop constraint %I', c.tbl, c.conname);
    end loop;
end $$;

alter table mcp_tool_endpoints
    add constraint mcp_tool_endpoints_endpoint_fkey foreign key (endpoint) references mcp_endpoints (key) on delete cascade;
-- Logs and drafts keep the key as text: a deleted endpoint's history stays readable.
alter table mcp_log add constraint mcp_log_server_check check (server ~ '^[a-z][a-z0-9-]{1,31}$');
alter table mcp_drafts add constraint mcp_drafts_server_check check (server ~ '^[a-z][a-z0-9-]{1,31}$');
alter table mcp_access_requests add constraint mcp_access_requests_endpoint_check check (endpoint ~ '^[a-z][a-z0-9-]{1,31}$');

-- Grants are re-applied by gaer_apply_grants() after the run.
