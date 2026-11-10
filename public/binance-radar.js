const BINANCE_RADAR_DATA_URL = "https://data-api.binance.vision/api/v3/ticker/24hr";
const BINANCE_RADAR_STREAM_BASE = "wss://data-stream.binance.vision/stream?streams=";
const BINANCE_RADAR_LIMIT = 50;
const BINANCE_RADAR_STALE_MS = 6000;
const BINANCE_RADAR_RECONNECT_MAX_MS = 30000;
const EXCLUDED_BASE_ASSETS = new Set([
  "USDC", "FDUSD", "TUSD", "USDP", "BUSD", "DAI", "UST", "USTC",
  "EUR", "GBP", "TRY", "BRL", "AUD", "BIDR", "IDRT", "BEUR"
]);

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function normalizeBinanceRadarTicker(row, receivedAt = Date.now()) {
  const symbol = String(row?.s ?? row?.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{1,20}USDT$/.test(symbol)) return null;

  const last = finitePositive(row?.c ?? row?.lastPrice);
  if (last === null) return null;
  const bid = finitePositive(row?.b ?? row?.bidPrice);
  const ask = finitePositive(row?.a ?? row?.askPrice);
  const quoteVolume = finitePositive(row?.q ?? row?.quoteVolume) ?? 0;
  const changePctValue = Number(row?.P ?? row?.priceChangePercent);
  const tradeCountValue = Number(row?.n ?? row?.count);
  const eventTimeValue = Number(row?.E ?? row?.closeTime);

  const mid = bid !== null && ask !== null && ask >= bid ? (bid + ask) / 2 : null;
  const spreadBps = mid !== null && mid > 0
    ? Math.max(0, ((ask - bid) / mid) * 10000)
    : null;

  return {
    symbol,
    baseAsset: symbol.slice(0, -4),
    quoteAsset: "USDT",
    last,
    bid,
    ask,
    spreadBps,
    changePct: Number.isFinite(changePctValue) ? changePctValue : null,
    quoteVolume,
    tradeCount: Number.isFinite(tradeCountValue) && tradeCountValue >= 0 ? tradeCountValue : null,
    eventTime: Number.isFinite(eventTimeValue) && eventTimeValue > 0 ? eventTimeValue : null,
    receivedAt: Number.isFinite(receivedAt) ? receivedAt : Date.now()
  };
}

export function selectBinanceRadarMarkets(rows, {
  limit = BINANCE_RADAR_LIMIT,
  minimumQuoteVolume = 5000000,
  minimumTrades = 250
} = {}) {
  if (!Array.isArray(rows)) return [];
  const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(BINANCE_RADAR_LIMIT, limit)) : BINANCE_RADAR_LIMIT;
  const normalized = new Map();

  for (const row of rows) {
    const ticker = normalizeBinanceRadarTicker(row);
    if (!ticker || EXCLUDED_BASE_ASSETS.has(ticker.baseAsset)) continue;
    if (/(?:UP|DOWN|BULL|BEAR)$/.test(ticker.baseAsset)) continue;
    if (ticker.quoteVolume <= 0) continue;
    const current = normalized.get(ticker.symbol);
    if (!current || ticker.quoteVolume > current.quoteVolume) normalized.set(ticker.symbol, ticker);
  }

  const candidates = [...normalized.values()].sort((a, b) => b.quoteVolume - a.quoteVolume);
  const preferred = candidates.filter((item) =>
    item.quoteVolume >= minimumQuoteVolume &&
    (item.tradeCount === null || item.tradeCount >= minimumTrades)
  );
  const fallback = candidates.filter((item) =>
    item.quoteVolume >= minimumQuoteVolume * 0.2 &&
    (item.tradeCount === null || item.tradeCount >= Math.max(50, Math.floor(minimumTrades * 0.2)))
  );
  const selected = preferred.length >= Math.min(20, safeLimit)
    ? preferred
    : fallback;
  return selected.slice(0, safeLimit);
}

