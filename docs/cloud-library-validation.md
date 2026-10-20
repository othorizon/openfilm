# Cloud library validation

The implementation follows GitHub issue #1 and child tickets #2–#12 in
`othorizon/openfilm`. These checks exercise public HTTP APIs, real CLI processes,
real PostgreSQL, local project files and an actual Electron window. Routine fault
injection is confined to the external OSS HTTP boundary.

## User-story coverage

| Stories | User-visible behavior | Evidence |
| --- | --- | --- |
| 1–6 | Register, sign in/out, change/reset passwords, initialize admin, disable accounts | `accounts.test.ts`, `admin.test.ts`, `studio.test.ts`, Electron smoke |
| 7–8 | Local projects/editing remain available without a cloud account or during an outage | `studio.test.ts`; existing local render/export suite |
| 9–13 | Private ownership, used/reserved capacity, shared quota, configured limits and operator quota adjustment | `library.test.ts`, Compose acceptance |
| 14–20 | Private media upload, name/tag/type search, preview, confirmed immediate publication | `library.test.ts`, CLI integration, Electron smoke |
| 21–27 | Local import, duplicate reuse, withdrawal, moderation, independent copies, confirmed deletion and cancellation | `library.test.ts`, `admin.test.ts`, `transfers.test.ts` |
| 28–35 | Independent portable draft versions, linked files/directories, editor state, missing-dependency errors, exclusions, new local identity | `transfers.test.ts`, actual CLI snapshot/restore |
| 36–38 | Private project results, project filtering, media sharing without duplicate blob charges | `library.test.ts`, CLI integration; local export regression suite |
| 39–43 | Direct OSS file/part traffic, durable progress, retry/resume, account/source checks and verified completion | `transfers.test.ts`, `library.test.ts`, real OSS acceptance |
| 44–45 | Actual 10,800-second signatures, Range reads, expired-link refresh with current authorization | `library.test.ts`, `transfers.test.ts`, real OSS acceptance |
| 46–49 | Agent/CLI and desktop share account, catalog, actions and local relative-path results; mutations need authorization | `studio.test.ts`, Electron smoke, `openfilm cloud --help`, `MANUAL.md` |
| 50–52 | Compose, clean migrations, admin CLI, account/service binding, real prefix-isolated OSS test and cleanup | Compose acceptance, `studio.test.ts`, `oss-acceptance.mjs` |

## Required acceptance scenarios

| Spec scenario | Verification |
| --- | --- |
| 1. Two-account workflow | CLI test publishes as Alice, discovers/imports as Bob, edits a local scene, saves/restores a draft and uploads/shares a project result. |
| 2. Authorization | Foreign task/item operations and unauthenticated requests are refused; disable/reset invalidate sessions; moderation survives restart. |
| 3. Direct transfer | Device-side fetch sends file bytes to OSS. Cloud accepts bounded JSON only and uses SDK metadata/control requests. Real PUT and multipart requests pass. |
| 4. Completion | Missing or changed parts fail; duplicate completion is idempotent; replaying a staging PUT cannot change published bytes. Lost PUT and multipart-completion responses recover. |
| 5. Revocation independence | Withdrawal stops new public grants; downloaded copies remain unchanged; snapshots contain materialized local files. |
| 6. Three-hour grants | Real signature query is 10800; an OSS boundary 403 forces a fresh authorization; withdrawal rejects a resumed download. |
| 7. Restart/resume | Persisted multipart progress survives Studio/service restart; changed source/identity is refused. A 5 MiB interrupted download preserves its verified 4 MiB prefix. |
| 8. Capacity | Small configured quotas test concurrent reservations, over-limit errors, cancellation, expiry and final-reference deletion. |
| 9. Portability | Approved directory links and editor state survive removal of external source files. Missing scene/media/JSON references fail; credentials and conversation state are excluded. |
| 10. Safe restoration | Traversal and incomplete manifests fail. Restore checks paths, file types, case-fold collisions, sizes and SHA-256 before opening a new project. |
| 11. Results | Media and non-media results keep project association; only media can be shared. Shared results/assets retain one charged blob until the final reference is deleted. |
| 12. Desktop/CLI | Actual Electron exercises account entry, project selection, confirmation, upload, preview, sharing, import and visible task completion. CLI exercises matching workflows. |
| 13. Local regression | Existing Studio rendering and export tests run with local browsers/FFmpeg; cloud-outage tests keep editing available. |
| 14. Deployment | A newly built Compose image starts with a fresh PostgreSQL volume; registration, operator init/reset/disable/enable/quota and restart persistence pass. |
| 15. Actual OSS | Private PUT, multipart restart/resume, exact downloads, Range, two-account sharing, withdrawal and abort cleanup pass in a unique child prefix. Exact created keys/upload IDs are removed afterward. |

## Running checks

Commands and environment requirements are in [cloud-service.md](cloud-service.md).
Real OSS and graphical Electron checks are explicit opt-ins, not silently skipped passes.
Routine cloud tests skip when `OPENFILM_TEST_DATABASE_URL` is absent; CI's cloud job
supplies PostgreSQL so those tests actually execute.

The Linux container's `/tmp` and home Trash are on different filesystems. An existing
skills test clears `OPENFILM_TRASH_DIR` and therefore fails with `EXDEV` in the aggregate
run. Running the unchanged skills test file with `TMPDIR` on the home filesystem passes.
No cloud change modifies trash behavior. Platform-specific skips remain explicit.

Public hosting and production TLS deployment require the operator's chosen server/domain;
they are not part of this implementation. The checked-in configuration contains placeholders.

## Standards review

No hard violations of the repository's documented standards were found. Three heuristic
findings were addressed: per-transfer action queues now serialize state transitions;
`TransferList` separates task rendering from the library controller; and
`stageSnapshotFile` names the staging/validation operation explicitly. The additional
HTTP-method finding was fixed with an exact POST route gate. Terminal cancellation
cannot be turned back into a resumable state by pausing it.

Standards: 0 hard violations, 3 heuristic findings addressed; no open review finding.

## Spec review

Five findings were addressed independently of the standards review:

1. Lost successful single PUT and multipart-completion responses now recover through
   verified OSS status and idempotent completion, without repeating accepted bytes.
2. Draft validation checks nested HTML, CSS, module, fetch and `new URL` resource
   references in addition to clip sources. Missing local dependencies fail packaging.
3. Transfer pause/resume/cancel require POST and the exact operation route.
4. Desktop account polling invalidates catalog, preview and task state after a CLI
   account/service change or logout, then reloads under the new identity.
5. Packaging and restoration share portable path restrictions and reject normalized
   case-fold name collisions before publishing an unrestorable snapshot.

Spec: 5 findings addressed, no material scope creep and no open review finding.
