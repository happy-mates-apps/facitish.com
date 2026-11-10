"""Sends e-mail: the one-time login codes and AI budget warnings (app/consumption.py). MAIL_PROVIDER picks the service; all are plain HTTPS APIs.

    ahasend   AhaSend (default)               AHASEND_API_KEY, AHASEND_ACCOUNT_ID
    scaleway  Scaleway Transactional Email    SCALEWAY_SECRET_KEY, SCALEWAY_PROJECT_ID, SCALEWAY_REGION
    mailjet   Mailjet                         MAILJET_API_KEY, MAILJET_API_SECRET
    brevo     Brevo                           BREVO_API_KEY
    lettermint Lettermint                     LETTERMINT_API_TOKEN (a Project API token)
    console   prints the mail (development only)

All need MAIL_FROM, an address on a domain verified with the provider.
"""

import html
import logging

import httpx

from app import config

log = logging.getLogger("gaer.mail")


class MailError(RuntimeError):
    pass


REQUIRED = {
    "ahasend": ("ahasend_api_key", "ahasend_account_id"),
    "scaleway": ("scaleway_secret_key", "scaleway_project_id"),
    "mailjet": ("mailjet_api_key", "mailjet_api_secret"),
    "brevo": ("brevo_api_key",),
    "lettermint": ("lettermint_api_token",),
    "console": (),
}


def missing_config() -> list[str]:
    """Environment variables the chosen provider still needs. Empty when mail can be sent."""
    s = config.settings
    if s.demo_mode:
        return []
    if s.mail_provider not in REQUIRED:
        return ["MAIL_PROVIDER"]
    missing = [name.upper() for name in REQUIRED[s.mail_provider] if not getattr(s, name)]
    if s.mail_provider != "console" and not s.mail_from:
        missing.append("MAIL_FROM")
    return missing


def otp_mail(code: str, app_name: str, minutes: int) -> tuple[str, str, str]:
    """Subject, text and HTML for a one-time code."""
    subject = f"{code} er din engangskode til {app_name}"
    text = (f"Din engangskode til {app_name} er {code}.\n\n"
            f"Den udløber om {minutes} minutter og kan kun bruges én gang. Del den ikke med andre.\n\n"
            "Har du ikke bedt om koden, kan du se bort fra denne mail.")
    name = html.escape(app_name)
    body = (f'<p>Din engangskode til {name} er</p>'
            f'<p style="font:700 28px/1.2 monospace;letter-spacing:4px">{code}</p>'
            f"<p>Den udløber om {minutes} minutter og kan kun bruges én gang. Del den ikke med andre.</p>"
            '<p style="color:#64748b;font-size:13px">Har du ikke bedt om koden, kan du se bort fra denne mail.</p>')
    return subject, text, body


def _n(value: int) -> str:
    return f"{value:,}".replace(",", ".")


def ai_budget_mail(kind: str, pct: int, used: int, limit: int, hard: bool, app_name: str, link: str,
                   resets_on: str) -> tuple[str, str, str]:
    """Subject, text and HTML for an AI budget warning. kind: warning (pct passed), cap (monthly cap) or total
    (the budget's total for the period). Only counts are mentioned, never what was asked."""
    if kind == "warning":
        subject = f"Du har brugt {pct} % af dit AI-budget i {app_name}"
        lead = f"Du har nu brugt {_n(used)} af {_n(limit)} tokens ({pct} %) af din AI-kvote i denne måned."
        then = (f"Når loftet er nået, holder AI pause til {resets_on}." if hard
                else "AI virker videre, også hvis du kommer over loftet.")
    elif kind == "cap":
        subject = f"Du har nået dit AI-loft for måneden i {app_name}"
        lead = f"Du har brugt {_n(used)} tokens, og månedens loft er {_n(limit)}."
        then = (f"AI holder pause til {resets_on}." if hard
                else "AI virker videre, men forbruget over loftet er markeret for din administrator.")
    else:
        subject = f"Du har brugt hele dit AI-budget i {app_name}"
        lead = f"Du har brugt {_n(used)} af {_n(limit)} tokens, som var budgettet for hele perioden."
        then = ("AI holder pause, til en administrator giver dig et nyt budget." if hard
                else "AI virker videre, men forbruget er markeret for din administrator.")
    more = "Kontakt en administrator, hvis du har brug for mere."
    text = f"{lead}\n\n{then} {more}\n\nSe dit forbrug: {link}"
    e = html.escape
    body = (f"<p>{e(lead)}</p><p>{e(then)} {e(more)}</p>"
            f'<p><a href="{e(link)}">Se dit forbrug</a></p>'
            f'<p style="color:#64748b;font-size:13px">Vi gemmer kun antal tokens, aldrig hvad du skrev, eller hvad AI svarede.</p>')
    return subject, text, body


