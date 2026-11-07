from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    app_name: str = "AI Trading Terminal"
    environment: str = os.getenv("APP_ENV", "development")
    database_path: Path = Path(os.getenv("DATABASE_PATH", "data/trading.db"))
    initial_capital_usd: float = float(os.getenv("PAPER_INITIAL_CAPITAL_USD", "100"))
    cex_exchange: str = os.getenv("CEX_EXCHANGE", "binance").lower()
    cex_symbols: tuple[str, ...] = tuple(
        s.strip() for s in os.getenv("CEX_SYMBOLS", "BTC/USDT,ETH/USDT,SOL/USDT").split(",") if s.strip()
    )
    jupiter_base_url: str = os.getenv("JUPITER_BASE_URL", "https://api.jup.ag/tokens/v2")
    jupiter_api_key: str | None = os.getenv("JUPITER_API_KEY") or None
    market_cache_seconds: int = int(os.getenv("MARKET_CACHE_SECONDS", "20"))
    scan_interval_seconds: int = int(os.getenv("SCAN_INTERVAL_SECONDS", "60"))
    # Cloud mode requires a password-protected UI/API and signed short-lived bearer tokens.
    auth_username: str = os.getenv("APP_USERNAME", "admin")
    auth_password: str = os.getenv("APP_PASSWORD", "")
    auth_secret: str = os.getenv("APP_AUTH_SECRET", "")
    auth_token_ttl_minutes: int = int(os.getenv("APP_TOKEN_TTL_MINUTES", "480"))
    # Testnet is an isolated virtual-money environment. It is OFF until explicitly configured.
    binance_testnet_enabled: bool = os.getenv("BINANCE_TESTNET_ENABLED", "false").lower() == "true"
    binance_testnet_api_key: str | None = os.getenv("BINANCE_TESTNET_API_KEY") or None
    binance_testnet_api_secret: str | None = os.getenv("BINANCE_TESTNET_API_SECRET") or None
    binance_testnet_order_enabled: bool = os.getenv("BINANCE_TESTNET_ORDER_ENABLED", "false").lower() == "true"
    binance_testnet_max_order_usdt: float = float(os.getenv("BINANCE_TESTNET_MAX_ORDER_USDT", "10"))
    binance_testnet_max_open_orders: int = int(os.getenv("BINANCE_TESTNET_MAX_OPEN_ORDERS", "3"))
    # Production/live execution remains deliberately hard-disabled.
    live_trading_enabled: bool = False


settings = Settings()
