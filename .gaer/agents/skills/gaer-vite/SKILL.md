---
name: gaer-vite
description: The Gær frontend (Vite + React + TypeScript) — structure, login screens, styling and calls to the API. Use when changing anything in web/.
---

# Frontend (gaer-vite)

Vite + React 19 + TypeScript + react-router. No UI framework: `web/src/styles.css` holds the Happy Mates
tokens (`--hm-*`) and a few components (`.card`, `.btn`, `.pill`, `.eyebrow`, `.table-wrap`, `.grid`, `.glow`).

## Structure
- `routes.json` — **the one description of every route** (path, app, access, chrome, embeddable, title, group).
  `npm run app-map` checks it against the `<Route>`s and writes `server/app/routes.json`, `server/app/mcp/app_map.json`
  and the route tables in `README.md` and `.gaer/agents/instructions.md`.
- `App.tsx` — routes of the app on `/`. `RequireUser` (optionally `login="/m/login"` …) guards pages.
- `api.ts` — **all** API calls (`api.get/post/put/patch/del`). Adds `X-Gaer: 1` (CSRF) and `X-Gaer-Embedded`.
  `ApiError.code` carries MFA errors; `setStepUpHandler` lets each app's step-up dialog repeat a call.
- `security.tsx` — second-factor form, step-up dialog (mounted in `App.tsx`) and the passkey nudge for the app on /.
- `auth.tsx` — `useAuth()` (user incl. `mfa`, scope, config, refresh, logout), passkey/security key/TOTP helpers.
- `ui.tsx` — `useLoad`, `PageHeader`, `Alert`, `Pager`, `Json`, formatting (`fmtDate`, `fmtBytes` …, da-DK).
- `pages/` (app), `mobile/` (`/m`), `extension/` (`/extension`), `office/` (`/office-addin` + tools),
  `bridge/` (postMessage clients).
- `admin-app/` — the **separate** admin app on `/admin` (entry `web/admin.html`, routes in `admin-app/main.tsx`,
  menu in `admin-app/nav.ts`). It has its own shell, components (`admin-app/ui.tsx`) and styles
  (`admin-app/base.css` + `admin.css`).
- `tracker.ts` + `ConsentBanner.tsx` — self-hosted analytics; only anonymous page views without consent.

## Two apps, one build
`/` (`index.html`) and `/admin` (`admin.html`) are separate Vite entries with separate bundles. They share
only `api.ts`, `auth.tsx`, `bridge/`, `deeplink.tsx` and `routes.json` (and the login cookie). Everything else stays on its own side:
`admin-app/` may not import the rest of `src/`, the rest of `src/` may not import `admin-app/`, and the shared
modules only import each other. `appBoundary()` in `web/vite.config.ts` fails `npm run dev` and
`npm run build` on a forbidden import — copy what you need instead of importing across.

## Adding a page
1. Describe it in `web/src/routes.json` (pick the group, or add one with English and Danish text for the docs).
2. Add the `<Route>` in `App.tsx` or `admin-app/main.tsx` (+ the menu item in `admin-app/nav.ts`, label = title).
3. `npm run app-map --prefix web` — commit the generated files with it. `npm run build` checks everything.

## Login screens
`pages/Login.tsx`: e-mail → code → then either the second factor (users with "Kræv passkey") or an offer to create
a passkey (with the /admin grace count for admins). Reused for `/extension/login` and `/m/login` via `home` /
`embedded` props. Do not add other login flows (see `gaer-auth`). Profile, account security, the step-up dialog and
the /admin MFA gate: skill `gaer-profile`.

## Conventions
- Danish UI text. Short sentences.
- Pages: `PageHeader eyebrow="/path" title="…"`, cards on a muted background, tables in `.table-wrap`.
- Confirm destructive actions with `confirm()` and say what happens.
- Run `npm run build --prefix web` (typecheck + build) before committing.
