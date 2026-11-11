"""Alias domains redirect to the primary address (app/canonical_host.py, REDIRECT_HOSTS)."""

import dataclasses

import pytest

from app import config


@pytest.fixture
def aliases(monkeypatch):
    monkeypatch.setattr(config, "settings", dataclasses.replace(
        config.settings, origin="https://app.smeden.dk", redirect_hosts=("smeden.dk", "www.smeden.dk")))


async def test_alias_redirects_to_origin_with_path_and_query(client, aliases):
    r = await client.get("/w/om?lang=en", headers={"host": "www.smeden.dk"})
    assert r.status_code == 301
    assert r.headers["location"] == "https://app.smeden.dk/w/om?lang=en"


async def test_apex_with_port_and_trailing_dot_redirects(client, aliases):
    r = await client.get("/", headers={"host": "Smeden.dk.:443"})
    assert r.status_code == 301 and r.headers["location"] == "https://app.smeden.dk/"


async def test_other_methods_keep_method_with_308(client, aliases):
    r = await client.post("/api/public/consent", headers={"host": "smeden.dk", "X-Gaer": "1"}, json={})
    assert r.status_code == 308 and r.headers["location"] == "https://app.smeden.dk/api/public/consent"


async def test_primary_and_health_are_not_redirected(client, aliases):
    assert (await client.get("/health", headers={"host": "www.smeden.dk"})).status_code == 200
    r = await client.get("/health", headers={"host": "app.smeden.dk"})
    assert r.status_code == 200


async def test_nothing_happens_without_redirect_hosts(client):
    assert config.settings.redirect_hosts == ()
    r = await client.get("/health", headers={"host": "www.smeden.dk"})
    assert r.status_code == 200


def test_setting_is_parsed_from_the_environment(monkeypatch):
    monkeypatch.setenv("REDIRECT_HOSTS", " Smeden.dk , www.smeden.dk.,,")
    assert config.Settings().redirect_hosts == ("smeden.dk", "www.smeden.dk")
