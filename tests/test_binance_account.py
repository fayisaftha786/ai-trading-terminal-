from types import SimpleNamespace

import pytest

from app.services.binance_account import BinanceAccountUnavailable, BinanceSpotReadOnly


def make_config(**overrides):
    values = {
        "binance_readonly_enabled": False,
        "binance_readonly_api_key": None,
        "binance_readonly_api_secret": None,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_status_is_read_only_and_never_offers_order_execution():
    status = BinanceSpotReadOnly(make_config()).status()
    assert status["environment"] == "production_read_only"
    assert status["order_execution_available"] is False
    assert status["live_trading_enabled"] is False
    assert status["ready_for_connection_check"] is False
    assert status["trade_permission_required"] is False
    assert status["withdrawal_permission_required"] is False


def test_connection_fails_closed_when_disabled():
    with pytest.raises(BinanceAccountUnavailable, match="disabled"):
        BinanceSpotReadOnly(make_config()).check_account()


def test_connection_fails_closed_without_credentials():
    with pytest.raises(BinanceAccountUnavailable, match="credentials are missing"):
        BinanceSpotReadOnly(make_config(binance_readonly_enabled=True)).check_account()


def test_reads_account_balance_without_enabling_orders():
    captured = {}

    class FakeExchange:
        def __init__(self, params):
            captured["params"] = params

        def fetch_balance(self):
            return {
                "free": {"USDT": 50.0, "BTC": 0.01, "ZERO": 0},
                "used": {"USDT": 2.0},
                "total": {"USDT": 52.0, "BTC": 0.01, "ZERO": 0},
            }

        def close(self):
            captured["closed"] = True

    config = make_config(
        binance_readonly_enabled=True,
        binance_readonly_api_key="READ_KEY",
        binance_readonly_api_secret="READ_SECRET",
    )
    result = BinanceSpotReadOnly(config, exchange_factory=FakeExchange).check_account()
    assert captured["params"]["apiKey"] == "READ_KEY"
    assert result["connected"] is True
    assert result["available_assets"] == ["BTC", "USDT"]
    assert result["usdt_free"] == 50.0
    assert result["usdt_total"] == 52.0
    assert result["order_execution_available"] is False
    assert result["live_trading_enabled"] is False
    assert "READ_SECRET" not in str(result)
    assert captured["closed"] is True


def test_provider_exception_does_not_leak_secret():
    class FakeExchange:
        def __init__(self, params):
            pass

        def fetch_balance(self):
            raise RuntimeError("failure with READ_SECRET")

        def close(self):
            pass

    config = make_config(
        binance_readonly_enabled=True,
        binance_readonly_api_key="READ_KEY",
        binance_readonly_api_secret="READ_SECRET",
    )
    with pytest.raises(BinanceAccountUnavailable) as exc:
        BinanceSpotReadOnly(config, exchange_factory=FakeExchange).check_account()
    assert "READ_SECRET" not in str(exc.value)
    assert "RuntimeError" in str(exc.value)
