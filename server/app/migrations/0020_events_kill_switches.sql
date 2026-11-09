-- Events and kill switches (app.events, app.killswitch, /admin/resources).
--
-- events         short-lived facts the app counts: a kind (http.5xx, auth.otp_failed …), an object id and a number.
--                No personal data: ref is never a user id, e-mail, phone number or IP, data holds ids and numbers.
--                With NATS they arrive through the JetStream stream EVENTS; id makes a redelivered message harmless.
--                Kept 7 days (retention policy "events").
-- kill_switches  emergency stops for parts of the service (app.killswitch.SWITCHES). A row only exists once a
--                switch has been used. Closed by an admin or automatically by a rule (setting kill_rules); expires_at
--                reopens it by itself. Every change is in the audit log.

create table events (
    id     uuid primary key,
    ts     timestamptz not null default now(),
    kind   text not null check (kind ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$'),
    ref    text not null default '' check (length(ref) <= 200),
    value  double precision not null default 0,
    data   jsonb not null default '{}'
);
create index events_ts_idx on events (ts);
create index events_kind_ts_idx on events (kind, ts desc);

create table kill_switches (
    key         text primary key,
    active      boolean not null default false,
    reason      text not null default '' check (length(reason) <= 500),
    auto        boolean not null default false,
    set_by      bigint references users (id) on delete set null,
    set_at      timestamptz,
    expires_at  timestamptz
);

insert into retention_policies (key, title, description, days, min_days) values
    ('events', 'Hændelser', 'Hændelser fra appen til tællinger og nødstop (kun id''er og tal)', 7, 1);
