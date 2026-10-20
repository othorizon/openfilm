# Cloud accounts

The first cloud slice provides accounts and an empty personal space. File transfers,
OSS integration, sharing, password changes and administrator controls are tracked
in the remaining subissues of [#1](https://github.com/othorizon/openfilm/issues/1).
Editing, media and projects remain local and work without a cloud account.

## Run the service

From the repository root, with Docker Compose installed:

```sh
cp deploy/cloud/env.example deploy/cloud/.env
openssl rand -hex 32
# Put the generated value in deploy/cloud/.env as CLOUD_DATABASE_PASSWORD.
docker compose --env-file deploy/cloud/.env -f deploy/cloud/compose.yaml up --build -d
curl http://127.0.0.1:8080/health
```

The service applies versioned SQL migrations before listening. PostgreSQL has a
persistent named volume and is not published to the host. `docker compose down`
preserves accounts; `down -v` removes the database. Back up PostgreSQL before
deploying future migrations.

The HTTP listener is published only on loopback. For access from other devices,
put a TLS reverse proxy in front of it and configure the client with its HTTPS
URL. Plain HTTP is accepted by the client only for localhost development.
Registration is open to anyone who can reach this service.

There are 30 registration/login attempts per minute per direct peer, with at most
four password operations in flight per service process. Forwarded-IP headers are
not trusted. A reverse proxy therefore shares that peer limit; deployments with
many users should add authentication rate limiting at the proxy and adjust the
service policy deliberately. Limits reset on service restart.

Without Docker, use Node 24 (or Node >=22.18) and PostgreSQL 17:

```sh
pnpm install --frozen-lockfile
DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/DATABASE pnpm --filter @openfilm/cloud start
```

`HOST` defaults to `0.0.0.0`, `PORT` to `8080`. The database role needs permission
to apply migrations. No OSS credentials are needed for this slice.

## Desktop and CLI

In **Settings → Cloud account**, save the service URL, create an account or sign
in, and view **My cloud space**. The initial quota is 10 GB. The interface also
provides refresh and sign out.

The CLI uses the same local Studio instance as the desktop:

```sh
openfilm cloud configure http://127.0.0.1:8080
read -rs -p 'Password: ' cloud_password
printf '%s' "$cloud_password" | openfilm cloud register alice --password-stdin
unset cloud_password
openfilm cloud status
openfilm cloud logout
```

Use `login` in place of `register` for an existing account. Passwords are read
from stdin, never command arguments. Results are JSON; failures exit nonzero.
Usernames are case insensitive, 3–32 letters/numbers/underscores/hyphens and must
start with a letter or number. Passwords contain 10–128 characters.

Sessions last 30 days. Passwords use salted scrypt hashes; only a hash of each
random session token is stored in PostgreSQL. The local token is in
`OPENFILM_HOME/cloud-account.json` (normally `~/.openfilm/cloud-account.json`),
with owner-only file permissions on Unix. It is never returned to the renderer
or written into a project. Development/preview desktop flavors have separate
Studio homes; launch a CLI with the corresponding `OPENFILM_HOME` to share them.

Switching accounts or service addresses discards the old local session and
attempts to revoke it remotely. Signing out while offline clears this device
immediately, but cannot revoke the remote token until the service is reachable;
the UI reports this limitation. An unavailable service never displays a cached
identity as authenticated and does not prevent opening or editing local films.

## Verification

Use a disposable database. Tests create isolated schemas, exercise real cloud
and Studio HTTP endpoints plus the actual CLI, and remove those schemas:

```sh
OPENFILM_TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/TEST_DATABASE \
  pnpm --filter @openfilm/cloud test
pnpm typecheck
```

Without `OPENFILM_TEST_DATABASE_URL`, cloud integration tests explicitly skip.
CI runs them against a real PostgreSQL service. No OSS tests are claimed by this
account-only change.

For the actual desktop flow, install the Electron binary and its system libraries,
run `pnpm build`, then run `pnpm --filter @openfilm/cloud test:desktop` with the
same test database environment variable. On Linux this requires an X display
(a virtual display such as Xvfb also works). It uses isolated application data and
ports 4767/19327. Set `OPENFILM_TEST_ARTIFACTS` to
save a screenshot of the signed-in account.
