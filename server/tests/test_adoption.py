"""Adoption (/admin/adoption): matching rules, the analytics, tracking, journeys, access, nudges, GDPR and retention."""

from datetime import datetime, timedelta, timezone

import pytest

from app import adoption, db, gdpr, retention
from app.adoption_match import matches, normalize, surface, tracked, valid
from app.logs import RequestMeta
from tests.helpers import full_user, otp_login

# The same vectors are in web/src/admin-app/adoption/match.ts's header comment: keep the two in step.
MATCH_CASES = [
    ("exact", "/klip", "/klip", True),
    ("exact", "/klip/", "/klip", True),
    ("exact", "/klip", "/klip/42", False),
    ("prefix", "/extension", "/extension/klip", True),
    ("prefix", "/extension*", "/extension", True),
    ("prefix", "/extension", "/m/klip", False),
    ("glob", "/klip/*", "/klip/:id", True),
    ("glob", "/klip/*", "/klip/42", True),
    ("glob", "/klip/*", "/klip", False),
    ("glob", "/klip/*", "/klip/42/x", False),
    ("glob", "/extension/**", "/extension/tools/word", True),
    ("regex", "^/(m|extension)/klip$", "/m/klip", True),
    ("regex", "^/(m|extension)/klip$", "/klip", False),
]


@pytest.fixture(autouse=True)
def no_leftover_jobs(owner_conn):
    """Nudges queue webhook deliveries as jobs; the shared clean-up does not empty those tables."""
    yield
    owner_conn.execute("delete from jobs")
    owner_conn.execute("delete from webhooks")


@pytest.mark.parametrize("match_type,pattern,path,expected", MATCH_CASES)
def test_match_rules(match_type, pattern, path, expected):
    assert matches(match_type, pattern, path) is expected


def test_paths_are_cleaned_grouped_and_filtered():
    assert not valid("regex", "(") and not valid("glob", "") and valid("glob", "/a/*")
    assert normalize("/klip/1842") == "/klip/:id"
    assert normalize("/klip/0b6a4c1e-8f2d-4c55-9a43-2f1d5e8c9a10") == "/klip/:id"
    assert normalize("/m/chat") == "/m/chat"
    assert [surface(p) for p in ("/", "/m/klip", "/extension/klip", "/extension/tools/word")] == \
        ["app", "mobil", "udvidelse", "office"]
    for p in ("/", "/klip", "/klip/42", "/m/klip", "/extension/klip", "/konto"):
        assert tracked(p), p
    for p in ("/login", "/m/login", "/extension/login", "/admin", "/admin/users", "/api/me", "/w/om", "/go",
              "/forbind", "/office-addin", "/findes-ikke"):
        assert not tracked(p), p


# ── The analytics, without a database ──────────────────────────────────────

NOW = datetime(2026, 11, 9, 12, tzinfo=timezone.utc)
STEPS = [{"label": "Åbner Klip", "match_type": "exact", "pattern": "/klip"},
         {"label": "Åbner et klip", "match_type": "glob", "pattern": "/klip/*"},
         {"label": "Gemmer fra udvidelsen", "match_type": "prefix", "pattern": "/extension/klip"}]


def _row(user_id, path, days_ago, n=1):
    at = NOW - timedelta(days=days_ago)
    return {"user_id": user_id, "path": path, "week": adoption.week_start(at), "first": at, "n": n}


def test_the_funnel_is_sequential_and_stuck_users_are_found():
    rows = [_row(1, "/klip", 20), _row(1, "/klip/7", 19), _row(1, "/extension/klip", 18),
            _row(2, "/klip", 12), _row(2, "/extension/klip", 11),       # skipped step 2: only step 1 counts
            _row(2, "/filer", 10, n=4),
            _row(3, "/filer", 2)]                                       # active, no step
    cohort = {1, 2, 3}
    progress = adoption.progress_by_user(STEPS, rows)
    assert progress[1].reached_count == 3 and progress[2].reached_count == 1 and 3 not in progress
    assert adoption.funnel_counts(3, progress, cohort) == [2, 1, 1]

    d = adoption.build_dashboard(steps=STEPS, start_at=NOW - timedelta(days=30), goal_pct=50, rows=rows, cohort=cohort,
                                 users={1: {"name": "Mette", "role": "Bruger"}, 2: {"name": "Jonas", "role": "Admin"}},
                                 live_hits=[], nudges={}, dim="role", now=NOW)
    assert d["done_pct"] == 33 and d["reached_last"] == 1 and d["cohort_size"] == 3
    assert [f["reached"] for f in d["funnel"]] == [2, 1, 1]
    assert d["funnel"][0]["drop"] == 1 and d["funnel"][0]["drop_pct"] == 50
    assert d["funnel"][0]["exits"] == ["/filer"]            # where the one who stopped went instead
    assert d["stuck_total"] == 1 and d["stuck_users"][0]["name"] == "Jonas"
    assert d["kpis"]["median_days_to_goal"] == 2.0
    assert {r["key"] for r in d["breakdown"]["rows"]} == {"Bruger", "Admin"}
    assert d["track"] in ("on-track", "behind", "reached") and d["series"][-1]["week"] == "U46"


