-- Gær base schema.
-- Roles (created by deploy/provision-database.sh, one set per container database):
--   <db>_owner  owns the schema and runs migrations
--   <db>_app    the application: may only SELECT/INSERT on log tables
--   <db>_purge  used from /admin to delete log data; may SELECT/DELETE on log tables
-- Grants are applied by gaer_apply_grants() at the end of every migration run.

-- ── Users and login ────────────────────────────────────────────────────────

create table users (
    id                 bigserial primary key,
    phone              text not null unique,            -- E.164, e.g. +4512345678
    display_name       text,
    role               text not null default 'user' check (role in ('user', 'admin')),
    grace_logins_used  integer not null default 0,
    blocked_at         timestamptz,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    last_login_at      timestamptz
);

create table otp_codes (
    id           bigserial primary key,
    phone        text not null,
    code_hash    text not null,                         -- HMAC-SHA256, never the code itself
    expires_at   timestamptz not null,
    attempts     integer not null default 0,
    consumed_at  timestamptz,
    created_at   timestamptz not null default now()
);
create index otp_codes_phone_idx on otp_codes (phone, created_at desc);

create table passkeys (
    id             bigserial primary key,
    user_id        bigint not null references users (id) on delete cascade,
    credential_id  bytea not null unique,
    public_key     bytea not null,
    sign_count     bigint not null default 0,
    transports     text[] not null default '{}',
    name           text not null default 'Passkey',
    created_at     timestamptz not null default now(),
    last_used_at   timestamptz
);
create index passkeys_user_idx on passkeys (user_id);

create table sessions (
    id            bigserial primary key,
    user_id       bigint not null references users (id) on delete cascade,
    token_hash    text not null unique,
    scope         text not null check (scope in ('full', 'enroll')),
    created_at    timestamptz not null default now(),
    expires_at    timestamptz not null,
    last_seen_at  timestamptz not null default now(),
    revoked_at    timestamptz,
    ip            inet,
    user_agent    text
);
create index sessions_user_idx on sessions (user_id);

create table webauthn_challenges (
    id          text primary key,
    challenge   bytea not null,
    kind        text not null check (kind in ('register', 'login')),
    user_id     bigint references users (id) on delete cascade,
    expires_at  timestamptz not null
);

-- ── Logs (append-only) ─────────────────────────────────────────────────────

create table auth_log (
    id            bigserial primary key,
    ts            timestamptz not null default now(),
    event         text not null,                        -- otp.sent, otp.verified, passkey.login, ...
    result        text not null check (result in ('ok', 'fail')),
    user_id       bigint,                               -- no FK: the log outlives the user
    phone_masked  text,                                 -- +45 •••• ••78
    phone_hash    text,                                 -- HMAC, lets admins search by full number
    ip            inet,
    device        text,
    detail        jsonb not null default '{}'
);
create index auth_log_ts_idx on auth_log (ts desc);
create index auth_log_user_idx on auth_log (user_id, ts desc);
create index auth_log_phone_idx on auth_log (phone_hash, ts desc);
create index auth_log_ip_idx on auth_log (ip, ts desc);

create table audit_log (
    id             bigserial primary key,
    ts             timestamptz not null default now(),
    actor_user_id  bigint,
    action         text not null,                       -- create, update, delete, file.upload, role.changed, ...
    table_name     text,
    row_id         text,
    before         jsonb,
    after          jsonb,
    ip             inet,
    detail         jsonb not null default '{}'
);
create index audit_log_ts_idx on audit_log (ts desc);
create index audit_log_actor_idx on audit_log (actor_user_id, ts desc);
create index audit_log_row_idx on audit_log (table_name, row_id);

-- Nobody may rewrite history, not even the owner. Deletion is a grant question (purge role only).
create function gaer_reject_log_update() returns trigger language plpgsql as $$
begin
    raise exception '% is append-only', tg_table_name using errcode = 'insufficient_privilege';
end $$;
create trigger auth_log_no_update before update on auth_log for each row execute function gaer_reject_log_update();
create trigger audit_log_no_update before update on audit_log for each row execute function gaer_reject_log_update();

-- ── Files in Object Storage ────────────────────────────────────────────────

create table files (
    id            uuid primary key,
    user_id       bigint references users (id) on delete set null,
    storage_key   text not null unique,
    filename      text not null,
    content_type  text not null,
    size_bytes    bigint not null,
    created_at    timestamptz not null default now()
);
create index files_user_idx on files (user_id);

