# Design: Facit · 246 — forside

Kilde: Design-lærredet „Facit · 246“ — https://claude.ai/artifact/VVwsKiPjqvYiGDxMPCPy23
(eksporteret 2026-11-05). Bygget med Happy Mates Design System.

## Indhold
En scroll-fortælling i fire sektioner om tandstikker-scenen i *Rain Man* (1988) og pointen
„facit først, forklaringen — måske“:

| Sektion | Id | Hvad |
| --- | --- | --- |
| Tallet | `#top` | Stort „246“; tryk afslører linje for linje. Sprogvælger DA · EN · DE · SV · NO. |
| Gulvet | `#gulvet` | 246 spredte tandstikkere; „Tæl dem“ viser tre klynger á 82. |
| Æsken | `#aesken` | 250 på æsken − 4 tilbage = 246; „Vis mellemregningen“. |
| Facit | `#facit` | Pointen om autistiske hjerner + Happy Mates-fodnote og link til happymates.ai. |

En flydende knap („Videre“ / „Forfra“) springer til næste sektion. Animationer respekterer
`prefers-reduced-motion`.

## Filer
- `design/Main.dc.html` — artboardet (hele kilden, alle tekster på fem sprog i `FACIT_TEXT`).
- `design/canvas.json` — lærredets indeks (1280 px bred side, `expand: fill`, interaktiv).
- `design/support.js` — DC-runtime, så filen kan åbnes direkte i en browser.

## Status
Designreference, ikke produktionskode. Skal den være sidens forside, genskabes den på `/w/`
(`server/app/routes/web.py`, `web_static/`) — husk login-kortet, som forsiden altid slutter med.
