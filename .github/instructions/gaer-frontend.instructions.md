---
applyTo: "web/**"
description: The Gær frontend — two apps (/ and /admin) in one Vite build, the shared API client and login, and the profile/MFA UI.
---

Read and follow `.gaer/agents/skills/gaer-vite/SKILL.md` before you change anything here. For login, the account
page, profile, passkeys, security keys, authenticator apps or anything behind `/admin`'s MFA gate, also read
`.gaer/agents/skills/gaer-profile/SKILL.md`.

- Two apps: `/` (`web/src/` outside `admin-app/`) and `/admin` (`web/src/admin-app/`). They share only `api.ts`,
  `auth.tsx`, `bridge/`, `deeplink.tsx` and `routes.json`; `npm run build` fails on an import across.
- All API calls go through `api` in `web/src/api.ts`. MFA errors carry `ApiError.code`; the step-up dialog
  (`setStepUpHandler`) repeats the call after the second factor — do not build your own retry.
- Never decide access in the browser alone: the server enforces login, MFA and roles (`gaer-auth`).
- UI text is Danish. `npm run build --prefix web` must pass.
- Routes are described in `web/src/routes.json` only; after a change run `npm run app-map --prefix web`.
