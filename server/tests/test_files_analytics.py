import json

from tests.helpers import full_user, otp_login

VISITOR = "v_" + "a" * 22


async def test_upload_link_delete(client, owner_conn):
    await otp_login(client, "12345678")
    r = await client.post("/api/files", files={"file": ("note.txt", b"hej", "text/plain")})
    assert r.status_code == 200
    file_id = r.json()["id"]
    link = (await client.get(f"/api/files/{file_id}/link")).json()
    assert (await client.get(link["url"])).content == b"hej"
    assert (await client.delete(f"/api/files/{file_id}")).status_code == 200
    actions = [r[0] for r in owner_conn.execute("select action from audit_log order by id").fetchall()]
    assert "file.upload" in actions and "file.delete" in actions


async def test_other_users_cannot_read_file(make_client):
    owner, other = make_client(), make_client()
    await otp_login(owner, "11111111")
    await otp_login(other, "22222222")
    file_id = (await owner.post("/api/files", files={"file": ("a.txt", b"x", "text/plain")})).json()["id"]
    assert (await other.get(f"/api/files/{file_id}/link")).status_code == 404


async def _collect(client, events):
    return await client.post("/api/collect", content=json.dumps(events), headers={"content-type": "text/plain"})


async def test_without_consent_only_anonymous_pageviews(client, owner_conn):
    await _collect(client, [{"kind": "pageview", "path": "/om?x=1", "visitor_id": VISITOR,
                             "referrer": "https://www.google.com/search?q=hemmelig"},
                            {"kind": "click", "path": "/om", "x": 0.5, "y": 0.5, "visitor_id": VISITOR}])
    rows = owner_conn.execute("select kind, path, visitor_id, referrer from analytics_events").fetchall()
    assert rows == [("pageview", "/om", None, "www.google.com")]


async def test_with_consent_clicks_and_scroll_are_stored(client, owner_conn):
    assert (await client.post("/api/consent", json={"statistics": True, "visitor_id": VISITOR})).status_code == 200
    r = await _collect(client, [{"kind": "pageview", "path": "/", "visitor_id": VISITOR, "session_id": "s1"},
                                {"kind": "click", "path": "/", "x": 0.25, "y": 1.7, "visitor_id": VISITOR},
                                {"kind": "scroll", "path": "/", "depth": 0.8, "visitor_id": VISITOR},
                                {"kind": "pageview", "path": "/admin/users", "visitor_id": VISITOR}])
    assert r.status_code == 204
    rows = owner_conn.execute("select kind, visitor_id, x, y, depth from analytics_events order by kind").fetchall()
    assert rows == [("click", VISITOR, 0.25, 1.0, None), ("pageview", VISITOR, None, None, None),
                    ("scroll", VISITOR, None, None, 0.8)]

    # Withdrawing consent stops tracking for that id.
    await client.post("/api/consent", json={"statistics": False, "visitor_id": VISITOR})
    await _collect(client, [{"kind": "click", "path": "/", "x": 0.1, "y": 0.1, "visitor_id": VISITOR}])
    assert owner_conn.execute("select count(*) from analytics_events where kind = 'click'").fetchone()[0] == 1


async def test_admin_analytics_and_heatmap(make_client):
    admin = make_client()
    await full_user(admin, "11111111")
    visitor = make_client(user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile Safari/604.1")
    await visitor.post("/api/consent", json={"statistics": True, "visitor_id": VISITOR})
    await _collect(visitor, [{"kind": "pageview", "path": "/", "visitor_id": VISITOR, "session_id": "s1"},
                             {"kind": "pageview", "path": "/priser", "prev_path": "/", "visitor_id": VISITOR,
                              "session_id": "s1"},
                             {"kind": "click", "path": "/priser", "x": 0.3, "y": 0.2, "visitor_id": VISITOR},
                             {"kind": "scroll", "path": "/priser", "depth": 0.55, "visitor_id": VISITOR}])

    stats = (await admin.get("/api/admin/analytics?days=7")).json()
    assert stats["totals"]["pageviews"] == 2 and stats["totals"]["visitors"] == 1
    assert stats["flows"] == [{"from": "/", "to": "/priser", "n": 1}]
    assert stats["devices"] == [{"device": "mobile", "pageviews": 2}]

    pages = (await admin.get("/api/admin/heatmaps/pages")).json()
    assert pages[0]["path"] == "/priser"
    heat = (await admin.get("/api/admin/heatmaps", params={"path": "/priser"})).json()
    assert heat["clicks"] == [[0.3, 0.2]]
    assert heat["scroll"][5]["share"] == 1 and heat["scroll"][6]["share"] == 0
