#!/usr/bin/env bash
set -Eeuo pipefail

REPO="https://github.com/fayisaftha786/ai-trading-terminal-.git"
APP_DIR="/opt/ai-trading-terminal"
DATA_DIR="/var/lib/ai-trading-terminal"
ENV_FILE="/etc/ai-trading-terminal.env"
IMAGE="ai-trading-terminal:main"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo: sudo ./bootstrap.sh" >&2
  exit 1
fi

ARCH="$(uname -m)"
if [[ "$ARCH" != "aarch64" && "$ARCH" != "arm64" ]]; then
  echo "This guide targets Oracle A1 ARM64 Always Free VMs (detected: $ARCH)." >&2
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  echo "Existing $ENV_FILE found. Refusing to overwrite secrets or configuration." >&2
  exit 1
fi

echo "Installing Ubuntu packages and Docker..."
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git openssl docker.io
systemctl enable --now docker

mkdir -p "$APP_DIR" "$DATA_DIR"
chmod 700 "$DATA_DIR"

if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch origin
  git -C "$APP_DIR" checkout main
  git -C "$APP_DIR" pull --ff-only origin main
else
  git clone --depth 1 --branch main "$REPO" "$APP_DIR"
fi

echo "Building current main-branch PAPER backend for this VM architecture..."
cd "$APP_DIR" || exit 1
docker build --pull -t "$IMAGE" .

read -r -p "Dashboard username [admin]: " APP_USERNAME
APP_USERNAME="${APP_USERNAME:-admin}"
if [[ ! "$APP_USERNAME" =~ ^[A-Za-z0-9_.-]{3,32}$ ]]; then
  echo "Username must be 3-32 characters: letters, numbers, dot, underscore or hyphen." >&2
  exit 1
fi

while true; do
  read -r -s -p "Create dashboard password (minimum 16 characters): " APP_PASSWORD
  echo
  if [[ "${#APP_PASSWORD}" -ge 20 && "$APP_PASSWORD" =~ ^[A-Za-z0-9._-]+$ ]]; then break; fi
  echo "Use at least 20 characters, with only letters, numbers, dot, underscore or hyphen."
done

APP_AUTH_SECRET="$(openssl rand -hex 32)"
umask 077
{
  printf 'APP_ENV=production\n'
  printf 'APP_USERNAME=%s\n' "$APP_USERNAME"
  printf 'APP_PASSWORD=%s\n' "$APP_PASSWORD"
  printf 'APP_AUTH_SECRET=%s\n' "$APP_AUTH_SECRET"
  printf 'APP_TOKEN_TTL_MINUTES=480\n'
  printf 'DATABASE_PATH=%s/trading.db\n' "$DATA_DIR"
  printf 'PAPER_INITIAL_CAPITAL_USD=100\n'
  printf 'SCAN_INTERVAL_SECONDS=60\n'
  printf 'MARKET_CACHE_SECONDS=20\n'
  printf 'CEX_EXCHANGE=binance\n'
  printf 'CEX_SYMBOLS=BTC/USDT,ETH/USDT,SOL/USDT\n'
  printf 'BINANCE_TESTNET_ENABLED=false\n'
  printf 'BINANCE_TESTNET_ORDER_ENABLED=false\n'
  printf 'BINANCE_TESTNET_API_KEY=\n'
  printf 'BINANCE_TESTNET_API_SECRET=\n'
  printf 'BINANCE_READONLY_ENABLED=false\n'
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
unset APP_PASSWORD APP_AUTH_SECRET

docker rm -f ai-trading-terminal >/dev/null 2>&1 || true
docker run -d \
  --name ai-trading-terminal \
  --restart unless-stopped \
  --env-file "$ENV_FILE" \
  -v "$DATA_DIR:$DATA_DIR" \
  -p 127.0.0.1:8000:8000 \
  "$IMAGE"

echo
echo "Backend container started. Waiting briefly for health check..."
health_ok=false
for attempt in {1..30}; do
  if curl -fsS http://127.0.0.1:8000/api/health >/dev/null; then
    health_ok=true
    break
  fi
  echo "Health check attempt $attempt/30; retrying..."
  sleep 2
done

if [[ "$health_ok" != true ]]; then
  echo "Health check failed. Inspect: docker logs ai-trading-terminal" >&2
  exit 1
fi

curl -fsS http://127.0.0.1:8000/api/health
echo
echo
echo "Install Tailscale using its official Linux instructions, sign this VM into your personal tailnet,"
echo "then run: sudo tailscale serve --bg 8000"
echo "Do NOT enable Funnel and do NOT open port 8000 to the public internet."
echo "Dashboard credentials are stored only in $ENV_FILE (root-readable)."
echo "Primary market data is Binance through CCXT; official Coinbase public-data fallback is enabled."
echo "If both providers are unavailable, strategy output fails closed (HOLD/no entry)."
echo "This deployment is PAPER-only; it does not place real-money orders."
