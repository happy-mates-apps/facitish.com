# GitHub Copilot instructions

Read `.gaer/agents/instructions.md` before making changes — it is the shared source for Claude and Copilot.
For the area you work in, also read the matching skill in `.gaer/agents/skills/*/SKILL.md`. For anything in
`server/` start with `gaer-backend`; for `web/` start with `gaer-vite` (and `gaer-profile` for login, profile and
MFA screens). `.github/instructions/*.instructions.md` point there automatically.

The prompt files in `.github/prompts/gaer-*.prompt.md` run the workflows in `.gaer/agents/workflows/`.

The short version:
- One container: FastAPI server (`server/`) + Vite/React frontend (`web/`), the container's own Postgres
  database, OVHcloud Object Storage.
- **The backend already exists.** Do not add another API server, database, ORM or auth library.
- Routes (full table in `.gaer/agents/instructions.md`): `/` app (anonymous → `/w/`) · `/w` public website with login
  card · `/login` · `/admin` standalone admin app (`web/admin.html`) · `/m` mobile PWA · `/extension` browser side
  panel · `/office-addin` Office router → `/extension/tools/*` · `/api` · `/health`.
- Login is e-mail + one-time code; passkeys, security keys and authenticator apps as second factor. /admin needs
  MFA after three grace logins, users can opt in ("Kræv passkey"). Guard endpoints with `current_user` /
  `require_admin` / `require_admin_stepup` from `app.sessions`. Never bypass it (`gaer-auth`).
- Postgres: psycopg 3, raw SQL, `async with db.connection()`. Locally `docker compose up -d`.
- Python 3.12+, pinned `server/requirements.txt`, venv in `.venv`, settings from env in `server/app/config.py`.
- Every data change writes `audit()` in the same transaction; logs are append-only (`gaer-audit`).
- New migrations are new SQL files in `server/app/migrations/`.
- Personal data must be in the GDPR export and removed on erasure.
- `pytest server` and `npm run build --prefix web` must pass. UI text is Danish.
