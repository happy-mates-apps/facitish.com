-- Beskeder, phase 2 (specs/beskeder/): conversations between users — the instance's shared conversation
-- ("Fællessamtalen", every active user is a member) and direct conversations between two users — with reports,
-- blocks and moderation in /admin. Ported from happy-groups member-chat (Conversation, Participant, MessageReport,
-- UserBlock) without groups.

alter table conversations drop constraint conversations_kind_check;
alter table conversations add constraint conversations_kind_check check (kind in ('reply', 'instance', 'direct'));
alter table conversations add column title text;
alter table conversations add column pair_key text unique;          -- direct: the two user ids sorted, "12:40"
create unique index conversations_one_instance_idx on conversations (kind) where kind = 'instance';

-- Read state. The shared conversation has every active user implicitly; a row appears on first read or post.
create table conversation_members (
    conversation_id  bigint not null references conversations (id) on delete cascade,
    user_id          bigint not null references users (id) on delete cascade,
    joined_at        timestamptz not null default now(),
    last_read_at     timestamptz,
    primary key (conversation_id, user_id)
);
create index conversation_members_user_idx on conversation_members (user_id);

-- A removed message keeps its text for the audit trail; users only see that it was removed.
alter table conversation_messages add column removed_at timestamptz;
alter table conversation_messages add column removed_by bigint references users (id) on delete set null;

create table message_reports (
    id            bigserial primary key,
    message_id    bigint not null references conversation_messages (id) on delete cascade,
    reporter_id   bigint not null references users (id) on delete cascade,
    reason        text not null check (reason in ('harassment', 'hate', 'sexual', 'spam', 'other')),
    details       text not null default '' check (char_length(details) <= 1000),
    status        text not null default 'pending' check (status in ('pending', 'dismissed', 'removed')),
    reviewed_by   bigint references users (id) on delete set null,
    reviewed_at   timestamptz,
    created_at    timestamptz not null default now(),
    unique (message_id, reporter_id)
);
create index message_reports_pending_idx on message_reports (created_at) where status = 'pending';

-- Blocks are the user's own: the blocked user's messages are hidden from the blocker, and no direct conversation
-- or notification passes between them. Admins only ever see counts.
create table user_blocks (
    blocker_id  bigint not null references users (id) on delete cascade,
    blocked_id  bigint not null references users (id) on delete cascade,
    created_at  timestamptz not null default now(),
    primary key (blocker_id, blocked_id),
    check (blocker_id <> blocked_id)
);
create index user_blocks_blocked_idx on user_blocks (blocked_id);

insert into retention_policies (key, title, description, days, min_days) values
    ('message_reports', 'Beskeder: afgjorte anmeldelser', 'Anmeldelser, der er afvist eller har fået beskeden fjernet', 365, 30);

insert into features (key, title, description, area, ring, builtin) values
    ('samtaler', 'Samtaler', 'Fællessamtalen og direkte beskeder mellem brugere, med anmeld og bloker', 'bruger', 4, true)
on conflict (key) do nothing;
