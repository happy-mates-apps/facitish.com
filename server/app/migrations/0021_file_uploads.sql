-- Direct upload to Object Storage (app/uploads.py): the browser asks for an upload, PUTs the bytes straight to the
-- bucket on short-lived presigned links (one link, or one per part for big files) and then completes it. Only then
-- does the file get a row in `files` (audited as file.upload with via = 'direct').
--
-- A zip can be kept as it is, or unpacked: then the zip lands on a temporary key and the job files.unzip puts each
-- file in it into the tree (folders kept), a batch at a time; `done` is how far it got, so a new run goes on from there.
--
-- status: uploading → done | unpacking → done | failed | aborted. Unfinished uploads are aborted (and their objects
-- removed) by the job files.uploads_cleanup when expires_at has passed; finished rows go after N days (retention).

create table file_uploads (
    id              uuid primary key,
    user_id         bigint not null references users (id) on delete cascade,  -- who uploads
    admin           boolean not null default false,  -- started from /api/admin/files (and only completed there)
    path            text not null,                   -- the target folder, /users/<id>/… or /shared/…
    filename        text not null,
    content_type    text not null,
    size_bytes      bigint not null check (size_bytes >= 0),
    storage_key     text not null,                   -- no user input: <prefix>/<uuid> or uploads/<uuid>
    multipart_id    text,                            -- the S3 multipart upload id (big files)
    part_size       bigint,
    overwrite       boolean not null default false,
    unzip           boolean not null default false,
    status          text not null default 'uploading'
                    check (status in ('uploading', 'unpacking', 'done', 'failed', 'aborted')),
    done            integer not null default 0,       -- unzip: entries handled so far
    result          jsonb,                            -- the file (upload) or counts and skipped entries (unzip)
    error           text,
    created_at      timestamptz not null default now(),
    expires_at      timestamptz not null,
    finished_at     timestamptz
);
create index file_uploads_user_idx on file_uploads (user_id, created_at desc);
create index file_uploads_open_idx on file_uploads (expires_at) where status in ('uploading', 'unpacking');

insert into retention_policies (key, title, description, days, min_days) values
    ('file_uploads', 'Uploads til Object Storage', 'Afsluttede, afbrudte og fejlede uploads (filerne selv bliver i mappetræet)', 14, 1);

insert into job_schedules (name, kind, description, interval_seconds) values
    ('files.uploads_cleanup', 'files.uploads_cleanup', 'Afbryder uploads, der aldrig blev gjort færdige, og sletter deres data i Object Storage', 3600);

-- Grants are re-applied by gaer_apply_grants() after the run.
