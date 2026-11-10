import asyncio
import time
from dataclasses import replace
from app.services.market_data import MarketDataService
from app.settings import settings

class FakeCoinbaseAdapter:
    async def __aenter__(self): return self
    async def __aexit__(self, exc_type, exc, traceback): return None
    async def fetch_market(self, symbol):
        return {"symbol":symbol,"status":"live","last":100.0,"bid":99.99,"ask":100.01,"quote_volume":2000000.0,"timestamp":time.time()*1000,"bid_depth_quote":100000.0,"ask_depth_quote":100000.0,"orderbook_retrieved_at_ms":time.time()*1000,"orderbook_timestamp_ms":None,"orderbook_timestamp_source":"retrieval_fallback"}
    async def fetch_candles(self, symbol, granularity_seconds):
        interval=granularity_seconds*1000; now=int(time.time()*1000); last=(now//interval)*interval-interval; count=160; start=last-(count-1)*interval
        return [[start+i*interval,100+i*.1-.1,100+i*.1+.4,100+i*.1-.4,100+i*.1,1000] for i in range(count)]

def test_market_data_uses_coinbase_only(monkeypatch):
    import app.services.market_data as module
    monkeypatch.setattr(module,"CoinbasePublicAdapter",FakeCoinbaseAdapter)
    service=MarketDataService(replace(settings,cex_symbols=("BTC/USD","ETH/USD")))
    result=asyncio.run(service.cex_tickers())
    assert result["status"]=="live" and result["exchange"]=="coinbase_public_fallback"
    assert len(result["markets"])==2
    assert all(row["market_data_provider"]=="coinbase_public_fallback" for row in result["markets"])
    assert all(row["quote_currency"]=="USD" for row in result["markets"])

def test_coinbase_strategy_uses_exact_six_hour_confirmation(monkeypatch):
    import app.services.market_data as module
    monkeypatch.setattr(module,"CoinbasePublicAdapter",FakeCoinbaseAdapter)
    service=MarketDataService(replace(settings,cex_symbols=("BTC/USD",)))
    result=asyncio.run(service.cex_strategy_data("BTC/USD","1h",300))
    assert result["status"]=="live" and result["provider"]=="coinbase_public_fallback"
    assert result["provider_symbol"]=="BTC-USD" and result["quote_currency"]=="USD"
    assert result["higher_timeframe"]["timeframe"]=="6h"
    assert result["data_quality"]["contiguous_closed_candles"] is True

def test_coinbase_does_not_fabricate_unsupported_primary_timeframe(monkeypatch):
    import app.services.market_data as module
    monkeypatch.setattr(module,"CoinbasePublicAdapter",FakeCoinbaseAdapter)
    service=MarketDataService(replace(settings,cex_symbols=("BTC/USD",)))
    result=asyncio.run(service.cex_strategy_data("BTC/USD","4h",300))
    assert result["status"]=="unavailable"
    assert "exact 5m, 15m and 1h" in result["error"] and result["candles"]==[]
