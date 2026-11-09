"""/admin/consumption: reports per period, model and user; budgets with caps, warnings and end dates; the user's own page."""

import dataclasses
from datetime import date, timedelta

import pytest

from app import ai, config
from tests.helpers import full_user, otp_login
from tests.test_ai import provider


@pytest.fixture
def ai_on(monkeypatch):
    monkeypatch.setattr(config, "settings", dataclasses.replace(config.settings, ai_api_key="test-key"))

    def use(prompt: int, completion: int):
        monkeypatch.setattr(ai, "transport", provider([
            {"choices": [{"delta": {"content": "ok"}}]},
            {"choices": [], "usage": {"prompt_tokens": prompt, "completion_tokens": completion}}]))
    return use


async def setup(make_client):
    admin = make_client()
    await full_user(admin, "11111111")
    user = make_client()
    await otp_login(user, "22222222")
    user_id = (await admin.get("/api/admin/users")).json()["items"][1]["id"]
    return admin, user, user_id


def chat(client):
    return client.post("/api/ai/chat", json={"messages": [{"role": "user", "content": "hej"}]})


def budget(user_id: int, **kw) -> dict:
    return {"user_id": user_id, "monthly_tokens": 1000, "warn_pcts": [50, 80], "hard": True,
            "starts_on": date.today().isoformat(), **kw}


async def test_budget_warns_then_blocks(make_client, ai_on, owner_conn):
    admin, user, user_id = await setup(make_client)
    r = await admin.post("/api/admin/consumption/budgets", json=budget(user_id, note="Pilot"))
    assert r.status_code == 200, r.text
    budget_id = r.json()["id"]

    ai_on(400, 200)  # 600 of 1000: passes 50 %
    assert (await chat(user)).status_code == 200
    status = (await user.get("/api/ai/status")).json()
    assert status["limit"] == 1000 and status["used"] == 600 and status["warning"] == 50 and status["status"] == "warning"

    ai_on(300, 200)  # 1100: passes 80 % and the cap in one go
    assert (await chat(user)).status_code == 200
    r = await chat(user)
    assert r.status_code == 429 and "kvote" in r.json()["detail"]

    alerts = owner_conn.execute("select kind, pct, budget_id from ai_budget_alerts order by kind, pct").fetchall()
    assert alerts == [("cap", 100, budget_id), ("warning", 50, budget_id), ("warning", 80, budget_id)]
    # Each level is stored and announced once per month.
    from app import consumption, db
    async with db.connection() as conn:
        assert await consumption.after_usage(conn, user_id) == []
    events = [r[0] for r in owner_conn.execute("select event from webhook_deliveries").fetchall()]
    assert events == []  # no webhook endpoints configured

    audit = owner_conn.execute("select action, after from audit_log where table_name = 'ai_budgets'").fetchone()
    assert audit[0] == "create" and audit[1]["monthly_tokens"] == 1000 and audit[1]["note"] == "Pilot"


async def test_soft_budget_only_warns(make_client, ai_on):
    admin, user, user_id = await setup(make_client)
    await admin.post("/api/admin/consumption/budgets", json=budget(user_id, monthly_tokens=100, hard=False))
    ai_on(100, 50)
    assert (await chat(user)).status_code == 200
    assert (await chat(user)).status_code == 200
    status = (await user.get("/api/ai/status")).json()
    assert status["enabled"] and status["status"] == "over" and status["blocked"] is False


async def test_period_total_blocks(make_client, ai_on):
    admin, user, user_id = await setup(make_client)
    await admin.post("/api/admin/consumption/budgets", json=budget(user_id, monthly_tokens=10_000, total_tokens=150))
    ai_on(100, 100)
    assert (await chat(user)).status_code == 200
    r = await chat(user)
    assert r.status_code == 429 and "perioden" in r.json()["detail"]


