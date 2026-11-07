from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import settings


@pytest.fixture
def client(tmp_path):
    cfg = replace(settings, database_path=tmp_path / "test.db", initial_capital_usd=100.0)
    app = create_app(config=cfg, db_path=tmp_path / "test.db")
    with TestClient(app) as test_client:
        yield test_client
