# CR_AGENTIC — Deploy Once on a Single EC2 (Option A)

This runbook deploys the entire CR_AGENTIC stack (API + browser/ai/discovery
workers + Postgres + Redis) as one `docker compose` stack on a single EC2
instance. Object storage uses real AWS S3.

```
                EC2 instance (Docker)
  ┌──────────────────────────────────────────────┐
  │  agent-api :3100                               │
  │  browser-worker   ai-worker   discovery-worker │
  │  agent-postgres (volume)   agent-redis (volume)│
  │  migrate (one-shot, runs Prisma migrations)    │
  └──────────────────────────────────────────────┘
        │                         │
        ▼                         ▼
   AWS S3 bucket          Main Course Rep API
 (sessions + docs)        (COURSE_REP_API_URL)
```

## 1. Prerequisites (in the AWS console — you sign in)

1. **S3 bucket** for sessions/documents (e.g. `cr-agent-documents`).
2. **IAM role for EC2** (instance profile) with `s3:GetObject`, `s3:PutObject`,
   `s3:ListBucket` on that bucket. This avoids static keys in `.env`.
3. **Security group** allowing inbound `22` (SSH, your IP only) and `3100`
   (or `80/443` if you add a reverse proxy — see step 7).
4. **EC2 instance**: Ubuntu 22.04/24.04, `t3.large` or larger
   (Playwright/Chromium is memory-hungry; 8 GB RAM recommended), 30 GB+ disk.
   Attach the IAM role from step 2.

## 2. Install Docker on the instance

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker   # or log out/in
```

## 3. Get the code

```bash
git clone <your-repo-url> course-rep-backend
cd course-rep-backend/CR_AGENTIC
```

## 4. Configure environment

```bash
cp .env.prod.example .env
# Edit .env. Generate strong secrets:
#   openssl rand -hex 32   # SESSION_ENCRYPTION_KEY
#   openssl rand -hex 32   # JWT_SECRET
nano .env
```

Required values: `POSTGRES_PASSWORD`, `JWT_SECRET`, `INTERNAL_API_SECRET`,
`SESSION_ENCRYPTION_KEY`, `AWS_S3_BUCKET`, `AWS_REGION`, `COURSE_REP_API_URL`,
`OPENAI_API_KEY`, `PORTAL_SEARCH_API_KEY`.

Leave `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` blank to use the instance
role. Do **not** set `AGENT_DATABASE_URL` — compose builds it from
`POSTGRES_PASSWORD` and points it at the local `agent-postgres` container.

## 5. Deploy

```bash
cd docker
./deploy.sh
```

This builds all images, runs the one-shot `migrate` service (Prisma
migrations), then starts the stack. `deploy.sh` is idempotent — re-run it to
pick up code changes (`git pull` first).

Equivalent manual commands:

```bash
docker compose --env-file ../.env -f docker-compose.prod.yml build
docker compose --env-file ../.env -f docker-compose.prod.yml up -d
```

## 6. Verify

```bash
docker compose --env-file ../.env -f docker-compose.prod.yml ps
curl http://localhost:3100/health
docker compose --env-file ../.env -f docker-compose.prod.yml logs -f agent-api
```

The `migrate` container should show state `Exited (0)`. App services should be
`Up`.

## 7. External access & HTTPS (recommended)

The API is published on `127.0.0.1:3100` only (not `0.0.0.0`). For a public
HTTPS endpoint, put a reverse proxy in front (Caddy on the host terminates
TLS for `agent-api.courserep.ng`):

```bash
# /etc/caddy/Caddyfile
agent.yourdomain.com {
    reverse_proxy localhost:3100
}
```

Then point your domain's DNS at the instance and open `80/443` in the security
group. The mobile app / main API should call `https://agent.yourdomain.com`.

### CORS (required for the React web app)

The browser web client calls this API cross-origin. Set `CORS_ORIGIN` in
`CR_AGENTIC/.env` to every origin where the React app is hosted, then rebuild
`agent-api`:

```bash
CORS_ORIGIN=https://app.courserep.ng,https://app.courserep.org,https://course-rep-agent-web.pages.dev,https://agent.courserep.org,http://localhost:5173
```

After redeploying, an `OPTIONS` preflight to `/api/v1/agent/...` should return
`204` with `Access-Control-Allow-Origin` matching the request origin.

### JWT (required — fixes 401 Unauthorized)

Tokens are issued by the **main** Course Rep API. The agent API validates them
with `JWT_SECRET`, `JWT_ISSUER`, and `JWT_AUDIENCE`. These three values must be
**identical** on both servers or every authenticated agent request returns 401.

On production, copy the JWT block from the main API `.env` on `api.courserep.ng`
into `CR_AGENTIC/.env`, then restart `agent-api`:

```bash
JWT_SECRET=<same-as-main-api>
JWT_ISSUER=COURSE_REP
JWT_AUDIENCE=mMY_AUDIOENCE_HERE
```

## 8. Connect the main Course Rep app

- Set `COURSE_REP_API_URL` in `.env` to the parent API's reachable URL **including
  the Nest global `/api` prefix**, e.g. `https://api.courserep.ng/api`.
  Omitting `/api` used to 404 (`Cannot POST /internal/courses/import-from-agent`);
  the agent client now appends `/api` if it is missing.
- Set the **same** `INTERNAL_API_SECRET` on both the main app and CR_AGENTIC so
  the internal endpoints (`/internal/courses/import-from-agent`,
  `/internal/universities/portal`) authenticate.

## 9. Operations

| Task | Command (run from `CR_AGENTIC/docker`) |
| --- | --- |
| Update/redeploy | `git pull && ./deploy.sh` |
| Tail logs | `docker compose --env-file ../.env -f docker-compose.prod.yml logs -f` |
| Restart one service | `... restart agent-api` |
| Stop everything | `... down` |
| Re-run migrations only | `... run --rm migrate` |
| Backup DB | `docker exec cr-agent-postgres pg_dump -U agent cr_agent > backup.sql` |

> Notes
> - Postgres and Redis data persist in named volumes (`agent-postgres-data`,
>   `agent-redis-data`); `down` keeps them, `down -v` deletes them.
> - This single-VM layout is ideal for staging / first production. To scale,
>   migrate to the ECS/RDS/ElastiCache stack in `infra/terraform`.
