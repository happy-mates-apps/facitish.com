-- Login with e-mail by default; SMS is opt-in (SMS_LOGIN=1). A user has an e-mail address, a phone number or both.
alter table users alter column phone drop not null;
alter table users add column email text unique check (email = lower(email));
alter table users add constraint users_contact_check check (email is not null or phone is not null);

-- The super admin is the first user of the instance. It cannot lose the admin role or be blocked by others.
alter table users add column super_admin boolean not null default false;
create unique index users_one_super_admin on users (super_admin) where super_admin;
update users set super_admin = true
where id = (select id from users where role = 'admin' and not impersonation_only order by id limit 1);

-- A one-time code goes to an e-mail address or a phone number.
alter table otp_codes rename column phone to recipient;
alter table otp_codes drop constraint otp_codes_purpose_check;
alter table otp_codes add constraint otp_codes_purpose_check check (purpose in ('login', 'phone_change', 'email_change'));
drop index otp_codes_phone_idx;
create index otp_codes_recipient_idx on otp_codes (recipient, purpose, created_at desc);

comment on column auth_log.phone_masked is 'masked login contact: e-mail address or phone number';
comment on column auth_log.phone_hash is 'HMAC of the login contact (e-mail or phone), lets admins search by the full value';
