-- db_query (<db>_mcp_ro) must not read authenticator-app secrets: totp_factors joins the hidden tables.
-- Same function as in 0010_mcp.sql otherwise; grants are re-applied after every migration run.
create or replace function gaer_apply_grants() returns void language plpgsql as $$
declare
    app_role text := current_database() || '_app';
    purge_role text := current_database() || '_purge';
    ro_role text := current_database() || '_mcp_ro';
    log_tables text[] := array['auth_log', 'audit_log', 'feature_usage', 'mcp_log'];
    ro_hidden text[] := array['otp_codes', 'webauthn_challenges', 'sessions', 'mcp_tokens', 'auth_log', 'totp_factors'];
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
