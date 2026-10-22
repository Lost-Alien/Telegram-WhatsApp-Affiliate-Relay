# Linux deployment

These instructions use a generic `/opt/telegram-whatsapp-relay` installation and a dedicated `relay` account. They do not contain a production hostname, cloud resource ID or account-specific affiliate configuration.

## Install

Install Node.js 22.13+ and Git first. Confirm that `/usr/bin/node` points to the intended Node version; change `ExecStart` in the service file if your Node executable lives elsewhere.

```sh
node --version
sudo useradd --system --home-dir /opt/telegram-whatsapp-relay --shell /usr/sbin/nologin relay
sudo git clone https://github.com/Lost-Alien/Telegram-WhatsApp-Affiliate-Relay.git /opt/telegram-whatsapp-relay
sudo chown -R relay:relay /opt/telegram-whatsapp-relay
cd /opt/telegram-whatsapp-relay
sudo -u relay npm ci --omit=dev
sudo -u relay cp .env.example .env
sudo chmod 600 .env
sudoedit .env
sudo install -d -m 700 -o relay -g relay .data
```

Fill in the required Telegram application credentials, source list, WhatsApp newsletter JID and Amazon store tag. Configure your Cuelinks channel ID for supported non-Amazon conversions. No service should borrow session files from another bot.

## Enable the service

```sh
sudo install -m 644 deploy/telegram-whatsapp-relay.service /etc/systemd/system/telegram-whatsapp-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-whatsapp-relay.service
sudo systemctl status telegram-whatsapp-relay.service
```

The example unit uses `MemoryHigh=160M`, `MemoryMax=192M`, `MemorySwapMax=128M`, `CPUQuota=50%` and a 112 MiB JavaScript heap. Memory requirements vary by account and media workload. Watch actual service memory after pairing and adjust the unit for your host if needed.

## Pair accounts

The dashboard listens at `127.0.0.1:3100` by default. Open it on the host or forward the port with your own SSH connection:

```sh
ssh -L 3100:127.0.0.1:3100 your-user@your-server
```

Then visit `http://localhost:3100/` and scan both account QR codes. The page has no password gate. To expose the dashboard on an intended network interface, set `HOST` explicitly and restart the service.

Pairing creates a new Telegram session and WhatsApp linked-device identity. They are stored with the outbox in `.data/relay.sqlite` and restored on restart.

## Check health

```sh
curl http://127.0.0.1:3100/healthz
curl http://127.0.0.1:3100/api/status
sudo journalctl -u telegram-whatsapp-relay.service -n 50 --no-pager
sudo systemctl show telegram-whatsapp-relay.service -p MemoryCurrent -p MemoryPeak -p MemorySwapCurrent -p NRestarts
```

`/healthz` returns `503` while accounts are pairing or disconnected. Status, retries and failed posts are visible in the dashboard.

## Update

```sh
sudo systemctl stop telegram-whatsapp-relay.service
cd /opt/telegram-whatsapp-relay
sudo -u relay git pull --ff-only
sudo -u relay npm ci --omit=dev
sudo -u relay npm run check
sudo -u relay npm test
sudo systemctl start telegram-whatsapp-relay.service
```

Keep your `.env` and `.data` directory in place. Changes to the source list take effect after restart; a source added for the first time starts at its latest message.

## Retry failed jobs

```sh
sudo systemctl stop telegram-whatsapp-relay.service
cd /opt/telegram-whatsapp-relay
sudo -u relay /usr/bin/node scripts/retry-failed.js
sudo systemctl start telegram-whatsapp-relay.service
```

Normal transient failures retry automatically. This manual command resets visible failed jobs to pending.

## Back up and restore

The database contains the outbox, source cursors and both account sessions. Use SQLite's backup API/tool for a live database, or stop the service before copying the database and any `-wal`/`-shm` sidecar files. Store backups outside the repository. Keep a separate private copy of your `.env`.

Restore to the same relative data location while the service is stopped, ensure files belong to the `relay` account, then start the service. Account revocation can still require pairing again.
