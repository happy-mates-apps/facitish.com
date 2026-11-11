-- Beskeder, phase 1 (specs/beskeder/): broadcasts from the administration, delivered in the app and per recipient by
-- SMS or e-mail; replies to a broadcast as a private thread between the user and the administration.
-- Ported from happy-groups member-chat / member-push / member-sms without groups.

create table message_broadcasts (
    id                 bigserial primary key,
    title              text not null check (char_length(title) between 1 and 120),
    body               text not null check (char_length(body) between 1 and 4000),
    audience           jsonb not null,
    audience_label     text not null,
    channels           text[] not null default '{}',               -- of sms, mail (app is always on); push in phase 3
    urgent             boolean not null default false,             -- goes through quiet hours
    allow_replies      boolean not null default true,
    total              integer not null default 0,
    push               integer not null default 0,
    sms                integer not null default 0,
    mail               integer not null default 0,
    app_only           integer not null default 0,
    segments           integer not null default 0,                 -- SMS segments per message
    price_minor        integer not null default 0,                 -- estimated SMS cost in øre
    status             text not null default 'sending' check (status in ('scheduled', 'sending', 'sent')),
    actor_id           bigint references users (id) on delete set null,
    confirmation_hash  text unique,                                -- a confirmation token sends once
    send_at            timestamptz,
    sent_at            timestamptz,
    created_at         timestamptz not null default now()
);
create index message_broadcasts_created_idx on message_broadcasts (created_at desc);

-- One per recipient and channel. The app row is the user's inbox entry.
create table message_deliveries (
    id            bigserial primary key,
    broadcast_id  bigint not null references message_broadcasts (id) on delete cascade,
    user_id       bigint not null references users (id) on delete cascade,
    channel       text not null check (channel in ('app', 'push', 'sms', 'mail')),
    status        text not null default 'queued'
                  check (status in ('queued', 'held', 'sent', 'delivered', 'read', 'failed', 'skipped', 'duplicate', 'throttled')),
    reason        text not null default 'broadcast' check (reason in ('broadcast', 'reply')),
    reply_id      bigint,                                            -- reason 'reply': the admin's answer (conversation_messages)
    sms_id        bigint,
    held_until    timestamptz,
    error         text,
    cost_minor    integer not null default 0,
    created_at    timestamptz not null default now(),
    sent_at       timestamptz,
    delivered_at  timestamptz,
    read_at       timestamptz
);
create unique index message_deliveries_inbox_idx on message_deliveries (broadcast_id, user_id) where channel = 'app';
create index message_deliveries_user_idx on message_deliveries (user_id, created_at desc);
create index message_deliveries_broadcast_idx on message_deliveries (broadcast_id, channel, status);
create index message_deliveries_created_idx on message_deliveries (created_at desc);

-- SMS messages need a yes of their own (a login phone number is not consent).
create table notification_prefs (
    user_id         bigint primary key references users (id) on delete cascade,
    sms             boolean not null default false,
    sms_consent_at  timestamptz,
    mail            boolean not null default true,
    updated_at      timestamptz not null default now()
);

create table sms_messages (
    id             bigserial primary key,
    user_id        bigint references users (id) on delete cascade,
    to_phone       text not null,
    body           text not null,
    purpose        text not null default 'message',
    segments       integer not null,
    encoding       text not null check (encoding in ('GSM-7', 'UCS-2')),
    provider       text not null,
    status         text not null default 'queued'
                   check (status in ('queued', 'sent', 'delivered', 'failed', 'duplicate', 'throttled')),
    attempts       integer not null default 0,
    error          text,
    created_at     timestamptz not null default now(),
    sent_at        timestamptz
);
create index sms_messages_created_idx on sms_messages (created_at desc);
create index sms_messages_phone_idx on sms_messages (to_phone, created_at desc);

-- Phase 1 has reply threads only; phase 2 adds 'instance' and 'direct'.
create table conversations (
    id               bigserial primary key,
    kind             text not null check (kind in ('reply')),
    broadcast_id     bigint references message_broadcasts (id) on delete cascade,
    user_id          bigint references users (id) on delete cascade,
    created_at       timestamptz not null default now(),
    last_message_at  timestamptz,
    last_from_admin  boolean not null default false,
    closed_at        timestamptz,
    closed_by        bigint references users (id) on delete set null,
    unique (broadcast_id, user_id)
);
create index conversations_open_idx on conversations (last_message_at desc) where closed_at is null;

create table conversation_messages (
    id               bigserial primary key,
    conversation_id  bigint not null references conversations (id) on delete cascade,
    author_id        bigint references users (id) on delete set null,
    author_name      text,
    from_admin       boolean not null default false,
    body             text not null check (char_length(body) between 1 and 4000),
    read_at          timestamptz,                                    -- by the other side
    created_at       timestamptz not null default now()
);
create index conversation_messages_conv_idx on conversation_messages (conversation_id, created_at);

alter table message_deliveries add constraint message_deliveries_reply_fk
    foreign key (reply_id) references conversation_messages (id) on delete cascade;
alter table message_deliveries add constraint message_deliveries_sms_fk
    foreign key (sms_id) references sms_messages (id) on delete set null;

insert into retention_policies (key, title, description, days, min_days) values
    ('message_deliveries', 'Beskeder: leveringer', 'Leveringer på SMS og e-mail pr. modtager (ikke indbakken i appen)', 90, 7),
    ('sms_messages', 'Beskeder: SMS', 'Sendte SMS med telefonnummer og tekst', 90, 7);

insert into features (key, title, description, area, ring, builtin) values
    ('beskeder', 'Beskeder', 'Beskeder fra administrationen i appen, på SMS og e-mail; svar til administrationen', 'bruger', 4, true)
on conflict (key) do nothing;
