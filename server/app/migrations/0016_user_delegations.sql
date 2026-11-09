-- Mit område (/user): a user can give another user access to their area as reader or author (/user/<id>).
-- app/delegation.py holds the rules; routes/user_area.py the API.
--
-- delegate_email is what the owner typed (lower case). delegate_id is set as soon as it is known: at once when a user
-- with that e-mail exists, otherwise the first time that person opens "Delt med dig". accepted_at = first opened.

create table user_delegations (
    id              bigserial primary key,
    owner_id        bigint not null references users (id) on delete cascade,
    delegate_email  text not null check (delegate_email = lower(delegate_email) and delegate_email like '%@%'),
    delegate_id     bigint references users (id) on delete cascade,
    role            text not null check (role in ('reader', 'author')),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    expires_at      timestamptz,
    accepted_at     timestamptz,
    last_used_at    timestamptz,
    check (delegate_id is null or delegate_id <> owner_id)
);
create unique index user_delegations_owner_email_idx on user_delegations (owner_id, delegate_email);
create unique index user_delegations_owner_delegate_idx on user_delegations (owner_id, delegate_id) where delegate_id is not null;
create index user_delegations_delegate_idx on user_delegations (delegate_id);
create index user_delegations_pending_idx on user_delegations (delegate_email) where delegate_id is null;

-- What a delegate does in someone's area is audited with detail.on_behalf_of = the owner, so the owner's
-- activity list can find it.
create index audit_log_on_behalf_idx on audit_log (((detail ->> 'on_behalf_of')::bigint), ts desc)
    where detail ? 'on_behalf_of';

insert into retention_policies (key, title, description, days, min_days) values
    ('user_delegations', 'Udløbne delinger', 'Adgang til en brugers område, der er udløbet for mere end N dage siden', 30, 1);

-- Grants are re-applied by gaer_apply_grants() after the run.
