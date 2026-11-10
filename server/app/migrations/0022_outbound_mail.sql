-- Outbound mail (app/outbound_mail.py): one row per mail the app sends through Lettermint — login codes, GDPR and
-- access links, budget alerts — with the delivery status Lettermint reports. Independent of the mail module
-- (mailboxes in Stalwart): this is about the app's own mail, shown in /admin/mail → Udgående mail.
--
-- Two sources keep status current: the incoming webhook handler "lettermint" (message.delivered, message.*_bounced, …)
-- and the job mail.lettermint_poll, which reads GET /v1/messages with a Team API token (LETTERMINT_TEAM_TOKEN) and
-- fills in anything the webhook missed.
--
-- Personal data: the recipient is stored as an HMAC (like auth_log.phone_hash) plus the domain, never in clear;
-- the subject is stored with digit runs masked, so a login code never ends up here. Rows follow the user
-- (user_id cascades, and erasure also removes rows matching the e-mail hash) and are in the GDPR export.

create table outbound_mail (
    id                   bigserial primary key,
    provider             text not null default 'lettermint',
    provider_message_id  text not null unique,
    user_id              bigint references users (id) on delete cascade,
    recipient_hash       text,
    recipient_domain     text,
    purpose              text not null default 'other',          -- login, email_change, gdpr, access, budget, other
    subject              text,                                    -- digits masked
    status               text not null default 'sent'
        check (status in ('scheduled', 'queued', 'sent', 'delivered', 'opened', 'deferred', 'soft_bounced', 'hard_bounced',
                          'failed', 'spam_complaint', 'suppressed', 'unknown')),
    status_source        text not null default 'app',             -- app, webhook, poll
    status_changed_at    timestamptz,
    detail               jsonb not null default '{}',
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now()
);
create index outbound_mail_created_idx on outbound_mail (created_at desc);
create index outbound_mail_user_idx on outbound_mail (user_id, created_at desc);
create index outbound_mail_recipient_idx on outbound_mail (recipient_hash);
create index outbound_mail_status_idx on outbound_mail (status, created_at desc);

insert into retention_policies (key, title, description, days, min_days) values
    ('outbound_mail', 'Udgående mail', 'Status på mails appen har sendt gennem Lettermint (login-koder, GDPR- og adgangslinks)', 90, 7);

insert into job_schedules (name, kind, description, interval_seconds) values
    ('mail.lettermint_poll', 'mail.lettermint_poll',
     'Henter status på udgående mail fra Lettermint (Team API) og udfylder det, webhooken ikke nåede', 900);
