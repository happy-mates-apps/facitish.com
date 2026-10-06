---
name: gaer-boot
description: Read the project in before working — architecture, rules and current status.
---

# /gaer-boot

Read the project before changing anything. Do not edit files in this workflow.

1. Read `CLAUDE.md` (or `.github/copilot-instructions.md`) and `README.md`.
2. Read the skills that apply to the task in `.gaer/agents/skills/*/SKILL.md`. Always read `gaer-auth` and `gaer-audit`.
3. Get oriented:
   ```bash
   git status && git log --oneline -10
   ls server/app server/app/routes server/app/migrations web/src
   (cd server && python -m app.migrate --status) 2>/dev/null || echo "database not reachable"
   ```
4. Summarize for the user in a few lines:
   - what Gær is (one container: Python server + Vite frontend, shared managed Postgres, Object Storage on OVHcloud)
   - which migrations exist and whether they are applied
   - uncommitted changes and the last commits
   - anything that looks broken
5. Ask what to work on.
