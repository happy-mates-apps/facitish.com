"""Groups (/api/admin/groups, /api/me/groups) and the secret manager (/api/admin/secrets, app/secret_store.py):
RACI defaults and rules, values encrypted and never logged, access by approval of A, R and C, grants that end,
notifications, GDPR."""

from app import db, gdpr, jobs, secret_store
from app.logs import RequestMeta
from tests.helpers import full_user

VALUE = "sk_live_abcdefghijklmnop4f2a"


async def _admins(make_client, n: int = 4):
    """n admins with passkeys (fresh second factor). The first is the super admin."""
    clients = []
    for i in range(n):
        c = make_client()
        await full_user(c, str(i + 1) * 8)
        clients.append(c)
    boss = clients[0]
    ids = sorted(u["id"] for u in (await boss.get("/api/admin/users")).json()["items"])
    for uid in ids[1:]:
        assert (await boss.patch(f"/api/admin/users/{uid}/role", json={"role": "admin"})).status_code == 200
    return clients, ids


async def _group(boss, ids, name="Betaling"):
    r = await boss.post("/api/admin/groups", json={"name": name, "description": "Betalinger"})
    assert r.status_code == 201, r.text
    gid = r.json()["id"]
    for uid in ids:
        assert (await boss.put(f"/api/admin/groups/{gid}/members/{uid}", json={"role": "member"})).status_code == 200
    return gid


def _actions(owner_conn, secret_id) -> list[str]:
    return [r[0] for r in owner_conn.execute(
        "select action from audit_log where table_name = 'secrets' and row_id = %s order by id", (str(secret_id),))]


def _jobs(owner_conn, kind="secrets.mail") -> list[dict]:
    return [r[0] for r in owner_conn.execute("select payload from jobs where kind = %s order by id", (kind,))]


async def test_groups_are_a_general_feature(make_client, owner_conn):
    (boss, other, *_), ids = await _admins(make_client, 2)
    r = await boss.post("/api/admin/groups", json={"name": "Drift & Støtte"})
    assert r.status_code == 201 and r.json()["slug"] == "drift-stoette"
    gid = r.json()["id"]
    assert (await boss.post("/api/admin/groups", json={"name": "Drift & Støtte"})).json()["slug"] == "drift-stoette-2"
    assert (await boss.put(f"/api/admin/groups/{gid}/members/{ids[1]}", json={"role": "manager"})).status_code == 200
    assert (await boss.put(f"/api/admin/groups/{gid}/members/99999", json={})).status_code == 404
    group = (await boss.get(f"/api/admin/groups/{gid}")).json()
    assert [(m["id"], m["role"]) for m in group["members"]] == [(ids[1], "manager")]
    mine = (await other.get("/api/me/groups")).json()
    assert [(g["name"], g["role"]) for g in mine] == [("Drift & Støtte", "manager")]
    assert (await boss.get("/api/me/groups")).json() == []
    r = await boss.patch(f"/api/admin/groups/{gid}", json={"notify_email": "Drift@Example.com"})
    assert r.json()["notify_email"] == "drift@example.com"
    assert (await boss.delete(f"/api/admin/groups/{gid}/members/{ids[1]}")).status_code == 200
    actions = [r[0] for r in owner_conn.execute(
        "select action from audit_log where table_name = 'groups' and row_id = %s order by id", (str(gid),))]
    assert actions == ["create", "group.member_added", "update", "group.member_removed"]
    assert (await boss.delete(f"/api/admin/groups/{gid}")).status_code == 200


