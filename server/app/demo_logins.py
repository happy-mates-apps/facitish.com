"""Demo logins for development: one account per role, offered on the login page.

Only when the login code is printed to the console (MAIL_PROVIDER=console) outside production — the same condition
under which /api/auth/otp/start already returns the code to the login page. The accounts log in through the normal
one-time-code flow: the demo endpoint creates the user with its role (audited), issues a code the way otp/start does,
and the login page verifies it. Grace logins, MFA for /admin, the auth log and sessions work exactly as for anyone else.
"""

from app import config, db
from app.admin_roles import FULL, ROLES
from app.logs import RequestMeta, audit

DOMAIN = "demo.example.com"

# key → (e-mail, display name, users.role, admin_roles, description shown on the login page)
ACCOUNTS: dict[str, dict] = {
    "fuld": {"email": f"admin@{DOMAIN}", "name": "Demo · Fuld adgang", "role": "admin", "admin_roles": [FULL],
             "description": ROLES[FULL]["description"]},
    **{key: {"email": f"{key}@{DOMAIN}", "name": f"Demo · {r['label']}", "role": "admin", "admin_roles": [key],
             "description": r["description"]}
       for key, r in ROLES.items() if key != FULL},
    "bruger": {"email": f"bruger@{DOMAIN}", "name": "Demo · Bruger", "role": "user", "admin_roles": [],
               "description": "En almindelig bruger uden adgang til /admin."},
}


def enabled() -> bool:
    s = config.settings
    return s.mail_provider == "console" and not s.is_production


def accounts() -> list[dict]:
    return [{"key": key, "email": a["email"], "label": a["name"].removeprefix("Demo · "), "role": a["role"],
             "admin_roles": a["admin_roles"], "description": a["description"]} for key, a in ACCOUNTS.items()]


async def ensure_user(conn, key: str, meta: RequestMeta) -> dict:
    """The demo user for `key`, created with its role on first use. An existing user is returned as is, so a role
    change, a block or a deletion made in /admin stays visible in the demo too."""
    a = ACCOUNTS[key]
    user = await db.fetch_one(conn, "select * from users where email = %s", (a["email"],))
    if user:
        return user
    # The first full-access demo admin becomes the super admin only when the instance has none yet.
    super_admin = a["role"] == "admin" and FULL in a["admin_roles"] and not (
        await db.fetch_one(conn, "select exists (select 1 from users where super_admin) as e"))["e"]
    audience = "internal" if a["role"] == "admin" else "external"
    user = await db.fetch_one(conn, """insert into users (email, display_name, role, admin_roles, super_admin, audience)
                                       values (%s, %s, %s, %s, %s, %s) returning *""",
                              (a["email"], a["name"], a["role"], a["admin_roles"], super_admin, audience))
    await audit(conn, "create", actor_id=user["id"], meta=meta, table="users", row_id=user["id"],
                after={"email": a["email"], "display_name": a["name"], "role": a["role"], "admin_roles": a["admin_roles"],
                       "super_admin": super_admin, "audience": audience}, reason="demo_login")
    return user
