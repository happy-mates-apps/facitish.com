"""Træstrukturer (app/meta.py): paths, who may create where, private trees, moving subtrees, audit and GDPR."""

import io
import json
import zipfile

from app import meta
from tests.helpers import full_user, otp_login


def test_slugs_and_paths():
    assert meta.slugify("  Kundeservice B2B ") == "kundeservice-b2b"
    assert meta.slugify("Økonomi & Løn") == "økonomi-løn"
    assert meta.slugify("1. linje") == "1-linje"
    assert meta.slugify("!!!") == ""
    assert meta.valid_slug("drift-it") and meta.valid_slug("københavn")
    assert not meta.valid_slug("Drift") and not meta.valid_slug("a/b") and not meta.valid_slug("-a") and not meta.valid_slug("")
    assert meta.ancestor_paths("/org/drift/support/1-linje") == ["/org/drift", "/org/drift/support"]
    assert meta.ancestor_paths("/org/drift") == []
    assert meta.ancestor_paths("/~/7/projekter/gaer") == ["/~/7/projekter"]
    assert meta.display_path("/~/7/projekter", 7) == "~/projekter"
    assert meta.display_path("/~/7/projekter", 8) == "/~/7/projekter"


async def _admin_and_user(make_client):
    admin = make_client()
    await full_user(admin, "11111111")  # the first user is the super admin, with a passkey (second factor)
    user = make_client()
    await otp_login(user, "22222222")
    return admin, user


async def _org(admin) -> dict:
    r = await admin.post("/api/admin/meta/dimensions", json={"slug": "org", "label": "Organisation", "color": "#2563EB"})
    assert r.status_code == 200, r.text
    dim = r.json()
    r = await admin.post("/api/meta/nodes", json={"dimension": "org", "label": "Drift"})
    assert r.status_code == 200, r.text
    drift = r.json()
    r = await admin.post("/api/meta/nodes", json={"dimension": "org", "parent_id": drift["id"], "label": "Support"})
    assert r.status_code == 200, r.text
    return {"dim": dim, "drift": drift, "support": r.json()}


async def test_admin_builds_the_skeleton_users_grow_the_leaves(make_client, owner_conn):
    admin, user = await _admin_and_user(make_client)
    t = await _org(admin)
    assert t["support"]["path"] == "/org/drift/support" and t["support"]["depth"] == 2
    assert [a["label"] for a in t["support"]["trail"]] == ["Drift"]

    # The user sees who may create where, and the top level is closed to them.
    dims = (await user.get("/api/meta/dimensions")).json()
    org = next(d for d in dims if d["slug"] == "org")
    assert org["can_create"] is False and org["create_denied"] == "Topniveauet oprettes af admin"
    assert next(d for d in dims if d["slug"] == "~")["can_create"] is True
    r = await user.post("/api/meta/nodes", json={"dimension": "org", "label": "Salg"})
    assert r.status_code == 403 and r.json()["detail"] == "Topniveauet oprettes af admin"

    # Below the top level everyone may add.
    r = await user.post("/api/meta/nodes", json={"dimension": "org", "parent_id": t["drift"]["id"], "label": "Kundeservice B2B"})
    assert r.status_code == 200, r.text
    ks = r.json()
    assert ks["path"] == "/org/drift/kundeservice-b2b" and ks["can_create"] is True
    r = await user.post("/api/meta/nodes", json={"dimension": "org", "parent_id": t["drift"]["id"], "label": "kundeservice  B2B"})
    assert r.status_code == 409

    tree = (await user.get("/api/meta/tree?dimension=org&depth=3")).json()
    assert tree["dimension"]["can_create"] is False
    by_path = {n["path"]: n for n in tree["nodes"]}
    assert by_path["/org/drift"]["has_children"] is True and by_path["/org/drift"]["can_create"] is True
    assert [n["label"] for n in tree["nodes"] if n["parent_id"] == t["drift"]["id"]] == ["Support", "Kundeservice B2B"]

    # A start node limits the tree and the search; ids resolve to labels with their trail.
    tree = (await user.get(f"/api/meta/tree?root={t['drift']['id']}")).json()
    assert tree["root"]["label"] == "Drift" and {n["label"] for n in tree["nodes"]} == {"Support", "Kundeservice B2B"}
    hits = (await user.get(f"/api/meta/search?q=serv&root={t['drift']['id']}")).json()
    assert [h["label"] for h in hits] == ["Kundeservice B2B"] and hits[0]["trail"][0]["label"] == "Drift"
    nodes = (await user.get(f"/api/meta/nodes?ids={ks['id']},{t['drift']['id']},99999")).json()
    assert [n["label"] for n in nodes] == ["Kundeservice B2B", "Drift"]

    # Shared nodes are edited in /admin/meta, not through the user API.
    assert (await user.patch(f"/api/meta/nodes/{ks['id']}", json={"label": "X"})).status_code == 403
    assert (await user.post("/api/admin/meta/dimensions", json={"slug": "x", "label": "X"})).status_code == 403

    actions = owner_conn.execute("""select action, actor_user_id from audit_log where table_name = 'meta_nodes'
                                    order by id""").fetchall()
    assert [a[0] for a in actions] == ["create", "create", "create"]


