from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.security import InvalidAccessToken, create_access_token, verify_access_token
from app.settings import settings


PASSWORD = "correct horse battery staple 2026"
SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef"


def cloud_client(tmp_path):
    cfg = replace(
        settings,
        environment="production",
        database_path=tmp_path / "cloud.db",
        auth_username="owner",
        auth_password=PASSWORD,
        auth_secret=SECRET,
        auth_token_ttl_minutes=60,
    )
    return TestClient(create_app(config=cfg, db_path=tmp_path / "cloud.db"))


def test_cloud_api_rejects_unauthenticated_requests(tmp_path):
    with cloud_client(tmp_path) as client:
        assert client.get("/api/auth/status").json()["required"] is True
        health = client.get("/api/health")
        assert health.status_code == 200
        assert health.json() == {"status": "ok", "mode": "paper_only", "live_trading_enabled": False,
                                 "version": "0.5.0-cloud"}
        assert health.headers["cache-control"] == "no-store, private"
        response = client.get("/api/dashboard")
        assert response.status_code == 401
        assert response.json()["detail"] == "Authentication required"


def test_cloud_login_returns_short_lived_bearer_token_and_unlocks_api(tmp_path):
    with cloud_client(tmp_path) as client:
        rejected = client.post("/api/auth/login", json={"username": "owner", "password": "wrong"})
        assert rejected.status_code == 401
        response = client.post("/api/auth/login", json={"username": "owner", "password": PASSWORD})
        assert response.status_code == 200
        body = response.json()
        assert body["token_type"] == "Bearer"
        assert body["expires_in"] == 3600
        headers = {"Authorization": f"Bearer {body['access_token']}"}
        dashboard = client.get("/api/dashboard", headers=headers)
        assert dashboard.status_code == 200
        assert dashboard.headers["cache-control"] == "no-store, private"
        invalid = client.get("/api/trades", headers={"Authorization": "Bearer invalid"})
        assert invalid.status_code == 401
        assert invalid.headers["cache-control"] == "no-store, private"


def test_cloud_login_rate_limits_repeated_failures(tmp_path):
    with cloud_client(tmp_path) as client:
        for _ in range(5):
            response = client.post("/api/auth/login", json={"username": "owner", "password": "wrong"})
            assert response.status_code == 401
        limited = client.post("/api/auth/login", json={"username": "owner", "password": PASSWORD})
        assert limited.status_code == 429


def test_production_mode_refuses_weak_or_missing_secrets(tmp_path):
    cfg = replace(settings, environment="production", database_path=tmp_path / "bad.db",
                  auth_username="owner", auth_password="short", auth_secret="tiny")
    with pytest.raises(RuntimeError, match="APP_PASSWORD"):
        create_app(config=cfg, db_path=tmp_path / "bad.db")


def test_token_expiry_and_tampering_fail_closed():
    token = create_access_token("owner", SECRET, 15, now=1_000)
    payload = verify_access_token(token, username="owner", secret=SECRET, max_ttl_minutes=15, now=1_001)
    assert payload["sub"] == "owner"
    with pytest.raises(InvalidAccessToken):
        verify_access_token(token, username="owner", secret=SECRET, max_ttl_minutes=15, now=1_901)
    with pytest.raises(InvalidAccessToken):
        verify_access_token(token + "x", username="owner", secret=SECRET, max_ttl_minutes=15, now=1_001)
