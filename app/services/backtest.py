from __future__ import annotations

from math import isfinite, sqrt
from datetime import datetime, timezone
from statistics import mean, pstdev
from typing import Any

from app.services.strategy import ema


def _validate(candles: list[list[float]]) -> list[list[float]]:
    rows: list[list[float]] = []
    for row in candles:
        if len(row) < 6:
            continue
        try:
            ts, op, high, low, close, volume = map(float, row[:6])
        except (TypeError, ValueError):
            continue
        if not all(isfinite(x) for x in (ts, op, high, low, close, volume)):
            continue
        if min(op, high, low, close) <= 0 or volume < 0 or high < max(op, close, low) or low > min(op, close, high):
            continue
        rows.append([ts, op, high, low, close, volume])
    rows.sort(key=lambda x: x[0])
    dedup = {row[0]: row for row in rows}
    return [dedup[key] for key in sorted(dedup)]


def run_ema_backtest(candles: list[list[float]], fee_bps: float = 10, slippage_bps: float = 10, start_index: int = 0) -> dict[str, Any]:
    """Long-only EMA cross with next-bar-open fills and explicit round-trip costs."""
    rows = _validate(candles)
    if len(rows) < 60:
        raise ValueError("At least 60 valid unique OHLCV candles are required")
    if start_index < 0 or start_index >= len(rows) - 2:
        raise ValueError("Evaluation start index must leave at least two candles for testing")
    closes = [row[4] for row in rows]
    fast, slow = ema(closes, 20), ema(closes, 50)
    fee, slip = fee_bps / 10_000, slippage_bps / 10_000
    cash, qty, entry_cost = 1_000.0, 0.0, 0.0
    equity_curve: list[float] = []
    trade_returns: list[float] = []
    wins = 0
    peak, max_drawdown = cash, 0.0
    turnover = 0.0
    closed_trades = 0
    for i, row in enumerate(rows):
        # Decisions use the prior candle close; fills occur at this candle's open.
        if i > 0:
            signal_up = fast[i - 1] > slow[i - 1] and fast[i - 2] <= slow[i - 2] if i > 1 else False
            signal_down = fast[i - 1] < slow[i - 1] and fast[i - 2] >= slow[i - 2] if i > 1 else False
            open_price = row[1]
            if i > start_index and qty == 0 and signal_up:
                fill = open_price * (1 + slip)
                spend = cash * (1 - fee)
                qty = spend / fill
                entry_cost = cash
                turnover += spend
                cash = 0.0
            elif i > start_index and qty > 0 and signal_down:
                fill = open_price * (1 - slip)
                proceeds = qty * fill * (1 - fee)
                pnl = proceeds - entry_cost
                trade_returns.append(pnl)
                wins += int(pnl > 0)
                closed_trades += 1
                turnover += qty * fill
                cash, qty, entry_cost = proceeds, 0.0, 0.0
        mark = cash + qty * row[4]
        if i >= start_index:
            equity_curve.append(mark)
        peak = max(peak, mark)
        max_drawdown = max(max_drawdown, (peak - mark) / peak if peak else 0.0)

    # Mark any remaining position to the last close with a conservative sell-side cost.
    open_position = qty > 0
    if open_position:
        final_proceeds = qty * rows[-1][4] * (1 - slip) * (1 - fee)
        final_pnl = final_proceeds - entry_cost
        trade_returns.append(final_pnl)
        wins += int(final_pnl > 0)
        closed_trades += 1
        turnover += qty * rows[-1][4]
        cash = final_proceeds
        qty = 0.0
    final_equity = cash
    daily_like_returns = [(equity_curve[i] / equity_curve[i - 1] - 1) for i in range(1, len(equity_curve)) if equity_curve[i - 1] > 0]
    gross_profit = sum(x for x in trade_returns if x > 0)
    gross_loss = abs(sum(x for x in trade_returns if x < 0))
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else (None if gross_profit == 0 else 999.0)
    expectancy = mean(trade_returns) if trade_returns else 0.0
    sharpe_approx = (mean(daily_like_returns) / pstdev(daily_like_returns) * sqrt(len(daily_like_returns))) if len(daily_like_returns) > 1 and pstdev(daily_like_returns) > 0 else None
    return {
        "starting_balance_usd": 1000.0, "ending_equity_usd": round(final_equity, 4),
        "evaluation_start_index": start_index, "evaluation_bars": len(equity_curve),
        "net_return_pct": round((final_equity / 1000.0 - 1) * 100, 4),
        "closed_trades": closed_trades, "win_rate_pct": round(100 * wins / closed_trades, 2) if closed_trades else 0.0,
        "profit_factor": round(profit_factor, 4) if profit_factor is not None else None,
        "expectancy_usd_per_trade": round(expectancy, 6),
        "max_drawdown_pct": round(max_drawdown * 100, 4),
        "sharpe_like_unannualized": round(sharpe_approx, 4) if sharpe_approx is not None else None,
        "turnover_usd": round(turnover, 4), "open_position_at_end": False,
        "execution_model": "Signal at previous close; fill at next candle open; entry and exit fee/slippage; remaining position liquidated at final close",
        "cost_assumptions": {"fee_bps_per_side": fee_bps, "slippage_bps_per_side": slippage_bps},
        "warning": "Historical simulation only. Use chronological out-of-sample and walk-forward validation; candle OHLCV cannot reproduce queue position, intrabar path, latency, market impact or real fills."
    }


