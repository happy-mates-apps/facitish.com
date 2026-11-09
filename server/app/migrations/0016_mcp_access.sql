-- MCP tools governed by the data catalog, internal/external users and access requests (specs/mcp/ACCESS.md).
--
-- users.audience       internal (employee) or external (partner, customer). External is the default: an admin marks
--                      people internal, or INTERNAL_EMAIL_DOMAINS does it at the first login. Admins start internal.
-- mcp_tools            every MCP tool. A Code tool is a handler in server/app/mcp (kind 'code', name = the handler's
--                      catalog name; synced from catalog.json at startup). A Data tool reads a dataset from the
--                      catalog in /admin/data (kind 'data', dataset_id). Code tools carry their own classification;
--                      a Data tool follows its dataset's classification, so /admin/data decides who may use it.
-- mcp_tool_endpoints   which endpoint (/mcp = app, /mcp/admin = admin) offers which tool. One tool, many endpoints;
--                      a Code tool only on endpoints it has a handler for.
-- mcp_access_requests  an MCP client asks for its own e-mail/phone in clear, or for a tool that needs a grant
--                      (yellow: the user approves; red: the user and an approver in /admin approve). An approved row
--                      is the grant: for that one MCP session until expires_at.
-- mcp_access_links     single-use links in the approval e-mails. Only the SHA-256 is stored.

alter table users add column audience text not null default 'external' check (audience in ('internal', 'external'));
update users set audience = 'internal' where role = 'admin';

create table mcp_tools (
    id              bigserial primary key,
    name            text not null unique check (name ~ '^[a-z][a-z0-9_]{1,47}$'),
    kind            text not null check (kind in ('code', 'data')),
    dataset_id      bigint references datasets (id) on delete cascade,
    title           text not null default '',
    description     text not null default '',
    classification  text check (classification in ('white', 'green', 'yellow', 'red')),   -- code tools; data: dataset's
    enabled         boolean not null default true,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    check ((kind = 'data') = (dataset_id is not null)),
    check ((kind = 'code') = (classification is not null))
);

create table mcp_tool_endpoints (
    tool_id   bigint not null references mcp_tools (id) on delete cascade,
    endpoint  text not null check (endpoint in ('app', 'admin')),
    primary key (tool_id, endpoint)
);

create table mcp_access_requests (
    id                   bigserial primary key,
    user_id              bigint not null references users (id) on delete cascade,
    session_id           bigint references sessions (id) on delete set null,   -- the MCP client's session; null = ended
    endpoint             text not null check (endpoint in ('app', 'admin')),
    client_name          text not null,
    target               text not null check (target in ('email', 'phone', 'tool')),
    tool_id              bigint references mcp_tools (id) on delete cascade,
    tool_name            text,                                                 -- kept for the history
    level                text not null check (level in ('own', 'internal', 'confidential')),
    reason               text not null,
    status               text not null default 'awaiting_user'
                         check (status in ('awaiting_user', 'awaiting_approver', 'approved', 'denied', 'withdrawn',
                                           'revoked')),
    user_decided_at      timestamptz,
    user_via             text check (user_via in ('list', 'email')),
    approver_id          bigint references users (id) on delete set null,
    approver_decided_at  timestamptz,
    approver_via         text check (approver_via in ('list', 'email', 'mcp')),
    note                 text,
    duration_days        integer not null,
    expires_at           timestamptz,                                          -- set when approved
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now(),
    check ((target = 'tool') = (tool_id is not null))
);
create index mcp_access_requests_user_idx on mcp_access_requests (user_id, created_at desc);
create index mcp_access_requests_open_idx on mcp_access_requests (status, created_at desc)
    where status in ('awaiting_user', 'awaiting_approver');
create index mcp_access_requests_session_idx on mcp_access_requests (session_id) where status = 'approved';

create table mcp_access_links (
    token_hash    text primary key,
    request_id    bigint not null references mcp_access_requests (id) on delete cascade,
    recipient_id  bigint not null references users (id) on delete cascade,
    step          text not null check (step in ('user', 'approver')),
    created_at    timestamptz not null default now(),
    expires_at    timestamptz not null,
    used_at       timestamptz
);
create index mcp_access_links_request_idx on mcp_access_links (request_id);

insert into retention_policies (key, title, description, days, min_days) values
    ('mcp_access_requests', 'MCP-adgangsanmodninger',
     'Afsluttede anmodninger (afvist, trukket tilbage, tilbagekaldt eller udløbet) og brugte e-maillinks', 365, 30);
