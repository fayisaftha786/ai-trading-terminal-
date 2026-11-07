from types import SimpleNamespace

import pytest

from app.services.binance_account import BinanceAccountUnavailable, BinanceReadOnlyAccount


def config(**overrides):
    values = {
        "binance_readonly_enabled": True,
        "binance_readonly_api_key": "test-key",
        "binance_readonly_api_secret": "test-secret",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class FakeExchange:
    def __init__(self, options):
        self.options = options
        self.closed = False

    def fetch_balance(self):
        return {
            "free": {"USDT": 12.5, "BTC": 0.01},
            "used": {"USDT": 2.0},
            "total": {"USDT": 14.5, "BTC": 0.01, "ETH": 0.0},
        }

    def close(self):
        self.closed = True


def test_status_is_read_only_and_never_exposes_order_execution():
    adapter = BinanceReadOnlyAccount(config())
    state = adapter.status()
    assert state["ready_for_connection_check"] is True
    assert state["order_execution_available"] is False
    assert state["live_trading_enabled"] is False
    assert state["withdrawals_permission_requested"] is False


def test_connection_returns_minimal_balances_and_closes_exchange():
    created = []

    def factory(options):
        exchange = FakeExchange(options)
        created.append(exchange)
        return exchange

    result = BinanceReadOnlyAccount(config(), factory).check_account()
    assert result["connected"] is True
    assert result["available_assets"] == ["BTC", "USDT"]
    assert result["usdt_free"] == 12.5
    assert result["usdt_used"] == 2.0
    assert result["usdt_total"] == 14.5
    assert result["live_trading_enabled"] is False
    assert created[0].closed is True
    assert created[0].options["enableRateLimit"] is True


def test_disabled_or_missing_credentials_fail_closed():
    with pytest.raises(BinanceAccountUnavailable):
        BinanceReadOnlyAccount(config(binance_readonly_enabled=False)).check_account()
    with pytest.raises(BinanceAccountUnavailable):
        BinanceReadOnlyAccount(config(binance_readonly_api_key=None)).check_account()


def test_exchange_error_does_not_leak_provider_message():
    class BrokenExchange(FakeExchange):
        def fetch_balance(self):
            raise RuntimeError("sensitive provider response")

    with pytest.raises(BinanceAccountUnavailable) as exc:
        BinanceReadOnlyAccount(config(), lambda options: BrokenExchange(options)).check_account()
    assert "sensitive provider response" not in str(exc.value)
