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
3. **Name the instance**: set `RP_NAME` in `.env`. After first login, set name, logo, SMS sender and GDPR e-mail in `/admin/settings`.
4. **Production (done by Happy Mates)** — only when the user asks for it:
   - Database in the shared cluster:
     `python deploy/provision_database.py --admin-url "<cluster admin url>" --name <name>` → prints the three URLs.
   - Object Storage bucket `gaer-<name>` and S3 credentials in the OVHcloud console.
   - OVHcloud SMS service and API credentials (`OVH_APPLICATION_KEY`, `OVH_APPLICATION_SECRET`, `OVH_CONSUMER_KEY`, `OVH_SMS_SERVICE`).
   - UpCloud server with Docker and a `deploy` user; copy `deploy/.env.example` to `~/gaer/.env` and
     `deploy/app.env.example` to `~/gaer/app.env` and fill them in.
     Set `BOOTSTRAP_ADMIN_PHONE` to the customer's admin number, so nobody else can become admin on the new instance.
   - GitHub environment `production`: secrets `HOST`, `SSH_KEY`, `SSH_KNOWN_HOSTS`. Variable `DOMAIN`. The image is streamed to the server over SSH.
   - Cloudflare Tunnel for the domain; its token is `TUNNEL_TOKEN` in `~/gaer/.env`.
5. Never commit `.env` files or credentials.
