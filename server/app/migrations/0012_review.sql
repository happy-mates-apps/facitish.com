-- The review panel (⌃⌥⌘W or ?review=1 in the app on /, logged in only). A team member looks at the app as a
-- ring sees it, points at what must be fixed and runs test sessions as an archetype. Everything is stored per
-- user here (not in the browser), so it is in the GDPR export and removed on erasure. Screenshots and audio are
-- files (kind 'review') in Object Storage; review_attachments links them to a note.

alter table files drop constraint if exists files_kind_check;
alter table files add constraint files_kind_check check (kind in ('file', 'avatar', 'review'));

-- A test session: who the tester plays (archetype), which playbook (drejebog) and its tasks, and the pages seen.
-- Archetypes and playbooks live in the code (web/src/review/scripts.ts); the session keeps a copy of their text.
create table review_sessions (
    id            bigserial primary key,
    user_id       bigint not null references users (id) on delete cascade,
    persona_key   text not null default '',
    persona       jsonb not null default '{}',     -- {name, who, wants, worries, ring}
    script_key    text not null default '',        -- '' = fri gennemgang
    script_title  text not null default '',
    ring          integer check (ring between 1 and 4),
    tasks         jsonb not null default '[]',     -- [{id, title, status: open|done|stuck|skipped}]
    pages         jsonb not null default '[]',     -- [{path, at}]
    notes         text not null default '',
    started_at    timestamptz not null default now(),
    ended_at      timestamptz
);
create index review_sessions_user_idx on review_sessions (user_id, started_at desc);
create unique index review_sessions_one_active on review_sessions (user_id) where ended_at is null;

-- A note about a page: text, impression, and what it points at (an element or an area) plus the feature there.
create table review_feedback (
    id            bigserial primary key,
    user_id       bigint not null references users (id) on delete cascade,
    session_id    bigint references review_sessions (id) on delete cascade,
    task_id       text,
    path          text not null,
    body          text not null default '',
    impression    text check (impression in ('good', 'meh', 'bad')),
    feature_key   text,
    ring          integer check (ring between 1 and 4),   -- the ring the page was seen as
    target        jsonb,                                  -- {kind: element|area, ...}
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create index review_feedback_user_idx on review_feedback (user_id, created_at desc);
create index review_feedback_feature_idx on review_feedback (feature_key);
create index review_feedback_session_idx on review_feedback (session_id);

create table review_attachments (
    file_id       uuid primary key references files (id) on delete cascade,
    feedback_id   bigint not null references review_feedback (id) on delete cascade,
    kind          text not null check (kind in ('screenshot', 'audio'))
);
create index review_attachments_feedback_idx on review_attachments (feedback_id);