async def test_create_reveal_and_change_value(make_client, owner_conn):
    (boss, two, three, four), ids = await _admins(make_client)
    gid = await _group(boss, ids)
    r = await boss.post("/api/admin/secrets", json={"group_id": gid, "name": "Stripe API-nøgle", "environment": "produktion",
                                                     "value": VALUE, "rotation_days": 90, "tags": ["Betaling", "api"]})
    assert r.status_code == 201, r.text
    sid = r.json()["id"]
    # Defaults: the creator is A and R, the rest of the group is I.
    detail = (await boss.get(f"/api/admin/secrets/{sid}")).json()
    assert [(p["id"], p["roles"]) for p in detail["raci"]] == [(ids[0], ["R", "A"]), (ids[1], ["I"]), (ids[2], ["I"]), (ids[3], ["I"])]
    assert detail["my_level"] == "write" and detail["status"] == "ok" and detail["tags"] == ["api", "betaling"]
    assert detail["versions"][0]["hint"] == "…4f2a" and "value" not in detail

    # Encrypted at rest; never in the audit log, a job or a list.
    blob = owner_conn.execute("select value_enc from secret_versions where secret_id = %s", (sid,)).fetchone()[0]
    assert VALUE.encode() not in bytes(blob)
    assert VALUE not in str(owner_conn.execute("select array_agg(detail::text || coalesce(after::text, '')) from audit_log").fetchone()[0])

    # I sees the metadata but not the value, nor the hint.
    other = (await two.get(f"/api/admin/secrets/{sid}")).json()
    assert other["my_level"] is None and other["versions"][0]["hint"] == ""
    assert (await two.post(f"/api/admin/secrets/{sid}/reveal")).status_code == 403
    assert (await two.put(f"/api/admin/secrets/{sid}/value", json={"value": "x"})).status_code == 403

    r = await boss.post(f"/api/admin/secrets/{sid}/reveal")
    assert r.status_code == 200 and r.json()["value"] == VALUE and r.json()["version"] == 1
    assert (await boss.put(f"/api/admin/secrets/{sid}/value", json={"value": "ny-værdi-1234567"})).json() == {"version": 2}
    assert (await boss.post(f"/api/admin/secrets/{sid}/reveal")).json()["value"] == "ny-værdi-1234567"
    assert (await boss.post(f"/api/admin/secrets/{sid}/reveal?version=1")).json()["value"] == VALUE
    assert (await boss.post(f"/api/admin/secrets/{sid}/versions/1/restore")).json() == {"version": 3}
    assert (await boss.post(f"/api/admin/secrets/{sid}/reveal")).json()["value"] == VALUE
    assert _actions(owner_conn, sid) == ["create", "secret.revealed", "secret.value_changed", "secret.revealed",
                                         "secret.revealed", "secret.value_changed", "secret.revealed"]
    # A value change goes straight to A, R and grantees, to I in the digest; revealing goes to A's digest (but the
    # actor is never told about their own action).
    digest = owner_conn.execute("select user_id, event from secret_notifications order by id").fetchall()
    assert set(digest) == {(ids[1], "secret.value.changed"), (ids[2], "secret.value.changed"), (ids[3], "secret.value.changed")}
    listed = (await boss.get("/api/admin/secrets")).json()["items"]
    assert [(s["name"], s["my_roles"], s["accountable"]["id"]) for s in listed] == [("Stripe API-nøgle", ["R", "A"], ids[0])]
    assert "value" not in listed[0]

    # Duplicate names in the same group and environment are refused; another environment is fine.
    dup = {"group_id": gid, "name": "stripe api-nøgle", "environment": "produktion", "value": "x"}
    assert (await boss.post("/api/admin/secrets", json=dup)).status_code == 409
    assert (await boss.post("/api/admin/secrets", json=dup | {"environment": "test"})).status_code == 201


