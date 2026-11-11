"""Jobs for Beskeder: the fan-out of a broadcast, and one SMS or e-mail per delivery.

messages.sms checks again at send time (the user may have withdrawn their yes), then the duplicate window and the
hourly cap (member-sms: a loop in the code must not burn the budget). A provider error raises, so the job is retried
with the queue's backoff; on the last attempt the delivery is marked failed.
"""

import html
import logging

from app import config, db, jobs, mail, outbound_mail, settings_store, sms
from app.messages import service, text

log = logging.getLogger("gaer.messages")


@jobs.handler("messages.deliver")
async def deliver_job(payload: dict, job: dict) -> dict:
    return await service.deliver(int(payload["broadcast_id"]))


async def _delivery(conn, delivery_id: int) -> dict | None:
    return await db.fetch_one(conn, """
        select d.*, b.title, b.body, b.urgent, u.phone, u.email, u.blocked_at,
               coalesce(p.sms, false) as sms_ok, coalesce(p.mail, true) as mail_ok,
               r.body as reply_body
        from message_deliveries d
        join message_broadcasts b on b.id = d.broadcast_id
        join users u on u.id = d.user_id
        left join notification_prefs p on p.user_id = d.user_id
        left join conversation_messages r on r.id = d.reply_id
        where d.id = %s for update of d""", (delivery_id,))


async def _set(conn, delivery_id: int, status: str, error: str | None = None, **extra) -> None:
    sets = ", ".join(f"{k} = %({k})s" for k in extra)
    await conn.execute(f"""update message_deliveries set status = %(status)s, error = %(error)s
                           {', ' + sets if sets else ''},
                           sent_at = case when %(status)s = 'sent' then now() else sent_at end
                           where id = %(id)s""", {"status": status, "error": error, "id": delivery_id, **extra})


def _compose(d: dict, app_name: str) -> tuple[str, str]:
    """Title and text of what this delivery says: the broadcast, or an admin's answer to the user's reply."""
    link = text.inbox_link(config.settings.origin, d["broadcast_id"])
    if d["reason"] == "reply":
        return f"Svar på »{d['title']}«", text.reply_sms(app_name, d["title"], d["reply_body"] or "", link)
    return d["title"], text.broadcast_sms(app_name, d["title"], d["body"], link)


@jobs.handler("messages.sms")
async def sms_job(payload: dict, job: dict) -> dict:
    delivery_id = int(payload["delivery_id"])
    async with db.connection() as conn:
        d = await _delivery(conn, delivery_id)
        if d is None:
            return {"skipped": "not found"}
        if d["status"] not in ("queued", "held"):
            return {"skipped": d["status"]}
        s = await service.get_settings(conn)
        if not (s["sms_enabled"] and d["sms_ok"] and d["phone"]) or d["blocked_at"] is not None:
            await _set(conn, delivery_id, "skipped", "SMS er slået fra, eller brugeren har ikke sagt ja")
            return {"skipped": "no consent"}
        values = await settings_store.get_all(conn)
        _, body = _compose(d, values["app_name"])
        segs, enc = text.segments(body)
        sms_id = d["sms_id"]
        if sms_id is None:
            dup = await db.fetch_one(conn, """
                select 1 from sms_messages where to_phone = %s and body = %s and status in ('queued', 'sent', 'delivered')
                and created_at > now() - make_interval(secs => %s) limit 1""",
                (d["phone"], body, int(s["duplicate_seconds"])))
            sent_last_hour = (await db.fetch_one(conn, """
                select count(*) as n from sms_messages where status in ('queued', 'sent', 'delivered')
                and created_at > now() - interval '1 hour'""", ()))["n"]
            status = "duplicate" if dup else "throttled" if sent_last_hour >= int(s["sms_max_per_hour"]) else "queued"
            row = await db.fetch_one(conn, """
                insert into sms_messages (user_id, to_phone, body, purpose, segments, encoding, provider, status)
                values (%s, %s, %s, %s, %s, %s, %s, %s) returning id""",
                (d["user_id"], d["phone"], body, d["reason"], segs, enc, config.settings.sms_provider, status))
            sms_id = row["id"]
            if status != "queued":
                await _set(conn, delivery_id, status,
                           "Samme tekst til samme nummer for nylig" if status == "duplicate" else "Over loftet for SMS pr. time",
                           sms_id=sms_id)
                return {status: True}
            await _set(conn, delivery_id, "queued", sms_id=sms_id,
                       cost_minor=segs * int(s["sms_price_minor"]))
        sender = values["sms_sender"]
        phone = d["phone"]
    try:
        await sms.send_sms(phone, body, sender)
    except Exception as e:  # noqa: BLE001 — recorded, then retried by the queue
        last = job["attempts"] >= job["max_attempts"]
        async with db.connection() as conn:
            await conn.execute("update sms_messages set attempts = attempts + 1, error = %s, status = %s where id = %s",
                               (str(e)[:500], "failed" if last else "queued", sms_id))
            if last:
                await _set(conn, delivery_id, "failed", str(e)[:500])
        if last:
            return {"failed": str(e)[:200]}
        raise
    async with db.connection() as conn:
        await conn.execute("""update sms_messages set status = 'sent', attempts = attempts + 1, error = null,
                              sent_at = now() where id = %s""", (sms_id,))
        await _set(conn, delivery_id, "sent")
    from app import events
    await events.emit("messages.sms", ref=str(d["broadcast_id"]), value=segs)
    return {"sent": True, "segments": segs}


