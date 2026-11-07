def test_trading_modes_endpoint_separates_demo_qualification_from_live_execution(client):
    before = client.get("/api/trading/modes")
    assert before.status_code == 200
    result = before.json()
    assert result["demo"]["mode"] == "DEMO"
    assert result["demo"]["qualified_for_live_review"] is False
    assert result["original"]["mode"] == "ORIGINAL_LIVE"
    assert result["original"]["enabled"] is False
    assert result["original"]["locked"] is True
    assert result["original"]["automatic_promotion"] is False
    assert result["safety"]["real_orders_sent"] is False

    enabled = client.put("/api/automation/paper-trading", json={"enabled": True})
    assert enabled.status_code == 200
    after = client.get("/api/trading/modes").json()
    assert after["demo"]["automation_enabled"] is True
    assert after["original"]["enabled"] is False


def test_dashboard_displays_both_modes_and_keeps_live_button_disabled(client):
    page = client.get("/").text
    script = client.get("/static/app.js").text
    assert 'id="tradingModes"' in page
    assert "DEMO MODE" in page
    assert "ORIGINAL / LIVE MODE" in page
    assert "Live activation unavailable" in page
    assert "loadTradingModes" in script