def run_walk_forward(candles: list[list[float]], folds: int = 3, fee_bps: float = 10, slippage_bps: float = 10) -> dict[str, Any]:
    """Chronological fixed-strategy walk-forward plus fee/slippage stress scenarios."""
    rows = _validate(candles)
    if folds < 2 or folds > 6:
        raise ValueError("Folds must be between 2 and 6")
    warmup = 60
    available = len(rows) - warmup
    if available < folds * 20:
        raise ValueError(f"At least {warmup + folds * 20} valid candles are required for {folds} folds")
    fold_size = available // folds

    def evaluate(multiplier: float) -> list[dict[str, Any]]:
        results = []
        for fold in range(folds):
            start = warmup + fold * fold_size
            end = warmup + (fold + 1) * fold_size if fold < folds - 1 else len(rows)
            result = run_ema_backtest(rows[:end], fee_bps * multiplier, slippage_bps * multiplier, start_index=start)
            result["fold"] = fold + 1
            result["test_start_timestamp"] = int(rows[start][0])
            result["test_end_timestamp"] = int(rows[end - 1][0])
            results.append(result)
        return results

    baseline = evaluate(1.0)
    returns = [item["net_return_pct"] for item in baseline]
    stress = []
    for multiplier in (1.0, 1.5, 2.0):
        scenarios = baseline if multiplier == 1.0 else evaluate(multiplier)
        scenario_returns = [item["net_return_pct"] for item in scenarios]
        stress.append({
            "cost_multiplier": multiplier,
            "mean_fold_return_pct": round(mean(scenario_returns), 4),
            "positive_folds": sum(value > 0 for value in scenario_returns),
            "total_folds": folds,
            "worst_fold_return_pct": round(min(scenario_returns), 4),
        })
    return {
        "method": "Expanding historical warm-up with sequential non-overlapping test windows; fixed EMA20/50 strategy; no parameter search",
        "folds": baseline,
        "mean_fold_return_pct": round(mean(returns), 4),
        "positive_folds": sum(value > 0 for value in returns),
        "total_folds": folds,
        "worst_fold_drawdown_pct": round(max(item["max_drawdown_pct"] for item in baseline), 4),
        "cost_stress": stress,
        "warning": "Walk-forward and cost stress are robustness checks, not proof of future profitability. Use untouched final holdout data, multiple assets/regimes, realistic venue-specific costs and live paper execution before considering deployment."
    }


