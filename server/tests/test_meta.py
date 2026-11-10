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
