---
name: gaer-init
description: Create a new Gær project from the template and set up environment variables.
---

# /gaer-init

Sets up a fresh fork of gaer-base for a customer, or a fresh local checkout.

1. **Confirm** the instance name with the user (lowercase, e.g. `kunde`), the domain (e.g. `app.kunde.dk`) and the display name.
2. **Local environment**
   ```bash
   cp .env.example .env
   python -c "import secrets; print(secrets.token_hex(32))"   # put in SECRET_KEY
   python -m venv .venv && . .venv/bin/activate && pip install -r server/requirements-dev.txt
   npm ci --prefix web
   docker compose up -d
   (cd server && python -m app.migrate)
   ```
3. **Name the instance**: set `RP_NAME` in `.env`. After first login, set name, logo, SMS sender and GDPR e-mail in `/admin/settings`, and choose the front page in `/admin/web`.
4. **Production (done by Happy Mates)** — only when the user asks for it:
   - Object Storage bucket `gaer-<name>` and S3 credentials (UpCloud Managed Object Storage or OVHcloud).
   - Mail for login codes: verify the sending domain with the mail provider (e.g. Lettermint) and note the token.
     SMS (OVHcloud) only if the customer wants `SMS_LOGIN=1`.
   - Server with Docker and a `deploy` user (e.g. UpCloud). Copy `deploy/.env.example` to `~/gaer/.env` (DB name,
     passwords incl. `DB_MCP_RO_PASSWORD`, `TUNNEL_TOKEN`) and `deploy/app.env.example` to `~/gaer/app.env`
     (domain, `SECRET_KEY`, `TOTP_KEYS`, mail, S3) and fill them in. The stack's Postgres creates the database
     and roles on first start (`deploy/postgres-init.sh`).
     Set `BOOTSTRAP_ADMIN_EMAIL` to the customer's admin address, so nobody else can become admin on the new instance.
   - GitHub environment `production`: secrets `HOST`, `SSH_KEY`, `SSH_KNOWN_HOSTS`. Variable `DOMAIN`. The image is streamed to the server over SSH.
   - Cloudflare Tunnel for the domain; its token is `TUNNEL_TOKEN` in `~/gaer/.env`.
5. Never commit `.env` files or credentials.