export function buildBinanceRadarStreamUrl(symbols) {
  if (!Array.isArray(symbols)) throw new TypeError("symbols_array_required");
  const unique = [...new Set(symbols.map((symbol) => String(symbol).trim().toUpperCase()))]
    .filter((symbol) => /^[A-Z0-9]{1,20}USDT$/.test(symbol))
    .slice(0, BINANCE_RADAR_LIMIT);
  if (!unique.length) throw new Error("at_least_one_valid_usdt_symbol_required");
  const streams = unique.map((symbol) => symbol.toLowerCase() + "@ticker").join("/");
  return BINANCE_RADAR_STREAM_BASE + streams;
}

export function medianRadarSpread(rows) {
  const values = (Array.isArray(rows) ? rows : [])
    .map((row) => row?.spreadBps)
    .filter((value) => value !== null && value !== undefined && value !== "" &&
      Number.isFinite(Number(value)) && Number(value) >= 0)
    .map(Number)
    .sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2
    ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
}

function text(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function money(value, digits = 2) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  }).format(value);
}

function compact(value) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2
  }).format(value);
}

function price(value) {
  if (!Number.isFinite(value)) return "—";
  const digits = value >= 1000 ? 2 : value >= 1 ? 4 : value >= 0.01 ? 6 : 8;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  }).format(value);
}