# Strategy-aligned research path. The older EMA crossover remains available as a
# deliberately separate baseline so the UI never implies it validates auto entries.
def _signal_backtest_metrics(
    rows: list[list[float]],
    higher_rows: list[list[float]],
    *,
    fee_bps: float,
    slippage_bps: float,
    start_index: int,
    primary_timeframe_ms: int = 3_600_000,
    higher_timeframe_ms: int = 14_400_000,
    risk_per_trade_pct: float = 0.25,
    max_exposure_pct: float = 20.0,
    stop_loss_pct: float = 1.0,
    take_profit_pct: float = 2.0,
    enforce_net_reward_risk: bool = True,
) -> dict[str, Any]:
    from app.services.strategy import analyze_candles, candle_integrity_report

    if len(rows) < 200:
        raise ValueError("At least 200 valid primary 1h candles are required")
    if len(higher_rows) < 150:
        raise ValueError("At least 150 valid higher-timeframe candles are required")
    if higher_timeframe_ms not in {14_400_000, 21_600_000}:
        raise ValueError("Higher timeframe must be an explicitly supported 4h or 6h interval")
    primary_quality = candle_integrity_report(rows, primary_timeframe_ms)
    if not primary_quality["is_clean"]:
        raise ValueError(
            "Backtest blocked by missing/off-grid candle intervals or duplicate/invalid primary OHLCV rows "
            f"({primary_quality})"
        )
    # Ignore higher-timeframe candles that close after the final historical decision
    # point. In particular, future rows must neither affect signals nor data-quality gates.
    last_decision_close_ms = rows[-2][0] + primary_timeframe_ms
    effective_higher = [row for row in higher_rows if row[0] + higher_timeframe_ms <= last_decision_close_ms]
    if len(effective_higher) < 150:
        raise ValueError("At least 150 fully closed higher-timeframe candles must be available by the final decision point")
    higher_quality = candle_integrity_report(effective_higher, higher_timeframe_ms)
    higher_gaps = higher_quality["missing_intervals"] + higher_quality["off_interval_pairs"]
    primary_gaps = primary_quality["missing_intervals"] + primary_quality["off_interval_pairs"]
    if not higher_quality["is_clean"]:
        raise ValueError(
            "Backtest blocked by missing/off-grid candle intervals or duplicate/invalid higher-timeframe OHLCV rows "
            f"({higher_quality})"
        )
    if start_index < 150 or start_index >= len(rows) - 2:
        raise ValueError("Evaluation start index must be between indicator warm-up and the final two candles")
    assumptions = (fee_bps, slippage_bps, risk_per_trade_pct, max_exposure_pct, stop_loss_pct, take_profit_pct)
    if not all(isfinite(float(v)) for v in assumptions):
        raise ValueError("Backtest assumptions must be finite")
    if not (0 <= fee_bps <= 100 and 0 <= slippage_bps <= 200):
        raise ValueError("Fee or slippage assumption is outside the supported range")
    if not (0 < risk_per_trade_pct <= 1 and 0 < max_exposure_pct <= 50):
        raise ValueError("Risk-per-trade or exposure assumption is outside the supported range")
    if not (0 < stop_loss_pct <= 10 and 0 < take_profit_pct <= 30):
        raise ValueError("Stop-loss or take-profit assumption is outside the supported range")
    round_trip_cost_pct = 2.0 * (fee_bps + slippage_bps) / 100.0
    net_reward_risk_viable = take_profit_pct >= stop_loss_pct + 2.0 * round_trip_cost_pct
    if enforce_net_reward_risk and not net_reward_risk_viable:
        raise ValueError("Take-profit cannot cover stop distance and round-trip costs for at least 1:1 net reward/risk")

    fee = fee_bps / 10_000.0
    slip = slippage_bps / 10_000.0
    cash = 1_000.0
    quantity = 0.0
    entry_cost = 0.0
    stop_price = target_price = 0.0
    equity_curve: list[float] = []
    trade_pnls: list[float] = []
    hold_bars: list[int] = []
    current_hold = 0
    peak_equity = cash
    max_drawdown = 0.0
    turnover = 0.0
    eligible_signals = 0
    signals_evaluated = 0
    entry_count = 0
    in_market_bars = 0
    last_exit_index = -10_000
    entries_by_utc_day: dict[str, int] = {}

    def realize_exit(exit_reference: float) -> None:
        nonlocal cash, quantity, entry_cost, stop_price, target_price, current_hold, turnover
        fill = max(1e-12, exit_reference * (1.0 - slip))
        gross_proceeds = quantity * fill
        exit_fee = gross_proceeds * fee
        net_proceeds = gross_proceeds - exit_fee
        trade_pnls.append(net_proceeds - entry_cost)
        hold_bars.append(current_hold)
        cash += net_proceeds
        turnover += gross_proceeds
        quantity = 0.0
        entry_cost = 0.0
        stop_price = target_price = 0.0
        current_hold = 0

    # Each decision uses only candles fully closed before the next candle opens.
    # A newly opened position is also exposed to the remainder of its entry candle;
    # stop/target checks therefore run on that same OHLC bar, with stop-first ordering.
    for i in range(start_index + 1, len(rows)):
        bar = rows[i]
        closed_this_bar = False
        in_market_this_bar = quantity > 0
        if quantity > 0:
            current_hold += 1
            hit_stop = bar[3] <= stop_price
            hit_target = bar[2] >= target_price
            exit_reference: float | None = None
            if hit_stop:
                # When both boundaries are touched in one OHLC bar, assume the worse
                # outcome (stop first); gaps below the stop fill at the open.
                exit_reference = min(bar[1], stop_price)
            elif hit_target:
                exit_reference = target_price
            if exit_reference is not None:
                realize_exit(exit_reference)
                closed_this_bar = True
                last_exit_index = i

        if quantity <= 0 and not closed_this_bar and (i - last_exit_index) >= 4:
            primary_history = rows[:i]
            decision_close_ms = rows[i - 1][0] + primary_timeframe_ms
            confirmed_higher = [row for row in higher_rows if row[0] + higher_timeframe_ms <= decision_close_ms]
            if len(primary_history) >= 150 and len(confirmed_higher) >= 150:
                primary_analysis = analyze_candles(primary_history, bars_per_day=24.0)
                higher_analysis = analyze_candles(confirmed_higher, bars_per_day=86_400_000 / higher_timeframe_ms)
                signals_evaluated += 1
                setup_ok = (
                    primary_analysis.get("signal") == "BUY_CANDIDATE"
                    and primary_analysis.get("regime") == "UPTREND"
                    and higher_analysis.get("regime") == "UPTREND"
                    and float(primary_analysis.get("atr_pct") or 999) < 5.0
                    and float(primary_analysis.get("rsi14") or 100) < 68.0
                    and float(primary_analysis.get("adx14") or 0) >= 18.0
                    and float(primary_analysis.get("plus_di14") or 0) > float(primary_analysis.get("minus_di14") or 0)
                    and net_reward_risk_viable
                )
                if setup_ok:
                    decision_day = datetime.fromtimestamp(rows[i - 1][0] / 1000.0, tz=timezone.utc).date().isoformat()
                    if entries_by_utc_day.get(decision_day, 0) >= 3:
                        setup_ok = False
                    else:
                        eligible_signals += 1
                        equity_before = cash
                        risk_budget = equity_before * risk_per_trade_pct / 100.0
                        # Use the same fee/slippage-inclusive stop budget as the paper broker.
                        round_trip_cost_rate = 2.0 * (fee_bps + slippage_bps) / 10_000.0
                        effective_stop_rate = (stop_loss_pct / 100.0) + round_trip_cost_rate
                        risk_limited_notional = risk_budget / effective_stop_rate
                        exposure_limited_notional = equity_before * max_exposure_pct / 100.0
                        cash_limited_notional = cash / (1.0 + fee)
                        notional = min(risk_limited_notional, exposure_limited_notional, cash_limited_notional)
                        if notional > 0:
                            fill = bar[1] * (1.0 + slip)
                            if fill > 0 and isfinite(fill):
                                entry_fee = notional * fee
                                quantity = notional / fill
                                entry_cost = notional + entry_fee
                                cash -= entry_cost
                                stop_price = fill * (1.0 - stop_loss_pct / 100.0)
                                target_price = fill * (1.0 + take_profit_pct / 100.0)
                                current_hold = 1
                                in_market_this_bar = True
                                turnover += notional
                                entry_count += 1
                                entries_by_utc_day[decision_day] = entries_by_utc_day.get(decision_day, 0) + 1
                                entry_hit_stop = bar[3] <= stop_price
                                entry_hit_target = bar[2] >= target_price
                                entry_exit_reference: float | None = None
                                if entry_hit_stop:
                                    # Same-bar ambiguity is resolved against the strategy.
                                    entry_exit_reference = min(bar[1], stop_price)
                                elif entry_hit_target:
                                    entry_exit_reference = target_price
                                if entry_exit_reference is not None:
                                    realize_exit(entry_exit_reference)
                                    closed_this_bar = True
                                    last_exit_index = i

        mark_equity = cash
        if in_market_this_bar:
            in_market_bars += 1
        if quantity > 0:
            liquidation = quantity * bar[4] * (1.0 - slip) * (1.0 - fee)
            mark_equity += liquidation
        peak_equity = max(peak_equity, mark_equity)
        if peak_equity > 0:
            max_drawdown = max(max_drawdown, (peak_equity - mark_equity) / peak_equity)
        equity_curve.append(mark_equity)

    forced_exit = quantity > 0
    if forced_exit:
        final_fill = rows[-1][4] * (1.0 - slip)
        proceeds = quantity * final_fill * (1.0 - fee)
        trade_pnls.append(proceeds - entry_cost)
        hold_bars.append(current_hold)
        turnover += quantity * final_fill
        cash += proceeds
        quantity = 0.0

    final_equity = cash
    # Exposure-matched buy-and-hold benchmark uses the same entry/exit cost assumptions.
    benchmark_notional = 1_000.0 * max_exposure_pct / 100.0
    benchmark_open = rows[start_index + 1][1] * (1.0 + slip)
    benchmark_quantity = benchmark_notional / benchmark_open if benchmark_open > 0 else 0.0
    benchmark_entry_cost = benchmark_notional * (1.0 + fee)
    benchmark_cash = 1_000.0 - benchmark_entry_cost
    benchmark_exit = rows[-1][4] * (1.0 - slip)
    benchmark_final_equity = benchmark_cash + benchmark_quantity * benchmark_exit * (1.0 - fee)
    benchmark_return_pct = (benchmark_final_equity / 1_000.0 - 1.0) * 100.0
    strategy_return_pct = (final_equity / 1_000.0 - 1.0) * 100.0
    gross_profit = sum(pnl for pnl in trade_pnls if pnl > 0)
    gross_loss = abs(sum(pnl for pnl in trade_pnls if pnl < 0))
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else None
    trade_count = len(trade_pnls)
    wins = sum(pnl > 0 for pnl in trade_pnls)
    expectancy = mean(trade_pnls) if trade_pnls else None
    mean_hold = mean(hold_bars) if hold_bars else None
    return {
        "strategy": "EMA20/50 + Wilder RSI/ATR/ADX + directional movement + volume/breakout filters",
        "mode": "historical_research_only",
        "starting_balance_usd": 1000.0,
        "ending_equity_usd": round(final_equity, 6),
        "net_return_pct": round(strategy_return_pct, 5),
        "benchmark": "buy_and_hold_at_the_same_max_exposure_with_same_entry_exit_costs",
        "benchmark_net_return_pct": round(benchmark_return_pct, 5),
        "excess_return_vs_benchmark_pct": round(strategy_return_pct - benchmark_return_pct, 5),
        "time_in_market_pct": round(100.0 * in_market_bars / len(equity_curve), 3) if equity_curve else 0.0,
        "evaluation_start_index": start_index,
        "evaluation_bars": len(equity_curve),
        "timeframe_assumptions": {
            "primary_interval_ms": primary_timeframe_ms,
            "higher_interval_ms": higher_timeframe_ms,
            "higher_bars_per_day": 86_400_000 / higher_timeframe_ms,
        },
        "signals_evaluated": signals_evaluated,
        "eligible_strategy_signals": eligible_signals,
        "entries": entry_count,
        "closed_trades": trade_count,
        "win_rate_pct": round(100.0 * wins / trade_count, 4) if trade_count else None,
        "profit_factor": round(profit_factor, 5) if profit_factor is not None else None,
        "profit_factor_status": "calculated" if profit_factor is not None else ("no_losses_in_sample" if gross_profit > 0 else "no_closed_trades_or_no_wins"),
        "expectancy_usd_per_trade": round(expectancy, 8) if expectancy is not None else None,
        "average_holding_bars": round(mean_hold, 2) if mean_hold is not None else None,
        "max_drawdown_pct": round(max_drawdown * 100.0, 5),
        "turnover_usd": round(turnover, 6),
        "forced_end_liquidation": forced_exit,
        "cost_assumptions": {"fee_bps_per_side": fee_bps, "slippage_bps_per_side": slippage_bps},
        "risk_assumptions": {"risk_per_trade_pct": risk_per_trade_pct, "max_exposure_pct": max_exposure_pct,
                             "stop_loss_pct": stop_loss_pct, "take_profit_pct": take_profit_pct,
                             "max_concurrent_positions": 1,
                             "net_reward_risk_after_estimated_costs": round(
                                 (take_profit_pct - round_trip_cost_pct) / (stop_loss_pct + round_trip_cost_pct), 4
                             ) if stop_loss_pct + round_trip_cost_pct > 0 else None,
                             "net_reward_risk_viable": net_reward_risk_viable},
        "execution_model": (
            "Signal on previous fully closed primary candle and latest fully closed higher-timeframe candle; "
            "entry at next primary candle open; fee/slippage applied both sides; stop/target checked against OHLC "
            "including the entry candle; stop-first ordering resolves ambiguous same-bar touches; "
            "if both boundaries are touched, stop is assumed first; four-bar same-symbol cooldown and three entries "
            "per UTC day are applied; remaining position is liquidated at final close."
        ),
        "data_quality": {
            "primary_missing_intervals": primary_gaps,
            "higher_timeframe_missing_intervals": higher_gaps,
            "primary_integrity": primary_quality,
            "higher_timeframe_integrity": higher_quality,
            "contiguous_closed_candles": True,
        },
        "scope_limitations": [
            "Historical OHLCV has no historical bid/ask spread, order-book depth, quote-volume provenance or queue position.",
            "The production paper-entry engine also requires live ticker freshness, spread, depth and liquidity gates; those cannot be reconstructed from this candle-only input.",
            "This model simulates one position at a time and fixed paper risk settings; it is not an exchange-fill simulation."
        ],
        "warning": "Historical validation only. It does not prove future profitability or validate production execution. Use untouched data, multiple market regimes, conservative costs and forward paper trading."
    }


