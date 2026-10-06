---
name: gaer-release
description: Merge to main so the deploy workflow builds and rolls out, and follow the run.
---

# /gaer-release

Push to `main` = production. `.github/workflows/deploy.yml` tests, builds one image tagged with the commit
sha, pushes it to OVHcloud Managed Private Registry, migrates the container's own database and rolls out.
If the new version does not answer `/health` within 60 seconds, the running version stays.

1. Confirm with the user which PR to release.
2. Check it is green: `gh pr checks <number>`.
3. If the PR has migrations, say so and confirm. Migrations run before the new version starts, so they must
   work with the old version too (add columns, do not drop or rename in the same release).
4. Merge: `gh pr merge <number> --squash --delete-branch`.
5. Follow the run:
   ```bash
   gh run watch $(gh run list --workflow=deploy.yml --limit 1 --json databaseId -q '.[0].databaseId')
   ```
6. Verify: `curl -fsS https://$DOMAIN/health` shows the new short sha as `version`.
7. If something is wrong after release: `/gaer-recover`.
