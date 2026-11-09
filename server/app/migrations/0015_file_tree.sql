-- A folder tree on top of files: every user has a home under /users/<id>/, and /shared/ holds common project files
-- (used by the app, the AI chat and the MCP servers). app/filetree.py maps paths to rows.

-- space 'user': the file lives in the home of files.user_id (user_id null = system files such as the logo, not in
-- the tree). space 'shared': under /shared, user_id is null and uploaded_by says who put it there.
alter table files add column space text not null default 'user' check (space in ('user', 'shared'));
-- The folder inside the space: '/' or '/a/b/' (always leading and trailing slash).
alter table files add column folder text not null default '/' check (folder like '/%/' or folder = '/');
alter table files add column uploaded_by bigint references users (id) on delete set null;
alter table files add column updated_at timestamptz;
alter table files add constraint files_shared_has_no_owner check (space = 'user' or user_id is null);
update files set uploaded_by = user_id where user_id is not null;
create index files_tree_idx on files (space, user_id, folder);
create index files_uploaded_by_idx on files (uploaded_by);

-- Folders exist on their own too, so an empty folder can be created before files are put in it.
create table file_folders (
    id          bigserial primary key,
    space       text not null check (space in ('user', 'shared')),
    user_id     bigint references users (id) on delete cascade,
    path        text not null check (path like '/%/'),
    created_by  bigint references users (id) on delete set null,
    created_at  timestamptz not null default now(),
    check ((space = 'user') = (user_id is not null))
);
create unique index file_folders_unique_idx on file_folders (space, coalesce(user_id, 0), path);

-- Grants are re-applied by gaer_apply_grants() after the run.
