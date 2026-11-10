"""Outbound mail: what the app sent through Lettermint, and whether it arrived.

Independent of the mail module (mailboxes in Stalwart). One row per message in outbound_mail, created when the app
sends (record_sent, from issue_code and the other senders) and kept current from two sources:

- the incoming webhook handler "lettermint" (app/mailbox/tasks.py → apply_event): Lettermint posts message.sent,
  message.delivered, message.hard_bounced, … — set up in /admin/webhooks → Indgående with the Lettermint signing
  secret (verify "gaer": the same t=…,v1=… scheme, header X-Lettermint-Signature);
- the job mail.lettermint_poll (every 15 minutes, /admin/jobs): GET /v1/messages with a Team API token
  (LETTERMINT_TEAM_TOKEN) for the last days, filtered on MAIL_FROM, so a missed webhook never leaves a mail
  stuck on "sent", and mails sent before the webhook existed get a status too.

Personal data: the recipient is an HMAC (security.phone_hash) plus the domain; the subject is stored with runs of
digits masked (a login code never ends up here). Exported with and erased with the user (app/gdpr.py).
"""

import logging
import re
from datetime import datetime, timedelta, timezone

import httpx
from psycopg.types.json import Jsonb

from app import config, db, jobs
from app.security import phone_hash

log = logging.getLogger("gaer.outbound_mail")

STATUSES = ("scheduled", "queued", "sent", "delivered", "opened", "deferred", "soft_bounced", "hard_bounced", "failed",
            "spam_complaint", "suppressed", "unknown")
# Later statuses win over earlier ones, so a late "sent" webhook cannot undo "delivered". Problems rank highest.
RANK = {s: i for i, s in enumerate(("unknown", "scheduled", "queued", "sent", "deferred", "delivered", "opened",
                                    "soft_bounced", "suppressed", "failed", "hard_bounced", "spam_complaint"))}
PROBLEMS = ("soft_bounced", "hard_bounced", "failed", "spam_complaint", "suppressed")
PURPOSES = ("login", "email_change", "gdpr", "access", "budget", "other")
POLL_DAYS = 7
POLL_PAGES = 20


def normalize_status(value: str | None) -> str:
    """Lettermint's message status or webhook event name → one of STATUSES."""
    n = (value or "").lower().removeprefix("message.")
    if n in STATUSES:
        return n
    if "complain" in n or "spam" in n:
        return "spam_complaint"
    if "hard" in n and "bounce" in n:
        return "hard_bounced"
    if "soft" in n and "bounce" in n:
        return "soft_bounced"
    if "bounce" in n or "reject" in n:
        return "hard_bounced"
    if "fail" in n or "error" in n:
        return "failed"
    if "suppress" in n:
        return "suppressed"
    if "defer" in n or "delay" in n or "retry" in n:
        return "deferred"
    if "open" in n:
        return "opened"
    if "deliver" in n:
        return "delivered"
    if "process" in n or "sent" in n or "accept" in n:
        return "sent"
    if "queue" in n or "pending" in n or "created" in n:
        return "queued"
    if "schedul" in n:
        return "scheduled"
    return "unknown"


def mask_subject(subject: str | None) -> str | None:
    if not subject:
        return None
    return re.sub(r"\d{3,}", "•••", subject)[:200]


def guess_purpose(subject: str | None) -> str:
    s = (subject or "").lower()
    if "engangskode" in s or "one-time code" in s:
        return "login"
    if "gdpr" in s or "dine data" in s or "indsigt" in s or "slet" in s:
        return "gdpr"
    if "adgang" in s or "access" in s:
        return "access"
    if "budget" in s or "forbrug" in s:
        return "budget"
    return "other"


def _domain(address: str | None) -> str | None:
    if address and "@" in address:
        return address.rsplit("@", 1)[1].lower()[:200]
    return None


def parse_when(value) -> datetime | None:
    if not value:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=timezone.utc)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


# ── Writing ─────────────────────────────────────────────────────────────────

