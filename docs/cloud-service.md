# OpenFilm Cloud

An optional self-hosted account and library service. PostgreSQL stores identities,
metadata, quota reservations and transfer state. A private Alibaba Cloud OSS bucket stores
file objects. Studio on the user's device sends file bytes directly to OSS, including
multipart uploads and retries. The cloud service only authorizes and verifies operations.
Editing, packaging, restoring and rendering remain local.

## Run the service

For deployments in mainland China, including Dokploy, use the separate
[China deployment configuration](../deploy/cloud/cn/README.md). It provides mirrored
Node/PostgreSQL images, Debian package sources and the npm/Corepack registry.

Copy `deploy/cloud/env.example` to an operator-owned file outside the checkout, restrict
its permissions to the operator, and replace the placeholders. Use a random hexadecimal
`CLOUD_DATABASE_PASSWORD`. Configure the OSS bucket, region, HTTPS endpoint, dedicated
prefix and an operator key with access only to that prefix. Keep the bucket private.
`OSS_CNAME=true` supports an OSS custom domain; normal bucket endpoints use `false`.

```sh
docker compose --env-file /secure/openfilm-cloud.env -f deploy/cloud/compose.yaml up --build -d
docker compose --env-file /secure/openfilm-cloud.env -f deploy/cloud/compose.yaml ps
```

The service binds to `127.0.0.1:8080` by default. Put a TLS reverse proxy in front of it
for remote clients. The deployment operator chooses the public domain and TLS setup.
`GET /health` checks PostgreSQL connectivity. Migrations run transactionally at startup;
back up PostgreSQL and the OSS prefix together before upgrading. The PostgreSQL volume
persists across restarts. Do not run `down --volumes` against data you need.

To develop without Docker, set `DATABASE_URL`, the `OSS_*` variables and run
`corepack pnpm --filter @openfilm/cloud start`. With no `OSS_BUCKET`, accounts work but
library operations return a configuration error. OSS credentials are read by the cloud
process only. Never put them in Studio, projects, snapshots, screenshots or source control.

## Accounts and administration

In Studio, open Settings → Cloud account, set the service URL, then register or sign in.
The cloud library is also available from the cloud button in the media pane. Choose a
local project for uploads and media imports. Snapshots restore a new project and do not
require an existing project. Settings also provides password changes, which revoke all
cloud sessions. Cloud failures do not disable local projects.

Passwords are scrypt hashes; sessions last 30 days and only token hashes are stored in
PostgreSQL. Studio keeps its session in its private home outside project directories.
Switching accounts or service URLs pauses active transfers. Resume explicitly after
signing in to the original service and account. A changed source file must be uploaded
as a new transfer. Failed transfers preserve checkpoints; cancel releases reservations.

Administrator commands run on the server with its privileged `DATABASE_URL`. They are
not public HTTP endpoints. Register the operator account first, then initialize it:

```sh
# Run inside the cloud container (or with DATABASE_URL in the server environment).
node apps/cloud/src/admin.ts init operator
node apps/cloud/src/admin.ts disable alice --as operator
node apps/cloud/src/admin.ts enable alice --as operator
node apps/cloud/src/admin.ts quota alice 20000000000 --as operator
node apps/cloud/src/admin.ts remove <asset-id> --as operator
# Supply the new password on stdin, never in arguments or shell history.
node apps/cloud/src/admin.ts reset alice --as operator --password-stdin
```

For Compose, prefix those commands with `docker compose --env-file
/secure/openfilm-cloud.env -f deploy/cloud/compose.yaml exec -T cloud`. Resetting a password
or disabling an account revokes its sessions. Disabled owners disappear from public
catalogs. Removing a shared asset stops new public access and prevents republishing the
same result through a new asset entry. The owner retains private access to their files.

## Storage, limits and recovery

Defaults use decimal bytes: 10 GB per account, 2 GB per asset/result, 5 GB per snapshot.
`CLOUD_QUOTA_BYTES` changes the default for new accounts; `admin quota` changes an existing
account. `CLOUD_FILE_BYTES` and `CLOUD_SNAPSHOT_BYTES` set per-file limits.
`CLOUD_PART_BYTES` defaults to 8 MiB; use 100 KiB–64 MiB and at most 10,000 parts per file.
`CLOUD_UPLOAD_SECONDS` defaults to 86,400 seconds. `CLOUD_CLEANUP_SECONDS` defaults to 300.
Expired/cancelled uploads release reservations and their objects/parts are swept. Small
uploads use staging objects; those are swept after the last 15-minute PUT grant expires.
Configure an OSS lifecycle rule to abort incomplete multipart uploads older than two days
inside the dedicated prefix, covering a process crash during multipart initialization.

Small uploads are verified using OSS size, MD5 and SHA-256 metadata, then copied within
OSS to an immutable final key. Large uploads use a unique multipart upload ID, fixed part
checksums, verified part sizes and consumed completion grants. Quota uses a lock per
account to serialize reservations and completion. A result shared as an asset references
the same blob; it counts once until its last reference is deleted.

Downloads and previews are signed for 10,800 seconds (three hours). This does not impose
a deadline on a transfer that already began. Revocation blocks new grants immediately;
a previously signed URL may remain usable for the rest of its three-hour window. Every
resume and expired-link refresh rechecks authorization. Range downloads persist verified
chunks and verify the complete SHA-256 before importing any file.

Snapshots copy approved linked files/directories into a portable ZIP, with per-file hashes
and a versioned manifest. They include project pages, code, media and portable editor state.
Hidden credentials, conversations, history, caches and generated exports are excluded.
Restore validates paths, duplicates, file sizes and checksums in an isolated folder before
opening a new project identity. Symbolic links in downloaded archives are rejected.

## Validation

```sh
OPENFILM_TEST_DATABASE_URL=postgres://... corepack pnpm --filter @openfilm/cloud test
# After pnpm build, with a graphical display available:
OPENFILM_TEST_DATABASE_URL=postgres://... corepack pnpm --filter @openfilm/cloud test:desktop
# Explicit real OSS test: private JSON config with bucket, region, endpoint, prefix and keys.
OPENFILM_TEST_DATABASE_URL=postgres://... OPENFILM_OSS_TEST_CONFIG=/secure/oss-test.json \
  node apps/cloud/test/oss-acceptance.mjs
```

Routine tests use real Studio, CLI, cloud service and PostgreSQL with an OSS HTTP double.
The opt-in OSS test writes under a unique child prefix and deletes only its own exact keys
and upload IDs. Its logs contain no credentials or signed URLs. See
[cloud-library-validation.md](cloud-library-validation.md) for acceptance coverage.
