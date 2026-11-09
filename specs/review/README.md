# Review-panelet

Et skjult arbejdspanel oven på appen på `/`. Teamet kan se appen, som hver ring ser den, pege på det, der skal
rettes, og gennemføre testsessioner som en bestemt kunde. Kræver login; alt gemmes på serveren pr. bruger.

## Åbn og luk
- ⌃⌥⌘W på Mac, Ctrl+Alt+Shift+W andre steder. Valget huskes i browseren (pr. bruger).
- `?review=1` åbner, `?review=0` lukker (fx på iPad). Parameteren fjernes fra adressen bagefter.
- Ikke logget ind: man sendes til `/login` og tilbage med panelet åbent.
- Koden (`web/src/review/ReviewPanel.tsx` og det, den bruger) hentes først, når panelet åbnes.
- Findes ikke i `/admin`, `/m`, `/extension` og `/office-addin`.

## Ring
Gærs ringe fra `/admin/features`: 1 Internt, 2 Beta, 3 Preview, 4 Stabilt. En feature vises, når dens ring er mindst
det niveau, man ser appen som. Panelet kan:
- vælge niveau at se appen som (kun i denne browser, kun mens panelet er åbent),
- vise ring-markører: hver `<FeatureGate>` får en stiplet ramme og et mærke; klik på mærket for at ændre den
  features ring lokalt,
- tælle features på siden og vise et feature-overblik med søgning, ringfilter og antal noter.

Ringe styrer, hvad appen viser. De styrer ikke adgang; det gør serveren.

## Feedback
Tekst, indtryk (Godt / Så som så / Dårligt), **Peg på element** (selector + feature), **Markér område**,
**Billede** (browserens skærmdeling, beskåret til elementet/området når fanen deles) og **Optag og diktér**
(lyd + tale til tekst på dansk, hvor browseren kan). Gemmes i `review_feedback`; billeder og lyd er filer af
typen `review` i Object Storage, koblet via `review_attachments`.

## Session
Vælg en arketype og en drejebog (eller fri gennemgang) fra `web/src/review/scripts.ts`. Sidebesøg samles,
opgaver markeres som gennemført, gået i stå eller sprunget over, og noter knyttes til den valgte opgave.
Én session ad gangen. Afsluttede sessioner kan zippes eller slettes.

## Zip
`GET /api/review/sessions/{id}/zip` og `GET /api/review/export.zip` (»Zip alt«):
`README.md` (læsbart resumé), `session.json`, `feedback.json`, `screenshots/`, `audio/`.

## Backend
`server/app/routes/review.py`, migration `0012_review.sql`, tests i `server/tests/test_review.py`.
Alle ændringer auditeres; data er med i GDPR-eksporten og slettes ved sletning af kontoen.

## Til en fork
Skriv `scripts.ts` til jeres egne kunder, og pak nye sektioner ind i `<FeatureGate feature="…">` med en nøgle
fra `server/app/features_catalog.py`, så de får en ring og kan markeres.
