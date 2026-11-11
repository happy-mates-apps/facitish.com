-- Groups (a general feature: /admin/groups, /api/me/groups) and the secret manager on top of them (/admin/secrets).
-- app/groups.py and app/secret_store.py hold the rules; routes/groups.py and routes/admin_secrets.py the API.
--
-- A secret is owned by one group and has its own RACI: exactly one A, at least one R, any number of C and I.
-- The value is encrypted (app.secrets_box, purpose "secret:<id>:<version>"); each change is a new version.
-- Access to the value is given by an access request that the people in A, R and C approve (approval_rule), and it
-- always expires. Nothing here ever holds a value in clear text.

create table groups (
    id              bigserial primary key,
    slug            text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    name            text not null check (length(name) between 1 and 80),
    description     text not null default '' check (length(description) <= 500),
    -- Optional address that gets the group channel's notifications (e.g. a shared mailbox from the mail module).
    notify_email    text check (notify_email is null or notify_email like '%@%'),
    created_by      bigint references users (id) on delete set null,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create table group_members (
    group_id        bigint not null references groups (id) on delete cascade,
    user_id         bigint not null references users (id) on delete cascade,
    role            text not null default 'member' check (role in ('member', 'manager')),
    added_by        bigint references users (id) on delete set null,
    added_at        timestamptz not null default now(),
    primary key (group_id, user_id)
);
create index group_members_user_idx on group_members (user_id);

create table secrets (
    id                bigserial primary key,
    group_id          bigint not null references groups (id) on delete restrict,
    name              text not null check (length(name) between 1 and 120),
    environment       text not null default '' check (length(environment) <= 40),
    description       text not null default '' check (length(description) <= 1000),
    tags              text[] not null default '{}',
    -- all: everyone in A, R and C · a_and_one_r: A and one R · a_only: A alone
    approval_rule     text not null default 'all' check (approval_rule in ('all', 'a_and_one_r', 'a_only')),
    rotation_days     integer check (rotation_days between 1 and 3650),
    expires_at        timestamptz,                       -- when the provider expires it, if it does
    current_version   integer not null default 0,
    value_changed_at  timestamptz,
    rotation_notified_at timestamptz,                    -- last "rotation due" reminder, so it is sent once per stage
    archived_at       timestamptz,
    created_by        bigint references users (id) on delete set null,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);
create unique index secrets_name_idx on secrets (group_id, lower(name), environment) where archived_at is null;

create table secret_versions (
    id              bigserial primary key,
    secret_id       bigint not null references secrets (id) on delete cascade,
    version         integer not null,
    value_enc       bytea not null,
    hint            text not null default '',            -- the last characters, for recognising it (never the value)
    length          integer not null,
    created_by      bigint references users (id) on delete set null,
    created_at      timestamptz not null default now(),
    superseded_at   timestamptz,                         -- set when a newer version replaces it; purged later
    unique (secret_id, version)
);

create table secret_raci (
    secret_id       bigint not null references secrets (id) on delete cascade,
    user_id         bigint not null references users (id) on delete cascade,
    role            text not null check (role in ('R', 'A', 'C', 'I')),
    added_at        timestamptz not null default now(),
    primary key (secret_id, user_id, role)
);
create unique index secret_raci_one_a_idx on secret_raci (secret_id) where role = 'A';
create index secret_raci_user_idx on secret_raci (user_id);

create table secret_access_requests (
    id                bigserial primary key,
    secret_id         bigint not null references secrets (id) on delete cascade,
    requester_id      bigint not null references users (id) on delete cascade,
    grantee_user_id   bigint references users (id) on delete cascade,
    grantee_group_id  bigint references groups (id) on delete cascade,
    level             text not null check (level in ('read', 'write')),
    days              integer not null check (days between 1 and 365),
    reason            text not null check (length(reason) between 1 and 1000),
    approval_rule     text not null,                       -- the secret's rule when the request was made
    fallback          boolean not null default false,      -- nobody else in RAC: one admin with /secrets approves
    status            text not null default 'pending'
                      check (status in ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
    created_at        timestamptz not null default now(),
    expires_at        timestamptz not null,
    decided_at        timestamptz,
    check (num_nonnulls(grantee_user_id, grantee_group_id) = 1)
);
create index secret_access_requests_secret_idx on secret_access_requests (secret_id, status);
create index secret_access_requests_pending_idx on secret_access_requests (expires_at) where status = 'pending';

-- One row per person who must answer, fixed when the request is made.
create table secret_approvals (
    request_id      bigint not null references secret_access_requests (id) on delete cascade,
    approver_id     bigint not null references users (id) on delete cascade,
    roles           text[] not null,                     -- the approver's roles then: A, R, C (or 'admin' as fallback)
    decision        text not null default 'pending' check (decision in ('pending', 'approved', 'rejected')),
    note            text check (length(note) <= 500),
    decided_at      timestamptz,
    primary key (request_id, approver_id)
);
create index secret_approvals_pending_idx on secret_approvals (approver_id) where decision = 'pending';

create table secret_grants (
    id              bigserial primary key,
    secret_id       bigint not null references secrets (id) on delete cascade,
    user_id         bigint references users (id) on delete cascade,
    group_id        bigint references groups (id) on delete cascade,
    level           text not null check (level in ('read', 'write')),
    request_id      bigint references secret_access_requests (id) on delete set null,
    granted_at      timestamptz not null default now(),
    expires_at      timestamptz not null,
    reminded_at     timestamptz,
    ended_at        timestamptz,                         -- expired or revoked
    ended_reason    text check (ended_reason in ('expired', 'revoked', 'archived')),
    revoked_by      bigint references users (id) on delete set null,
    check (num_nonnulls(user_id, group_id) = 1)
);
create index secret_grants_secret_idx on secret_grants (secret_id) where ended_at is null;
create index secret_grants_user_idx on secret_grants (user_id) where ended_at is null;
create index secret_grants_group_idx on secret_grants (group_id) where ended_at is null;

-- Who in a group hears about what. A missing row means the default in app/secret_store.py (NOTIFY_DEFAULTS).
create table group_notify_rules (
    group_id        bigint not null references groups (id) on delete cascade,
    event           text not null,
    audience        text not null check (audience in ('A', 'R', 'C', 'I', 'grantee', 'channel')),
    mode            text not null check (mode in ('now', 'digest', 'off')),
    updated_at      timestamptz not null default now(),
    primary key (group_id, event, audience)
);

-- Notifications waiting for the daily digest mail (and the record of those sent).
create table secret_notifications (
    id              bigserial primary key,
    user_id         bigint not null references users (id) on delete cascade,
    secret_id       bigint not null references secrets (id) on delete cascade,
    event           text not null,
    created_at      timestamptz not null default now(),
    sent_at         timestamptz
);
create index secret_notifications_pending_idx on secret_notifications (user_id) where sent_at is null;

insert into job_schedules (name, kind, description, interval_seconds) values
    ('secrets.maintenance', 'secrets.maintenance',
     'Hemmeligheder: udløber anmodninger og adgange, påminder om udløb og rotation', 3600),
    ('secrets.digest', 'secrets.digest', 'Hemmeligheder: sender den daglige opsamling af beskeder', 86400);

insert into retention_policies (key, title, description, days, min_days) values
    ('secret_versions', 'Gamle versioner af hemmeligheder',
     'Krypterede værdier, der er erstattet af en nyere version for mere end N dage siden', 30, 1),
    ('secret_access_requests', 'Afgjorte anmodninger og afsluttede adgange til hemmeligheder',
     'Anmodninger afgjort og adgange udløbet eller tilbagekaldt for mere end N dage siden (audit-loggen beholder sporet)', 365, 30),
    ('secret_notifications', 'Sendte beskeder om hemmeligheder', 'Beskeder i den daglige opsamling, sendt for mere end N dage siden', 30, 1);

-- The read-only MCP role (db_query in /mcp/admin) never sees the encrypted values.
create or replace function gaer_apply_grants() returns void language plpgsql as $$
declare
    app_role text := current_database() || '_app';
    purge_role text := current_database() || '_purge';
    ro_role text := current_database() || '_mcp_ro';
    log_tables text[] := array['auth_log', 'audit_log', 'feature_usage', 'mcp_log'];
    ro_hidden text[] := array['otp_codes', 'webauthn_challenges', 'sessions', 'mcp_tokens', 'auth_log', 'totp_factors',
                                 'secret_versions'];
    t record;
begin
    if exists (select 1 from pg_roles where rolname = app_role) then
        execute format('grant usage on schema public to %I', app_role);
        for t in select tablename from pg_tables where schemaname = 'public' loop
            if t.tablename = any (log_tables) then
                execute format('revoke update, delete, truncate on %I from %I', t.tablename, app_role);
                execute format('grant select, insert on %I to %I', t.tablename, app_role);
            elsif t.tablename = 'schema_migrations' then
                execute format('grant select on %I to %I', t.tablename, app_role);
            else
                execute format('grant select, insert, update, delete on %I to %I', t.tablename, app_role);
            end if;
        end loop;
        execute format('grant usage, select on all sequences in schema public to %I', app_role);
        execute format('grant execute on function gaer_ensure_analytics_partition(date) to %I', app_role);
    end if;

    if exists (select 1 from pg_roles where rolname = purge_role) then
        execute format('grant usage on schema public to %I', purge_role);
        execute format('grant select, delete on auth_log, audit_log, analytics_events, consents, feature_usage, mcp_log to %I',
                       purge_role);
        execute format('grant insert on audit_log to %I', purge_role);
        execute format('grant usage on sequence audit_log_id_seq to %I', purge_role);
        execute format('grant select on users, settings to %I', purge_role);
    end if;

    if exists (select 1 from pg_roles where rolname = ro_role) then
        execute format('grant usage on schema public to %I', ro_role);
        for t in select tablename from pg_tables where schemaname = 'public' loop
            if t.tablename = any (ro_hidden) then
                execute format('revoke all on %I from %I', t.tablename, ro_role);
            else
                execute format('grant select on %I to %I', t.tablename, ro_role);
            end if;
        end loop;
    end if;
end $$;

-- Grants are re-applied by gaer_apply_grants() after the run.
