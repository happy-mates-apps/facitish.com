---
name: gaer-profile
description: Frontend guide to user profile and security in Gær — the profile/avatar/security API, MFA (passkeys, security keys, authenticator apps, "Kræv passkey"), the step-up dialog, the /admin MFA gate and the admin user API. Use when building or changing login screens, the account page, profile fields, anything that needs a second factor, or user management in /admin.
---

# Profile and security for frontend code (gaer-profile)

The server decides who may do what (skill `gaer-auth`). The frontend shows the right screens, calls the API through
`web/src/api.ts`, and lets the step-up dialog handle "prove your second factor". Never re-implement a rule in the
browser only.

## Where things are
| What | App on `/` | Admin app `/admin` | Shared |
| --- | --- | --- | --- |
| User, login, WebAuthn helpers | | | `web/src/auth.tsx` |
| API client, `ApiError.code`, `setStepUpHandler` | | | `web/src/api.ts` |
| Second factor form, step-up dialog, passkey nudge | `web/src/security.tsx` | `web/src/admin-app/mfa.tsx` | |
| Login steps (code → offer / mfa) | `web/src/pages/Login.tsx` | (uses `/login`) | |
| Account: profile, avatar, security | `web/src/pages/Account.tsx`, `AccountSecurity.tsx` | | |
| MFA gate + grace banner | | `admin-app/main.tsx` (`RequireAdmin`), `AdminShell.tsx` | |
| User list + drawer (MFA status, reset, profile) | | `admin-app/pages/Users.tsx`, `UserDrawer.tsx`, `users.ts` | |

The admin app may not import the app's files (and vice versa) — `npm run build` fails. Shared code goes in
`auth.tsx`/`api.ts` only if both apps need it and it has no UI.

## The user object (`useAuth()`)
```ts
const { user, scope, refresh } = useAuth();
user.mfa.required         // "Kræv passkey" is on
user.mfa.methods          // ["passkey", "totp"] — what the user can prove a second factor with
user.mfa.factors          // number of passkeys + security keys + authenticator apps
user.mfa.admin_ok         // this session may use /admin right now
user.mfa.admin_grace_left // admins without a factor: code logins left before /admin needs one (null otherwise)
user.passkeys             // passkeys + security keys
user.avatar_url           // "/api/me/avatar" or null
scope                     // "full" | "mfa" (pending: logged in with a code, second factor missing)
```
Call `refresh()` after anything that changes login state, factors or the profile.

## API
All calls via `api.get/post/put/patch/del`. Errors are `ApiError` with `status`, a Danish `message` and `code`:
`"mfa_required"` (the session needs its second factor), `"mfa_setup_required"` (admin without any factor),
`"stepup_required"` (a recent second factor is needed for this action).

**Login** (`/api/auth`)
- `POST /otp/start {email}` → `{ok, expires_in, dev_code?}` · `POST /otp/verify {email, code}` → `LoginResult`
- `POST /passkey/login/options` + `/verify` → `LoginResult` (use `loginWithPasskey()`)
- `LoginResult` = `{status: "logged_in", offer_passkey, admin, admin_grace_left, became_admin}` or
  `{status: "mfa_required", methods}` → show the second-factor step (`SecondFactor`, the `mfa` step in `Login.tsx`).
- Second factor: `stepUpWithPasskey()` · `stepUpWithTotp(code)` (`/api/auth/mfa/*`). Both replace the session.
- `GET /me` → `{user, scope, impersonator}`.

**Profile** (`/api/me`)
- `GET /profile` → `{id, email, phone, display_name, locale, time_zone, avatar_url, role, created_at, locales}`
- `PATCH /profile {display_name?, locale?: "da" | "en", time_zone?: IANA name}` — only sent fields change; `""`
  or `null` clears a field.
- `PUT /avatar` (FormData `file`, PNG/JPEG/WebP ≤ 2 MB, checked by content) · `GET /avatar` (the image) ·
  `DELETE /avatar`. The avatar is not listed under `/api/files`.
- E-mail/phone with a code: `POST /email/start {email}` → `POST /email/verify {email, code}` (same for `phone`).
  Like deleting the account, this needs a recent second factor when the user has one (the dialog handles it).
- Sessions: `GET /sessions`, `DELETE /sessions/{id}` · GDPR: `GET /export`, `POST /delete {confirm}`.

