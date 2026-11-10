# Oracle Always Free backend setup (₹0 guardrails)

This guide is deliberately conservative. It does not create Oracle resources, upgrade an Oracle account, enable paid services, or configure real-money trading.

## Cost and account checks before creating anything

- Oracle requires a supported credit/debit card for identity verification. It may place a temporary authorization hold; Oracle says this is not an actual charge and is typically released by the bank within 3–5 days. If even a temporary hold is unacceptable, stop here.
- Do not click **Upgrade**, **Pay As You Go**, or create a paid account.
- Use only resources visibly labelled **Always Free eligible** in the Oracle Console. Do not rely on the free-trial US$300 credits.
- Oracle says Always Free compute must be created in the tenancy's home region. Its published A1 allowance is up to 2 OCPUs and 12 GB RAM total, plus 200 GB total boot/block storage. A single A1 VM with 1 OCPU, 6 GB RAM and the default 50 GB boot volume stays within those published limits.
- Capacity is not guaranteed. If the A1 shape is unavailable, wait or stop; do not select a paid shape.
- Oracle may reclaim Always Free compute that remains idle under its published CPU, network and (A1) memory thresholds over a 7-day period. This is not a guaranteed 24/7 SLA.
- Do not create load balancers, paid NAT gateways, paid databases, extra volumes, or any resource whose console page does not explicitly show Always Free eligibility.
- A budget alert is only an alert, not a hard spending cap. The safest rule is never to upgrade and never to create a non-Always-Free resource.

Official references:
- https://www.oracle.com/cloud/free/faq/
- https://docs.oracle.com/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm

## Create the VM manually

1. Sign up / sign in at https://cloud.oracle.com/ only if you accept the card verification and possible temporary authorization hold described above. Use one accurate account only.
2. Confirm the account remains on Free Tier. Do not upgrade it.
3. In **Compute → Instances → Create instance**, choose the tenancy **home region**.
4. Choose an Ubuntu ARM image marked **Always Free eligible**.
5. Choose **VM.Standard.A1.Flex**, 1 OCPU and 6 GB memory. Check the estimated cost / Always Free label before creating. If the page shows a charge, cancel.
6. Use the default 50 GB boot volume. Do not add block volumes.
7. For networking, use the simplest public-subnet configuration available in the home region. Do not add a load balancer or paid network resource.
8. Add an SSH key you control. In the subnet security list / network security group, allow SSH (TCP 22) only from your current public IP. Do not open TCP 8000, 443, or 80 to the public internet.
9. Review the final resource summary. If any component is not explicitly Always Free eligible or shows a price, cancel instead of proceeding.

## Install the backend

After the VM exists, connect over SSH and run:

```bash
curl -fsSL https://raw.githubusercontent.com/fayisaftha786/ai-trading-terminal-/main/deploy/oracle-always-free/bootstrap.sh -o bootstrap.sh
chmod +x bootstrap.sh
sudo ./bootstrap.sh
```

The script is intended for an ARM64 Ubuntu A1 VM. It installs Docker, clones the public repository's **main** branch, builds the current PAPER-only backend, creates a persistent SQLite directory, generates a strong app secret, and asks you to choose a strong dashboard password (20+ alphanumeric/dot/underscore/hyphen characters). It does not ask for or store exchange API keys. It binds the app to 127.0.0.1:8000 only.

The backend uses Coinbase Exchange public REST endpoints for BTC-USD, ETH-USD and SOL-USD. Market-data errors fail closed and automatic signals remain HOLD when fresh, complete data is unavailable. Do not use proxies or VPNs to bypass regional exchange restrictions.

After the script completes, sign the VM into your personal Tailscale network (free Personal plan is intended for non-commercial personal use): https://tailscale.com/download/linux . Install Tailscale on your Android phone and sign in to the same tailnet. Then, on the VM, run:

```bash
sudo tailscale serve --bg 8000
sudo tailscale serve status
```

Tailscale Serve provides a private HTTPS URL reachable only by devices in your tailnet. Do not use Tailscale Funnel. Do not expose port 8000 publicly. Official docs: https://tailscale.com/docs/features/tailscale-serve

## Verification

On the VM:

```bash
docker ps
docker logs --tail=100 ai-trading-terminal
curl -fsS http://127.0.0.1:8000/api/health
sudo tailscale serve status
```

Then open the private HTTPS Tailscale Serve URL in a browser first. Sign in and run a manual market scan. Confirm the CEX provider reports live markets, verify candle integrity and check that no provider errors are present. Only then use the UI's Auto Scan / Auto Paper controls. On Android, open the AI Trading Terminal APK, choose Cloud dashboard, and enter that same private HTTPS URL. The APK uses HTTPS only and does not need exchange keys.

The app is PAPER-only by default on main. The scheduled scanner runs inside the FastAPI process; enable Auto Scan in the dashboard to start automatic market updates, or explicitly opt into Auto Paper only after the provider health is verified. Auto Paper entries are simulated and use existing risk sizing, daily/weekly loss limits, drawdown halt, symbol cooldown and stop/target monitoring. Coinbase live order execution remains locked and is not configured by this bootstrap. No production LIVE trading route exists. First verify provider reachability from the VM; if Coinbase public market data is unavailable in the Oracle region, the strategy must remain HOLD.

## Important limitations

- I cannot create the VM inside your Oracle account without you completing Oracle's account and console steps. Do not share your Oracle password, card details, SSH private key, Tailscale auth key, or exchange secrets in chat.
- Oracle free capacity, account approval, and region availability are not guaranteed.
- This setup is not yet a verified live trading bot. It provides a private persistent PAPER backend only. Any future live execution requires separate authenticated exchange lifecycle tests and explicit opt-in after verification.
