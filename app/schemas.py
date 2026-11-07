from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class PaperOrderRequest(BaseModel):
    engine: str = Field(pattern=r"^(multi_crypto|solana)$")
    symbol: str = Field(min_length=2, max_length=120)
    name: str = Field(default="", max_length=120)
    mint: str = Field(default="", max_length=100)
    price_usd: float = Field(gt=0, le=1_000_000_000)
    requested_notional_usd: float | None = Field(default=None, gt=0, le=1_000_000)


class RiskUpdate(BaseModel):
    risk_per_trade_pct: float = Field(ge=0.05, le=1.0)
    max_daily_loss_pct: float = Field(ge=0.25, le=5.0)
    max_weekly_loss_pct: float = Field(ge=0.5, le=10.0)
    max_total_exposure_pct: float = Field(ge=1.0, le=50.0)
    max_open_positions: int = Field(ge=1, le=5)
    stop_loss_pct: float = Field(ge=0.25, le=10.0)
    take_profit_pct: float = Field(ge=0.5, le=30.0)
    fee_bps_per_side: float = Field(ge=0, le=100)
    slippage_bps: float = Field(ge=0, le=200)
    max_total_drawdown_pct: float = Field(default=5.0, ge=1.0, le=20.0)

    @model_validator(mode="after")
    def net_reward_risk_is_viable(self):
        round_trip_cost_pct = 2.0 * (self.fee_bps_per_side + self.slippage_bps) / 100.0
        minimum_target_pct = self.stop_loss_pct + 2.0 * round_trip_cost_pct
        if self.take_profit_pct < minimum_target_pct:
            raise ValueError(
                "Take-profit must cover stop distance and round-trip costs for at least 1:1 net reward/risk"
            )
        return self


class BacktestRequest(BaseModel):
    candles: list[list[float]] = Field(min_length=60, max_length=5000)
    fee_bps: float = Field(default=10, ge=0, le=100)
    slippage_bps: float = Field(default=10, ge=0, le=200)


class WalkForwardRequest(BaseModel):
    candles: list[list[float]] = Field(min_length=100, max_length=10000)
    folds: int = Field(default=3, ge=2, le=6)
    fee_bps: float = Field(default=10, ge=0, le=100)
    slippage_bps: float = Field(default=10, ge=0, le=200)


class ScanAutomationRequest(BaseModel):
    enabled: bool


class SignalBacktestRequest(BaseModel):
    """Historical candles for research using the current saved server risk profile."""

    model_config = ConfigDict(extra="forbid")
    candles: list[list[float]] = Field(min_length=200, max_length=5000)
    higher_timeframe_candles: list[list[float]] = Field(min_length=150, max_length=1000)
    timeframe: Literal["1h"] = "1h"


class SignalWalkForwardRequest(BaseModel):
    """Walk-forward request; fees and risk limits are read from persisted server settings."""

    model_config = ConfigDict(extra="forbid")
    candles: list[list[float]] = Field(min_length=240, max_length=5000)
    higher_timeframe_candles: list[list[float]] = Field(min_length=150, max_length=1000)
    timeframe: Literal["1h"] = "1h"
    folds: int = Field(default=3, ge=2, le=6)



class TestnetLimitOrderRequest(BaseModel):
    """A bounded, explicit LIMIT order for Binance Spot Testnet only."""

    idempotency_key: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    symbol: str = Field(min_length=4, max_length=24, pattern=r"^[A-Z0-9]{2,20}/USDT$")
    side: Literal["buy", "sell"]
    amount: float = Field(gt=0, le=1_000_000)
    price: float = Field(gt=0, le=1_000_000_000)

    @field_validator("amount", "price")
    @classmethod
    def finite_positive(cls, value: float) -> float:
        if not __import__("math").isfinite(value):
            raise ValueError("Value must be finite")
        return value


class TestnetKillSwitchResetRequest(BaseModel):
    confirmation: Literal["RESET TESTNET ORDER LOCK"]


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=256)
