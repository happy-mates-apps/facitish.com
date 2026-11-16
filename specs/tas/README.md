# TAS — Terminal Assistance Simulator

A virtual Ingenico Move/3500 (and Lane/3600 preview) with **TAS**, a chat assistant that answers customer service
agents from published terminal knowledge and walks them through the menus on the simulated terminal. It started as
a claude.ai artifact (*TAS - Terminal Assistance Simulator*, by the Nordic & Baltic Floorcoach Team) and runs in
Gær unchanged apart from the patches listed in `port.py`.

## Where it lives

| Surface | Who | What |
| --- | --- | --- |
| `/w/` | everyone | The simulator, accessories and the TAS chat, from the **published** release. The front page when the setting `web_front` is `tas` (this fork's default, `WEB_FRONT=tas`; changeable in `/admin/web`). Its header has *Log in*, or *Admin Portal* / *Backoffice* when signed in. |
| `/backoffice` | logged in | The same simulator inside the app's shell (an iframe of `/w/tas/backoffice`). **Editors** land in the **Admin Portal**: TAS settings, terminal menu, control panel, terminal models, languages, accessories, knowledge and troubleshooting; preview the draft, publish, history and restore. Others see the simulator. |

**Editors** are admins with the admin role *Fuld adgang* or *Indhold* and a second factor within `ADMIN_MFA_HOURS` —
the same rule as `/admin`. This replaces the artifact's shared Admin Portal password.

## How it runs

- `server/app/web_static/tas/` — the artifact's `index.html` and scripts (`app.js`, `engine.js`, `assistant.js`,
  `models.js`, `soon.js`, `lane3600.js`, `mark.js`) as `port.py` writes them, plus **`gaer.js`**, ours: it answers
  the artifact's `window.claude.use('db' | 'user' | 'sample' | 'assets')` with `/api/tas`.
- `/w/tas/env.js` tells the page who is looking (signed in, editor, AI on, which collections they may read).
- `server/app/tas.py` + `routes/tas.py` — documents in named collections (`tas_docs`) and images (`tas_assets`):

  | Collections | Read | Write |
  | --- | --- | --- |
  | `models`, `published`, `pubpart`, `pubacc`, `tas`, `i18n` (the live release and settings) | everyone | editors |
  | `nodes`, `articles`, `troubles`, `kb`, `accessories`, `releases`, `accrel`, `notes` (drafts and history) | editors | editors |

  Every write is audited (`tas.doc.set` / `tas.doc.update` / `tas.doc.delete`, `tas.asset.upload`) with the changed
  fields; large values are summarised. Changes by others reach open pages by polling `/api/tas/rev` every 15 s.
- **AI**: the simulator's `sample.json(prompt)` goes to `POST /api/tas/ai` (Gær's AI endpoint, counted as surface
  `tas` in AI consumption, under the user's limit and budget). Only for signed-in users; without AI, TAS answers
  from its local retrieval as it did for viewers without Claude on claude.ai.
- **Seed**: an empty instance is filled at start-up from `server/app/tas_seed/` — the artifact's database (menus,
  238 knowledge articles, 50 troubleshooting entries, translations, accessories, releases v1–v14) and its 14
  accessory images, exported on 11 Nov 2026.

## Updating from a new version of the artifact

1. Download the artifact's published files into a folder.
2. `python specs/tas/port.py <folder>` — fails loudly if a patch no longer matches.
3. Check `/w/` and `/backoffice`, run `pytest server`, commit.

Data is not re-seeded once an instance has documents; editors keep working in the Admin Portal.
