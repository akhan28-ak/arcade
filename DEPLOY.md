# Deploying Chip Wars

Chip Wars is one Node process (`server.js`) that serves both the static
frontend and the Socket.IO backend on a single port — there's no separate
frontend build step and no separate backend service. That makes deployment
simple: any host that can run `npm install && node server.js` and expose
one port works.

I can't push this live for you from here (no hosting credentials, and this
sandbox's network is locked to package registries only) — but everything
below has been tested locally against the exact same install/start
commands each platform will run, including a clean `npm install --omit=dev`
and a real `/healthz` + game-flow check.

## Before you deploy: one important limitation

Rooms live in **in-memory** state (a plain `Map` in `server.js`). That
means:
- Deploy to a **single instance/machine**. If a platform auto-scales to
  multiple instances behind a load balancer without sticky sessions,
  players in the same room can land on different instances and never see
  each other's moves.
- A restart or redeploy drops all active rooms. Fine for a casual game;
  swap in Redis (via `socket.io-adapter-redis` and a shared room store) if
  you need horizontal scaling or zero-downtime deploys later.

All the configs below are set up for exactly one instance.

---

## Option 1 — Render (recommended, easiest)

Render's free/starter web services support WebSockets out of the box and
`render.yaml` is included, so it's mostly point-and-click.

1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com) → **New** → **Blueprint** → connect
   the repo. Render reads `render.yaml` automatically and creates the
   service (build: `npm install --omit=dev`, start: `node server.js`,
   health check: `/healthz`).
3. Deploy. Render gives you a URL like `https://chip-wars.onrender.com`.

Or without the blueprint: **New** → **Web Service** → connect repo →
Build Command `npm install --omit=dev`, Start Command `node server.js`.

## Option 2 — Railway

1. Push to GitHub.
2. [railway.app](https://railway.app) → **New Project** → **Deploy from
   GitHub repo**. Railway auto-detects Node and the `Procfile`
   (`web: node server.js`) — no config needed.
3. Under **Settings → Networking**, click **Generate Domain** to get a
   public URL. Railway's proxy supports WebSockets natively.

## Option 3 — Fly.io

`fly.toml` is included, targeting a single always-on machine.

```
fly auth login
fly launch --no-deploy   # detects fly.toml, skip the prompts to overwrite it
fly deploy
```

Fly terminates TLS and proxies WebSockets at the edge, so nothing extra is
needed for Socket.IO.

## Option 4 — Docker (any host: Fly, Cloud Run, DigitalOcean App
Platform, ECS, a VPS, etc.)

```
docker build -t chip-wars .
docker run -p 3000:3000 -e PORT=3000 chip-wars
```

The image installs production-only dependencies, exposes port 3000, and
has a `HEALTHCHECK` hitting `/healthz`. For Cloud Run specifically: deploy
with `--min-instances=1` and `--max-instances=1` (or wire up the Redis
adapter first) — Cloud Run's autoscaling otherwise violates the
single-instance requirement above. Cloud Run supports WebSockets on all
current generations, no extra flags needed.

## Option 5 — Your own VPS (systemd + Nginx)

```
git clone <your-repo> /opt/chip-wars
cd /opt/chip-wars
npm install --omit=dev
```

`/etc/systemd/system/chip-wars.service`:
```ini
[Unit]
Description=Chip Wars server
After=network.target

[Service]
WorkingDirectory=/opt/chip-wars
ExecStart=/usr/bin/node server.js
Restart=always
Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

```
sudo systemctl enable --now chip-wars
```

Nginx reverse proxy — the `Upgrade`/`Connection` headers are required or
Socket.IO silently falls back to slow long-polling:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```
Then put Certbot/Let's Encrypt in front for HTTPS as usual.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port the server listens on. Most platforms inject this automatically. |
| `CORS_ORIGIN` | `*` | Socket.IO CORS origin. Tighten to your actual domain in production, e.g. `https://chipwars.example.com`. |

## After deploying

Open the deployed URL — the online-multiplayer lobby (Create Room / Join
Room) will work immediately, since the Socket.IO client is served from the
same origin (`/socket.io/socket.io.js`) with no extra configuration.

Sanity check any deployment with:
```
curl https://your-app-url/healthz
# {"ok":true,"rooms":0,"uptime":...}
```