async def test_raci_rules(make_client, owner_conn):
    (boss, two, three, four), ids = await _admins(make_client)
    gid = await _group(boss, ids)
    sid = (await boss.post("/api/admin/secrets", json={"group_id": gid, "name": "SFTP", "value": VALUE})).json()["id"]
    put = lambda c, raci: c.put(f"/api/admin/secrets/{sid}/raci", json={"raci": raci})
    two_as = [{"user_id": ids[0], "roles": ["A", "R"]}, {"user_id": ids[1], "roles": ["A"]}]
    assert "præcis én" in (await put(boss, two_as)).json()["detail"]
    assert "mindst én" in (await put(boss, [{"user_id": ids[0], "roles": ["A"]}])).json()["detail"]
    # Only an admin whose roles open /secrets can be A, R or C.
    assert (await boss.put(f"/api/admin/users/{ids[3]}/admin-roles", json={"roles": ["support"]})).status_code == 200
    r = await put(boss, [{"user_id": ids[0], "roles": ["A", "R"]}, {"user_id": ids[3], "roles": ["C"]}])
    assert r.status_code == 400 and "administratorer" in r.json()["detail"]
    good = [{"user_id": ids[0], "roles": ["A"]}, {"user_id": ids[1], "roles": ["R"]}, {"user_id": ids[2], "roles": ["C"]},
            {"user_id": ids[3], "roles": ["I"]}]
    assert (await put(boss, good)).status_code == 200
    assert (await put(two, good)).status_code == 403            # only A changes the RACI
    assert (await two.patch(f"/api/admin/secrets/{sid}", json={"description": "Banken"})).status_code == 200   # R edits
    assert (await two.patch(f"/api/admin/secrets/{sid}", json={"approval_rule": "a_only"})).status_code == 403
    assert (await three.patch(f"/api/admin/secrets/{sid}", json={"description": "x"})).status_code == 403
    assert "secret.raci_changed" in _actions(owner_conn, sid)
    # Those whose role changed are told at once (C now), I via the digest.
    told = {p["user_id"] for p in _jobs(owner_conn) if p["event"] == "secret.raci.changed"}
    assert told == {ids[1], ids[2]}


async def test_access_needs_everyone_in_a_r_and_c(make_client, owner_conn):
    (boss, two, three, four), ids = await _admins(make_client)
    gid = await _group(boss, ids)
    sid = (await boss.post("/api/admin/secrets", json={"group_id": gid, "name": "Stripe", "value": VALUE})).json()["id"]
    raci = [{"user_id": ids[0], "roles": ["A"]}, {"user_id": ids[1], "roles": ["R"]}, {"user_id": ids[2], "roles": ["C"]},
            {"user_id": ids[3], "roles": ["I"]}]
    assert (await boss.put(f"/api/admin/secrets/{sid}/raci", json={"raci": raci})).status_code == 200
    owner_conn.execute("delete from jobs")

    r = await four.post(f"/api/admin/secrets/{sid}/requests", json={"level": "write", "days": 30, "reason": "Rotation i uge 47"})
    assert r.status_code == 201, r.text
    req = r.json()
    assert req["total"] == 3 and req["rule_label"] == "Alle i A, R og C" and req["own"] and not req["can_decide"]
    assert (await four.post(f"/api/admin/secrets/{sid}/requests", json={"reason": "igen"})).status_code == 409
    # Every approver is mailed at once, whatever the group's rules say.
    assert {p["user_id"] for p in _jobs(owner_conn) if p["event"] == "secret.access.requested"} == set(ids[:3])
    waiting = (await three.get("/api/admin/secrets/requests?scope=waiting")).json()["items"]
    assert [w["id"] for w in waiting] == [req["id"]] and waiting[0]["can_decide"]

    decide = lambda c, approve, note=None: c.post(f"/api/admin/secrets/requests/{req['id']}/decide",
                                                   json={"approve": approve, "note": note})
    assert (await decide(four, True)).status_code == 403            # never your own
    assert (await decide(boss, True)).json()["status"] == "pending"
    assert (await decide(boss, True)).status_code == 409             # already answered
    assert (await decide(two, True)).json()["status"] == "pending"
    assert (await decide(three, False)).status_code == 400           # a rejection needs a reason
    assert (await four.post(f"/api/admin/secrets/{sid}/reveal")).status_code == 403
    r = await decide(three, True)
    assert r.json()["status"] == "approved" and r.json()["grant_id"]
    assert (await four.post(f"/api/admin/secrets/{sid}/reveal")).json()["value"] == VALUE
    assert (await four.put(f"/api/admin/secrets/{sid}/value", json={"value": "fra-fire-1234"})).status_code == 200
    detail = (await four.get(f"/api/admin/secrets/{sid}")).json()
    assert detail["my_level"] == "write" and len(detail["grants"]) == 1

    # A or R revokes; then the value is closed again.
    grant = detail["grants"][0]["id"]
    assert (await three.post(f"/api/admin/secrets/{sid}/grants/{grant}/revoke")).status_code == 403
    assert (await two.post(f"/api/admin/secrets/{sid}/grants/{grant}/revoke")).status_code == 200
    assert (await four.post(f"/api/admin/secrets/{sid}/reveal")).status_code == 403
    assert _actions(owner_conn, sid)[-8:] == [
        "secret.access_requested", "secret.access_approved", "secret.access_approved", "secret.access_approved",
        "secret.access_granted", "secret.revealed", "secret.value_changed", "secret.access_ended"]
    events = [r[0] for r in owner_conn.execute(
        "select payload->>'event' from jobs where kind = 'webhook.deliver' order by id")]
    assert events == []  # no webhook endpoints configured: nothing is queued


