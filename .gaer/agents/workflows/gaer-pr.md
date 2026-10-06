---
name: gaer-pr
description: Create a pull request with a description and checklist.
---

# /gaer-pr

1. Make sure you are on a feature branch (`git switch -c <type>/<short-name>` if on `main`).
2. Run the checks and stop if they fail:
   ```bash
   pytest server
   npm run build --prefix web
   ```
3. Commit with a clear message (`feat:`, `fix:`, `chore:` …). Never commit `.env` files.
4. Push and open the PR:
   ```bash
   git push -u origin HEAD
   gh pr create --fill --body-file -   # write the body below
   ```
   Body:
   ```
   ## Hvad
   <what changed and why>

   ## Tjekliste
   - [ ] Tests (`pytest server`) og build (`npm run build --prefix web`) er grønne
   - [ ] Nye migrationer er nye filer; ingen ændrede migrationer
   - [ ] Ændringer i data skrives i audit-loggen
   - [ ] Login-reglerne (gaer-auth) er ikke omgået
   - [ ] Persondata er med i GDPR-eksport og -sletning
   - [ ] Ingen hemmeligheder i koden
   ```
5. Give the user the PR link. Merging to `main` deploys to production.