async def test_locked_dimension_is_admin_only(make_client):
    admin, user = await _admin_and_user(make_client)
    t = await _org(admin)
    r = await admin.patch(f"/api/admin/meta/dimensions/{t['dim']['id']}", json={"locked": True})
    assert r.status_code == 200 and r.json()["locked"] is True
    r = await user.post("/api/meta/nodes", json={"dimension": "org", "parent_id": t["support"]["id"], "label": "1. linje"})
    assert r.status_code == 403 and "låst" in r.json()["detail"]
    r = await admin.post("/api/meta/nodes", json={"dimension": "org", "parent_id": t["support"]["id"], "label": "1. linje"})
    assert r.status_code == 200 and r.json()["path"] == "/org/drift/support/1-linje"


async def test_private_tree_is_only_the_owners(make_client):
    admin, user = await _admin_and_user(make_client)
    r = await user.post("/api/meta/nodes", json={"dimension": "~", "label": "Projekter"})
    assert r.status_code == 200, r.text
    proj = r.json()
    assert proj["display_path"] == "~/projekter" and proj["private"] is True
    r = await user.post("/api/meta/nodes", json={"dimension": "~", "parent_id": proj["id"], "label": "Gær"})
    gaer = r.json()
    assert gaer["display_path"] == "~/projekter/gær"

    # Nobody else sees it, not even an admin, and it cannot be used as a parent.
    assert (await admin.get(f"/api/meta/nodes?ids={proj['id']}")).json() == []
    assert (await admin.get("/api/meta/tree?dimension=~")).json()["nodes"] == []
    assert (await admin.post("/api/meta/nodes", json={"dimension": "~", "parent_id": proj["id"], "label": "X"})).status_code == 404

    # The owner renames, moves and archives their own nodes.
    r = await user.patch(f"/api/meta/nodes/{gaer['id']}", json={"label": "Gær-base", "slug": "gaer-base", "parent_id": None})
    assert r.status_code == 200, r.text
    assert r.json()["display_path"] == "~/gaer-base" and r.json()["depth"] == 1
    r = await user.patch(f"/api/meta/nodes/{proj['id']}", json={"archived": True})
    assert r.json()["archived"] is True
    assert [n["label"] for n in (await user.get("/api/meta/tree?dimension=~")).json()["nodes"]] == ["Gær-base"]


