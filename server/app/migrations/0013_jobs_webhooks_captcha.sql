-- Background jobs, schedules, retention policies, outgoing webhooks and spent captcha challenges.
--
-- jobs              a queue in Postgres. Workers take jobs with `for update skip locked`, so several app
--                   containers (blue/green deploys) never run the same job twice. Failed jobs are retried with
--                   backoff until max_attempts, then 'dead'.
-- job_schedules     recurring jobs (every N seconds). The scheduler enqueues a job when next_run_at has passed.
-- retention_policies  how long operational data is kept (job history, webhook deliveries, codes, sessions …).
--                   The four logs (auth, audit, analytics, MCP) keep their periods in /admin/retention and are
--                   purged by the purge user; these policies cover the rest.
-- webhooks          endpoints an admin registered. Every delivery is signed (HMAC-SHA256); an Authorization (or
--                   other) header is optional. Secrets are encrypted with AES-GCM (app.secrets_box).
-- webhook_deliveries  one row per event per endpoint, with attempts, status code and a short response excerpt.
-- captcha_spent     solved proof-of-work challenges, so a solution can be used once.

create table jobs (
    id            bigserial primary key,
    kind          text not null,
    payload       jsonb not null default '{}',
    status        text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'dead')),
    priority      integer not null default 0,              -- higher first
    run_at        timestamptz not null default now(),
    attempts      integer not null default 0,
    max_attempts  integer not null default 5 check (max_attempts between 1 and 50),
    dedupe_key    text,                                    -- at most one queued/running job per key
    locked_by     text,
    locked_at     timestamptz,
    last_error    text,
    result        jsonb,
    schedule      text,                                    -- set when enqueued by job_schedules
    created_at    timestamptz not null default now(),
    started_at    timestamptz,
    finished_at   timestamptz
);
create index jobs_ready_idx on jobs (priority desc, run_at) where status = 'queued';
create index jobs_running_idx on jobs (locked_at) where status = 'running';
create index jobs_finished_idx on jobs (finished_at) where status in ('succeeded', 'failed', 'dead');
create index jobs_kind_idx on jobs (kind, created_at desc);
create unique index jobs_dedupe_idx on jobs (dedupe_key) where dedupe_key is not null and status in ('queued', 'running');

create table job_schedules (
    name              text primary key check (name ~ '^[a-z0-9][a-z0-9._-]*$'),
    kind              text not null,
    payload           jsonb not null default '{}',
    description       text not null default '',
    interval_seconds  integer not null check (interval_seconds >= 60),
    enabled           boolean not null default true,
    next_run_at       timestamptz not null default now(),
    last_run_at       timestamptz,
    last_job_id       bigint,
    updated_at        timestamptz not null default now()
);

create table retention_policies (
    key            text primary key,
    title          text not null,
    description    text not null default '',
    days           integer not null check (days between 1 and 3650),
    min_days       integer not null default 1,
    enabled        boolean not null default true,
    last_run_at    timestamptz,
    last_deleted   integer,
    updated_at     timestamptz not null default now()
);

insert into retention_policies (key, title, description, days, min_days) values
    ('jobs', 'Afsluttede jobs', 'Jobs der er gennemført, fejlet eller opgivet', 30, 1),
    ('webhook_deliveries', 'Webhook-leveringer', 'Leveringer med svar og fejl (afsluttede)', 30, 1),
    ('otp_codes', 'Engangskoder', 'Brugte og udløbne engangskoder (kun som hash)', 1, 1),
    ('webauthn_challenges', 'Passkey-udfordringer', 'Udløbne WebAuthn-udfordringer', 1, 1),
    ('sessions', 'Udløbne sessioner', 'Sessioner der udløb for mere end N dage siden', 30, 1),
    ('captcha_spent', 'Brugte captchaer', 'Løste captcha-opgaver (kun et hash)', 1, 1),
    ('review_orphans', 'Tomme review-sessioner', 'Afsluttede review-sessioner uden noter og uden sider', 90, 7);

insert into job_schedules (name, kind, description, interval_seconds) values
    ('maintenance', 'maintenance.hourly', 'Analytics-partitioner og stale jobs', 3600),
    ('retention.logs', 'retention.logs', 'Sletter gamle hændelser i auth-, audit-, analytics- og MCP-loggen (purge-brugeren)', 86400),
    ('retention.cleanup', 'retention.cleanup', 'Rydder op efter opbevaringsreglerne', 3600);

create table webhooks (
    id                 bigserial primary key,
    name               text not null,
    url                text not null,
    events             text[] not null default '{}',     -- '*' = every event
    active             boolean not null default true,
    auth_header_name   text check (auth_header_name ~ '^[A-Za-z0-9-]{1,64}$'),
    auth_header_enc    bytea,                            -- encrypted value, e.g. "Bearer …"; null = no header
    auth_header_hint   text,                             -- last 4 characters, for the admin list
    secret_enc         bytea not null,                   -- signing secret, encrypted
    timeout_seconds    integer not null default 10 check (timeout_seconds between 1 and 30),
    max_attempts       integer not null default 8 check (max_attempts between 1 and 20),
    consecutive_failures integer not null default 0,
    disabled_reason    text,
    created_by         bigint references users (id) on delete set null,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    last_success_at    timestamptz,
    last_failure_at    timestamptz
);

create table webhook_deliveries (
    id             uuid primary key,                     -- also X-Gaer-Delivery, for idempotency at the receiver
    webhook_id     bigint not null references webhooks (id) on delete cascade,
    event          text not null,
    payload        jsonb not null,
    status         text not null default 'pending' check (status in ('pending', 'succeeded', 'failed', 'dead')),
    attempts       integer not null default 0,
    last_status    integer,
    last_error     text,
    last_response  text,
    duration_ms    integer,
    created_at     timestamptz not null default now(),
    last_attempt_at timestamptz,
    delivered_at   timestamptz
);
create index webhook_deliveries_hook_idx on webhook_deliveries (webhook_id, created_at desc);
create index webhook_deliveries_status_idx on webhook_deliveries (status, created_at);

create table captcha_spent (
    challenge   text primary key,                        -- the challenge hash, never anything about the person
    expires_at  timestamptz not null
);
create index captcha_spent_expires_idx on captcha_spent (expires_at);
