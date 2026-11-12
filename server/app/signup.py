"""Who may create an account by logging in (setting `signup`, edited in /admin/settings → Tilmelding).

  open     everybody who logs in with a new e-mail (or, with SMS login, phone number) gets a user account
  domains  only e-mail addresses on the listed domains (and their subdomains); everybody else is created by an admin
  closed   only users an admin created in /admin/users

Existing users can always log in. On a new instance the first admin can always get in (BOOTSTRAP_ADMIN_EMAIL /
_PHONE, or the very first user when none is set), whatever the setting says.
/api/auth/otp/start answers the same for every contact, so the login page never reveals who has an account; it just
sends no code to a contact that may not sign up.
"""

import re

from fastapi import HTTPException

from app import settings_store

MODES = ("open", "domains", "closed")
DEFAULT = {"mode": "open", "domains": [], "contact": ""}
_DOMAIN = re.compile(r"^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
MAX_DOMAINS = 50


def clean(mode: str, domains: list[str], contact: str) -> dict:
    """Validated setting. Raises 422 with a Danish message."""
    if mode not in MODES:
        raise HTTPException(422, "Ukendt tilmelding")
    out: list[str] = []
    for raw in domains:
        d = raw.strip().lower().lstrip("@").rstrip(".")
        if not d:
            continue
        if not _DOMAIN.match(d):
            raise HTTPException(422, f"Ugyldigt domæne: {raw.strip()[:80]}")
        if d not in out:
            out.append(d)
    if len(out) > MAX_DOMAINS:
        raise HTTPException(422, f"Højst {MAX_DOMAINS} domæner")
    if mode == "domains" and not out:
        raise HTTPException(422, "Skriv mindst ét domæne")
    return {"mode": mode, "domains": out, "contact": contact.strip()[:200]}


async def get(conn) -> dict:
    value = await settings_store.get(conn, "signup")
    return {**DEFAULT, **(value or {})}


def allows(setting: dict, channel: str, contact: str) -> bool:
    """May this contact create an account by logging in?"""
    mode = setting.get("mode", "open")
    if mode == "open":
        return True
    if mode == "domains" and channel == "email":
        domain = contact.rsplit("@", 1)[-1].lower()
        return any(domain == d or domain.endswith("." + d) for d in setting.get("domains") or [])
    return False
