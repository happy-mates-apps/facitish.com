import psycopg
import pytest

from tests.helpers import otp_login


async def test_app_user_cannot_change_or_delete_logs(client, app_conn):
    await otp_login(client, "12345678")
    for table in ("auth_log", "audit_log"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            app_conn.execute(f"update {table} set detail = '{{}}'")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            app_conn.execute(f"delete from {table}")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            app_conn.execute(f"truncate {table}")
        app_conn.execute(f"select count(*) from {table}")


async def test_nobody_can_update_logs(client, owner_conn):
    await otp_login(client, "12345678")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        owner_conn.execute("update auth_log set result = 'ok'")


async def test_purge_user_may_delete_but_not_touch_app_data(client, purge_conn):
    await otp_login(client, "12345678")
    purge_conn.execute("delete from auth_log where false")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        purge_conn.execute("delete from users")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        purge_conn.execute("update audit_log set action = 'x'")


async def test_profile_change_is_audited_with_before_and_after(client, owner_conn):
    await otp_login(client, "12345678")
    r = await client.patch("/api/me/profile", json={"display_name": "Mette"})
    assert r.status_code == 200
    row = owner_conn.execute("""select action, table_name, before, after from audit_log
                                where action = 'update'""").fetchone()
    assert row == ("update", "users", {"display_name": None}, {"display_name": "Mette"})
