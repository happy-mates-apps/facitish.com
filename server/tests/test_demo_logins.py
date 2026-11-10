"""Demo logins for development: one account per role on the login page, through the ordinary one-time code."""

import dataclasses

import pytest

from app import config
from app.admin_roles import ROLES


@pytest.fixture
def settings(monkeypatch):
    def set_(**values):
        monkeypatch.setattr(config, "settings", dataclasses.replace(config.settings, **values))
    return set_


async def demo_login(client, key: str) -> dict:
    r = await client.post(f"/api/auth/demo-logins/{key}")
    assert r.status_code == 200, r.text
    start = r.json()
    r = await client.post("/api/auth/otp/verify", json={"email": start["email"], "code": start["dev_code"]})
    assert r.status_code == 200, r.text
    return r.json()


async def test_lists_one_account_per_role(client):
    r = await client.get("/api/auth/demo-logins")
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is True
    keys = [a["key"] for a in body["accounts"]]
    assert keys == list(ROLES) + ["bruger"]
    assert all(a["email"].endswith("@demo.example.com") for a in body["accounts"])


async def test_demo_admins_get_their_role_and_log_in_normally(make_client, owner_conn):
    full = make_client()
    body = await demo_login(full, "fuld")
    assert body["status"] == "logged_in" and body["admin"] is True and body["became_admin"] is False
    assert (await full.get("/api/admin/users")).status_code == 200
    assert (await full.get("/api/admin/settings")).status_code == 200

    support = make_client()
    assert (await demo_login(support, "support"))["admin"] is True
    assert (await support.get("/api/admin/users")).status_code == 200
    assert (await support.get("/api/admin/settings")).status_code == 403  # drift only

    user = make_client()
    assert (await demo_login(user, "bruger"))["admin"] is False
    assert (await user.get("/api/me/sessions")).status_code == 200
    assert (await user.get("/api/admin/users")).status_code == 403

    rows = owner_conn.execute("""select email, role, admin_roles, super_admin, display_name from users
                                 order by id""").fetchall()
    assert rows == [("admin@demo.example.com", "admin", ["fuld"], True, "Demo · Fuld adgang"),
                    ("support@demo.example.com", "admin", ["support"], False, "Demo · Support"),
                    ("bruger@demo.example.com", "user", [], False, "Demo · Bruger")]
    created = owner_conn.execute("""select detail->>'reason' from audit_log where action = 'create' and table_name = 'users'
                                    order by id""").fetchall()
    assert created == [("demo_login",)] * 3
    events = [r[0] for r in owner_conn.execute("select event from auth_log order by id").fetchall()]
    assert events.count("otp.sent") == 3 and events.count("otp.verified") == 3 and events.count("grace.used") == 2


async def test_second_login_reuses_the_user_and_counts_grace(make_client, owner_conn):
    first = await demo_login(make_client(), "fuld")
    second = await demo_login(make_client(), "fuld")
    assert (first["admin_grace_left"], second["admin_grace_left"]) == (2, 1)
    assert owner_conn.execute("select count(*) from users").fetchone()[0] == 1


async def test_unknown_key(client):
    assert (await client.post("/api/auth/demo-logins/ceo")).status_code == 404


async def test_off_in_production_or_with_a_real_mail_provider(client, settings):
    settings(environment="production")
    assert (await client.get("/api/auth/demo-logins")).json() == {"enabled": False, "accounts": []}
    assert (await client.post("/api/auth/demo-logins/fuld")).status_code == 404
    assert (await client.get("/api/public/config")).json()["demo_logins"] is False

    settings(environment="development", mail_provider="lettermint")
    assert (await client.get("/api/auth/demo-logins")).json()["enabled"] is False
    assert (await client.post("/api/auth/demo-logins/bruger")).status_code == 404