async def test_rejection_read_level_and_fallback(make_client, owner_conn):
    (boss, two, three, four), ids = await _admins(make_client)
    gid = await _group(boss, ids)
    sid = (await boss.post("/api/admin/secrets", json={"group_id": gid, "name": "Bank", "value": VALUE})).json()["id"]

    # Boss is the only one in A, R and C: a request from boss for "two" falls back to another admin (not two).
    r = await boss.post(f"/api/admin/secrets/{sid}/requests", json={"grantee_user_id": ids[1], "level": "read",
                                                                    "days": 7, "reason": "Support-sag"})
    req = r.json()
    assert req["fallback"] and {a["approver"]["id"] for a in req["approvals"]} == {ids[2], ids[3]}
    assert (await two.post(f"/api/admin/secrets/requests/{req['id']}/decide", json={"approve": True})).status_code == 403
    assert (await three.post(f"/api/admin/secrets/requests/{req['id']}/decide",
                             json={"approve": True})).json()["status"] == "approved"
    assert (await two.post(f"/api/admin/secrets/{sid}/reveal")).status_code == 200
    r = await two.put(f"/api/admin/secrets/{sid}/value", json={"value": "nej"})
    assert r.status_code == 403 and "kun lov til at se" in r.json()["detail"]

    # One rejection closes a request.
    raci = [{"user_id": ids[0], "roles": ["A", "R"]}, {"user_id": ids[1], "roles": ["C"]}]
    assert (await boss.put(f"/api/admin/secrets/{sid}/raci", json={"raci": raci})).status_code == 200
    req = (await four.post(f"/api/admin/secrets/{sid}/requests", json={"reason": "Vil gerne se"})).json()
    r = await two.post(f"/api/admin/secrets/requests/{req['id']}/decide", json={"approve": False, "note": "Ikke nødvendigt"})
    assert r.json()["status"] == "rejected"
    assert (await boss.post(f"/api/admin/secrets/requests/{req['id']}/decide", json={"approve": True})).status_code == 409

    # "A and one R": A plus any one R is enough.
    raci = [{"user_id": ids[0], "roles": ["A"]}, {"user_id": ids[1], "roles": ["R"]}, {"user_id": ids[2], "roles": ["R"]}]
    assert (await boss.put(f"/api/admin/secrets/{sid}/raci", json={"raci": raci})).status_code == 200
    assert (await boss.patch(f"/api/admin/secrets/{sid}", json={"approval_rule": "a_and_one_r"})).status_code == 200
    req = (await four.post(f"/api/admin/secrets/{sid}/requests", json={"reason": "Ny opgave"})).json()
    assert req["total"] == 3
    assert (await boss.post(f"/api/admin/secrets/requests/{req['id']}/decide", json={"approve": True})).json()["status"] == "pending"
    assert (await three.post(f"/api/admin/secrets/requests/{req['id']}/decide", json={"approve": True})).json()["status"] == "approved"


