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