def run_signal_backtest(
    candles: list[list[float]],
    higher_timeframe_candles: list[list[float]],
    fee_bps: float = 10,
    slippage_bps: float = 10,
    start_index: int = 180,
    *,
    higher_timeframe_ms: int = 14_400_000,
    risk_per_trade_pct: float = 0.25,
    max_exposure_pct: float = 20.0,
    stop_loss_pct: float = 1.0,
    take_profit_pct: float = 2.0,
    enforce_net_reward_risk: bool = True,
) -> dict[str, Any]:
    rows = _validate(candles)
    higher_rows = _validate(higher_timeframe_candles)
    return _signal_backtest_metrics(
        rows, higher_rows, fee_bps=fee_bps, slippage_bps=slippage_bps,
        start_index=start_index, higher_timeframe_ms=higher_timeframe_ms,
        risk_per_trade_pct=risk_per_trade_pct,
        max_exposure_pct=max_exposure_pct, stop_loss_pct=stop_loss_pct,
        take_profit_pct=take_profit_pct, enforce_net_reward_risk=enforce_net_reward_risk,
    )


def run_signal_walk_forward(
    candles: list[list[float]],
    higher_timeframe_candles: list[list[float]],
    folds: int = 3,
    fee_bps: float = 10,
    slippage_bps: float = 10,
    *,
    higher_timeframe_ms: int = 14_400_000,
    risk_per_trade_pct: float = 0.25,
    max_exposure_pct: float = 20.0,
    stop_loss_pct: float = 1.0,
    take_profit_pct: float = 2.0,
) -> dict[str, Any]:
    rows = _validate(candles)
    higher_rows = _validate(higher_timeframe_candles)
    if folds < 2 or folds > 6:
        raise ValueError("Folds must be between 2 and 6")
    warmup = 180
    available = len(rows) - warmup
    if available < folds * 20:
        raise ValueError(f"At least {warmup + folds * 20} valid primary candles are required for {folds} folds")
    if len(higher_rows) < 150:
        raise ValueError("At least 150 valid higher-timeframe candles are required")
    if higher_timeframe_ms not in {14_400_000, 21_600_000}:
        raise ValueError("Higher timeframe must be an explicitly supported 4h or 6h interval")
    fold_size = available // folds

    def evaluate(multiplier: float) -> list[dict[str, Any]]:
        results = []
        for fold in range(folds):
            start = warmup + fold * fold_size
            end = warmup + (fold + 1) * fold_size if fold < folds - 1 else len(rows)
            result = run_signal_backtest(
                rows[:end], higher_rows, fee_bps * multiplier, slippage_bps * multiplier,
                start_index=start,
                higher_timeframe_ms=higher_timeframe_ms,
                risk_per_trade_pct=risk_per_trade_pct,
                max_exposure_pct=max_exposure_pct,
                stop_loss_pct=stop_loss_pct,
                take_profit_pct=take_profit_pct,
                enforce_net_reward_risk=(multiplier == 1.0),
            )
            result["fold"] = fold + 1
            result["test_start_timestamp_ms"] = int(rows[start][0])
            result["test_end_timestamp_ms"] = int(rows[end - 1][0])
            results.append(result)
        return results

    baseline = evaluate(1.0)
    returns = [item["net_return_pct"] for item in baseline]
    stress = []
    for multiplier in (1.0, 1.5, 2.0):
        scenarios = baseline if multiplier == 1.0 else evaluate(multiplier)
        scenario_returns = [item["net_return_pct"] for item in scenarios]
        stress.append({
            "cost_multiplier": multiplier,
            "mean_fold_return_pct": round(mean(scenario_returns), 5),
            "positive_folds": sum(value > 0 for value in scenario_returns),
            "total_folds": folds,
            "worst_fold_return_pct": round(min(scenario_returns), 5),
        })
    return {
        "strategy": "same primary signal and higher-timeframe trend conditions as automatic paper entries",
        "method": "Expanding historical warm-up with sequential, non-overlapping test windows; fixed parameters; no parameter search",
        "timeframe_assumptions": {
            "primary_interval_ms": 3_600_000,
            "higher_interval_ms": higher_timeframe_ms,
            "higher_bars_per_day": 86_400_000 / higher_timeframe_ms,
        },
        "folds": baseline,
        "mean_fold_return_pct": round(mean(returns), 5),
        "positive_folds": sum(value > 0 for value in returns),
        "total_folds": folds,
        "mean_excess_vs_benchmark_pct": round(mean(item["excess_return_vs_benchmark_pct"] for item in baseline), 5),
        "positive_benchmark_excess_folds": sum(item["excess_return_vs_benchmark_pct"] > 0 for item in baseline),
        "worst_fold_drawdown_pct": round(max(item["max_drawdown_pct"] for item in baseline), 5),
        "cost_stress": stress,
        "cost_assumptions": {"fee_bps_per_side": fee_bps, "slippage_bps_per_side": slippage_bps},
        "risk_assumptions": {"risk_per_trade_pct": risk_per_trade_pct, "max_exposure_pct": max_exposure_pct,
                             "stop_loss_pct": stop_loss_pct, "take_profit_pct": take_profit_pct,
                             "max_concurrent_positions": 1},
        "configuration_source": "current_saved_server_risk_profile_when_called_from_app_api",
        "warning": "This validates the indicator and higher-timeframe portion only. Historical spread, depth, live feed checks, latency, queue position and real fills remain unmodelled; walk-forward results are not proof of future profitability."
    }
