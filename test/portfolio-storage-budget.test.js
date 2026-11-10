import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const engine = readFileSync(new URL("../src/engine.js", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

const portfolioStart = engine.indexOf("  portfolio(markBySymbol, risk, nowMs)");
const portfolioEnd = engine.indexOf("  entryBlockReasons(portfolio, risk, nowMs)", portfolioStart);
const portfolio = engine.slice(portfolioStart, portfolioEnd);

test("paper ledger summary is backfilled only when its singleton row is absent", () => {
  assert.ok(engine.includes("CREATE TABLE IF NOT EXISTS trade_ledger_summary"));
  assert.ok(engine.includes("SELECT 1 AS present FROM trade_ledger_summary WHERE id=1 LIMIT 1"));
  assert.ok(engine.includes("if (!ledgerSummaryExists)"));
  assert.ok(engine.includes("SELECT 1,COUNT(*),COALESCE(SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END),0)"));
});

test("SQLite triggers maintain total count and realized P&L on insert, close/update and delete", () => {
  assert.ok(engine.includes("AFTER INSERT ON trades"));
  assert.ok(engine.includes("AFTER UPDATE OF status,pnl_usd ON trades"));
  assert.ok(engine.includes("AFTER DELETE ON trades"));
  assert.ok(engine.includes("realized_pnl_usd=realized_pnl_usd+CASE WHEN NEW.status='CLOSED'"));
  assert.ok(engine.includes("realized_pnl_usd=realized_pnl_usd-CASE WHEN OLD.status='CLOSED'"));
});

test("portfolio risk reads use the bounded summary row, not full-ledger SUM or COUNT", () => {
  assert.ok(portfolio.includes("this.getTradeLedgerSummary()"));
  assert.ok(!portfolio.includes("SELECT COUNT(*)"));
  assert.ok(!portfolio.includes("SUM(pnl_usd) AS pnl FROM trades WHERE status='CLOSED'"));
  assert.ok(portfolio.includes("ledger_summary_available: ledgerSummaryAvailable"));
  assert.ok(engine.includes('if (portfolio.ledger_summary_available !== true) reasons.push("ledger_summary_unavailable")'));
});

test("daily and weekly realized-P&L queries use closed_at_ms ranges and the partial covering index", () => {
  assert.ok(engine.includes("idx_trades_closed_at_id_pnl ON trades(closed_at_ms DESC,id DESC,pnl_usd) WHERE status='CLOSED'"));
  assert.ok(portfolio.includes("closed_at_ms>=? AND closed_at_ms<?"));
  assert.ok(portfolio.includes("closed_at_ms>=? AND closed_at_ms<=?"));
  assert.ok(!portfolio.includes("date(closed_at_ms/1000,'unixepoch')"));
});

test("trade listing and capital review use the maintained ledger summary instead of full COUNT scans", () => {
  assert.ok(engine.includes("const ledgerSummary = this.getTradeLedgerSummary();"));
  assert.ok(engine.includes('if (!ledgerSummary) return jsonResponse({ error: "ledger_summary_unavailable" }, 503);'));
  assert.ok(!engine.includes('SELECT COUNT(*) AS count FROM trades").toArray()[0]?.count'));
});

test("dashboard refresh does not poll trading mode and paper automation endpoints redundantly", () => {
  const refreshStart = dashboard.indexOf("async function refresh(){");
  const refreshEnd = dashboard.indexOf("\nasync function ", refreshStart + 1);
  const refresh = dashboard.slice(refreshStart, refreshEnd < 0 ? undefined : refreshEnd);
  assert.ok(refreshStart >= 0);
  assert.ok(!refresh.includes("loadTradingMode()"));
});


test("equity snapshot retention uses a covering timestamp index and prunes once per ten inserts", () => {
  assert.ok(source.includes("CREATE INDEX IF NOT EXISTS idx_equity_snapshots_at_id ON equity_snapshots(at_ms DESC,id DESC)"));
  assert.ok(source.includes("VALUES(?,?,?,?,?,?) RETURNING id"));
  assert.ok(source.includes("snapshotId % 10 === 0"));
  assert.ok(source.includes("DELETE FROM equity_snapshots WHERE id NOT IN (SELECT id FROM equity_snapshots ORDER BY at_ms DESC,id DESC LIMIT 2000)"));
  assert.ok(!source.includes("DELETE FROM equity_snapshots WHERE at_ms NOT IN"));
});