def test_forecast_reaches_the_goal_when_progress_keeps_up():
    rows = [_row(u, "/klip", 7 * (u % 4) + 1) for u in range(1, 9)]
    steps = STEPS[:1]
    progress = adoption.progress_by_user(steps, rows)
    fc = adoption.forecast_completion(1, progress, set(range(1, 11)), NOW - timedelta(days=35), 100, NOW)
    assert fc["series"][-1]["pct"] == 80.0 and fc["rate_per_week"] > 0
    assert fc["track"] == "on-track" and fc["forecast_date"] is not None


# ── Tracking and journeys through the API ───────────────────────────────────

async def _setup(make_client, owner_conn):
    boss = make_client()
    await full_user(boss, "11111111")             # first user: super admin with Fuld adgang
    user = make_client()
    await otp_login(user, "22222222")
    ids = [r[0] for r in owner_conn.execute("select id from users order by id")]
    return boss, user, ids[0], ids[1]


async def test_tracking_is_off_until_a_full_admin_turns_it_on(make_client, owner_conn):
    boss, user, boss_id, user_id = await _setup(make_client, owner_conn)
    r = await user.post("/api/adoption/visits", json={"paths": ["/klip"]})
    assert r.json() == {"tracking": False, "recorded": 0}
    assert (await user.get("/api/admin/adoption/settings")).status_code == 403

    r = await boss.put("/api/admin/adoption/settings", json={"tracking": True})
    assert r.status_code == 200, r.text
    row = owner_conn.execute("""select actor_user_id, before, after from audit_log
                                where action = 'update' and row_id = 'adoption_tracking'""").fetchone()
    assert row == (boss_id, {"tracking": False}, {"tracking": True})

    r = await user.post("/api/adoption/visits", json={"paths": [
        "/klip", "/klip", "/klip/42?x=1#top", "/login", "/admin/users", "/findes-ikke", "/m/klip", "/extension/klip/"]})
    assert r.json() == {"tracking": True, "recorded": 4}
    rows = owner_conn.execute("select user_id, path, surface from adoption_visits order by id").fetchall()
    assert rows == [(user_id, "/klip", "app"), (user_id, "/klip/42", "app"), (user_id, "/m/klip", "mobil"),
                    (user_id, "/extension/klip", "udvidelse")]
    assert (await make_client().post("/api/adoption/visits", json={"paths": ["/klip"]})).status_code == 401


