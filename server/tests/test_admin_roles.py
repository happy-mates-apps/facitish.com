"""Administrative roles (app/admin_roles.py): which parts of /admin an admin may use, who may change them,
and that the menu (/api/auth/me) and the API agree."""

from app import admin_roles
from tests.helpers import full_user


async def _two_admins(make_client):
    """The super admin and a second admin, both with a passkey (so a step-up is fresh)."""
    boss = make_client()
    await full_user(boss, "11111111")
    other = make_client()
    await full_user(other, "22222222")
    users = (await boss.get("/api/admin/users")).json()["items"]
    boss_id, other_id = users[0]["id"], users[1]["id"]
    assert (await boss.patch(f"/api/admin/users/{other_id}/role", json={"role": "admin"})).status_code == 200
    return boss, other, boss_id, other_id


async def test_new_admins_get_full_access_and_the_menu_follows_the_roles(make_client, owner_conn):
    boss, other, boss_id, other_id = await _two_admins(make_client)
    me = (await boss.get("/api/auth/me")).json()["user"]
    assert me["admin_roles"] == ["fuld"] and set(me["admin_sections"]) == set(admin_roles.SECTIONS)
    assert (await other.get("/api/auth/me")).json()["user"]["admin_roles"] == ["fuld"]

    r = await boss.put(f"/api/admin/users/{other_id}/admin-roles", json={"roles": ["support"]})
    assert r.status_code == 200 and r.json() == {"admin_roles": ["support"]}
    row = owner_conn.execute("select before, after from audit_log where action = 'role.changed' order by id desc").fetchone()
    assert row == ({"admin_roles": ["fuld"]}, {"admin_roles": ["support"]})

    me = (await other.get("/api/auth/me")).json()["user"]
    assert me["admin_sections"] == ["/", "/users", "/impersonation", "/logs/auth"]
    assert (await other.get("/api/admin/analytics")).status_code == 200      # Statistik: every admin
    assert (await other.get("/api/admin/users")).status_code == 200
    assert (await other.get("/api/admin/logs/auth")).status_code == 200
    for path in ("/api/admin/gdpr", "/api/admin/logs/audit", "/api/admin/data/catalog", "/api/admin/settings",
                 "/api/admin/features", "/api/admin/mcp/overview"):
        r = await other.get(path)
        assert r.status_code == 403 and "admin-rolle" in r.json()["detail"], path


async def test_only_full_admins_change_roles_or_other_admins(make_client):
    boss, other, boss_id, other_id = await _two_admins(make_client)
    await boss.put(f"/api/admin/users/{other_id}/admin-roles", json={"roles": ["support"]})
    third = make_client()
    await full_user(third, "33333333")
    third_id = (await boss.get("/api/admin/users")).json()["items"][2]["id"]

    # Support helps users, but cannot hand out roles or touch an admin with more rights.
    assert (await other.post(f"/api/admin/users/{third_id}/revoke-sessions")).status_code == 200
    assert (await other.patch(f"/api/admin/users/{third_id}/role", json={"role": "admin"})).status_code == 403
    assert (await other.put(f"/api/admin/users/{other_id}/admin-roles", json={"roles": ["fuld"]})).status_code == 403
    r = await other.post(f"/api/admin/users/{boss_id}/revoke-sessions")
    assert r.status_code == 403 and "fuld adgang" in r.json()["detail"]

    # Unknown roles, the super admin and the last full admin are refused.
    assert (await boss.put(f"/api/admin/users/{other_id}/admin-roles", json={"roles": ["konge"]})).status_code == 422
    assert (await boss.put(f"/api/admin/users/{other_id}/admin-roles", json={"roles": []})).status_code == 422
    assert (await boss.put(f"/api/admin/users/{boss_id}/admin-roles", json={"roles": ["data"]})).status_code == 409
    assert (await boss.put(f"/api/admin/users/{third_id}/admin-roles", json={"roles": ["data"]})).status_code == 409  # not admin


async def test_several_roles_add_up_and_demotion_clears_them(make_client, owner_conn):
    boss, other, _, other_id = await _two_admins(make_client)
    await boss.put(f"/api/admin/users/{other_id}/admin-roles", json={"roles": ["data", "privatliv"]})
    assert (await other.get("/api/admin/data/catalog")).status_code == 200
    assert (await other.get("/api/admin/gdpr")).status_code == 200
    assert (await other.get("/api/admin/logs/audit.csv")).status_code == 200
    assert (await other.get("/api/admin/users")).status_code == 200          # the user list, for GDPR requests
    assert (await other.get(f"/api/admin/users/{other_id}")).status_code == 403  # but not the user pages
    assert (await other.get("/api/admin/web")).status_code == 403

    assert (await boss.patch(f"/api/admin/users/{other_id}/role", json={"role": "user"})).status_code == 200
    assert owner_conn.execute("select admin_roles from users where id = %s", (other_id,)).fetchone()[0] == []
    # Promoting again starts from full access, as before roles existed.
    await boss.patch(f"/api/admin/users/{other_id}/role", json={"role": "admin"})
    assert owner_conn.execute("select admin_roles from users where id = %s", (other_id,)).fetchone()[0] == ["fuld"]


def test_every_section_has_rules_and_every_role_is_known():
    for role, sections in admin_roles.ROLE_SECTIONS.items():
        assert role in admin_roles.ROLES and set(sections) <= set(admin_roles.SECTIONS)
    assert admin_roles.allows(["fuld"], "DELETE", "/api/admin/anything")
    assert admin_roles.allows(["drift"], "GET", "/api/admin/inbound-webhooks")
    assert admin_roles.allows(["drift"], "POST", "/api/admin/inbound-webhooks/events/1/replay")
    assert admin_roles.allows(["drift"], "POST", "/api/admin/retention/policies/run")
    assert not admin_roles.allows(["drift"], "GET", "/api/admin/unknown")   # deny by default
    assert not admin_roles.allows(["support"], "PATCH", "/api/admin/users/5/role")
    assert admin_roles.allows(["support"], "PATCH", "/api/admin/users/5/email")
