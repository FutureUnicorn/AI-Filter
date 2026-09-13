# Reconstruction log: integration/rebuild-feature-stack

Executes `AI_Filter_PR_Cleanup_Plan.md`. Every historical PR is replayed as its own
base-to-head delta onto a modern baseline, never as a wholesale branch merge.

## Baseline

| | |
|---|---|
| Baseline ref | `origin/integrate-af23-25` @ **`616464f2467da3e05911e9a5d43fc1d7c3227114`** (head of PR #82) |
| Drift watch | Recorded 2026-09-13: #82 head is still that exact SHA, `develop` is still `543daba49`, and both are 0 commits ahead of this branch. **PR #82 is `CHANGES_REQUESTED` and unmerged, so this baseline is provisional.** An explicit reconciliation against the final merged #82 (or whatever `develop` becomes) is required before the final integration PR is opened, and must be re-checked rather than assumed from this line. |
| Why not `develop` | PR #82 is **OPEN, not merged**; `develop` is still at `543daba`. Plan §3 and the operator's rule 10 both direct using the #82 repaired state as the baseline and leaving `develop` untouched. |
| Rule 9 check | AF-23/AF-24/AF-25 artifacts confirmed present at the baseline: `lib/session.ts`, `api/roles/route.ts`, `roles/page.tsx`, `api/roles/[roleId]/rubric/route.ts`, `0009_roles.sql`, `0011_rubrics.sql`, and the role/rubric/session test suites. |
| Baseline gate | `pnpm check` exit 0 — 39 unit, 307 integration, 17 architecture, 27 Python, zero failures. 13 migrations replay from an empty database in filename order. |

## Known blocker carried into this branch

PR #82 is `CHANGES_REQUESTED` (Saikrishnaa-vr, 2026-09-11) with two blocking auth-flow
defects. They are defects in the baseline, so they are fixed here first rather than
propagated through 30 replays. Operator rule 8 forbids working on `integrate-af23-25`
itself, so the fixes live on this branch and are logged as extra bug fixes, not replays.

---

## Entries

### Baseline fixes (not replays)

| | |
|---|---|
| Source | PR #82 review, Saikrishnaa-vr 2026-09-11, two blocking auth defects |
| Commits | `c53c40b`, `05797a1` |
| Issue 1 | Email delivered `/auth/redeem?token=...`; only `POST /api/auth/magic-link/redeem` existed, so a real click 404'd while the round-trip test passed by calling the API handler directly. Added `GET /auth/redeem`; moved redemption into `apps/web/src/lib/magic-link.ts` so both entry points share one implementation. |
| Issue 2 | Only the known-account branch sends mail, so a provider exception returned 500 while an unknown address returned 202: an account-existence oracle on any outage. Delivery is now contained; 202 either way. `magic_link.delivery_failed` added to the closed `LOG_EVENT_NAMES` allowlist, otherwise the operator signal would have been replaced by the rejection placeholder. |
| Scope held | Only the delivery step is contained. Config/database faults still answer 500, since those affect both branches and are not an oracle. |
| Tests | `tests/integration/magic-link-route.test.ts`: delivered URL redeemed verbatim (plus consumed-link cannot mint a second session); known-account-with-failing-provider matches unknown on status and body, using a closed port so the failure is real. |
| Negative controls | Removing the `/auth/redeem` handler fails test 1; removing the delivery containment fails test 2. Both confirmed. |
| Result | `pnpm check` exit 0 — 39 unit, 309 integration, 17 architecture, 27 Python. |
| Limitation | `GET /auth/redeem` spends a single-use token, so a mail-client prefetch or link scanner can consume it. Inherent to emailed magic links; mitigated by atomic single-use and short expiry. A confirm interstitial is a product decision, not taken here. |

### PR #35 — AF-26 rubric criterion editor

| | |
|---|---|
| Original base | `feature/AF-25-rubric-draft-edit-api` |
| Original head | `feature/AF-26-rubric-criterion-editor` |
| Commits in range | 3: `b64885a` (AF-26), `13132e6` (AF-21 redactPii propagation), `4a46fe9` (AF-43 db fixes) |
| Replayed | **`b64885a` only.** The other two are stale re-applications of work already in the baseline, which plan section 8 directs porting around rather than cherry-picking. Verified before excluding: the baseline already carries the span-based `redactPii` (`hasDigitOutside` present, no marker scheme). Replaying them would have regressed modern code. |
| Effect of that choice | The combined base-to-head diff shows `packages/db` +306 and `packages/security` +328; AF-26's own commit is 4 files / +322. Those bulk hunks belong to the carry-forwards and were correctly excluded. |
| Files changed | `apps/web/src/app/roles/[roleId]/rubric/page.tsx`, `packages/domain/src/index.ts`, `tests/unit/protected-characteristic-proxy.test.ts`, `package.json` |
| Conflicts | `package.json` (test registry). |
| Resolution | Union, baseline ordering as the spine: unit 7 + 1 = 8, integration 27 + 0 = 27, architecture 3. AF-26's old registry lacked four integration suites the baseline has (`inference-budget-precision`, `inference-kill-switch-contracts`, `magic-link-route`, `rubric-contracts`); taking its side would have unregistered them. `typecheck:tests` asserted still present. |
| Migration changes | None. |
| Tests executed | Full `pnpm check` against a database migrated from zero. |
| Result | exit 0 — 51 unit, 309 integration, 17 architecture, 27 Python, zero failures. |
| Product check | Adds `ProtectedCharacteristicCategory` / `ProtectedCharacteristicFlag`, a fairness guard that flags criteria proxying for protected characteristics. No score, rank, or automatic decision introduced (plan section 23). |

### PR #36 — AF-27 named approval and immutable rubric publishing

| | |
|---|---|
| Original base | `feature/AF-26-rubric-criterion-editor` |
| Original head | `feature/AF-27-rubric-approval-and-publishing` |
| Commits in range | 3: `b60d37d` (AF-27), `14fc056` (AF-21 redactPii propagation), `83699c3` (AF-43 db fixes) |
| Replayed | **`b60d37d` only.** Same two stale carry-forwards as #35, excluded for the same verified reason. |
| Files changed | `apps/web/src/app/api/roles/[roleId]/rubric/publish/route.ts`, `apps/web/src/app/roles/[roleId]/rubric/page.tsx`, `packages/db/src/index.ts`, migration, plus added test and registry |
| Conflicts | None from the cherry-pick (`packages/db` auto-merged). |
| Migration changes | **`0011_immutable_published_rubrics.sql` renumbered to `0012_`.** `0011_` was already taken by `0011_rubrics.sql` on the baseline. Grepped for references to the old filename across `*.ts/*.sql/*.mjs/*.md/*.json` before renaming: none existed. Ordering verified semantically, not just numerically: the trigger targets the `rubrics` table created by `0011`, so it must sort after it. 14 migrations replay from an empty database in filename order. |
| Stale reference fixed | `publishRubric`'s doc comment said "migration 0011's trigger". Left alone it would have pointed at the rubrics table migration instead of the trigger. Updated to name `0012_immutable_published_rubrics.sql` and to record why it moved. |
| Extra coverage added | AF-27 shipped the immutability trigger **and** `publishRubric` with **zero tests**. Added `assertPublishedRubricImmutability` (packages/db, house `assert*` probe pattern, since `pg` lives there) and `tests/integration/published-rubric-immutability.test.ts`, registered in `test:integration`. It asserts: the draft to published transition is allowed; republish returns `no_draft`; UPDATE of a published row is refused by the database with a message naming the reason; DELETE is refused separately; a later draft stays editable. |
| Negative controls | Narrowing the trigger to `BEFORE UPDATE` only (dropping DELETE) fails the test; removing the trigger entirely fails it. Both confirmed, so the DELETE assertion is load-bearing rather than decorative. |
| Tests executed | Full `pnpm check` against a database migrated from zero. |
| Result | exit 0 — 51 unit, 310 integration, 17 architecture, 27 Python, zero failures. |
| Known limitation | `publishRubric` sets `approved_at`/`updated_at` with `CURRENT_TIMESTAMP`, which is transaction-start time rather than statement time. Five `CURRENT_TIMESTAMP` uses remain in `packages/db`, two of them pre-existing on the baseline from AF-25's rubric edit path, against seven `clock_timestamp()` uses. Reviewer feedback on AF-20 established `clock_timestamp()` as the convention for `occurred_at` on audit rows, where ordering is load-bearing. Not changed here: it is a pre-existing baseline inconsistency across several call sites, not something AF-27 introduced, and silently rewriting five timestamp semantics mid-replay is a behaviour change outside this delta. Flagged for a follow-up decision. |
| Product check | Approval records a named approver and freezes the version. No score, rank, or automatic decision. |

### PR #37 — AF-28 secure direct file upload

| | |
|---|---|
| Original base | `feature/AF-27-rubric-approval-and-publishing` |
| Original head | `feature/AF-28-secure-file-upload` |
| Commits in range | 4: `1d01384` (AF-28), `22536a3` + `cb5ebcc` (stale carry-forwards), `cbf85b2` (`fix(AF-28): constrain file_intakes to its own tenant's roles`) |
| Replayed | **`1d01384` and `cbf85b2`.** Unlike #35 and #36 this range contains a second genuine AF-28 commit, and it is the one that addresses plan section 16: `file_intakes` referencing `organization_id` and `role_id` independently with no guarantee the role belongs to that organization. Dropping it would have reintroduced the exact integrity hole the plan calls out. |
| Plan section 16 outcome | Preserved as a real database-level guarantee, not application-level filtering: `roles` gains `UNIQUE (role_id, organization_id)` and `file_intakes` gains `FOREIGN KEY (role_id, organization_id) REFERENCES roles (role_id, organization_id)`. A cross-tenant row is now unrepresentable. Covered by `tests/integration/file-intake-tenant-integrity.test.ts`, which the same commit added. |
| Conflicts | `package.json` (registry) and `packages/db/src/index.ts` (2 hunks). |
| Resolution | Registry: union, integration 28 + 1 = 29, `typecheck:tests` asserted intact. `packages/db`: both hunk boundaries fell **inside function bodies**, so a keep-both concatenation would have produced a file that does not parse (the failure mode hit earlier in this repo's history). Took HEAD for both hunks, preserving the AF-28 feature additions plus the probes already on the branch, then appended `cbf85b2`'s single self-contained `assertFileIntakeTenantIntegrity` extracted whole from the commit. Verified afterwards: no markers, and each `assert*` probe declared exactly once. |
| Migration changes | **`0012_file_intakes.sql` renumbered to `0013_`** (`0012_` taken by AF-27's trigger). Two live references existed and were updated: `packages/db/src/index.ts` (the probe's migration loader, which reads the file by name) and the error message in `file-intake-tenant-integrity.test.ts`. Renaming alone would have left the probe reading a dead path. |
| Dependency | `packages/ingestion` gains `@aws-sdk/s3-request-presigner@3.1115.0`; lockfile updated and `--frozen-lockfile` install succeeds. |
| Tests executed | 15 migrations replayed from an empty database, **then replayed a second time over the migrated database** because the new FK is added through a conditional `DO` block rather than `ADD CONSTRAINT IF NOT EXISTS`; both passes clean. Full `pnpm check`. |
| Result | exit 0 — 51 unit, 311 integration, 17 architecture, 27 Python, zero failures. |
| Product check | Presigned direct upload plus intake rows. No score, rank, or automatic decision. |

### PR #38 — AF-29 file allowlist, MIME validation, hash and quarantine

| | |
|---|---|
| Original base | `feature/AF-28-secure-file-upload` |
| Original head | `feature/AF-29-file-validation-and-quarantine` |
| Commits in range | 3: `a5afc7e` (AF-29), `817c195` + `73bd192` (stale carry-forwards) |
| Replayed | `a5afc7e` only. |
| Conflicts | `package.json` (registry). Union: unit 8 + 1 = 9, integration 29, architecture 3; `typecheck:tests` asserted intact. |
| Migration changes | **`0013_file_intake_validation.sql` renumbered to `0014_`.** This was not merely a duplicate prefix, it was an active ordering hazard: against `0013_file_intakes.sql`, filename sort puts `0013_file_intake_validation.sql` **first** (`_` sorts before `s`), and the validation migration is `ALTER TABLE file_intakes ADD COLUMN ...`. Replayed as authored it would have altered a table that did not exist yet. Verified by sorting the two names directly rather than assuming. No external references to the old filename existed. |
| Stale reference fixed | The migration's own header said "extends file_intakes (AF-28, migration 0012)". `0012_` is AF-27's rubric trigger on this baseline and file_intakes is now `0013_`, so the comment pointed at the wrong file twice over. Updated to name `0013_file_intakes.sql`. |
| Dependencies | `packages/ingestion` gains `file-type@22.0.2` and a `@signal-audit/domain` workspace link; `--frozen-lockfile` install succeeds. |
| Tests executed | 16 migrations replayed from an empty database; full `pnpm check`. |
| Result | exit 0 — 60 unit, 311 integration, 17 architecture, 27 Python, zero failures. |
| Product check | Validation classifies and quarantines files. No score, rank, or automatic candidate decision. |

### Extra fix — migration prefix guard (plan section 12)

| | |
|---|---|
| Why now | AF-29 proved the risk is live, not theoretical: `0013_file_intake_validation.sql` beside `0013_file_intakes.sql` sorts first (`_` before `s`), so an `ALTER TABLE` would have run before its `CREATE TABLE`. Nothing in the repository would have caught it. |
| Added | `tests/architecture/migration-ordering.test.ts`, registered in `test:architecture`. |
| Invariants | (1) no new migration reuses a numeric prefix; (2) every grandfathered exemption still covers a real duplicate, so the exemption list cannot rot into a silent permit; (3) every prefix is 4 digits, since filename order only matches numeric order while the width is fixed. |
| Grandfathering | `0006` and `0009` were already duplicated on the baseline. Plan section 12 warns against casually renaming migrations that may already be deployed, so they are recorded as known exceptions rather than renumbered. Shrinking that list is safe; growing it is what the test prevents. |
| Negative controls | Recreating the exact AF-29 collision fails the test; adding a 3-digit prefix fails it. Both confirmed. |
| Result | 3/3 pass; architecture suite 17 to 20. |