async def test_journey_setup_dashboard_routes_and_live(make_client, owner_conn):
    boss, user, boss_id, user_id = await _setup(make_client, owner_conn)
    await boss.put("/api/admin/adoption/settings", json={"tracking": True})
    await user.post("/api/adoption/visits", json={"paths": ["/klip", "/klip/42", "/filer"]})

    r = await boss.post("/api/admin/adoption/journeys", json={"name": "Kom i gang med Klip"})
    assert r.status_code == 201, r.text
    j = r.json()
    assert j["status"] == "draft" and j["my_role"] == "admin" and j["steps"] == []
    jid = j["id"]

    bad = await boss.patch(f"/api/admin/adoption/journeys/{jid}", json={"steps": [
        {"label": "x", "match_type": "regex", "pattern": "("}]})
    assert bad.status_code == 400 and "Trin 1" in bad.json()["detail"]
    r = await boss.patch(f"/api/admin/adoption/journeys/{jid}", json={
        "status": "active", "goal_pct": 50, "start_at": (datetime.now(timezone.utc) - timedelta(days=3)).isoformat(),
        "steps": [{"label": s["label"], "match_type": s["match_type"], "pattern": s["pattern"]} for s in STEPS]})
    assert r.status_code == 200, r.text
    j = r.json()
    assert [s["pattern"] for s in j["steps"]] == ["/klip", "/klip/*", "/extension/klip"]
    assert j["cohort_size"] == 1 and j["reached"] == [1, 1, 0] and j["done_pct"] == 0
    audit_row = owner_conn.execute("""select before, after from audit_log where action = 'update'
                                      and table_name = 'adoption_journeys' order by id desc""").fetchone()
    assert audit_row[1]["status"] == "active" and audit_row[1]["steps"][0] == "exact /klip" and audit_row[0]["steps"] == []

    d = (await boss.get(f"/api/admin/adoption/journeys/{jid}/dashboard?dim=surface")).json()
    assert [f["reached"] for f in d["funnel"]] == [1, 1, 0] and d["funnel"][1]["exits"] == ["/filer"]
    assert d["live_hits"][0]["path"] == "/klip/42" and d["live_hits"][0]["step"] == 2
    assert d["kpis"]["active_now"] == 1 and d["nudge_webhooks"] == 0
    assert d["breakdown"]["rows"][0]["key"] == "Appen"

    routes = (await boss.get("/api/admin/adoption/routes?days=7")).json()
    by_route = {r["route"]: r for r in routes["rows"]}
    assert by_route["/klip/:id"]["journeys"] == [{"id": jid, "name": "Kom i gang med Klip"}]
    assert by_route["/filer"]["journeys"] == [] and by_route["/klip"]["users"] == 1 and routes["total"] == 3

    o = (await boss.get("/api/admin/adoption/overview?days=7")).json()
    assert o["tracking"] and o["journeys_active"] == 1 and o["tracked_visits"]["value"] == 3
    assert o["active_users"]["value"] == 1 and len(o["tracked_visits"]["series"]) == 7

    live = (await boss.get("/api/admin/adoption/live")).json()
    assert [line["path"] for line in live["lines"]] == ["/filer", "/klip/42", "/klip"]
    assert live["lines"][1]["hits"] == [{"journey_id": jid, "journey_name": "Kom i gang med Klip", "step": 2}]
    assert (await boss.get(f"/api/admin/adoption/live?after={live['last_id']}")).json()["lines"] == []

    r = await boss.get("/api/admin/adoption/stream?seconds=0")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    assert "data: " in r.text and "/klip/42" in r.text

    assert (await boss.delete(f"/api/admin/adoption/journeys/{jid}")).status_code == 200
    assert owner_conn.execute("select count(*) from adoption_steps").fetchone()[0] == 0
    assert owner_conn.execute("""select before->>'name' from audit_log where action = 'delete'
                                 and table_name = 'adoption_journeys'""").fetchone()[0] == "Kom i gang med Klip"


async def test_journey_roles_decide_who_sees_edits_and_manages(make_client, owner_conn):
    boss, user, boss_id, user_id = await _setup(make_client, owner_conn)
    other = make_client()
    await full_user(other, "33333333")
    other_id = owner_conn.execute("select max(id) from users").fetchone()[0]
    await boss.patch(f"/api/admin/users/{other_id}/role", json={"role": "admin"})
    assert (await boss.put(f"/api/admin/users/{other_id}/admin-roles", json={"roles": ["produkt"]})).status_code == 200

    jid = (await boss.post("/api/admin/adoption/journeys", json={"name": "Passkey for alle"})).json()["id"]
    assert (await other.get("/api/admin/adoption/journeys")).json()["items"] == []
    assert (await other.get(f"/api/admin/adoption/journeys/{jid}")).status_code == 404
    r = await other.put("/api/admin/adoption/settings", json={"tracking": True})
    assert r.status_code == 403 and "Fuld adgang" in r.json()["detail"]

    # Only admins whose roles open Adoption can get a role; the user is not an admin.
    assert (await boss.put(f"/api/admin/adoption/journeys/{jid}/members/{user_id}", json={"role": "reader"})).status_code == 400
    assert (await boss.put(f"/api/admin/adoption/journeys/{jid}/members/{other_id}", json={"role": "reader"})).status_code == 200
    j = (await other.get(f"/api/admin/adoption/journeys/{jid}")).json()
    assert j["my_role"] == "reader" and not j["can_edit"]
    assert (await other.patch(f"/api/admin/adoption/journeys/{jid}", json={"name": "Nyt navn"})).status_code == 403

    await boss.put(f"/api/admin/adoption/journeys/{jid}/members/{other_id}", json={"role": "editor"})
    assert (await other.patch(f"/api/admin/adoption/journeys/{jid}", json={"name": "Nyt navn"})).status_code == 200
    assert (await other.put(f"/api/admin/adoption/journeys/{jid}/members/{other_id}", json={"role": "owner"})).status_code == 403
    assert (await other.delete(f"/api/admin/adoption/journeys/{jid}")).status_code == 403

    # The creator is the only owner: they cannot be removed or demoted until someone else owns it.
    r = await boss.delete(f"/api/admin/adoption/journeys/{jid}/members/{boss_id}")
    assert r.status_code == 409
    assert (await boss.put(f"/api/admin/adoption/journeys/{jid}/members/{boss_id}", json={"role": "reader"})).status_code == 409
    await boss.put(f"/api/admin/adoption/journeys/{jid}/members/{other_id}", json={"role": "owner"})
    assert (await boss.delete(f"/api/admin/adoption/journeys/{jid}/members/{boss_id}")).status_code == 200

    m = (await other.get(f"/api/admin/adoption/journeys/{jid}/members")).json()
    assert [x["user_id"] for x in m["items"]] == [other_id] and m["can_manage"]
    assert [c["id"] for c in m["candidates"]] == [boss_id]
    actions = [r[0] for r in owner_conn.execute("""select action from audit_log where table_name = 'adoption_members'
                                                   order by id""")]
    assert actions == ["create", "update", "update", "delete"]

    access = {a["id"]: a for a in (await boss.get("/api/admin/adoption/access")).json()["items"]}
    assert access[boss_id]["access"] == "all" and access[other_id]["access"] == "assigned"

    # Support does not open Adoption at all.
    await boss.put(f"/api/admin/users/{other_id}/admin-roles", json={"roles": ["support"]})
    assert (await other.get("/api/admin/adoption/journeys")).status_code == 403