async def send_mail(to: str, subject: str, text: str, html_body: str, sender_name: str) -> str | None:
    """Sends one mail. Returns the provider's message id when it gives one (Lettermint), so the delivery status can
    be followed in outbound_mail; None otherwise."""
    s = config.settings
    if s.demo_mode:
        log.warning("DEMO_MODE mail to %s: %s", to, subject)
        return None
    if s.mail_provider == "console":
        if s.is_production:
            raise MailError("MAIL_PROVIDER=console is not allowed in production")
        log.warning("mail to %s: %s", to, subject)
        print(f"[mail] to={to} subject={subject}\n{text}", flush=True)
        return None
    missing = missing_config()
    if missing:
        raise MailError(f"mail is not configured ({', '.join(missing)})")
    send = SENDERS[s.mail_provider]
    async with httpx.AsyncClient(timeout=10) as client:
        return await send(client, s, {"email": s.mail_from, "name": s.mail_from_name or sender_name}, to, subject, text,
                          html_body)


def _check(response: httpx.Response, provider: str) -> None:
    if response.status_code >= 300:
        raise MailError(f"{provider} failed: {response.status_code} {response.text[:200]}")


async def _ahasend(client, s, sender, to, subject, text, html_body) -> None:
    """https://ahasend.com/docs/api-reference/messages/create-message"""
    response = await client.post(
        f"https://api.ahasend.com/v2/accounts/{s.ahasend_account_id}/messages",
        headers={"Authorization": f"Bearer {s.ahasend_api_key}"},
        json={"from": sender, "recipients": [{"email": to}], "subject": subject,
              "text_content": text, "html_content": html_body})
    _check(response, "AhaSend")
    for message in response.json().get("data", []):
        if message.get("status") == "error":
            raise MailError(f"AhaSend rejected the recipient: {message.get('error')}")


async def _scaleway(client, s, sender, to, subject, text, html_body) -> None:
    """https://www.scaleway.com/en/developers/api/transactional-email/"""
    response = await client.post(
        f"https://api.scaleway.com/transactional-email/v1alpha1/regions/{s.scaleway_region}/emails",
        headers={"X-Auth-Token": s.scaleway_secret_key},
        json={"from": sender, "to": [{"email": to}], "subject": subject, "text": text, "html": html_body,
              "project_id": s.scaleway_project_id})
    _check(response, "Scaleway TEM")


async def _mailjet(client, s, sender, to, subject, text, html_body) -> None:
    """https://dev.mailjet.com/email/guides/send-api-v31/"""
    response = await client.post(
        "https://api.mailjet.com/v3.1/send", auth=(s.mailjet_api_key, s.mailjet_api_secret),
        json={"Messages": [{"From": {"Email": sender["email"], "Name": sender["name"]}, "To": [{"Email": to}],
                            "Subject": subject, "TextPart": text, "HTMLPart": html_body}]})
    _check(response, "Mailjet")
    for message in response.json().get("Messages", []):
        if message.get("Status") != "success":
            raise MailError(f"Mailjet rejected the message: {message.get('Errors')}")


async def _brevo(client, s, sender, to, subject, text, html_body) -> None:
    """https://developers.brevo.com/reference/sendtransacemail"""
    response = await client.post(
        "https://api.brevo.com/v3/smtp/email", headers={"api-key": s.brevo_api_key},
        json={"sender": sender, "to": [{"email": to}], "subject": subject, "textContent": text,
              "htmlContent": html_body})
    _check(response, "Brevo")


async def _lettermint(client, s, sender, to, subject, text, html_body) -> str | None:
    """https://lettermint.co/docs/quickstart — answers {"message_id": …}, followed in outbound_mail."""
    name = sender["name"].replace('"', "")
    response = await client.post(
        f"{s.lettermint_api_url.rstrip('/')}/send", headers={"x-lettermint-token": s.lettermint_api_token},
        json={"from": f'"{name}" <{sender["email"]}>', "to": [to], "subject": subject, "text": text,
              "html": html_body})
    _check(response, "Lettermint")
    try:
        message_id = response.json().get("message_id")
    except ValueError:
        return None
    return str(message_id) if message_id else None


SENDERS = {"ahasend": _ahasend, "scaleway": _scaleway, "mailjet": _mailjet, "brevo": _brevo,
           "lettermint": _lettermint}