def test_outcome_rules():
    a = lambda roles, d: {"roles": roles, "decision": d}
    assert secret_store.outcome(False, "all", [a(["A"], "approved"), a(["C"], "pending")]) == "pending"
    assert secret_store.outcome(False, "all", [a(["A"], "approved"), a(["C"], "rejected")]) == "rejected"
    assert secret_store.outcome(False, "a_only", [a(["A"], "approved")]) == "approved"
    assert secret_store.outcome(False, "a_and_one_r", [a(["R"], "approved"), a(["R"], "pending")]) == "approved"  # requester is A
    assert secret_store.outcome(False, "a_and_one_r", [a(["A"], "pending"), a(["R"], "approved")]) == "pending"
    assert secret_store.outcome(True, "all", [a(["admin"], "pending"), a(["admin"], "approved")]) == "approved"


async def test_group_grant_maintenance_and_notify_rules(make_client, owner_conn):
    (boss, two, three, four), ids = await _admins(make_client)
    gid = await _group(boss, ids[:3])
    ops = (await boss.post("/api/admin/groups", json={"name": "Support", "notify_email": "support@example.com"})).json()["id"]
    sid = (await boss.post("/api/admin/secrets", json={"group_id": gid, "name": "Token", "value": VALUE,
                                                       "rotation_days": 10})).json()["id"]
    raci = [{"user_id": ids[0], "roles": ["A", "R"]}, {"user_id": ids[1], "roles": ["C"]}, {"user_id": ids[2], "roles": ["I"]}]
    assert (await boss.put(f"/api/admin/secrets/{sid}/raci", json={"raci": raci})).status_code == 200
    req = (await boss.post(f"/api/admin/secrets/{sid}/requests", json={"grantee_group_id": ops, "level": "read",
                                                                       "days": 5, "reason": "Support skal kunne se"})).json()
    assert (await two.post(f"/api/admin/secrets/requests/{req['id']}/decide", json={"approve": True})).json()["status"] == "approved"
    # Joining a group with a grant gives access — and A is told.
    owner_conn.execute("delete from jobs")
    assert (await boss.put(f"/api/admin/groups/{ops}/members/{ids[3]}", json={})).status_code == 200
    assert (await four.post(f"/api/admin/secrets/{sid}/reveal")).status_code == 200
    assert "secret.access_via_group" in _actions(owner_conn, sid)
    assert (await four.get(f"/api/admin/secrets/{sid}")).json()["my_level"] == "read"

    # The group's rules: only a manager or a full admin changes them; the channel cannot be a digest.
    assert (await boss.put(f"/api/admin/users/{ids[1]}/admin-roles", json={"roles": ["drift"]})).status_code == 200
    rules = (await two.get(f"/api/admin/secrets/groups/{gid}/notify")).json()
    assert rules["can_edit"] is False and rules["events"][0]["key"] == "secret.access.requested"
    body = {"rules": [{"event": "secret.revealed", "audience": "I", "mode": "now"}]}
    assert (await two.put(f"/api/admin/secrets/groups/{gid}/notify", json=body)).status_code == 403
    assert (await boss.put(f"/api/admin/secrets/groups/{gid}/notify", json=body)).status_code == 200
    bad = {"rules": [{"event": "secret.revealed", "audience": "channel", "mode": "digest"}]}
    assert (await boss.put(f"/api/admin/secrets/groups/{gid}/notify", json=bad)).status_code == 400
    owner_conn.execute("delete from jobs")
    await four.post(f"/api/admin/secrets/{sid}/reveal")
    assert {p["user_id"] for p in _jobs(owner_conn) if p.get("event") == "secret.revealed"} == {ids[2]}

    # Maintenance: rotation reminder, grant reminders and expiry, requests that time out.
    owner_conn.execute("update secrets set value_changed_at = now() - interval '9 days' where id = %s", (sid,))
    pending = (await three.post(f"/api/admin/secrets/{sid}/requests", json={"reason": "Bare for at se"})).json()
    owner_conn.execute("update secret_access_requests set expires_at = now() - interval '1 minute' where id = %s", (pending["id"],))
    counts = await secret_store.maintenance({}, {})
    assert counts == {"requests_expired": 1, "grants_expired": 0, "grants_reminded": 1, "rotations_due": 1}
    assert (await secret_store.maintenance({}, {}))["rotations_due"] == 0       # once per version
    owner_conn.execute("update secret_grants set expires_at = now() - interval '1 minute'")
    assert (await secret_store.maintenance({}, {}))["grants_expired"] == 1
    assert (await four.post(f"/api/admin/secrets/{sid}/reveal")).status_code == 403

    # Mail jobs run (console provider) and the digest is sent and marked.
    await jobs.run_pending()
    assert owner_conn.execute("select count(*) from jobs where kind like 'secrets.%%' and status <> 'succeeded'").fetchone()[0] == 0
    result = await secret_store.send_digests({}, {})
    assert result["items"] >= 1   # I hears about the RACI change in the digest
    assert owner_conn.execute("select count(*) from secret_notifications where sent_at is null").fetchone()[0] == 0


