-- Adoption: journeys (adoptionsforløb) measured by the routes signed-in users visit. Ported from surdej-v1
-- modules/member-adoption in a generic form: no Office Graph, no Organisation dataset, no message bus.
--
-- adoption_journeys  a journey: name, status, audience (who is measured), goal and period.
-- adoption_steps     the ordered measuring points. A step is reached when the user has visited a route that matches
--                    (exact, prefix, glob or regex) since the journey started. The funnel is sequential.
-- adoption_members   who may read, edit or manage a journey (reader, editor, owner). Admins with "Fuld adgang" see all.
-- adoption_visits    one row per page a signed-in user opened in the app on /, /m or /extension, while tracking is on
--                    (setting adoption_tracking, off by default). Personal data: in the GDPR export, deleted with the
--                    user (cascade) and after N days (retention_policies 'adoption_visits').
-- adoption_nudges    a nudge sent to a user who is stuck; delivered as the webhook event adoption.nudge.sent.

create table adoption_journeys (
    id          bigserial primary key,
    name        text not null check (length(name) between 1 and 120),
    status      text not null default 'draft' check (status in ('draft', 'active', 'paused')),
    audience    jsonb not null default '{"kind": "all"}',
    goal_pct    integer not null default 75 check (goal_pct between 1 and 100),
    start_at    timestamptz not null default date_trunc('day', now()),
    end_at      timestamptz,
    created_by  bigint references users (id) on delete set null,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    check (end_at is null or end_at > start_at)
);

create table adoption_steps (
    id          bigserial primary key,
    journey_id  bigint not null references adoption_journeys (id) on delete cascade,
    position    integer not null check (position >= 0),
    label       text not null check (length(label) between 1 and 120),
    match_type  text not null check (match_type in ('exact', 'prefix', 'glob', 'regex')),
    pattern     text not null check (length(pattern) between 1 and 300),
    unique (journey_id, position)
);

create table adoption_members (
    journey_id  bigint not null references adoption_journeys (id) on delete cascade,
    user_id     bigint not null references users (id) on delete cascade,
    role        text not null check (role in ('reader', 'editor', 'owner')),
    added_by    bigint references users (id) on delete set null,
    created_at  timestamptz not null default now(),
    primary key (journey_id, user_id)
);
create index adoption_members_user_idx on adoption_members (user_id);

create table adoption_visits (
    id       bigserial primary key,
    user_id  bigint not null references users (id) on delete cascade,
    path     text not null check (length(path) between 1 and 300),
    surface  text not null check (surface in ('app', 'mobil', 'udvidelse', 'office')),
    at       timestamptz not null default now()
);
create index adoption_visits_at_idx on adoption_visits (at);
create index adoption_visits_user_idx on adoption_visits (user_id, at);

create table adoption_nudges (
    id          bigserial primary key,
    journey_id  bigint not null references adoption_journeys (id) on delete cascade,
    user_id     bigint not null references users (id) on delete cascade,
    sent_by     bigint references users (id) on delete set null,
    sent_at     timestamptz not null default now()
);
create index adoption_nudges_journey_idx on adoption_nudges (journey_id, user_id, sent_at desc);

insert into retention_policies (key, title, description, days, min_days) values
    ('adoption_visits', 'Adoption-besøg', 'Rutebesøg fra indloggede brugere, som adoptionsforløb måles på', 180, 30);
