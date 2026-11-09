-- Incoming webhooks: other systems POST to /api/hooks/in/<key>. Each endpoint chooses how a request proves where it
-- comes from: a Gær signature (X-Gaer-Signature, so two Gær instances can talk), a generic HMAC-SHA256 header
-- (GitHub-style "sha256=…", hex or base64), a fixed header such as Authorization: Bearer …, or only the secret URL.
-- Accepted requests are stored and handed to a job (webhook.inbound) that runs the endpoint's handler from the code.
-- Rejected requests are only counted on the endpoint; their bodies are never stored.

create table webhook_endpoints (
    id                 bigserial primary key,
    name               text not null,
    key                text not null unique,                   -- the unguessable part of the URL
    verify             text not null default 'gaer' check (verify in ('gaer', 'hmac', 'token', 'none')),
    header_name        text check (header_name ~ '^[A-Za-z0-9-]{1,64}$'), -- signature or token header (hmac/token)
    secret_enc         bytea,                                   -- HMAC secret or expected token, encrypted
    secret_hint        text,
    handler            text not null default 'store',           -- app.webhooks_in.HANDLERS
    event_header       text check (event_header ~ '^[A-Za-z0-9-]{1,64}$'),   -- e.g. X-GitHub-Event
    event_field        text check (event_field ~ '^[A-Za-z0-9_.]{1,64}$'),   -- e.g. type, or data.event
    id_header          text check (id_header ~ '^[A-Za-z0-9-]{1,64}$'),      -- e.g. X-GitHub-Delivery, for dedupe
    allowed_ips        cidr[] not null default '{}',            -- empty = any address
    max_body_kb        integer not null default 256 check (max_body_kb between 1 and 5120),
    max_per_minute     integer not null default 120 check (max_per_minute between 1 and 10000),
    tolerance_seconds  integer not null default 300 check (tolerance_seconds between 30 and 3600),
    active             boolean not null default true,
    received_count     bigint not null default 0,
    rejected_count     bigint not null default 0,
    last_received_at   timestamptz,
    last_rejected_at   timestamptz,
    last_rejected_reason text,
    created_by         bigint references users (id) on delete set null,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now()
);

create table webhook_inbound (
    id            uuid primary key,
    endpoint_id   bigint not null references webhook_endpoints (id) on delete cascade,
    external_id   text,                                    -- the sender's delivery id (id_header / X-Gaer-Delivery)
    event         text,
    status        text not null default 'received' check (status in ('received', 'processed', 'failed', 'ignored')),
    content_type  text,
    headers       jsonb not null default '{}',             -- without secrets (authorization, cookies, signatures)
    body          text not null,
    body_json     jsonb,
    ip            inet,
    attempts      integer not null default 0,
    result        jsonb,
    error         text,
    received_at   timestamptz not null default now(),
    processed_at  timestamptz
);
create index webhook_inbound_endpoint_idx on webhook_inbound (endpoint_id, received_at desc);
create index webhook_inbound_received_idx on webhook_inbound (received_at);
create unique index webhook_inbound_dedupe_idx on webhook_inbound (endpoint_id, external_id) where external_id is not null;

insert into retention_policies (key, title, description, days, min_days) values
    ('webhook_inbound', 'Modtagne webhooks', 'Indgående webhooks med indhold (behandlede og ignorerede)', 30, 1);
