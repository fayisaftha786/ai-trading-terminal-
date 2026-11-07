# v0.5.0 Cloud Edition — Release audit scope

The current release gate is executed by `python scripts/master_release.py`.

Cloud-specific controls added in this release:

1. Production mode requires a 16+ character dashboard password and a 32-byte token-signing secret.
2. Every `/api/*` endpoint except the minimal health route and authentication handshake requires a valid, unexpired bearer token.
3. Login failures are rate-limited to five attempts per ten minutes per client address within the single server process.
4. API responses include security headers; HTTPS responses include HSTS.
5. Android accepts only HTTPS URLs and blocks cleartext traffic for all hosts.
6. Render Blueprint mounts persistent SQLite storage at `/var/data` and keeps a single service instance.
7. Docker runs one Uvicorn worker; the background scheduler remains process-local.
8. Live trading remains hard-disabled; Testnet order switches remain OFF in the deployment Blueprint.

The audit does not claim a completed cloud deployment, a built APK, device installation, 24/7 uptime, profitability, or authenticated exchange Testnet execution. Those require real provider deployment and device/exchange tests.
