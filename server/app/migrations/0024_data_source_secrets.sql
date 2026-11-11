-- API sources (/admin/data/connect) use secrets from Hemmeligheder (/admin/secrets).
--
-- A kildebeskrivelse names a secret as "gruppe/navn" (or "gruppe/navn@miljø"); it never holds a value. The server may
-- use the value for a source only while the source holds an active grant with the level 'use' ("Brug i kilde"). That
-- grant comes from an access request approved by the secret's A, R and C like any other, always expires, and gives no
-- person a way to see the value. data_source_secrets records which secrets a saved source names, so the secret's page
-- can show where it is used.

alter table secret_access_requests add column grantee_source_id bigint references data_sources (id) on delete cascade;
alter table secret_grants add column source_id bigint references data_sources (id) on delete cascade;

-- The unnamed checks from 0023 (one grantee; level read/write) are replaced by ones that know about sources.
do $$
declare c record;
begin
    for c in select conrelid::regclass::text as tbl, conname from pg_constraint
             where contype = 'c' and conrelid in ('secret_access_requests'::regclass, 'secret_grants'::regclass)
               and (pg_get_constraintdef(oid) like '%num_nonnulls%' or pg_get_constraintdef(oid) like '%''write''%')
    loop
        execute format('alter table %I drop constraint %I', c.tbl, c.conname);
    end loop;
end $$;

alter table secret_access_requests
    add constraint secret_access_requests_grantee_check
        check (num_nonnulls(grantee_user_id, grantee_group_id, grantee_source_id) = 1),
    add constraint secret_access_requests_level_check
        check (level in ('read', 'write', 'use') and ((level = 'use') = (grantee_source_id is not null)));
alter table secret_grants
    add constraint secret_grants_grantee_check check (num_nonnulls(user_id, group_id, source_id) = 1),
    add constraint secret_grants_level_check check (level in ('read', 'write', 'use') and ((level = 'use') = (source_id is not null)));

create index secret_grants_source_idx on secret_grants (source_id) where ended_at is null;

create table data_source_secrets (
    source_id   bigint not null references data_sources (id) on delete cascade,
    secret_id   bigint not null references secrets (id) on delete cascade,
    used_as     text not null check (length(used_as) between 1 and 80),   -- "auth" or "header:X-Name"
    primary key (source_id, secret_id, used_as)
);
create index data_source_secrets_secret_idx on data_source_secrets (secret_id);

-- Grants are re-applied by gaer_apply_grants() after the run.