async def record_sent(conn, *, message_id: str | None, recipient: str, purpose: str, user_id: int | None = None,
                      subject: str | None = None) -> None:
    """Called right after a provider accepted a mail. Without a message id (console, other providers) nothing is stored."""
    if not message_id:
        return
    await conn.execute("""
        insert into outbound_mail (provider_message_id, user_id, recipient_hash, recipient_domain, purpose, subject, status,
                                   status_source, status_changed_at)
        values (%s, %s, %s, %s, %s, %s, 'sent', 'app', now())
        on conflict (provider_message_id) do update
            set user_id = coalesce(outbound_mail.user_id, excluded.user_id), purpose = excluded.purpose,
                recipient_hash = coalesce(outbound_mail.recipient_hash, excluded.recipient_hash),
                recipient_domain = coalesce(outbound_mail.recipient_domain, excluded.recipient_domain),
                subject = coalesce(outbound_mail.subject, excluded.subject), updated_at = now()""",
        (message_id[:200], user_id, phone_hash(recipient), _domain(recipient),
         purpose if purpose in PURPOSES else "other", mask_subject(subject)))


async def apply_event(conn, *, message_id: str, status: str, source: str, at: datetime | None = None,
                      recipient: str | None = None, subject: str | None = None, created_at: datetime | None = None,
                      detail: dict | None = None) -> str:
    """A status seen by the webhook or the poll. Creates the row when the app did not record the send itself
    (older mail, another instance sharing the project). Returns 'created', 'updated' or 'kept'."""
    status = status if status in STATUSES else normalize_status(status)
    row = await db.fetch_one(conn, "select id, status from outbound_mail where provider_message_id = %s for update",
                             (message_id[:200],))
    if row is None:
        await conn.execute("""
            insert into outbound_mail (provider_message_id, recipient_hash, recipient_domain, purpose, subject, status,
                                       status_source, status_changed_at, detail, created_at)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, coalesce(%s, now()))
            on conflict (provider_message_id) do nothing""",
            (message_id[:200], phone_hash(recipient) if recipient else None, _domain(recipient), guess_purpose(subject),
             mask_subject(subject), status, source, at or datetime.now(timezone.utc), Jsonb(detail or {}), created_at))
        return "created"
    if RANK.get(status, 0) < RANK.get(row["status"], 0):
        # Fill in what we may be missing, but keep the later status.
        await conn.execute("""update outbound_mail set recipient_hash = coalesce(recipient_hash, %s),
                                     recipient_domain = coalesce(recipient_domain, %s), subject = coalesce(subject, %s),
                                     updated_at = now() where id = %s""",
                           (phone_hash(recipient) if recipient else None, _domain(recipient), mask_subject(subject), row["id"]))
        return "kept"
    await conn.execute("""update outbound_mail set status = %s, status_source = %s, status_changed_at = %s,
                                 recipient_hash = coalesce(recipient_hash, %s), recipient_domain = coalesce(recipient_domain, %s),
                                 subject = coalesce(subject, %s), detail = detail || %s, updated_at = now()
                          where id = %s""",
                       (status, source, at or datetime.now(timezone.utc), phone_hash(recipient) if recipient else None,
                        _domain(recipient), mask_subject(subject), Jsonb(detail or {}), row["id"]))
    return "updated" if status != row["status"] else "kept"


# ── Lettermint Team API (poll) ──────────────────────────────────────────────

def poll_enabled() -> bool:
    return bool(config.settings.lettermint_team_token)


def _recipient(message: dict) -> str | None:
    to = message.get("to") or []
    if isinstance(to, list) and to:
        first = to[0]
        return first.get("email") if isinstance(first, dict) else str(first)
    return None


