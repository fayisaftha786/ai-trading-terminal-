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
    cex_exchange: str = "coinbase"
    cex_symbols: tuple[str, ...] = tuple(
        s.strip() for s in os.getenv("CEX_SYMBOLS", "BTC/USD,ETH/USD,SOL/USD").split(",") if s.strip()
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
    # Production/live execution remains deliberately hard-disabled.
    live_trading_enabled: bool = False


settings = Settings()
