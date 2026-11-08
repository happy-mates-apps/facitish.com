---
name: gaer-vite
description: The Gær frontend (Vite + React + TypeScript) — structure, login screens, styling and calls to the API. Use when changing anything in web/.
---

# Frontend (gaer-vite)

Vite + React 19 + TypeScript + react-router. No UI framework: `web/src/styles.css` holds the Happy Mates
tokens (`--hm-*`) and a few components (`.card`, `.btn`, `.pill`, `.eyebrow`, `.table-wrap`, `.grid`, `.glow`).

## Structure
- `App.tsx` — routes of the app on `/`. `RequireUser` (optionally `login="/m/login"` …) guards pages.
- `api.ts` — **all** API calls (`api.get/post/put/patch/del`). Adds `X-Gaer: 1` (CSRF) and `X-Gaer-Embedded`.
- `auth.tsx` — `useAuth()` (user, scope, config, refresh, logout), passkey helpers.
- `ui.tsx` — `useLoad`, `PageHeader`, `Alert`, `Pager`, `Json`, formatting (`fmtDate`, `fmtBytes` …, da-DK).
- `pages/` (app), `mobile/` (`/m`), `extension/` (`/extension`), `office/` (`/office-addin` + tools),
  `bridge/` (postMessage clients).
- `admin-app/` — the **separate** admin app on `/admin` (entry `web/admin.html`, routes in `admin-app/main.tsx`,
  menu in `admin-app/nav.ts`). It has its own shell, components (`admin-app/ui.tsx`) and styles
  (`admin-app/base.css` + `admin.css`).
- `tracker.ts` + `ConsentBanner.tsx` — self-hosted analytics; only anonymous page views without consent.

## Two apps, one build
`/` (`index.html`) and `/admin` (`admin.html`) are separate Vite entries with separate bundles. They share
only `api.ts`, `auth.tsx` and `bridge/` (and the login cookie). Everything else stays on its own side:
`admin-app/` may not import the rest of `src/`, the rest of `src/` may not import `admin-app/`, and the shared
modules only import each other. `appBoundary()` in `web/vite.config.ts` fails `npm run dev` and
`npm run build` on a forbidden import — copy what you need instead of importing across.

## Login screens
`pages/Login.tsx`: phone → code → (offer passkey | passkey required). Shows grace-login pills. Reused for
`/extension/login` and `/m/login` via `home` / `embedded` props. Do not add other login flows (see `gaer-auth`).

## Conventions
- Danish UI text. Short sentences.
- Pages: `PageHeader eyebrow="/path" title="…"`, cards on a muted background, tables in `.table-wrap`.
- Confirm destructive actions with `confirm()` and say what happens.
- Run `npm run build --prefix web` (typecheck + build) before committing.