def _mail_body(title: str, body: str, link: str, reply: bool, app_name: str) -> tuple[str, str]:
    action = "Svar i appen" if reply else "Læs og svar i appen"
    plain = f"{body}\n\n{action}: {link}"
    e = html.escape
    paragraphs = "".join(f"<p>{e(p)}</p>" for p in body.split("\n\n"))
    rich = (f"<h2 style=\"font-size:18px\">{e(title)}</h2>{paragraphs.replace(chr(10), '<br>')}"
            f'<p><a href="{e(link)}">{e(action)}</a></p>'
            f'<p style="color:#64748b;font-size:13px">Sendt fra administrationen i {e(app_name)}. '
            f"Du kan ændre, hvordan du får beskeder, på siden Beskeder.</p>")
    return plain, rich


@jobs.handler("messages.mail")
async def mail_job(payload: dict, job: dict) -> dict:
    delivery_id = int(payload["delivery_id"])
    async with db.connection() as conn:
        d = await _delivery(conn, delivery_id)
        if d is None:
            return {"skipped": "not found"}
        if d["status"] not in ("queued", "held"):
            return {"skipped": d["status"]}
        s = await service.get_settings(conn)
        if not (s["mail_enabled"] and d["mail_ok"] and d["email"]) or d["blocked_at"] is not None:
            await _set(conn, delivery_id, "skipped", "E-mail er slået fra for brugeren")
            return {"skipped": "mail off"}
        app_name = await settings_store.get(conn, "app_name")
    reply = d["reason"] == "reply"
    subject = f"Svar på »{d['title']}«" if reply else d["title"]
    plain, rich = _mail_body(subject, d["reply_body"] if reply else d["body"],
                             text.inbox_link(config.settings.origin, d["broadcast_id"]), reply, app_name)
    try:
        message_id = await mail.send_mail(d["email"], subject, plain, rich, app_name)
    except Exception as e:  # noqa: BLE001
        if job["attempts"] >= job["max_attempts"]:
            async with db.connection() as conn:
                await _set(conn, delivery_id, "failed", str(e)[:500])
            return {"failed": str(e)[:200]}
        raise
    async with db.connection() as conn:
        await _set(conn, delivery_id, "sent")
        await outbound_mail.record_sent(conn, message_id=message_id, recipient=d["email"], user_id=d["user_id"],
                                        purpose="message", subject=subject)
    return {"sent": True}
