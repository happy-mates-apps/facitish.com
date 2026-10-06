---
name: gaer-whatsup
description: Short status — latest changes, open tasks and errors in the log.
---

# /gaer-whatsup

1. Code:
   ```bash
   git log --oneline -10
   git status --short
   gh pr list --limit 10
   gh issue list --limit 10
   ```
2. Production:
   ```bash
   gh run list --workflow=deploy.yml --limit 3
   curl -fsS "https://$(gh variable get DOMAIN)/health"
   ```
3. Local (if running): `curl -fsS localhost:8000/health`, `(cd server && python -m app.migrate --status)`.
4. Report a short table:

   | Område | Status | Note |
   | --- | --- | --- |
   | Kode | … | uncommitted changes, open PRs |
   | Seneste deploy | ✅ / ❌ | sha, time |
   | Produktion /health | ✅ / ❌ | version |
   | Migrationer | … | pending? |

   For errors in the app itself, point the user to `/admin/logs/auth` (failed logins) and the server log.
