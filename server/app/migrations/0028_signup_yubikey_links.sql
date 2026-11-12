-- Sign-up modes (setting `signup`: open, domains, closed), users created by an admin, the YubiKey requirement for
-- /admin and other privileged areas, and login links (the one-time code as a link in the mail).

-- Who created the user in /admin (null: the user signed up by logging in).
alter table users add column created_by bigint references users (id) on delete set null;
-- /admin, step-up and other privileged areas accept only a YubiKey as the second factor (app.mfa).
alter table users add column yubikey_required boolean not null default false;

-- A security key whose attestation shows a YubiKey. attestation: 'verified' (the chain ends in a Yubico root from
-- YUBICO_ROOTS) or 'issuer' (signed by a certificate that names Yubico; no root to check against).
-- enrolled_by: an admin registered the key in person for the user. Such a key is only ever a second factor after the
-- user's own code, never a login on its own (the admin held it).
alter table passkeys add column yubikey boolean not null default false;
alter table passkeys add column attestation text check (attestation in ('verified', 'issuer'));
alter table passkeys add column aaguid uuid;
alter table passkeys add column enrolled_by bigint references users (id) on delete set null;

-- When this session last proved a YubiKey (the requirement counts only this, see app.mfa).
alter table sessions add column yubikey_at timestamptz;

-- Login link: a login code sent by e-mail also gets a long random token; only its hash is stored. Redeeming the link
-- consumes the code row like typing the code does.
alter table otp_codes add column link_hash text;
create unique index otp_codes_link_idx on otp_codes (link_hash) where link_hash is not null;

-- Admin in-person enrollment: the challenge is for the user, but only the admin who asked may answer it.
alter table webauthn_challenges add column actor_id bigint references users (id) on delete cascade;
alter table webauthn_challenges drop constraint webauthn_challenges_kind_check;
alter table webauthn_challenges add constraint webauthn_challenges_kind_check
    check (kind in ('register', 'login', 'stepup', 'enroll'));

-- A link an admin sends so the user can add a YubiKey that counts for the requirement. Single use, expiring.
create table yubikey_enrollments (
    id           bigserial primary key,
    user_id      bigint not null references users (id) on delete cascade,
    token_hash   text not null unique,
    created_by   bigint references users (id) on delete set null,
    created_at   timestamptz not null default now(),
    expires_at   timestamptz not null,
    used_at      timestamptz,
    passkey_id   bigint references passkeys (id) on delete set null
);
create index yubikey_enrollments_user_idx on yubikey_enrollments (user_id, created_at desc);

insert into retention_policies (key, title, description, days, min_days) values
    ('yubikey_enrollments', 'YubiKey-links', 'Links til at tilknytte en YubiKey, efter de er udløbet.', 30, 1)
on conflict (key) do nothing;
