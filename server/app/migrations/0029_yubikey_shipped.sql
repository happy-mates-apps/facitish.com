-- A YubiKey the super admin set up and sent to the user (routes/yubikey.py, mode "ship"). Like a key enrolled in
-- person it is only ever a second factor after the user's own code; shipped_at shows it is on its way until the user
-- takes it into use (last_used_at).
alter table passkeys add column shipped_at timestamptz;
