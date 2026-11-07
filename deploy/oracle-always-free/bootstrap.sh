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

if [[ -f "$ENV_FILE" ]]; then
  echo "Existing $ENV_FILE found. Refusing to overwrite secrets or configuration." >&2
  exit 1
fi

echo "Installing free Ubuntu packages and Docker..."
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

read -r -p "Dashboard username [admin]: " APP_USERNAME
APP_USERNAME="${APP_USERNAME:-admin}"
while true; do
  read -r -s -p "Create dashboard password (minimum 16 characters): " APP_PASSWORD
  echo
  if [[ "${#APP_PASSWORD}" -ge 16 ]]; then break; fi
  echo "Password too short. Try again."
done

APP_AUTH_SECRET="$(openssl rand -hex 32)"
cat > "$ENV_FILE" <<EOF
APP_ENV=production
APP_USERNAME=$APP_USERNAME
APP_PASSWORD=$APP_PASSWORD
APP_AUTH_SECRET=$APP_AUTH_SECRET
APP_TOKEN_TTL_MINUTES=480
DATABASE_PATH=$DATA_DIR/trading.db
PAPER_INITIAL_CAPITAL_USD=100
SCAN_INTERVAL_SECONDS=60
CEX_EXCHANGE=binance
CEX_SYMBOLS=BTC/USDT,ETH/USDT,SOL/USDT
BINANCE_TESTNET_ENABLED=false
BINANCE_TESTNET_ORDER_ENABLED=false
BINANCE_TESTNET_API_KEY=
BINANCE_TESTNET_API_SECRET=
BINANCE_READONLY_ENABLED=false
EOF
chmod 600 "$ENV_FILE"
unset APP_PASSWORD APP_AUTH_SECRET

echo "Building current main-branch PAPER backend for this VM architecture..."
cd "$APP_DIR"
docker build --pull -t "$IMAGE" .

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
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8000/api/health >/dev/null; then
    echo "Health check passed."
    break
  fi
  sleep 2
done

if ! curl -fsS http://127.0.0.1:8000/api/health; then
  echo "Health check failed. Inspect: docker logs ai-trading-terminal" >&2
  exit 1
fi

echo
echo "Install Tailscale using its official Linux instructions, sign this VM into your personal tailnet,"
echo "then run: sudo tailscale serve --bg 8000"
echo "Do NOT enable Funnel and do NOT open port 8000 to the public internet."
echo "Dashboard credentials are stored only in $ENV_FILE (root-readable)."
echo "This deployment uses main-branch PAPER mode only; it does not place real orders."
