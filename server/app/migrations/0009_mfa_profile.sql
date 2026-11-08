-- MFA: /admin needs a second factor after the grace logins; other users are nudged to passkeys and may opt in.
-- Factors: passkeys (platform), security keys (e.g. YubiKey) and authenticator apps (TOTP).

-- The user's own choice: the one-time code alone is no longer enough to log in.
alter table users add column mfa_required boolean not null default false;

-- Profile fields.
alter table users add column locale text check (locale in ('da', 'en'));
alter table users add column time_zone text check (char_length(time_zone) <= 64);

-- A passkey on the device (platform) or a separate security key such as a YubiKey.
alter table passkeys add column kind text not null default 'passkey' check (kind in ('passkey', 'security_key'));

-- Sessions: 'mfa' is a pending login that may only complete the second factor. The old 'enroll' scope is gone.
update sessions set revoked_at = now() where scope = 'enroll' and revoked_at is null;
alter table sessions drop constraint sessions_scope_check;
update sessions set scope = 'mfa' where scope = 'enroll';
alter table sessions add constraint sessions_scope_check check (scope in ('full', 'mfa'));
alter table sessions add column mfa_at timestamptz;                       -- when this session proved a second factor
alter table sessions add column grace boolean not null default false;     -- an admin grace login (no factor yet)

alter table webauthn_challenges drop constraint webauthn_challenges_kind_check;
alter table webauthn_challenges add constraint webauthn_challenges_kind_check
    check (kind in ('register', 'login', 'stepup'));

-- Authenticator apps. The secret is encrypted (AES-GCM, key derived from SECRET_KEY) and never leaves the server
-- after setup. A factor counts once it is confirmed with a code.
create table totp_factors (
    id              bigserial primary key,
    user_id         bigint not null references users (id) on delete cascade,
    name            text not null default 'Godkendelsesapp' check (char_length(name) <= 60),
    secret_enc      bytea not null,
    created_at      timestamptz not null default now(),
    confirmed_at    timestamptz,
    last_used_step  bigint,                                               -- blocks replay of a used code
    last_used_at    timestamptz
);
create index totp_factors_user_idx on totp_factors (user_id);

-- The avatar is a file in Object Storage like other files, but not listed under /filer.
alter table files add column kind text not null default 'file' check (kind in ('file', 'avatar'));
alter table users add column avatar_file_id uuid references files (id) on delete set null;

-- The seeded front page still described the old login. Only untouched seed text is changed.
update web_pages set body = replace(replace(body,
        '- Log ind med telefonnummer og engangskode', '- Log ind med din e-mailadresse og en engangskode'),
        '- Brug en passkey efter tre logins', '- Brug en passkey, sikkerhedsnøgle eller godkendelsesapp'),
    updated_at = now()
where slug = '' and lang = 'da' and body like '%- Brug en passkey efter tre logins%';
update web_pages set body = replace(replace(body,
        '- Log in with your phone number and a one-time code', '- Log in with your e-mail address and a one-time code'),
        '- Use a passkey after three logins', '- Use a passkey, security key or authenticator app'),
    updated_at = now()
where slug = '' and lang = 'en' and body like '%- Use a passkey after three logins%';
