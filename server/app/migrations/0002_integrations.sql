-- Integrations: browser extension (/extension), Office add-ins (/office-addin),
-- the public website (/w) and the mobile app (/m).

-- Clips: text a user captures from a web page (extension), a mail (Outlook) or writes
-- by hand, and can insert into Word or Outlook later.
create table clips (
    id          bigserial primary key,
    user_id     bigint not null references users (id) on delete cascade,
    source      text not null check (source in ('manual', 'extension', 'outlook', 'word', 'mobile')),
    title       text not null,
    body        text not null default '',
    url         text,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index clips_user_idx on clips (user_id, created_at desc);

-- Per-domain consent for the browser extension: the app may only read pages on
-- domains the user has allowed.
create table bridge_consents (
    id          bigserial primary key,
    user_id     bigint not null references users (id) on delete cascade,
    domain      text not null,
    created_at  timestamptz not null default now(),
    unique (user_id, domain)
);

-- The public website under /w. Markdown, edited in /admin/web, rendered by the Python server.
create table web_pages (
    id           bigserial primary key,
    slug         text not null check (slug ~ '^[a-z0-9-]*$'),   -- '' is the front page
    lang         text not null check (lang in ('da', 'en')),
    title        text not null,
    description  text not null default '',
    body         text not null default '',
    nav_order    integer,                                       -- null: not in the menu
    published    boolean not null default false,
    updated_at   timestamptz not null default now(),
    unique (slug, lang)
);

insert into web_pages (slug, lang, title, description, body, nav_order, published) values
('', 'da', 'Velkommen', 'Velkommen til vores nye løsning.',
'# Velkommen

Dette er forsiden af jeres offentlige website. Teksten redigeres i **/admin/web**.

- Log ind med telefonnummer og engangskode
- Brug en passkey efter tre logins
- Dine data bliver i Europa', 0, true),
('', 'en', 'Welcome', 'Welcome to our new solution.',
'# Welcome

This is the front page of your public website. Edit it in **/admin/web**.

- Log in with your phone number and a one-time code
- Use a passkey after three logins
- Your data stays in Europe', 0, true),
('om', 'da', 'Om os', 'Hvem vi er.', '# Om os

Fortæl her, hvem I er.', 1, true),
('om', 'en', 'About', 'Who we are.', '# About us

Tell people who you are.', 1, true);
