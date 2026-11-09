# MCP-adgang — kataloget styrer værktøjerne, interne/eksterne brugere og adgangsanmodninger

Design: canvas "MCP-adgangsanmodninger" (flow, /konto, /godkend + mail, /admin/access, brugerskuffen).
Code: `server/app/mcp/toolmap.py`, `server/app/mcp/data_tools.py`, `server/app/access.py`,
`server/app/mcp/access_tools.py`, `server/app/routes/access.py`, `server/app/routes/mcp_tools.py`,
migration `0016_mcp_access.sql`. Tests: `server/tests/test_mcp_access.py`.

## The endpoint map (governed from /admin/data → MCP-værktøjer)

| Table | What |
| --- | --- |
| `mcp_tools` | every tool. **Code tool** (`kind = 'code'`): a handler in `server/app/mcp`, named in `catalog.json`; a row is made the first time the catalog has it, on the endpoints that have a handler, classified white. **Data tool** (`kind = 'data'`, `dataset_id`): reads one dataset from the catalog. |
| `mcp_tool_endpoints` | `(tool_id, endpoint)` — which endpoint (`app` = `/mcp`, `admin` = `/mcp/admin`) offers the tool. One tool, one or more endpoints. A Code tool only on endpoints that have its handler. |

`registry.invoke()` resolves every call through the map: a tool that is not on the endpoint, or is switched off, is
"Ukendt værktøj". `tools/list` and the hub list the map, not the catalog. `catalog.json` still describes the Code
tools' handlers (and the catalog test still checks handlers against it).

## Classification → who may call a tool

A Code tool has its own classification (set in /admin/data → MCP-værktøjer). A Data tool has none: it follows its
dataset's classification, so changing the dataset in the catalog changes who may use the tool.

| | Who |
| --- | --- |
| white | everyone who may use the endpoint |
| green | internal users |
| yellow | internal users with a grant the user approved |
| red | internal users with a grant the user **and** an approver approved |

A Data tool's fields are masked by their own classification: yellow fields open with any grant, red fields only with
a confidential grant. Masked fields cannot be filters. Core tools (`whoami`, `confirm_draft`, `cancel_draft`,
`list_drafts`, `access_list`, `access_request`) are always on and always white.

## Internal and external users

`users.audience`: `internal` (employee) or `external` (partner, customer). New users are external, admins internal,
and e-mails on a domain in `INTERNAL_EMAIL_DOMAINS` internal from the first login. Changed in the user drawer in
/admin/users (step-up) or with the `/mcp/admin` draft `user_set_audience`. Going external ends the user's
internal/confidential grants and open requests at once. External users only use white tools and may only ask for
their own data.

## Access requests

`access_request(target, reason)` on both endpoints — `target` is `email` or `phone` (the user's own, shown in
clear by `whoami`/`profile_get`), or a tool name from `access_list`.

1. The request is stored (`mcp_access_requests`), audited, and a job mails the user a link to `/godkend?t=…`.
2. The **user** approves or denies — in Konto → MCP-adgang (list) or from the mail (link). The link is single use,
   expires after `MCP_ACCESS_LINK_HOURS` (72) and only works for the logged-in recipient. The client never approves.
3. Confidential (red) only: a job mails every **approver** — an admin whose roles open `/admin/access` (Fuld adgang,
   Privatliv) — a link to `/admin/access?request=…&t=…`. The approver decides from the list in /admin/access, the
   link, or the `/mcp/admin` draft `access_request_decide`; a fresh second factor is required; never their own
   request. Duration 1, 7 or 30 days; a denial needs a note.
4. An approved row is the grant: only for the MCP session that asked, until `expires_at`, only while the user is
   internal (for non-own data). The user can revoke it in /konto, an approver in /admin/access.

Every step is in `audit_log` (`mcp_access.*`, `mcp_tool.*`). Requests are in the GDPR export and cascade on erasure;
closed ones are cleaned up by the retention policy `mcp_access_requests`.