async def test_budget_dates_and_overlap(make_client, ai_on):
    admin, user, user_id = await setup(make_client)
    today = date.today()
    expired = budget(user_id, monthly_tokens=5, starts_on=(today - timedelta(days=60)).isoformat(),
                     ends_on=(today - timedelta(days=1)).isoformat())
    assert (await admin.post("/api/admin/consumption/budgets", json=expired)).status_code == 200
    planned = budget(user_id, monthly_tokens=7, starts_on=(today + timedelta(days=10)).isoformat())
    planned_id = (await admin.post("/api/admin/consumption/budgets", json=planned)).json()["id"]

    # Neither applies today: the instance default does.
    status = (await user.get("/api/ai/status")).json()
    assert status["limit"] == 200_000

    # No end date overlaps the planned one; a budget that ends before it does not.
    clash = await admin.post("/api/admin/consumption/budgets", json=budget(user_id))
    assert clash.status_code == 409
    ok = await admin.post("/api/admin/consumption/budgets",
                          json=budget(user_id, ends_on=(today + timedelta(days=9)).isoformat()))
    assert ok.status_code == 200
    assert (await user.get("/api/ai/status")).json()["limit"] == 1000

    bad = await admin.post("/api/admin/consumption/budgets",
                           json=budget(user_id, starts_on=today.isoformat(), ends_on=(today - timedelta(days=1)).isoformat()))
    assert bad.status_code == 422
    assert (await admin.post("/api/admin/consumption/budgets", json=budget(user_id, warn_pcts=[33]))).status_code == 422

    items = (await admin.get("/api/admin/consumption/budgets")).json()["items"]
    assert sorted(i["status"] for i in items) == ["active", "expired", "planned"]
    assert [i["current"] for i in items if i["status"] == "active"] == [True]

    # Change and delete are audited; a budget cannot move to another user.
    moved = await admin.put(f"/api/admin/consumption/budgets/{planned_id}", json={**planned, "user_id": 1})
    assert moved.status_code == 400
    r = await admin.put(f"/api/admin/consumption/budgets/{planned_id}", json={**planned, "monthly_tokens": 9, "ends_on": None})
    assert r.status_code == 200
    assert (await admin.delete(f"/api/admin/consumption/budgets/{planned_id}")).status_code == 200
    assert (await admin.delete(f"/api/admin/consumption/budgets/{planned_id}")).status_code == 404


async def test_report_per_period_model_and_user(make_client, ai_on, owner_conn):
    admin, user, user_id = await setup(make_client)
    ai_on(1000, 500)
    assert (await chat(user)).status_code == 200
    owner_conn.execute("""insert into ai_usage (user_id, surface, model, prompt_tokens, completion_tokens, ts)
                          values (%s, 'word', 'Mistral-Nemo-Instruct-2407', 300, 100, now() - interval '3 days')""",
                       (user_id,))
    r = await admin.put("/api/admin/consumption/prices", json={"items": [
        {"model": "Meta-Llama-3_3-70B-Instruct", "input_per_million": "4", "output_per_million": "8"}]})
    assert r.status_code == 200

    day = (await admin.get("/api/admin/consumption?range=day")).json()
    assert day["period"]["bucket"] == "hour" and len(day["series"]) == 24
    assert day["totals"]["requests"] == 1 and day["totals"]["prompt_tokens"] == 1000

    month = (await admin.get("/api/admin/consumption?range=month")).json()
    assert len(month["series"]) == 30 and month["totals"]["requests"] == 2
    models = {m["model"]: m for m in month["models"]}
    assert float(models["Meta-Llama-3_3-70B-Instruct"]["cost"]) == pytest.approx(0.008)  # 1000·4/1e6 + 500·8/1e6
    assert models["Mistral-Nemo-Instruct-2407"]["priced"] is False
    assert {s["surface"] for s in month["surfaces"]} == {"app", "word"}
    users = {u["id"]: u for u in month["users"]}
    assert users[user_id]["tokens"] == 1900 and users[user_id]["policy"]["source"] == "default"

    year = (await admin.get("/api/admin/consumption?range=year")).json()
    assert year["period"]["bucket"] == "month" and len(year["series"]) == 12

    today = date.today()
    custom = (await admin.get(f"/api/admin/consumption?range=custom&from={(today - timedelta(days=6)).isoformat()}"
                              f"&to={today.isoformat()}")).json()
    assert len(custom["series"]) == 7
    assert (await admin.get("/api/admin/consumption?range=custom")).status_code == 400

    csv = await admin.get("/api/admin/consumption/export.csv?range=month")
    assert csv.status_code == 200 and "Mistral-Nemo-Instruct-2407" in csv.text

    prices = (await admin.get("/api/admin/consumption/prices")).json()["items"]
    assert {p["model"] for p in prices} >= {"Meta-Llama-3_3-70B-Instruct", "Mistral-Nemo-Instruct-2407"}

    # A plain user cannot read any of it.
    assert (await user.get("/api/admin/consumption")).status_code == 403