async def test_archive_gdpr_and_orphans(make_client, owner_conn):
    (boss, two, three, four), ids = await _admins(make_client)
    gid = await _group(boss, ids)
    sid = (await boss.post("/api/admin/secrets", json={"group_id": gid, "name": "Mail", "value": VALUE})).json()["id"]
    raci = [{"user_id": ids[1], "roles": ["A"]}, {"user_id": ids[0], "roles": ["R"]}, {"user_id": ids[2], "roles": ["C"]}]
    assert (await boss.put(f"/api/admin/secrets/{sid}/raci", json={"raci": raci})).status_code == 200

    async with db.connection() as conn:
        export = await gdpr.build_user_export(conn, ids[1])
    assert export["vault_roles"] == [{**export["vault_roles"][0], "name": "Mail", "role": "A"}]
    assert [g["name"] for g in export["groups"]] == ["Betaling"]

    # A is erased: the secret has no accountable person, R and C are told, and a full admin may pick a new A.
    owner_conn.execute("delete from jobs")
    await gdpr.erase_user(ids[1], actor_id=ids[0], meta=RequestMeta(), reason="test")
    detail = (await boss.get(f"/api/admin/secrets/{sid}")).json()
    assert detail["status"] == "orphaned" and detail["can_edit_raci"]
    assert {p["user_id"] for p in _jobs(owner_conn) if p["event"] == "secret.orphaned"} == {ids[0], ids[2]}
    raci = [{"user_id": ids[0], "roles": ["A", "R"]}, {"user_id": ids[2], "roles": ["C"]}]
    assert (await boss.put(f"/api/admin/secrets/{sid}/raci", json={"raci": raci})).status_code == 200

    assert (await three.post(f"/api/admin/secrets/{sid}/archive", json={})).status_code == 403
    assert (await boss.post(f"/api/admin/secrets/{sid}/archive", json={"reason": "Udfaset"})).status_code == 200
    assert (await boss.post(f"/api/admin/secrets/{sid}/reveal")).status_code == 403
    assert (await boss.get("/api/admin/secrets")).json()["items"] == []
    assert [s["status"] for s in (await boss.get("/api/admin/secrets?archived=true")).json()["items"]] == ["archived"]
    assert (await boss.delete(f"/api/admin/groups/{gid}")).status_code == 409
