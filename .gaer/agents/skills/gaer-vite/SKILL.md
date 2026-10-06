---
name: gaer-vite
description: The Gær frontend (Vite + React + TypeScript) — structure, login screens, styling and calls to the API. Use when changing anything in web/.
---

# Frontend (gaer-vite)

Vite + React 19 + TypeScript + react-router. No UI framework: `web/src/styles.css` holds the Happy Mates
tokens (`--hm-*`) and a few components (`.card`, `.btn`, `.pill`, `.eyebrow`, `.table-wrap`, `.grid`, `.glow`).

## Structure
- `App.tsx` — routes. `RequireUser` (optionally `admin`, `login="/m/login"` …) guards pages.
- `api.ts` — **all** API calls (`api.get/post/put/patch/del`). Adds `X-Gaer: 1` (CSRF) and `X-Gaer-Embedded`.
- `auth.tsx` — `useAuth()` (user, scope, config, refresh, logout), passkey helpers.
- `ui.tsx` — `useLoad`, `PageHeader`, `Alert`, `Pager`, `Json`, formatting (`fmtDate`, `fmtBytes` …, da-DK).
- `pages/` (app), `admin/` (one file per `/admin/*` section, listed in `admin/sections.ts`),
  `mobile/` (`/m`), `extension/` (`/extension`), `office/` (`/office-addin` + tools), `bridge/` (postMessage clients).
- `tracker.ts` + `ConsentBanner.tsx` — self-hosted analytics; only anonymous page views without consent.

## Login screens
`pages/Login.tsx`: phone → code → (offer passkey | passkey required). Shows grace-login pills. Reused for
`/extension/login` and `/m/login` via `home` / `embedded` props. Do not add other login flows (see `gaer-auth`).

## Conventions
- Danish UI text. Short sentences.
- Pages: `PageHeader eyebrow="/path" title="…"`, cards on a muted background, tables in `.table-wrap`.
- Confirm destructive actions with `confirm()` and say what happens.
- Run `npm run build --prefix web` (typecheck + build) before committing.