async def test_users_own_usage_and_defaults(make_client, ai_on):
    admin, user, user_id = await setup(make_client)
    r = await admin.put("/api/admin/consumption/defaults", json={"monthly_tokens": 1000, "warn_pct": 50})
    assert r.status_code == 200
    assert (await admin.put("/api/admin/consumption/defaults", json={"monthly_tokens": 1000, "warn_pct": 33})).status_code == 422
    ai_on(400, 200)
    await chat(user)

    me = (await user.get("/api/ai/usage")).json()
    assert me["enabled"] is True
    assert me["policy"]["source"] == "default" and me["policy"]["limit"] == 1000 and me["policy"]["warning"] == 50
    assert sum(d["tokens"] for d in me["days"]) == 600
    assert me["surfaces"][0]["surface"] == "app" and me["months"][0]["tokens"] == 600
    assert [a["kind"] for a in me["alerts"]] == ["warning"]

    await admin.post("/api/admin/consumption/budgets", json=budget(user_id, note="kun for admins"))
    me = (await user.get("/api/ai/usage")).json()
    assert me["policy"]["source"] == "budget" and "note" not in str(me["policy"])
    assert me["after_budget_limit"] == 1000


async def test_gdpr_export_has_budgets(make_client, ai_on):
    admin, user, user_id = await setup(make_client)
    await admin.post("/api/admin/consumption/budgets", json=budget(user_id))
    from app import db, gdpr
    async with db.connection() as conn:
        data = await gdpr.build_user_export(conn, user_id)
    assert data["ai_budgets"][0]["monthly_tokens"] == 1000 and data["ai_budget_alerts"] == []


async def test_warning_mail_to_the_user(make_client, ai_on, owner_conn, monkeypatch):
    from app import consumption, jobs, mail
    sent = []

    async def fake_send(to, subject, text, html_body, sender_name):
        sent.append((to, subject, text))
    monkeypatch.setattr(mail, "send_mail", fake_send)

    admin, user, user_id = await setup(make_client)
    owner_conn.execute("update users set email = 'mette@kunde.dk' where id = %s", (user_id,))
    await admin.post("/api/admin/consumption/budgets", json=budget(user_id))

    ai_on(400, 200)  # 60 %: passes 50 %
    await chat(user)
    assert await jobs.run_pending() == 1
    assert len(sent) == 1
    to, subject, text = sent[0]
    assert to == "mette@kunde.dk" and "50 %" in subject and "/konto/forbrug" in text and "hej" not in text
    assert owner_conn.execute("select count(*) from ai_budget_alerts where mailed_at is not null").fetchone()[0] == 1

    ai_on(300, 200)  # 110 %: passes 80 % and the cap in one call → one mail, about the cap
    await chat(user)
    await jobs.run_pending()
    assert len(sent) == 2 and "loft" in sent[1][1]

    # A mailed alert is not mailed again.
    alert_id = owner_conn.execute("select id from ai_budget_alerts where kind = 'cap'").fetchone()[0]
    assert (await consumption.send_alert_mail({"alert_id": alert_id}, {}))["skipped"] == "already mailed"

    # Switched off in /admin/consumption: alerts and webhooks still happen, mails do not.
    r = await admin.put("/api/admin/consumption/defaults", json={"monthly_tokens": 200000, "warn_pct": 80, "warning_mail": False})
    assert r.status_code == 200
    owner_conn.execute("delete from ai_budget_alerts")
    from app import db
    async with db.connection() as conn:
        assert len(await consumption.after_usage(conn, user_id)) == 3
    assert await jobs.run_pending() == 0 and len(sent) == 2


async def test_no_mail_without_email(make_client, ai_on, monkeypatch):
    from app import jobs, mail
    sent = []

    async def fake_send(*args):
        sent.append(args)
    monkeypatch.setattr(mail, "send_mail", fake_send)
    admin, user, user_id = await setup(make_client)
    await admin.post("/api/admin/consumption/budgets", json=budget(user_id))
    ai_on(400, 200)
    await chat(user)
    await jobs.run_pending()
    assert sent == []