-- ── Settings, GDPR and consent ─────────────────────────────────────────────

create table settings (
    key         text primary key,
    value       jsonb not null,
    updated_at  timestamptz not null default now()
);

create table gdpr_requests (
    id            bigserial primary key,
    user_id       bigint references users (id) on delete set null,
    kind          text not null check (kind in ('access', 'rectification', 'erasure')),
    contact       text not null,
    message       text not null default '',
    status        text not null default 'received' check (status in ('received', 'in_progress', 'completed', 'rejected')),
    received_at   timestamptz not null default now(),
    due_at        timestamptz not null default now() + interval '30 days',
    completed_at  timestamptz,
    handled_by    bigint,
    notes         text not null default ''
);

create table consents (
    id          bigserial primary key,
    ts          timestamptz not null default now(),
    visitor_id  text,                                   -- only set when statistics was accepted
    user_id     bigint references users (id) on delete set null,
    statistics  boolean not null,
    version     integer not null default 1,             -- banner text version the visitor answered
    device      text
);
create index consents_visitor_idx on consents (visitor_id, ts desc);

-- ── Analytics and heatmaps (partitioned by month) ──────────────────────────

create table analytics_events (
    ts          timestamptz not null default now(),
    kind        text not null check (kind in ('pageview', 'click', 'scroll')),
    path        text not null,
    visitor_id  text,                                   -- null unless the visitor consented
    session_id  text,
    user_id     bigint,
    referrer    text,
    prev_path   text,
    device      text,
    browser     text,
    x           real,                                   -- click: fraction of page width (0..1)
    y           real,                                   -- click: fraction of page height (0..1)
    depth       real,                                   -- scroll: max depth reached (0..1)
    viewport_w  integer
) partition by range (ts);
create index analytics_events_ts_idx on analytics_events (ts);
create index analytics_events_path_idx on analytics_events (path, kind);

-- Creates the monthly partition that holds `day` if it does not exist. Rows that already
-- landed in the default partition for that month are moved into the new partition.
create function gaer_ensure_analytics_partition(day date) returns void language plpgsql as $$
declare
    start_month date := date_trunc('month', day)::date;
    end_month date := (date_trunc('month', day) + interval '1 month')::date;
    name text := 'analytics_events_' || to_char(start_month, 'YYYY_MM');
    has_default boolean := to_regclass('analytics_events_default') is not null;
begin
    if to_regclass(name) is not null then
        return;
    end if;
    if has_default then
        create temp table gaer_moved_events on commit drop as
            select * from analytics_events_default where ts >= start_month and ts < end_month;
        delete from analytics_events_default where ts >= start_month and ts < end_month;
    end if;
    execute format('create table %I partition of analytics_events for values from (%L) to (%L)',
                   name, start_month, end_month);
    if has_default then
        insert into analytics_events select * from gaer_moved_events;
        drop table gaer_moved_events;
    end if;
end $$;

select gaer_ensure_analytics_partition(current_date);
select gaer_ensure_analytics_partition((current_date + interval '1 month')::date);
-- Anything outside a monthly partition (clock skew, far-future timestamps) lands here.
create table analytics_events_default partition of analytics_events default;

-- ── Grants ─────────────────────────────────────────────────────────────────

create function gaer_apply_grants() returns void language plpgsql as $$
declare
    app_role text := current_database() || '_app';
    purge_role text := current_database() || '_purge';
    log_tables text[] := array['auth_log', 'audit_log'];
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
        -- The app creates next month's analytics partition; partition creation needs ownership,
        -- so it goes through this security-definer function instead.
        execute format('grant execute on function gaer_ensure_analytics_partition(date) to %I', app_role);
    end if;

    if exists (select 1 from pg_roles where rolname = purge_role) then
        -- Privileges on a partitioned table cover its partitions when accessed through it.
        execute format('grant usage on schema public to %I', purge_role);
        execute format('grant select, delete on auth_log, audit_log, analytics_events, consents to %I', purge_role);
        -- So the purge itself is written as log.purged in the same transaction.
        execute format('grant insert on audit_log to %I', purge_role);
        execute format('grant usage on sequence audit_log_id_seq to %I', purge_role);
        execute format('grant select on users, settings to %I', purge_role);
    end if;
end $$;

alter function gaer_ensure_analytics_partition(date) security definer set search_path = public, pg_temp;
