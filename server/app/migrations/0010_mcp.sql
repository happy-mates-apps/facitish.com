-- MCP servers (specs/mcp): /mcp for the app and /mcp/admin for admin, OAuth 2.0 PKCE on top of the
-- normal Gær login. An authorized MCP client is a row in `sessions` (mcp_client_id set), so it shows under
-- Konto → Sessioner, and revoking or blocking ends it like any other session.

-- Clips saved through MCP (clip_create) get their own source.
alter table clips drop constraint clips_source_check;
alter table clips add constraint clips_source_check check (source in ('manual', 'extension', 'outlook', 'word', 'mobile', 'mcp'));

-- Dynamic client registration (public clients, PKCE required).
create table mcp_clients (
    id             text primary key,                    -- client_id, random
    name           text not null,
    redirect_uris  text[] not null,
    created_at     timestamptz not null default now(),
    last_used_at   timestamptz
);

alter table sessions add column mcp_client_id text references mcp_clients (id) on delete cascade;
alter table sessions add column mcp_scope text check (mcp_scope in ('mcp', 'mcp:admin'));

-- Authorization codes (10 min), access tokens (1 h) and refresh tokens (30 days). Only the SHA-256 is stored.
create table mcp_tokens (
    id              bigserial primary key,
    kind            text not null check (kind in ('code', 'access', 'refresh')),
    token_hash      text not null unique,
    client_id       text not null references mcp_clients (id) on delete cascade,
    user_id         bigint not null references users (id) on delete cascade,
    session_id      bigint references sessions (id) on delete cascade,   -- null for codes
    scope           text not null check (scope in ('mcp', 'mcp:admin')),
    redirect_uri    text,
    code_challenge  text,
    resource        text,
    created_at      timestamptz not null default now(),
    expires_at      timestamptz not null,
    used_at         timestamptz
);
create index mcp_tokens_session_idx on mcp_tokens (session_id);

-- Every change through MCP is a draft first; confirm_draft runs it once.
create table mcp_drafts (
    id            text primary key,                      -- d_<8 hex>
    server        text not null check (server in ('app', 'admin')),
    tool_name     text not null,
    args          jsonb not null,
    summary       text not null,
    impact        jsonb not null,
    links         jsonb not null default '[]',
    state_hash    text not null,
    status        text not null default 'pending'
                  check (status in ('pending', 'confirmed', 'cancelled', 'expired', 'failed')),
    created_by    bigint not null references users (id) on delete cascade,
    created_at    timestamptz not null default now(),
    expires_at    timestamptz not null,
    confirmed_at  timestamptz,
    reason        text,
    result        jsonb
);
create index mcp_drafts_creator_idx on mcp_drafts (created_by, created_at desc);

-- One row per MCP call (append-only, like the other logs).
create table mcp_log (
    id           bigserial primary key,
    ts           timestamptz not null default now(),
    server       text not null check (server in ('app', 'admin')),
    user_id      bigint,
    client_id    text,
    method       text not null,
    tool         text,
    args         jsonb,
    duration_ms  integer,
    status       text not null check (status in ('ok', 'error', 'auth_failed', 'forbidden', 'draft', 'confirmed', 'cancelled')),
    ip_masked    text
);
create index mcp_log_ts_idx on mcp_log (server, ts desc);
create index mcp_log_user_idx on mcp_log (user_id, ts desc);
create trigger mcp_log_no_update before update on mcp_log for each row execute function gaer_reject_log_update();

-- The /admin monitor listens for new rows.
create function gaer_notify_mcp_log() returns trigger language plpgsql as $$
begin
    perform pg_notify('mcp_log', new.id::text);
    return new;
end $$;
create trigger mcp_log_notify after insert on mcp_log for each row execute function gaer_notify_mcp_log();

-- Grants: mcp_log is a log table; <db>_mcp_ro (db_query) may only SELECT, and never secrets or phone hashes.
create or replace function gaer_apply_grants() returns void language plpgsql as $$
declare
    app_role text := current_database() || '_app';
    purge_role text := current_database() || '_purge';
    ro_role text := current_database() || '_mcp_ro';
    log_tables text[] := array['auth_log', 'audit_log', 'feature_usage', 'mcp_log'];
    ro_hidden text[] := array['otp_codes', 'webauthn_challenges', 'sessions', 'mcp_tokens', 'auth_log'];
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