**Security** (`/api/me`)
- `GET /security` → `{mfa_required, factors, methods, passkeys[], security_keys[], totp[],
  session: {mfa_at, stepup_ok, grace}, admin: {ok, grace_logins, grace_left, mfa_hours} | null, active_sessions,
  advice[]}`. `advice` ∈ `add_passkey`, `admin_needs_mfa`, `add_backup_factor`, `enable_mfa` — show them as hints.
- Passkey: `registerPasskey(name?)`; security key (YubiKey): `registerPasskey(name?, "security_key")`.
  `PATCH /passkeys/{id} {name}`, `DELETE /passkeys/{id}`.
- Authenticator app: `totpSetup.start(name?)` → `{id, secret, uri, qr_svg}`. Show the QR code as
  `<img src={"data:image/svg+xml;utf8," + encodeURIComponent(qr_svg)} />` (never `dangerouslySetInnerHTML`), the
  secret in groups of 4 and `uri` as an "Åbn i app" link; then `totpSetup.confirm(id, code)`.
  `PATCH /totp/{id} {name}`, `DELETE /totp/{id}`.
- "Kræv passkey": `PUT /mfa {required: boolean}` (needs at least one factor; 409 otherwise).

**Admin** (`/api/admin`, admin app only)
- `GET /users` items include `passkeys`, `totp`, `mfa_required`, `grace_logins_used`.
- `GET /users/{id}` → `{user, security: {factors, methods, keys[], totp[], grace_left}, sessions[]}`
- `PATCH /users/{id}/profile {display_name?, locale?, time_zone?}` · `GET /users/{id}/avatar`
- `POST /users/{id}/reset-mfa` (all factors, "Kræv passkey" off, logged out everywhere; another admin only by the
  super admin; never yourself) · `POST /users/{id}/reset-passkeys`.
- Role, e-mail/phone, block/unblock, resets, revoking sessions and GDPR erasure need a fresh second factor — the
  step-up dialog appears by itself.

**MCP** (skill `gaer-mcp`): `/mcp` has `profile_get`, `profile_update` and `security_get` (read only);
`/mcp/admin` has `user_get`, and the drafts `user_profile_set` and `user_reset_mfa`. Deep links focus the
`data-deeplink` anchors `account-profile`, `account-security`, `user-profile` and `user-mfa` — keep them when you
change those screens and run `npm run app-map --prefix web`.

## Step-up: let the dialog do it
Each app mounts one dialog that registers `setStepUpHandler` (`StepUpDialog` in `App.tsx`, `AdminStepUp` in
`admin-app/main.tsx`). When a call returns `stepup_required` or `mfa_required`, `api.ts` opens it and repeats the
call once after success. So write actions plainly:
```ts
await api.post(`/api/admin/users/${id}/block`); // may show the dialog first; throws ApiError if cancelled
```
Do not add your own retry, and do not call `/api/auth/mfa/*` before every action. If the user has no factor
(`user.mfa.methods` is empty) the dialog does not open and the call fails with the server's message — link to
`/konto#sikkerhed`.

## Patterns
- **Nudge, don't force.** Users without a passkey see `PasskeyNudge` (dismissable for 14 days). Only admins see
  the grace count. Never block the app on `/` because a user has no passkey.
- **Login screens**: after `otp/verify` or a passkey login, branch on `LoginResult` like `after()` in `Login.tsx`:
  `mfa_required` → second factor; `offer_passkey` / `admin_grace_left` → offer step; else continue.
  Embedded logins (`/extension/login`, `/m/login`) reuse `Login`.
- **/admin gate**: `RequireAdmin` shows `AdminMfaGate` while `!user.mfa.admin_ok`; the server checks too.
- **A new profile field** end to end: migration (a new file) → `ProfileIn` + `clean_profile` in `routes/me.py`
  (validation) → `GET /profile` → GDPR export in `gdpr.py` → `GET /api/admin/users/{id}` → UI in `Account.tsx`
  and `UserDrawer.tsx` → tests in `server/tests/test_mfa.py`. The audit entry comes from `update_profile_fields`.
- Security texts are Danish and concrete: "passkey", "sikkerhedsnøgle (fx YubiKey)", "godkendelsesapp",
  "Kræv passkey", "Bekræft at det er dig".

## Never
- Store codes, TOTP secrets or WebAuthn responses in `localStorage`, logs or analytics.
- Show the TOTP secret again after setup, or render server SVG/HTML with `dangerouslySetInnerHTML`.
- Rely on hiding a button as the only protection — the endpoint must use the right guard.
- Add a "remember this device" or "skip MFA" switch; that is a login rule (`gaer-auth`).