function parseDisplayedNumber(id) {
  const raw = document.getElementById(id)?.textContent || "";
  const value = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function coinbaseReferenceGap(row) {
  const suffix = row.baseAsset;
  if (!["BTC", "ETH", "SOL"].includes(suffix)) return null;
  const bid = parseDisplayedNumber("bid" + suffix);
  const ask = parseDisplayedNumber("ask" + suffix);
  const feed = document.getElementById("feed" + suffix);
  if (bid === null || ask === null || ask < bid || !feed ||
      !feed.classList.contains("live")) return null;
  const coinbaseMid = (bid + ask) / 2;
  if (!Number.isFinite(coinbaseMid) || coinbaseMid <= 0) return null;
  return ((row.last / coinbaseMid) - 1) * 100;
}

function createCell(value, className = "") {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.textContent = value;
  return cell;
}

function createRadarRow(row, now) {
  const tr = document.createElement("tr");
  const ageMs = Math.max(0, now - row.receivedAt);
  const fresh = ageMs <= BINANCE_RADAR_STALE_MS;
  const pair = document.createElement("td");
  pair.className = "radar-pair";
  const pairName = document.createElement("strong");
  pairName.textContent = row.baseAsset + "/USDT";
  const pairMeta = document.createElement("small");
  pairMeta.textContent = row.symbol + " · SPOT";
  pair.append(pairName, pairMeta);
  tr.append(pair);

  const last = document.createElement("td");
  last.className = "radar-price";
  last.textContent = price(row.last);
  tr.append(last);

  const changeClass = row.changePct === null ? "" : row.changePct > 0 ? "positive" : row.changePct < 0 ? "negative" : "";
  tr.append(createCell(row.changePct === null ? "—" : (row.changePct > 0 ? "+" : "") + row.changePct.toFixed(2) + "%", changeClass));

  const spread = document.createElement("td");
  if (row.spreadBps === null) {
    spread.textContent = "—";
  } else {
    const chip = document.createElement("span");
    chip.className = "radar-spread " + (row.spreadBps <= 8 ? "tight" : row.spreadBps <= 25 ? "normal" : "wide");
    chip.textContent = row.spreadBps.toFixed(1) + " bps";
    spread.append(chip);
  }
  tr.append(spread);

  const gap = coinbaseReferenceGap(row);
  tr.append(createCell(
    gap === null ? "—" : (gap > 0 ? "+" : "") + gap.toFixed(3) + "%",
    gap === null ? "muted" : gap > 0 ? "positive" : gap < 0 ? "negative" : ""
  ));
  tr.append(createCell(compact(row.quoteVolume) + " USDT", "radar-volume"));
  const ageCell = document.createElement("td");
  ageCell.className = "radar-age";
  const indicator = document.createElement("span");
  indicator.className = "radar-live-dot " + (fresh ? "on" : "off");
  const ageLabel = document.createElement("span");
  ageLabel.textContent = fresh ? (ageMs < 1000 ? "now" : (ageMs / 1000).toFixed(1) + "s") : "stale";
  ageCell.append(indicator, ageLabel);
  tr.append(ageCell);
  tr.append(createCell("MONITOR", "radar-monitor"));
  return tr;
}

function bootBinanceRadar() {
  const app = document.getElementById("app");
  const tableBody = document.getElementById("binanceRadarRows");
  if (!app || !tableBody) return;

  let markets = [];
  let active = false;
  let socket = null;
  let renderTimer = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let lastMessageAt = 0;
  let selectedFilter = "all";
  let selectedSort = "volume";
  let searchTerm = "";
  let lastRestRefreshAt = 0;
  let restRetryTimer = null;
  let restRetryAttempts = 0;

  const rowsBySymbol = new Map();

  function setFeedState(label, status) {
    const node = document.getElementById("radarFeedState");
    if (!node) return;
    node.textContent = label;
    node.className = "tag " + (status || "");
  }

  function sortRows(rows) {
    const filtered = rows.filter((row) => {
      if (searchTerm && !row.symbol.includes(searchTerm) && !row.baseAsset.includes(searchTerm)) return false;
      if (selectedFilter === "gainers" && !(row.changePct > 0)) return false;
      if (selectedFilter === "losers" && !(row.changePct < 0)) return false;
      if (selectedFilter === "tight" && !(row.spreadBps !== null && row.spreadBps <= 12)) return false;
      return true;
    });
    filtered.sort((a, b) => {
      if (selectedSort === "move") return (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity);
      if (selectedSort === "tight") return (a.spreadBps ?? Infinity) - (b.spreadBps ?? Infinity);
      return b.quoteVolume - a.quoteVolume;
    });
    return filtered;
  }

  function render() {
    if (!active) return;
    const now = Date.now();
    const rows = sortRows([...rowsBySymbol.values()]);
    tableBody.replaceChildren();
    if (!rows.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 8;
      td.className = "muted";
      td.textContent = markets.length ? "No markets match the current search or filter." : "Waiting for Binance market data.";
      tr.append(td);
      tableBody.append(tr);
    } else {
      for (const row of rows) tableBody.append(createRadarRow(row, now));
    }

    const liveCount = [...rowsBySymbol.values()].filter((row) => now - row.receivedAt <= BINANCE_RADAR_STALE_MS).length;
    text("radarMarketCount", String(markets.length));
    text("radarLiveCount", String(liveCount));
    const median = medianRadarSpread([...rowsBySymbol.values()]);
    text("radarMedianSpread", median === null ? "—" : median.toFixed(2) + " bps");
    const top = [...rowsBySymbol.values()].sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0))[0];
    text("radarTopMover", top ? top.baseAsset + " " + (top.changePct > 0 ? "+" : "") + (top.changePct ?? 0).toFixed(2) + "%" : "—");
    text("radarLastUpdate", lastMessageAt ? new Date(lastMessageAt).toLocaleTimeString() : "Waiting for first stream event");

    if (socket?.readyState === WebSocket.OPEN && lastMessageAt && now - lastMessageAt <= BINANCE_RADAR_STALE_MS) {
      setFeedState("LIVE · " + markets.length + " MARKETS", "good");
    } else if (socket?.readyState === WebSocket.OPEN) {
      setFeedState("CONNECTED · WAITING", "");
    } else if (active && markets.length) {
      setFeedState("RECONNECTING", "bad");
    }
  }

  function stopSocket() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (restRetryTimer) clearTimeout(restRetryTimer);
    reconnectTimer = null;
    restRetryTimer = null;
    if (socket) {
      const current = socket;
      socket = null;
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      try { current.close(1000, "dashboard_hidden"); } catch {}
    }
  }

  function scheduleReconnect() {
    if (!active || reconnectTimer) return;
    reconnectAttempts += 1;
    const delay = Math.min(BINANCE_RADAR_RECONNECT_MAX_MS, 1000 * (2 ** Math.min(reconnectAttempts - 1, 5)));
    setFeedState("RECONNECTING · " + Math.ceil(delay / 1000) + "s", "bad");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectSocket();
    }, delay);
  }

  function connectSocket() {
    if (!active || !markets.length || socket) return;
    try {
      const url = buildBinanceRadarStreamUrl(markets.map((row) => row.symbol));
      const next = new WebSocket(url);
      socket = next;
      next.onopen = () => {
        if (socket !== next) return;
        reconnectAttempts = 0;
        setFeedState("CONNECTED · WAITING", "");
      };
      next.onmessage = (event) => {
        if (socket !== next || !active) return;
        let payload;
        try { payload = JSON.parse(event.data); } catch { return; }
        const ticker = normalizeBinanceRadarTicker(payload?.data, Date.now());
        if (!ticker || !rowsBySymbol.has(ticker.symbol)) return;
        const prior = rowsBySymbol.get(ticker.symbol);
        rowsBySymbol.set(ticker.symbol, { ...prior, ...ticker });
        lastMessageAt = Date.now();
      };
      next.onerror = () => {
        if (socket !== next) return;
        setFeedState("STREAM ERROR", "bad");
      };
      next.onclose = () => {
        if (socket !== next) return;
        socket = null;
        scheduleReconnect();
      };
    } catch {
      setFeedState("STREAM UNAVAILABLE", "bad");
      scheduleReconnect();
    }
  }

  async function loadUniverse() {
    setFeedState("LOADING MARKETS", "");
    try {
      const response = await fetch(BINANCE_RADAR_DATA_URL, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        headers: { "accept": "application/json" }
      });
      if (!response.ok) throw new Error("binance_market_data_http_" + response.status);
      const payload = await response.json();
      const selected = selectBinanceRadarMarkets(payload);
      if (!selected.length) throw new Error("binance_market_universe_empty");
      markets = selected;
      window.binanceRadarSymbols = markets.map((row) => row.symbol);
      rowsBySymbol.clear();
      const seedTime = Date.now();
      for (const row of selected) rowsBySymbol.set(row.symbol, { ...row, receivedAt: seedTime });
      lastRestRefreshAt = seedTime;
      restRetryAttempts = 0;
      if (restRetryTimer) clearTimeout(restRetryTimer);
      restRetryTimer = null;
      text("radarUniverseNote", "Top " + markets.length + " liquid Binance USDT Spot pairs · 24h quote-volume ranking · public market-data-only endpoint.");
      connectSocket();
      render();
    } catch (error) {
      setFeedState("DATA UNAVAILABLE", "bad");
      text("radarUniverseNote", "Binance public market data could not be loaded: " + String(error?.message || "network_error") + ". No cached or synthetic prices are shown.");
      if (active && !restRetryTimer) {
        restRetryAttempts += 1;
        const delay = Math.min(BINANCE_RADAR_RECONNECT_MAX_MS, 2000 * (2 ** Math.min(restRetryAttempts - 1, 4)));
        restRetryTimer = setTimeout(() => {
          restRetryTimer = null;
          if (active && !markets.length) loadUniverse();
        }, delay);
      }
    }
  }

  function start() {
    if (active || document.hidden || app.classList.contains("hidden")) return;
    active = true;
    if (renderTimer) clearInterval(renderTimer);
    renderTimer = setInterval(render, 1000);
    const needsRefresh = !markets.length || Date.now() - lastRestRefreshAt > 5 * 60 * 1000;
    if (needsRefresh) {
      stopSocket();
      loadUniverse();
    } else {
      connectSocket();
      render();
    }
  }

  function stop() {
    active = false;
    if (renderTimer) clearInterval(renderTimer);
    renderTimer = null;
    stopSocket();
    if (markets.length) setFeedState("PAUSED · TAB HIDDEN", "");
  }

  document.getElementById("radarSearch")?.addEventListener("input", (event) => {
    searchTerm = String(event.target.value || "").trim().toUpperCase().slice(0, 24);
    render();
  });
  document.getElementById("radarFilter")?.addEventListener("change", (event) => {
    selectedFilter = String(event.target.value || "all");
    render();
  });
  document.getElementById("radarSort")?.addEventListener("change", (event) => {
    selectedSort = String(event.target.value || "volume");
    render();
  });
  document.getElementById("radarRefresh")?.addEventListener("click", () => {
    if (!active) return;
    stopSocket();
    markets = [];
    rowsBySymbol.clear();
    loadUniverse();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });
  const observer = new MutationObserver(() => {
    if (app.classList.contains("hidden")) stop();
    else start();
  });
  observer.observe(app, { attributes: true, attributeFilter: ["class"] });
  if (!app.classList.contains("hidden") && !document.hidden) start();
}

if (typeof document !== "undefined") bootBinanceRadar();
