---
name: gaer-mix
description: Mix a recipe into the project — code, migrations and frontend — step by step with consent gates.
---

# /gaer-mix

A recipe is a description of a feature (a Markdown file or a text the user gives) that should become
code in this project: a migration, Python routes, frontend pages and tests. Equivalent to `/surdej-blend`.

1. **Read the recipe** the user points to. Then read the skills it touches (`gaer-python-api`, `gaer-vite`,
   `gaer-audit`, and `gaer-storage` / `gaer-integrations` if relevant).
2. **Analyse**: list the tables, endpoints, pages and admin needs; what personal data it adds (GDPR export
   and erasure); what must be audited; risks.
3. **Plan**: write `plans/mix-<topic>.md` as a checklist of small steps, e.g.
   - [ ] migration `NNNN_<topic>.sql`
   - [ ] `server/app/routes/<topic>.py` + register in `main.py`
   - [ ] tests in `server/tests/test_<topic>.py`
   - [ ] pages in `web/src/...` + route in `App.tsx`
   - [ ] GDPR export/erasure updated
   - [ ] docs in README
4. **Consent gate**: show the analysis and plan. Stop and ask before the first step.
5. **Build one step at a time.** Tick it off in the plan, run `pytest server` and `npm run build --prefix web`,
   and ask before the next major step.
6. **Finish**: summarize what was added and update `README.md`.
