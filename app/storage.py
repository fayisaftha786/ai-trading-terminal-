from __future__ import annotations

import json
import sqlite3
from math import isfinite
from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from app.services.risk import safe_cost_assumptions

DEFAULT_RISK = {
    "risk_per_trade_pct": 0.25,
    "max_daily_loss_pct": 1.5,
    "max_weekly_loss_pct": 4.0,
    "max_total_exposure_pct": 20.0,
    "max_open_positions": 3,
    "stop_loss_pct": 1.0,
    "take_profit_pct": 2.0,
    "fee_bps_per_side": 10.0,
    "slippage_bps": 10.0,
    "max_total_drawdown_pct": 5.0,
}


class Storage:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        if str(self.path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._memory_connection: sqlite3.Connection | None = None
        if str(self.path) == ":memory:":
            self._memory_connection = sqlite3.connect(":memory:", check_same_thread=False)
            self._memory_connection.row_factory = sqlite3.Row

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        if self._memory_connection is not None:
            conn = self._memory_connection
            try:
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            return
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def initialize(self, initial_capital: float = 100.0) -> None:
        with self.connection() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS trades (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    engine TEXT NOT NULL CHECK(engine IN ('multi_crypto','solana')),
                    symbol TEXT NOT NULL,
                    name TEXT NOT NULL DEFAULT '',
                    mint TEXT NOT NULL DEFAULT '',
                    side TEXT NOT NULL CHECK(side IN ('BUY')),
                    status TEXT NOT NULL CHECK(status IN ('OPEN','CLOSED')),
                    entry_price REAL NOT NULL,
                    quantity REAL NOT NULL,
                    notional_usd REAL NOT NULL,
                    stop_loss REAL NOT NULL,
                    take_profit REAL NOT NULL,
                    opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    closed_at TEXT,
                    exit_price REAL,
                    fees_usd REAL NOT NULL DEFAULT 0,
                    pnl_usd REAL,
                    metadata_json TEXT NOT NULL DEFAULT '{}'
                );
                CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
                CREATE INDEX IF NOT EXISTS idx_trades_opened_at ON trades(opened_at);
                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_type TEXT NOT NULL,
                    message TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    metadata_json TEXT NOT NULL DEFAULT '{}'
                );
                CREATE TABLE IF NOT EXISTS portfolio (
                    id INTEGER PRIMARY KEY CHECK(id=1),
                    initial_capital_usd REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS equity_snapshots (
                    bucket_minute TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    equity_usd REAL NOT NULL,
                    realized_pnl_usd REAL NOT NULL,
                    unrealized_pnl_usd REAL NOT NULL,
                    open_positions INTEGER NOT NULL,
                    drawdown_pct_from_peak REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_equity_snapshots_created_at
                    ON equity_snapshots(created_at);
                CREATE TABLE IF NOT EXISTS testnet_orders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    client_order_id TEXT NOT NULL UNIQUE,
                    exchange_order_id TEXT,
                    symbol TEXT NOT NULL,
                    side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
                    amount REAL NOT NULL,
                    price REAL NOT NULL,
                    notional_usdt REAL NOT NULL,
                    status TEXT NOT NULL,
                    filled REAL NOT NULL DEFAULT 0,
                    remaining REAL NOT NULL DEFAULT 0,
                    average REAL,
                    cost REAL NOT NULL DEFAULT 0,
                    error_code TEXT,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                );
                CREATE INDEX IF NOT EXISTS idx_testnet_orders_status ON testnet_orders(status);
                CREATE INDEX IF NOT EXISTS idx_testnet_orders_created_at ON testnet_orders(created_at);
                CREATE TABLE IF NOT EXISTS testnet_auto_orders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    list_client_order_id TEXT NOT NULL UNIQUE,
                    exchange_list_id TEXT,
                    working_order_id TEXT,
                    symbol TEXT NOT NULL,
                    quantity REAL NOT NULL,
                    exit_quantity REAL NOT NULL,
                    entry_price REAL NOT NULL,
                    stop_price REAL NOT NULL,
                    target_price REAL NOT NULL,
                    notional_usdt REAL NOT NULL,
                    signal_score REAL NOT NULL DEFAULT 0,
                    status TEXT NOT NULL,
                    error_code TEXT,
                    entry_filled_qty REAL,
                    entry_cost_quote REAL,
                    entry_fee_quote REAL,
                    exit_filled_qty REAL,
                    exit_proceeds_quote REAL,
                    exit_fee_quote REAL,
                    realized_pnl_quote REAL,
                    accounting_status TEXT NOT NULL DEFAULT 'PENDING',
                    above_order_id TEXT,
                    below_order_id TEXT,
                    closed_at TEXT,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                );
                CREATE INDEX IF NOT EXISTS idx_testnet_auto_orders_status
                    ON testnet_auto_orders(status);
                CREATE INDEX IF NOT EXISTS idx_testnet_auto_orders_created_at
                    ON testnet_auto_orders(created_at);
                """
            )
            # Idempotent additive migration for existing SQLite deployments.
            # CREATE TABLE IF NOT EXISTS does not add columns to an older table.
            auto_columns = {
                "entry_filled_qty": "REAL",
                "entry_cost_quote": "REAL",
                "entry_fee_quote": "REAL",
                "exit_filled_qty": "REAL",
                "exit_proceeds_quote": "REAL",
                "exit_fee_quote": "REAL",
                "realized_pnl_quote": "REAL",
                "accounting_status": "TEXT NOT NULL DEFAULT 'PENDING'",
                "above_order_id": "TEXT",
                "below_order_id": "TEXT",
                "closed_at": "TEXT",
            }
            existing_auto_columns = {
                row["name"] for row in conn.execute("PRAGMA table_info(testnet_auto_orders)").fetchall()
            }
            for column, definition in auto_columns.items():
                if column not in existing_auto_columns:
                    conn.execute(f"ALTER TABLE testnet_auto_orders ADD COLUMN {column} {definition}")
            conn.execute(
                "INSERT OR IGNORE INTO portfolio(id, initial_capital_usd) VALUES(1, ?)",
                (float(initial_capital),),
            )
            conn.execute(
                "INSERT OR IGNORE INTO app_settings(key, value_json) VALUES('risk', ?)",
                (json.dumps(DEFAULT_RISK),),
            )
            duplicates = conn.execute(
                "SELECT engine, symbol, COUNT(*) AS n FROM trades "
                "WHERE status='OPEN' GROUP BY engine, symbol HAVING COUNT(*) > 1"
            ).fetchall()
            if duplicates:
                markets = ", ".join(f"{row['engine']}:{row['symbol']}" for row in duplicates)
                raise RuntimeError(
                    "Existing paper ledger has duplicate open positions; manual reconciliation is required "
                    f"before unique-position protection can be enabled: {markets}"
                )
            # Enforce one open row per market in SQLite itself. This closes the race
            # between concurrent API/background scans that a Python pre-check cannot.
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_one_open_per_market "
                "ON trades(engine, symbol) WHERE status='OPEN'"
            )

    def get_risk(self) -> dict[str, Any]:
        with self.connection() as conn:
            row = conn.execute("SELECT value_json FROM app_settings WHERE key='risk'").fetchone()
        stored = json.loads(row["value_json"]) if row else {}
        merged = dict(DEFAULT_RISK)
        if isinstance(stored, dict):
            merged.update(stored)
        return merged

    def set_risk(self, risk: dict[str, Any]) -> None:
        with self.connection() as conn:
            conn.execute(
                "INSERT INTO app_settings(key,value_json) VALUES('risk',?) "
                "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
                (json.dumps(risk),),
            )

    def get_setting(self, key: str, default: Any = None) -> Any:
        with self.connection() as conn:
            row = conn.execute("SELECT value_json FROM app_settings WHERE key=?", (key,)).fetchone()
        return json.loads(row["value_json"]) if row else default

    def set_setting(self, key: str, value: Any) -> None:
        with self.connection() as conn:
            conn.execute(
                "INSERT INTO app_settings(key,value_json) VALUES(?,?) "
                "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
                (key, json.dumps(value)),
            )

    def has_open_trade(self, engine: str, symbol: str) -> bool:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT 1 FROM trades WHERE engine=? AND symbol=? AND status='OPEN' LIMIT 1",
                (engine, symbol),
            ).fetchone()
        return row is not None

    def count_entries_since(self, timestamp: str, engine: str | None = None) -> int:
        query = "SELECT COUNT(*) AS n FROM trades WHERE opened_at >= ?"
        args: list[Any] = [timestamp]
        if engine:
            query += " AND engine=?"
            args.append(engine)
        with self.connection() as conn:
            row = conn.execute(query, args).fetchone()
        return int(row["n"] or 0)

    def last_trade_timestamp(self, engine: str, symbol: str) -> str | None:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT COALESCE(closed_at, opened_at) AS stamp FROM trades "
                "WHERE engine=? AND symbol=? ORDER BY id DESC LIMIT 1",
                (engine, symbol),
            ).fetchone()
        return str(row["stamp"]) if row and row["stamp"] else None

    def log_event(self, event_type: str, message: str, metadata: dict[str, Any] | None = None) -> None:
        with self.connection() as conn:
            conn.execute(
                "INSERT INTO events(event_type,message,metadata_json) VALUES(?,?,?)",
                (event_type, message, json.dumps(metadata or {})),
            )

    def list_events(self, limit: int = 50) -> list[dict[str, Any]]:
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM events ORDER BY id DESC LIMIT ?", (max(1, min(limit, 200)),)
            ).fetchall()
        return [dict(row) for row in rows]

    def list_trades(self, limit: int = 100) -> list[dict[str, Any]]:
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM trades ORDER BY id DESC LIMIT ?", (max(1, min(limit, 500)),)
            ).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["metadata"] = json.loads(item.pop("metadata_json", "{}"))
            result.append(item)
        return result

    def open_trades(self) -> list[dict[str, Any]]:
        with self.connection() as conn:
            rows = conn.execute("SELECT * FROM trades WHERE status='OPEN' ORDER BY id").fetchall()
        return [dict(row) for row in rows]

    def closed_trades_for_performance(self, limit: int = 10000) -> list[dict[str, Any]]:
        """Return a bounded closed-trade sample in chronological order."""
        limit = max(1, min(int(limit), 10000))
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM (SELECT * FROM trades WHERE status='CLOSED' "
                "ORDER BY closed_at DESC, id DESC LIMIT ?) ORDER BY closed_at ASC, id ASC",
                (limit,),
            ).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["metadata"] = json.loads(item.pop("metadata_json", "{}"))
            result.append(item)
        return result

    def record_equity_snapshot(
        self, summary: dict[str, Any], timestamp: datetime | None = None
    ) -> bool:
        """Persist one fully marked portfolio snapshot per UTC minute.

        A missing mark means the snapshot would be misleading, so such observations
        are rejected rather than interpolated or carried forward.
        """
        if int(summary.get("unmarked_positions", 0) or 0) > 0:
            return False
        stamp = timestamp or datetime.now(timezone.utc)
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        stamp = stamp.astimezone(timezone.utc)
        created_at = stamp.isoformat()
        bucket = stamp.replace(second=0, microsecond=0).isoformat()
        values = (
            float(summary["equity_usd"]),
            float(summary["realized_pnl_usd"]),
            float(summary["unrealized_pnl_usd"]),
            int(summary["open_positions"]),
            float(summary["drawdown_pct_from_peak"]),
        )
        if not all(isfinite(v) for v in values if isinstance(v, float)):
            return False
        with self.connection() as conn:
            conn.execute(
                "INSERT INTO equity_snapshots(bucket_minute,created_at,equity_usd,realized_pnl_usd,"
                "unrealized_pnl_usd,open_positions,drawdown_pct_from_peak) VALUES(?,?,?,?,?,?,?) "
                "ON CONFLICT(bucket_minute) DO UPDATE SET created_at=excluded.created_at, "
                "equity_usd=excluded.equity_usd, realized_pnl_usd=excluded.realized_pnl_usd, "
                "unrealized_pnl_usd=excluded.unrealized_pnl_usd, open_positions=excluded.open_positions, "
                "drawdown_pct_from_peak=excluded.drawdown_pct_from_peak",
                (bucket, created_at, *values),
            )
            retention_cutoff = (stamp - timedelta(days=180)).isoformat()
            conn.execute("DELETE FROM equity_snapshots WHERE created_at < ?", (retention_cutoff,))
        return True

    def list_equity_snapshots(self, since: str, limit: int = 5000) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 5000))
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT created_at,equity_usd,realized_pnl_usd,unrealized_pnl_usd,"
                "open_positions,drawdown_pct_from_peak FROM equity_snapshots "
                "WHERE created_at >= ? ORDER BY created_at ASC LIMIT ?",
                (since, limit),
            ).fetchall()
        return [dict(row) for row in rows]


    def create_testnet_order(self, values: dict[str, Any], max_open_orders: int = 3) -> None:
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            halted_row = conn.execute(
                "SELECT value_json FROM app_settings WHERE key='testnet_order_halted'"
            ).fetchone()
            if halted_row is not None and json.loads(halted_row["value_json"]):
                raise ValueError("Testnet emergency order lock is active; no new orders are allowed.")
            active = conn.execute(
                "SELECT "
                "(SELECT COUNT(*) FROM testnet_orders "
                " WHERE status IN ('OPEN','PARTIALLY_FILLED','SUBMITTING','UNKNOWN')) + "
                "(SELECT COUNT(*) FROM testnet_auto_orders "
                " WHERE status IN ('SUBMITTING','EXECUTING','UNKNOWN','UNPROTECTED')) AS n"
            ).fetchone()
            if int(active["n"] or 0) >= max(1, min(int(max_open_orders), 10)):
                raise ValueError("Maximum number of open or unresolved Testnet orders reached.")
            conn.execute(
                "INSERT INTO testnet_orders(idempotency_key, client_order_id, symbol, side, amount, price, "
                "notional_usdt, status) VALUES(?,?,?,?,?,?,?,?)",
                (values["idempotency_key"], values["client_order_id"], values["symbol"], values["side"],
                 float(values["amount"]), float(values["price"]), float(values["notional_usdt"]), values["status"]),
            )

    @staticmethod
    def _testnet_order_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
        return dict(row) if row is not None else None

    def get_testnet_order_by_key(self, idempotency_key: str) -> dict[str, Any] | None:
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM testnet_orders WHERE idempotency_key=?", (idempotency_key,)).fetchone()
        return self._testnet_order_row(row)

    def get_testnet_order_by_client_id(self, client_order_id: str) -> dict[str, Any] | None:
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM testnet_orders WHERE client_order_id=?", (client_order_id,)).fetchone()
        return self._testnet_order_row(row)

    def update_testnet_order(self, client_order_id: str, values: dict[str, Any]) -> None:
        allowed = {"exchange_order_id", "symbol", "side", "amount", "price", "notional_usdt",
                   "status", "filled", "remaining", "average", "cost", "error_code"}
        updates = {key: value for key, value in values.items() if key in allowed}
        if not updates:
            return
        updates["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        assignments = ", ".join(f"{key}=?" for key in updates)
        with self.connection() as conn:
            conn.execute(
                f"UPDATE testnet_orders SET {assignments} WHERE client_order_id=?",
                (*updates.values(), client_order_id),
            )

    def list_testnet_orders(self, limit: int = 50) -> list[dict[str, Any]]:
        safe_limit = max(1, min(int(limit), 100))
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM testnet_orders ORDER BY id DESC LIMIT ?", (safe_limit,)
            ).fetchall()
        return [dict(row) for row in rows]

    def list_active_testnet_orders(self) -> list[dict[str, Any]]:
        """Return every open or ambiguous app-owned order, independent of UI history limits."""
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM testnet_orders "
                "WHERE status IN ('OPEN','PARTIALLY_FILLED','SUBMITTING','UNKNOWN') ORDER BY id ASC"
            ).fetchall()
        return [dict(row) for row in rows]

    def create_testnet_auto_order(self, values: dict[str, Any], max_open_orders: int = 3) -> None:
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            halted_row = conn.execute(
                "SELECT value_json FROM app_settings WHERE key='testnet_order_halted'"
            ).fetchone()
            if halted_row is not None and json.loads(halted_row["value_json"]):
                raise ValueError("Testnet emergency order lock is active; no new orders are allowed.")
            active = conn.execute(
                "SELECT "
                "(SELECT COUNT(*) FROM testnet_orders "
                " WHERE status IN ('OPEN','PARTIALLY_FILLED','SUBMITTING','UNKNOWN')) + "
                "(SELECT COUNT(*) FROM testnet_auto_orders "
                " WHERE status IN ('SUBMITTING','EXECUTING','UNKNOWN','UNPROTECTED')) AS n"
            ).fetchone()
            if int(active["n"] or 0) >= max(1, min(int(max_open_orders), 3)):
                raise ValueError("Maximum number of active Testnet automatic order lists reached.")
            conn.execute(
                "INSERT INTO testnet_auto_orders(idempotency_key,list_client_order_id,symbol,quantity,"
                "exit_quantity,entry_price,stop_price,target_price,notional_usdt,signal_score,status) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (values["idempotency_key"], values["list_client_order_id"], values["symbol"],
                 float(values["quantity"]), float(values["exit_quantity"]), float(values["entry_price"]),
                 float(values["stop_price"]), float(values["target_price"]), float(values["notional_usdt"]),
                 float(values.get("signal_score", 0)), values["status"]),
            )

    def get_testnet_auto_order_by_key(self, idempotency_key: str) -> dict[str, Any] | None:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT * FROM testnet_auto_orders WHERE idempotency_key=?", (idempotency_key,)
            ).fetchone()
        return dict(row) if row is not None else None

    def update_testnet_auto_order(self, list_client_order_id: str, values: dict[str, Any]) -> None:
        allowed = {
            "exchange_list_id", "working_order_id", "status", "error_code",
            "entry_filled_qty", "entry_cost_quote", "entry_fee_quote",
            "exit_filled_qty", "exit_proceeds_quote", "exit_fee_quote",
            "realized_pnl_quote", "accounting_status", "above_order_id",
            "below_order_id", "closed_at",
        }
        updates = {key: value for key, value in values.items() if key in allowed}
        if not updates:
            return
        updates["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        assignments = ", ".join(f"{key}=?" for key in updates)
        with self.connection() as conn:
            conn.execute(
                f"UPDATE testnet_auto_orders SET {assignments} WHERE list_client_order_id=?",
                (*updates.values(), list_client_order_id),
            )

    def list_active_testnet_auto_orders(self) -> list[dict[str, Any]]:
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM testnet_auto_orders "
                "WHERE status IN ('SUBMITTING','EXECUTING','UNKNOWN','UNPROTECTED') ORDER BY id ASC"
            ).fetchall()
        return [dict(row) for row in rows]

    def list_testnet_auto_orders(self, limit: int = 50) -> list[dict[str, Any]]:
        safe_limit = max(1, min(int(limit), 100))
        with self.connection() as conn:
            rows = conn.execute(
                "SELECT * FROM testnet_auto_orders ORDER BY id DESC LIMIT ?", (safe_limit,)
            ).fetchall()
        return [dict(row) for row in rows]

    def testnet_auto_performance(self) -> dict[str, Any]:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS total, "
                "COUNT(CASE WHEN status='CLOSED' THEN 1 END) AS closed, "
                "COUNT(CASE WHEN status='CLOSED' AND accounting_status='EXACT' THEN 1 END) AS exact_closed, "
                "COUNT(CASE WHEN status='CLOSED' AND accounting_status!='EXACT' THEN 1 END) AS fee_unresolved, "
                "COALESCE(SUM(CASE WHEN status='CLOSED' AND accounting_status='EXACT' "
                "THEN realized_pnl_quote ELSE 0 END),0) AS realized_pnl_usdt "
                "FROM testnet_auto_orders"
            ).fetchone()
        return {
            "total_order_lists": int(row["total"] or 0),
            "closed_order_lists": int(row["closed"] or 0),
            "exactly_accounted_trades": int(row["exact_closed"] or 0),
            "fee_unresolved_trades": int(row["fee_unresolved"] or 0),
            "realized_pnl_usdt": float(row["realized_pnl_usdt"] or 0.0),
            "pnl_scope": "closed Testnet auto-trades with exact quote-denominated fees only",
        }

    def testnet_auto_realized_pnl_since(self, timestamp: str) -> float:
        """Return only fully fee-accounted, completed Testnet auto-trades."""
        with self.connection() as conn:
            row = conn.execute(
                "SELECT COALESCE(SUM(realized_pnl_quote),0) AS pnl "
                "FROM testnet_auto_orders WHERE status='CLOSED' "
                "AND accounting_status='EXACT' AND closed_at >= ?",
                (timestamp,),
            ).fetchone()
        return float(row["pnl"] or 0.0)

    def testnet_auto_unaccounted_closed_count(self) -> int:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM testnet_auto_orders "
                "WHERE status='CLOSED' AND accounting_status!='EXACT'"
            ).fetchone()
        return int(row["n"] or 0)

    def count_testnet_auto_entries_since(self, timestamp: str) -> int:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM testnet_auto_orders WHERE created_at >= ?",
                (timestamp,),
            ).fetchone()
        return int(row["n"] or 0)

    def last_testnet_auto_entry(self, symbol: str) -> str | None:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT created_at FROM testnet_auto_orders WHERE symbol=? "
                "ORDER BY id DESC LIMIT 1", (symbol,)
            ).fetchone()
        return str(row["created_at"]) if row and row["created_at"] else None

    def count_open_testnet_auto_orders(self) -> int:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM testnet_auto_orders "
                "WHERE status IN ('SUBMITTING','EXECUTING','UNKNOWN','UNPROTECTED')"
            ).fetchone()
        return int(row["n"] or 0)

    def count_open_testnet_orders(self) -> int:
        with self.connection() as conn:
            row = conn.execute(
                "SELECT "
                "(SELECT COUNT(*) FROM testnet_orders "
                " WHERE status IN ('OPEN','PARTIALLY_FILLED','SUBMITTING','UNKNOWN')) + "
                "(SELECT COUNT(*) FROM testnet_auto_orders "
                " WHERE status IN ('SUBMITTING','EXECUTING','UNKNOWN','UNPROTECTED')) AS n"
            ).fetchone()
        return int(row["n"] or 0)

    def portfolio_summary(
        self,
        marks: dict[str, float] | None = None,
        fee_bps_per_side: float = 10.0,
        slippage_bps: float = 10.0,
    ) -> dict[str, float | int]:
        """Return realized and (when fresh marks are supplied) estimated net equity.

        Missing marks are counted, not silently replaced with stale or synthetic prices.
        Unrealized P&L includes estimated exit fee and slippage so equity is conservative.
        """
        marks = marks or {}
        with self.connection() as conn:
            portfolio = conn.execute("SELECT initial_capital_usd FROM portfolio WHERE id=1").fetchone()
            totals = conn.execute(
                "SELECT COALESCE(SUM(CASE WHEN status='CLOSED' THEN pnl_usd ELSE 0 END),0) AS realized, "
                "COUNT(CASE WHEN status='OPEN' THEN 1 END) AS open_count, "
                "COALESCE(SUM(CASE WHEN status='OPEN' THEN notional_usd ELSE 0 END),0) AS exposure "
                "FROM trades"
            ).fetchone()
            open_rows = conn.execute("SELECT * FROM trades WHERE status='OPEN'").fetchall()
            period = conn.execute(
                "SELECT "
                "COALESCE(SUM(CASE WHEN substr(closed_at,1,10)=date('now') THEN pnl_usd ELSE 0 END),0) AS daily_pnl, "
                "COALESCE(SUM(CASE WHEN strftime('%Y-%W',substr(closed_at,1,10))=strftime('%Y-%W','now') THEN pnl_usd ELSE 0 END),0) AS weekly_pnl "
                "FROM trades WHERE status='CLOSED'"
            ).fetchone()
        initial = float(portfolio["initial_capital_usd"] if portfolio else 100.0)
        realized = float(totals["realized"] or 0)
        safe_fee_bps, safe_slippage_bps = safe_cost_assumptions({
            "fee_bps_per_side": fee_bps_per_side, "slippage_bps": slippage_bps,
        })
        fee_rate = safe_fee_bps / 10_000
        slip_rate = safe_slippage_bps / 10_000
        unrealized = 0.0
        marked_positions = 0
        unmarked_positions = 0
        marked_exposure = 0.0
        for row in open_rows:
            mark = marks.get(row["symbol"])
            if mark is None or not isinstance(mark, (int, float)) or not isfinite(float(mark)) or mark <= 0:
                unmarked_positions += 1
                marked_exposure += float(row["notional_usd"])
                continue
            exit_estimate = float(mark) * (1 - slip_rate)
            quantity = float(row["quantity"])
            estimated_exit_fee = exit_estimate * quantity * fee_rate
            unrealized += (exit_estimate - float(row["entry_price"])) * quantity
            unrealized -= float(row["fees_usd"]) + estimated_exit_fee
            marked_exposure += float(mark) * quantity
            marked_positions += 1
        equity = initial + realized + unrealized
        # Persist the highest observed net equity so the circuit breaker uses peak-to-trough drawdown.
        stored_peak = float(self.get_setting("equity_peak_usd", initial) or initial)
        peak = max(initial, stored_peak, equity)
        if peak > stored_peak:
            self.set_setting("equity_peak_usd", peak)
        drawdown_from_peak = max(0.0, (peak - equity) / peak * 100) if peak > 0 else 0.0

        # Realized-only daily/weekly loss limits can miss an open position's adverse move.
        # Keep persistent UTC-period equity baselines and compare fully marked net equity.
        # When a position has no current mark, these values are unknown (and entry is blocked).
        daily_equity_pnl: float | None = None
        weekly_equity_pnl: float | None = None
        if unmarked_positions == 0:
            now_utc = datetime.now(timezone.utc)
            day_key = now_utc.date().isoformat()
            week_key = now_utc.strftime("%Y-%W")
            stored_day = self.get_setting("risk_day_baseline_key")
            stored_day_equity = self.get_setting("risk_day_baseline_equity")
            if stored_day != day_key or stored_day_equity is None:
                # Reconstruct the known baseline from today's realized P&L. Unrealized
                # moves become measurable from this first fully marked observation onward.
                baseline_equity = equity - float(period["daily_pnl"] or 0)
                self.set_setting("risk_day_baseline_key", day_key)
                self.set_setting("risk_day_baseline_equity", baseline_equity)
                stored_day_equity = baseline_equity
            stored_week = self.get_setting("risk_week_baseline_key")
            stored_week_equity = self.get_setting("risk_week_baseline_equity")
            if stored_week != week_key or stored_week_equity is None:
                baseline_equity = equity - float(period["weekly_pnl"] or 0)
                self.set_setting("risk_week_baseline_key", week_key)
                self.set_setting("risk_week_baseline_equity", baseline_equity)
                stored_week_equity = baseline_equity
            daily_equity_pnl = equity - float(stored_day_equity)
            weekly_equity_pnl = equity - float(stored_week_equity)

        return {
            "initial_capital_usd": initial,
            "realized_pnl_usd": realized,
            "unrealized_pnl_usd": unrealized,
            "daily_realized_pnl_usd": float(period["daily_pnl"] or 0),
            "weekly_realized_pnl_usd": float(period["weekly_pnl"] or 0),
            "daily_equity_pnl_usd": daily_equity_pnl,
            "weekly_equity_pnl_usd": weekly_equity_pnl,
            "risk_period_timezone": "UTC",
            "equity_usd": equity,
            "open_positions": int(totals["open_count"] or 0),
            "exposure_usd": marked_exposure if marks else float(totals["exposure"] or 0),
            "marked_positions": marked_positions,
            "unmarked_positions": unmarked_positions,
            "peak_equity_usd": peak,
            "drawdown_pct_from_peak": drawdown_from_peak,
        }
