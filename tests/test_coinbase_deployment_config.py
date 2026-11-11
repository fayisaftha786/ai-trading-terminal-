from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_legacy_render_blueprint_uses_coinbase_usd_and_has_no_binance_settings():
    render = (ROOT / "render.yaml").read_text(encoding="utf-8")
    assert "key: CEX_EXCHANGE\n        value: coinbase" in render
    assert "value: BTC/USD,ETH/USD,SOL/USD" in render
    assert "binance" not in render.lower()
    assert "BINANCE_TESTNET" not in render
    assert "autoDeploy: false" in render


def test_android_install_guide_describes_coinbase_and_six_hour_confirmation():
    guide = (ROOT / "docs/GET_ANDROID_APK.md").read_text(encoding="utf-8")
    assert "Coinbase public market data" in guide
    assert "BTC/USD" in guide
    assert "1-hour and 6-hour candles" in guide
    assert "binance" not in guide.lower()