async def poll(*, days: int = POLL_DAYS, client: httpx.AsyncClient | None = None) -> dict:
    """Reads the team's outbound messages from the last `days` days (from MAIL_FROM when set) and applies their status."""
    s = config.settings
    if not poll_enabled():
        return {"skipped": "LETTERMINT_TEAM_TOKEN er ikke sat"}
    since = (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()
    params: dict[str, str] = {"filter[type]": "outbound", "filter[from_date]": since, "page[size]": "100",
                              "sort": "-created_at"}
    if s.mail_from:
        params["filter[from_email]"] = s.mail_from
    headers = {"Authorization": f"Bearer {s.lettermint_team_token}", "Accept": "application/json"}
    own = client is None
    client = client or httpx.AsyncClient(timeout=20)
    seen = created = updated = pages = 0
    cursor: str | None = None
    try:
        while pages < POLL_PAGES:
            q = {**params, **({"page[cursor]": cursor} if cursor else {})}
            response = await client.get(f"{s.lettermint_api_url.rstrip('/')}/messages", params=q, headers=headers)
            if response.status_code == 429:
                raise jobs.Retry("Lettermint: for mange kald (429)")
            if response.status_code >= 300:
                raise RuntimeError(f"Lettermint svarede {response.status_code}: {response.text[:200]}")
            body = response.json()
            items = body.get("data") or []
            pages += 1
            async with db.connection() as conn:
                for m in items:
                    if not m.get("id"):
                        continue
                    seen += 1
                    result = await apply_event(
                        conn, message_id=str(m["id"]), status=normalize_status(m.get("status")), source="poll",
                        at=parse_when(m.get("status_changed_at")), recipient=_recipient(m), subject=m.get("subject"),
                        created_at=parse_when(m.get("created_at")),
                        detail={"tag": m.get("tag")} if m.get("tag") else None)
                    created += result == "created"
                    updated += result == "updated"
            cursor = body.get("next_cursor") if isinstance(body, dict) else None
            if not cursor or not items:
                break
    finally:
        if own:
            await client.aclose()
    return {"seen": seen, "created": created, "updated": updated, "pages": pages, "since": since}


@jobs.handler("mail.lettermint_poll")
async def poll_job(payload: dict, job: dict) -> dict:
    return await poll(days=int(payload.get("days") or POLL_DAYS))


# ── Reading (admin) ─────────────────────────────────────────────────────────

async def summary(conn, *, days: int = 14) -> dict:
    counts = await db.fetch_one(conn, """
        select count(*) as total,
               count(*) filter (where status in ('delivered', 'opened')) as delivered,
               count(*) filter (where status in ('sent', 'queued', 'scheduled', 'deferred')) as pending,
               count(*) filter (where status in ('soft_bounced', 'hard_bounced', 'failed', 'spam_complaint', 'suppressed')) as problems,
               count(*) filter (where status = 'unknown') as unknown
        from outbound_mail where created_at > now() - make_interval(days => %s)""", (days,))
    per_day = await db.fetch_all(conn, """
        select created_at::date as day, count(*) as sent,
               count(*) filter (where status in ('delivered', 'opened')) as delivered,
               count(*) filter (where status in ('soft_bounced', 'hard_bounced', 'failed', 'spam_complaint', 'suppressed')) as problems
        from outbound_mail where created_at > now() - make_interval(days => %s) group by 1 order by 1""", (days,))
    by_purpose = await db.fetch_all(conn, """
        select purpose, count(*) as n from outbound_mail where created_at > now() - make_interval(days => %s)
        group by 1 order by 2 desc""", (days,))
    last_poll = await db.fetch_one(conn, """
        select status, finished_at, result, last_error as error from jobs where kind = 'mail.lettermint_poll'
        and status in ('succeeded', 'failed', 'dead') and not coalesce(result ? 'skipped', false)
        order by finished_at desc nulls last limit 1""")
    schedule = await db.fetch_one(conn, "select enabled, next_run_at, last_run_at from job_schedules where name = 'mail.lettermint_poll'")
    last_webhook = await db.fetch_one(conn, """select max(status_changed_at) as at from outbound_mail
                                              where status_source = 'webhook'""")
    return {"days": days, "counts": counts, "per_day": per_day, "by_purpose": by_purpose,
            "poll": {"enabled": poll_enabled(), "last": last_poll, "schedule": schedule},
            "webhook": {"last_event_at": last_webhook["at"] if last_webhook else None}}


async def recent(conn, *, status: str | None = None, purpose: str | None = None, limit: int = 100, offset: int = 0) -> dict:
    where, params = ["true"], []
    if status == "problems":
        where.append("status in ('soft_bounced', 'hard_bounced', 'failed', 'spam_complaint', 'suppressed')")
    elif status == "pending":
        where.append("status in ('sent', 'queued', 'scheduled', 'deferred')")
    elif status and status in STATUSES:
        where.append("status = %s")
        params.append(status)
    if purpose and purpose in PURPOSES:
        where.append("purpose = %s")
        params.append(purpose)
    sql_where = " and ".join(where)
    total = await db.fetch_one(conn, f"select count(*) as n from outbound_mail where {sql_where}", params)
    items = await db.fetch_all(conn, f"""
        select o.id, o.provider_message_id, o.user_id, u.display_name as user_name, o.recipient_domain, o.purpose, o.subject,
               o.status, o.status_source, o.status_changed_at, o.created_at
        from outbound_mail o left join users u on u.id = o.user_id
        where {sql_where} order by o.created_at desc limit %s offset %s""", [*params, limit, offset])
    return {"items": items, "total": total["n"]}