async def test_nudges_go_to_stuck_users_in_the_audience_as_a_webhook(make_client, owner_conn):
    boss, user, boss_id, user_id = await _setup(make_client, owner_conn)
    jid = (await boss.post("/api/admin/adoption/journeys", json={"name": "Klip"})).json()["id"]
    await boss.patch(f"/api/admin/adoption/journeys/{jid}", json={
        "status": "active", "audience": {"kind": "role", "roles": ["user"]},
        "start_at": (datetime.now(timezone.utc) - timedelta(days=30)).isoformat(),
        "steps": [{"label": "A", "match_type": "exact", "pattern": "/klip"},
                  {"label": "B", "match_type": "exact", "pattern": "/filer"}]})
    owner_conn.execute("insert into adoption_visits (user_id, path, surface, at) values (%s, '/klip', 'app', now() - interval '10 days')",
                       (user_id,))
    owner_conn.execute("""insert into webhooks (name, url, events, secret_enc) values ('Teams', 'https://example.com/hook',
                          '{adoption.nudge.sent}', '\\x00')""")

    d = (await boss.get(f"/api/admin/adoption/journeys/{jid}/dashboard")).json()
    assert d["cohort_size"] == 1 and d["stuck_total"] == 1 and d["stuck_users"][0]["user_id"] == user_id
    assert d["nudge_webhooks"] == 1

    r = await boss.post(f"/api/admin/adoption/journeys/{jid}/nudges", json={"user_ids": [boss_id]})
    assert r.status_code == 400   # the admin is not in the audience (role: user)
    r = await boss.post(f"/api/admin/adoption/journeys/{jid}/nudges", json={"user_ids": [user_id]})
    assert r.json() == {"sent": 1, "webhooks": 1}
    payload = owner_conn.execute("select event, payload from webhook_deliveries").fetchone()
    assert payload[0] == "adoption.nudge.sent" and payload[1]["data"] == {"journey_id": jid, "user_ids": [user_id]}
    assert owner_conn.execute("select count(*) from audit_log where table_name = 'adoption_nudges'").fetchone()[0] == 1
    d = (await boss.get(f"/api/admin/adoption/journeys/{jid}/dashboard")).json()
    assert d["stuck_users"][0]["nudged_at"] is not None


async def test_visits_are_in_the_gdpr_export_erased_with_the_user_and_expire(make_client, owner_conn):
    boss, user, boss_id, user_id = await _setup(make_client, owner_conn)
    await boss.put("/api/admin/adoption/settings", json={"tracking": True})
    await user.post("/api/adoption/visits", json={"paths": ["/klip", "/filer"]})
    owner_conn.execute("insert into adoption_visits (user_id, path, surface, at) values (%s, '/konto', 'app', now() - interval '200 days')",
                       (user_id,))

    async with db.connection() as conn:
        data = await gdpr.build_user_export(conn, user_id)
    assert [v["path"] for v in data["adoption_visits"]] == ["/konto", "/klip", "/filer"]

    assert await retention.cleanup(only="adoption_visits") == {"adoption_visits": 1}
    await gdpr.erase_user(user_id, actor_id=boss_id, meta=RequestMeta(), reason="test")
    assert owner_conn.execute("select count(*) from adoption_visits").fetchone()[0] == 0
