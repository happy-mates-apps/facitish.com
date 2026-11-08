---
name: gaer-pr-review
description: Review a pull request for security, logging and migrations.
---

# /gaer-pr-review

1. Get the diff: `gh pr diff <number>` (or `git diff main...HEAD`).
2. Read the skills `gaer-auth`, `gaer-audit` and the ones matching the changed files.
3. Check, and report findings with file:line:
   - **Auth**: no endpoint that changes data without `current_user`/`require_admin`; pending `mfa` sessions only
     reach `/api/auth/mfa/*`; admin security actions use `require_admin_stepup`; MFA, grace-login and factor
     rules intact (skill `gaer-auth`); no new way to log in.
   - **CSRF**: new state-changing endpoints are under `/api/` (the `X-Gaer` header check applies).
   - **Audit**: every create/update/delete writes `audit()` in the same transaction, with before/after.
     Admin actions are audited. Logs stay append-only.
   - **Migrations**: new files only; grants still correct for log tables; no destructive change without a plan.
   - **GDPR**: new personal data in export and erasure; analytics only with consent.
   - **Storage**: files only via `app.storage`; download only via short-lived links; ownership checked.
   - **Embedding**: changes to CSP / `EMBEDDABLE` in `main.py` are deliberate.
   - **Tests**: new behaviour has tests.
4. Summarize: blocking issues first, then suggestions. Do not approve with failing checks.
