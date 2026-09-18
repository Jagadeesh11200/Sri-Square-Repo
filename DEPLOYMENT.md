# GitHub-triggered deployment

The legacy archive was a GitHub Pages PWA and contained a generic GKE workflow with placeholder values and an invalid branch declaration. This application now contains a Node.js server and persistent SQLite database, so GitHub Pages is not an appropriate host: it cannot run the server or retain the database volume.

The supplied deployment path is deliberately simple and persistent:

```text
push / merge to main
        |
GitHub Actions: npm ci → syntax check → integration test
        |
build immutable Docker image → GitHub Container Registry
        |
SSH to your Docker host → pull image → docker compose up → health check
        |
named Docker volume: sri_square_data
```

`ci.yml` validates pull requests and `main`. `deploy.yml` runs on every push to `main`, publishes the immutable `${commit SHA}` image to GHCR, then rolls it out automatically once the production secrets are present.

## One-time GitHub repository setup

1. Push this codebase to the target GitHub repository with `main` as its deployment branch.
2. In **Settings → Actions → General**, allow GitHub Actions to read/write packages.
3. Create a GitHub **production** environment. Add an approval rule if production changes should require one.
4. In **Settings → Secrets and variables → Actions**, create these repository/environment secrets:

| Secret | Purpose |
| --- | --- |
| `DEPLOY_HOST` | Host name or IP address of the Docker server. |
| `DEPLOY_USER` | Non-root SSH user that can run Docker Compose. |
| `DEPLOY_SSH_KEY` | Private deployment SSH key. |
| `DEPLOY_KNOWN_HOSTS` | Trusted `known_hosts` line for the Docker host; generate it from a trusted network, not in the workflow. |
| `GHCR_PULL_USERNAME` | GitHub user or machine-user able to read the package. |
| `GHCR_PULL_TOKEN` | Fine-grained GitHub token with **Packages: Read** for the host to pull the GHCR image. |

Optional repository variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEPLOY_PORT` | `22` | SSH port of the Docker server. |
| `SRI_SQUARE_APP_PORT` | `3030` | Host port exposed by the service. |

The deployment job does not try to guess host credentials. Until all required secrets exist, the validation and image-publish job succeeds while the rollout job is skipped. Once they are configured, every successful `main` push deploys automatically.

## One-time Docker-host setup

On an Ubuntu/Debian server, install Docker Engine plus the Docker Compose plugin. Create a non-root deploy user and authorize the public half of `DEPLOY_SSH_KEY` for that user. The user must be permitted to run `docker compose`.

This product deliberately has **no login or logout**. Its Docker port is therefore bound only to `127.0.0.1` by default. Do not expose it directly to the public internet. If it must be reached outside the host, use a private VPN/network or a trusted reverse proxy with network-level access restrictions. Route the chosen host port (default `3030`) only through that protected path. The health endpoint is:

```text
GET /api/health
```

The named `sri_square_data` Docker volume holds `sri-square.db` and generated automatic JSON backups. Do not remove that volume during application updates; a fresh immutable application image is safe because it reattaches the existing volume.

## Data migration from the attached legacy PWA

The original PWA exported files with the format `SRI SQUARE ACCOUNTS BACKUP`. The owner can select one in **Backup & Audit → Import Backup**. Bookings, customer billing values, finance values, expenses, and cash ledger entries are converted into new append-only events.

Migration is idempotent: importing the same legacy file again adds nothing. Existing booking serial numbers are also protected from duplicate legacy imports. Export a current event backup before a major migration.

## Security notes

- The product opens directly into the owner workspace. It has no application-level login, logout or customer access path.
- The product has one fixed owner audit identity. Any old secondary local account is disabled on startup rather than deleted, preserving audit attribution.
- SSH host verification uses the explicit `DEPLOY_KNOWN_HOSTS` secret; the workflow does not rely on blind host-key scanning.
- The image tag is the immutable Git commit SHA, not only `latest`.
- GitHub Pages is retained only for the archived static legacy product; do not point it at this server-backed application.
