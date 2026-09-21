# CR_AGENTIC Infrastructure

Terraform that provisions CR_AGENTIC as a **standalone** stack, fully separate
from the main Course Rep MySQL deployment. It creates a dedicated VPC, RDS
PostgreSQL, ElastiCache Redis, an S3 bucket, four ECS Fargate services behind an
ALB, Secrets Manager entries, and the IAM roles that tie them together.

## Components

| File | Provisions |
|------|------------|
| `network.tf` | VPC, public/app/data subnets, NAT, security groups |
| `data-stores.tf` | RDS PostgreSQL 16, ElastiCache Redis 7, S3 bucket |
| `secrets.tf` | Secrets Manager entries + derived `AGENT_DATABASE_URL` |
| `iam.tf` | ECS execution + task roles (secret read, S3 access) |
| `ecs.tf` | ECR repos, cluster, task defs/services, migrate task |
| `alb.tf` | ALB, target group, HTTP/HTTPS listeners |

## Services

`agent-api` (public via ALB), `browser-worker`, `ai-worker`, and
`discovery-worker` (private). Each runs from its own ECR image and reads
configuration from `common_env` plus Secrets Manager.

## Usage

```bash
cd CR_AGENTIC/infra/terraform
cp terraform.tfvars.example terraform.tfvars   # edit values
terraform init
terraform plan
terraform apply
```

After the first apply, set the real secret values (Terraform only creates
placeholders and then ignores changes to them):

```bash
aws secretsmanager put-secret-value --secret-id cr-agentic/jwt_secret --secret-string "<value>"
# repeat for session_encryption_key, internal_api_secret, openai_api_key, portal_search_api_key
```

> The `JWT_SECRET` and `JWT_ISSUER` must match the main Course Rep API.
> `JWT_ISSUER` is set to `COURSE_REP` in `ecs.tf` to align with the main `.env`.

## Deploys & migrations

Production CI (`.github/workflows/deploy.yml`) SSHes to the Contabo VPS, resets
`/opt/courserep/courserep_backend` to `origin/cr-agentic`, and runs
`CR_AGENTIC/docker/deploy.sh` (compose build + migrate + up). Health is checked
at `http://127.0.0.1:3100/api/v1/agent/health` (fallback `/health`).

Required GitHub repository secrets:

- `CONTABO_HOST` — VPS address (84.46.240.202)
- `CONTABO_USER` — SSH user
- `CONTABO_SSH_KEY` — private key for that user

The Terraform in this directory still describes the suspended AWS ECS/ECR
stack. Do not use it for production rollouts.