async def test_moving_a_node_rewrites_its_subtree(make_client, owner_conn):
    admin, user = await _admin_and_user(make_client)
    t = await _org(admin)
    salg = (await admin.post("/api/meta/nodes", json={"dimension": "org", "label": "Salg"})).json()
    first = (await user.post("/api/meta/nodes", json={"dimension": "org", "parent_id": t["support"]["id"], "label": "1. linje"})).json()

    r = await admin.patch(f"/api/admin/meta/nodes/{t['support']['id']}", json={"parent_id": salg["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["path"] == "/org/salg/support"
    paths = dict(owner_conn.execute("select id, path from meta_nodes").fetchall())
    assert paths[first["id"]] == "/org/salg/support/1-linje"

    # Not under itself; not onto an existing path.
    r = await admin.patch(f"/api/admin/meta/nodes/{salg['id']}", json={"parent_id": first["id"]})
    assert r.status_code == 400
    clash = (await admin.post("/api/meta/nodes", json={"dimension": "org", "parent_id": salg["id"], "label": "Drift"})).json()
    r = await admin.patch(f"/api/admin/meta/nodes/{clash['id']}", json={"parent_id": None})
    assert r.status_code == 409

    # A subtree filter covers the node and everything under it.
    ids = (await user.get(f"/api/meta/expand?ids={salg['id']}")).json()["ids"]
    assert set(ids) == {salg["id"], t["support"]["id"], first["id"], clash["id"]}

    # Deleting a node with children needs force; the audit row counts them.
    assert (await admin.delete(f"/api/admin/meta/nodes/{salg['id']}")).status_code == 409
    r = await admin.delete(f"/api/admin/meta/nodes/{salg['id']}?force=true")
    assert r.status_code == 200 and r.json()["deleted"] == 4
    detail = owner_conn.execute("""select detail from audit_log where table_name = 'meta_nodes' and action = 'delete'""").fetchone()[0]
    assert detail["descendants"] == 3


async def test_private_tree_is_exported_and_erased(make_client, owner_conn):
    admin, user = await _admin_and_user(make_client)
    await _org(admin)
    await user.post("/api/meta/nodes", json={"dimension": "~", "label": "Læseliste"})
    r = await user.get("/api/me/export")
    data = json.loads(zipfile.ZipFile(io.BytesIO(r.content)).read("data.json"))
    assert [n["label"] for n in data["meta_private_nodes"]] == ["Læseliste"]

    r = await user.post("/api/me/delete", json={"confirm_phone": "22222222"})
    assert r.status_code == 200, r.text
    assert owner_conn.execute("select count(*) from meta_nodes where owner_id is not null").fetchone()[0] == 0
    assert owner_conn.execute("select count(*) from meta_nodes").fetchone()[0] == 2


# ── Tagging objects (app/meta_objects.py) ──────────────────────────────────

def test_url_normalisation():
    from app.meta_objects import normalize_url
    assert normalize_url("https://GitHub.com/happy/surdej-v1/?utm_source=slack&b=2&a=1#readme") == "https://github.com/happy/surdej-v1/?a=1&b=2"
    assert normalize_url("https://Example.com:443/Docs/") == "https://example.com/Docs"
    assert normalize_url("https://example.com/") == "https://example.com"
    assert normalize_url("https://github.com/happy/*") == "https://github.com/happy/*"
    assert normalize_url("Status.Example.com") == "status.example.com"
    for bad in ("ftp://x.dk/a", "not a url", "javascript:alert(1)"):
        try:
            normalize_url(bad)
            raise AssertionError(bad)
        except Exception as e:  # noqa: BLE001
            assert getattr(e, "status_code", None) == 400


async def test_tagging_across_dimensions_and_context(make_client, owner_conn):
    admin, user = await _admin_and_user(make_client)
    t = await _org(admin)
    await admin.post("/api/admin/meta/dimensions", json={"slug": "produkt", "label": "Produkter"})
    gaer = (await admin.post("/api/meta/nodes", json={"dimension": "produkt", "label": "Gær"})).json()
    mine = (await user.post("/api/meta/nodes", json={"dimension": "~", "label": "Læseliste"})).json()

    # One object, three nodes: shared in two dimensions and the user's own tree.
    r = await user.post("/api/meta/objects", json={"kind": "url", "ref": "https://Status.example.com/?utm_source=x",
                                                   "title": "Status", "node_ids": [t["support"]["id"], gaer["id"], mine["id"]]})
    assert r.status_code == 200, r.text
    obj = r.json()
    assert obj["created"] is True and obj["ref"] == "https://status.example.com"
    assert {n["label"] for n in obj["nodes"]} == {"Support", "Gær", "Læseliste"}

    # Same URL again finds the object; the admin does not see the user's private tag.
    r = await admin.post("/api/meta/objects", json={"kind": "url", "ref": "https://status.example.com/", "title": "Andet navn",
                                                    "node_ids": [t["drift"]["id"]]})
    assert r.json()["created"] is False and r.json()["title"] == "Status"
    assert {n["label"] for n in r.json()["nodes"]} == {"Drift", "Support", "Gær"}

    # Context of Support: parents, siblings, children, objects, and related nodes via shared objects.
    ctx = (await admin.get(f"/api/meta/context?node={t['support']['id']}")).json()
    assert [p["label"] for p in ctx["parents"]] == ["Drift"]
    assert [o["title"] for o in ctx["objects"]] == ["Status"]
    assert [r["node"]["label"] for r in ctx["related"]] == ["Gær"]  # Drift is the node's own line

    # Objects at a node, also in the subtree; the tree counts direct tags.
    assert [o["title"] for o in (await user.get(f"/api/meta/objects?node={t['drift']['id']}&subtree=true")).json()] == ["Status"]
    tree = (await user.get("/api/meta/tree?dimension=org")).json()
    assert {n["label"]: n["objects"] for n in tree["nodes"]} == {"Drift": 1, "Support": 1}

    # URL look-up for the extension: exact before pattern before host.
    await user.post("/api/meta/objects", json={"kind": "url", "ref": "https://status.example.com/*", "title": "Alt på status",
                                               "node_ids": [gaer["id"]]})
    await user.post("/api/meta/objects", json={"kind": "url", "ref": "status.example.com", "title": "Værten", "node_ids": [gaer["id"]]})
    res = (await user.get("/api/meta/resolve-url?url=https://status.example.com/?fbclid=1")).json()
    assert [(m["title"], m["match"]) for m in res["matches"]] == [("Status", "exact"), ("Alt på status", "pattern"), ("Værten", "host")]
    res = (await user.get("/api/meta/resolve-url?url=https://status.example.com/incidents/42")).json()
    assert [m["match"] for m in res["matches"]] == ["pattern", "host"]

    # Entities by reference; the title is the creator's (or an admin's) to change.
    clip = (await user.post("/api/meta/objects", json={"kind": "entity", "ref": "clip:12", "title": "Mødenoter",
                                                       "node_ids": [t["support"]["id"]]})).json()
    assert (await admin.get("/api/meta/objects/by-ref?kind=entity&ref=clip:12")).json()["id"] == clip["id"]
    other = make_client()
    await otp_login(other, "33333333")
    assert (await other.patch(f"/api/meta/objects/{clip['id']}", json={"title": "X"})).status_code == 403
    assert (await user.patch(f"/api/meta/objects/{clip['id']}", json={"title": "Mødenoter 2"})).json()["title"] == "Mødenoter 2"

    actions = owner_conn.execute("select action from audit_log where table_name = 'meta_objects' order by id").fetchall()
    assert [a[0] for a in actions][:3] == ["create", "update", "update"]


async def test_private_tags_stay_private_and_last_tag_removes_object(make_client, owner_conn):
    admin, user = await _admin_and_user(make_client)
    t = await _org(admin)
    mine = (await user.post("/api/meta/nodes", json={"dimension": "~", "label": "Hemmeligt"})).json()
    obj = (await user.post("/api/meta/objects", json={"kind": "note", "title": "Min note", "node_ids": [mine["id"]]})).json()
    assert obj["ref"].startswith("note:")
    assert (await admin.get(f"/api/meta/objects/{obj['id']}")).status_code == 404

    # Setting the tags: the admin's view changes, the user's private tag stays.
    await user.put(f"/api/meta/objects/{obj['id']}/nodes", json={"node_ids": [mine["id"], t["support"]["id"]]})
    r = await admin.put(f"/api/meta/objects/{obj['id']}/nodes", json={"node_ids": [t["drift"]["id"]]})
    assert [n["label"] for n in r.json()["nodes"]] == ["Drift"]
    assert {n["label"] for n in (await user.get(f"/api/meta/objects/{obj['id']}")).json()["nodes"]} == {"Drift", "Hemmeligt"}

    # Removing the last tags deletes the object.
    await user.delete(f"/api/meta/objects/{obj['id']}/nodes/{t['drift']['id']}")
    r = await user.delete(f"/api/meta/objects/{obj['id']}/nodes/{mine['id']}")
    assert r.json() == {"id": obj["id"], "deleted": True}
    assert owner_conn.execute("select count(*) from meta_objects").fetchone()[0] == 0

    # A node with tags is not deleted by accident; with force its orphaned objects go too.
    o2 = (await user.post("/api/meta/objects", json={"kind": "entity", "ref": "clip:1", "title": "K", "node_ids": [t["support"]["id"]]})).json()
    r = await admin.delete(f"/api/admin/meta/nodes/{t['support']['id']}")
    assert r.status_code == 409 and "tags" in r.json()["detail"]
    assert (await admin.delete(f"/api/admin/meta/nodes/{t['support']['id']}?force=true")).status_code == 200
    assert owner_conn.execute("select count(*) from meta_objects where id = %s", (o2["id"],)).fetchone()[0] == 0


async def test_objects_in_private_tree_are_exported_and_erased(make_client, owner_conn):
    admin, user = await _admin_and_user(make_client)
    t = await _org(admin)
    mine = (await user.post("/api/meta/nodes", json={"dimension": "~", "label": "Mit"})).json()
    await user.post("/api/meta/objects", json={"kind": "note", "title": "Privat", "node_ids": [mine["id"]]})
    await user.post("/api/meta/objects", json={"kind": "url", "ref": "https://example.com", "title": "Delt", "node_ids": [t["drift"]["id"]]})
    r = await user.get("/api/me/export")
    data = json.loads(zipfile.ZipFile(io.BytesIO(r.content)).read("data.json"))
    assert {o["title"] for o in data["meta_objects_created"]} == {"Privat", "Delt"}
    assert len(data["meta_tags_set"]) == 2
    assert (await user.post("/api/me/delete", json={"confirm_phone": "22222222"})).status_code == 200
    rows = owner_conn.execute("select title, created_by from meta_objects").fetchall()
    assert rows == [("Delt", None)]
