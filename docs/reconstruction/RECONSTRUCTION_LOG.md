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

### PR #39 — AF-30 PDF/DOCX canonical text parser

| | |
|---|---|
| Original base | `feature/AF-29-file-validation-and-quarantine` |
| Original head | `feature/AF-30-canonical-text-parser` |
| Commits in range | 3: `d9400f1` (AF-30), `3528968` + `3bf3805` (stale carry-forwards) |
| Replayed | `d9400f1` only. |
| Conflicts | `package.json` (registry). Union: unit 9 + 1 = 10, integration 29, architecture 4; `typecheck:tests` asserted intact. |
| Migration changes | **`0014_canonical_text_extractions.sql` renumbered to `0015_`**, colliding with AF-29's `0014_file_intake_validation.sql`. Dependency checked rather than assumed: it references `file_intakes (intake_id)` from `0013_`, so execution order was already satisfied and this collision was a latent hazard rather than an active break. Renumbered anyway, since a duplicate prefix leaves order depending on the rest of the filename. No external references. |
| Guard caught it | The prefix guard added after AF-29 flagged the duplicate before the gate ran. |
| Dependencies | `packages/ingestion` gains `mammoth@1.12.1` and `pdf-parse@2.4.5`; `--frozen-lockfile` install succeeds. |
| Defect found in my own work | The prefix guard failed `typecheck:tests` with three errors: a non-null assertion and two possibly-undefined regex results. `node --test` type-strips, so running the file directly passed while the real gate did not. Fixed by extracting a `migrationPrefixes()` helper that asserts the prefix exists once, rather than by loosening the assertions or the tsconfig. Negative control re-run afterwards to confirm the guard still fires. This is the modern `typecheck:tests` safeguard (plan section 14) doing exactly its job. |
| Tests executed | 17 migrations replayed from an empty database; full `pnpm check`. |
| Result | exit 0 — 65 unit, 311 integration, 20 architecture, 27 Python, zero failures. |
| Product check | Text extraction only. No score, rank, or automatic decision. |

### PR #40 — AF-31 CSV mapping and ten-row preview

| | |
|---|---|
| Original base | `feature/AF-30-canonical-text-parser` |
| Original head | `feature/AF-31-csv-mapping-and-preview` |
| Commits in range | 4: `3340f33` (AF-31), `0cf256e` + `2f8d2e6` (stale carry-forwards), `aae40da` (`fix(AF-31): move csv-text-sniff off the unit suite so CI's Unit job can load it`) |
| Replayed | **`3340f33` and `aae40da`.** The second is plan section 15's test-placement fix and had to be kept. |
| Plan section 15 — CSV sniffing | Preserved: `looksLikeCsvText` exists in `packages/ingestion` and is wired as the fallback at the sniff site (`detected?.mime ?? (looksLikeCsvText(bytes) ? ... : undefined)`), because `file-type` cannot identify plain CSV text. The moved test references it 7 times. |
| Plan section 15 — test placement | Preserved. `csv-text-sniff.test.ts` lives in `tests/integration/`, not `tests/unit/`. Reason verified in the scripts rather than assumed: `test:integration` runs `build:packages &&` first while `test:unit:ts` does not, so a test importing built ingestion artifacts can only load from the integration suite. The earlier arrangement passed locally only because an earlier step had already built `dist`, which is the false green the plan describes. |
| Conflicts | `package.json` on both cherry-picks. |
| Resolution — union rule deliberately overridden | The union resolver **aborted** on the second pick, refusing to register `tests/unit/csv-text-sniff.test.ts` because that path no longer exists on disk. That abort was correct and the rule was wrong for this case: this is an intentional relocation, not an accidental unregistration. Resolved by hand as union-minus-the-move: unit loses `csv-text-sniff.test.ts` (11 entries), integration gains it (30 entries), architecture unchanged. Asserted afterwards that the file is registered in integration, absent from unit, every registered path exists, and `typecheck:tests` survives. |
| Migration changes | None. |
| Tests executed | 17 migrations replayed from an empty database; full `pnpm check`. |
| Result | exit 0 — 75 unit, 316 integration, 20 architecture, 27 Python, zero failures. |
| Product check | CSV column mapping and a bounded ten-row preview. No score, rank, or automatic decision. |

### PR #41 — AF-32 idempotent import finalization

| | |
|---|---|
| Original base | `feature/AF-31-csv-mapping-and-preview` |
| Original head | `feature/AF-32-idempotent-import-finalization` |
| Commits in range | 6: `3ecc0d6` (AF-32), `e27cb01` + `f200594` (stale carry-forwards), `a076c38` (AF-31's csv move, already applied here as `aae40da`), `d78943a` (`reject whitespace-only candidate name and email`), `5aff3a2` (`constrain applications to its own tenant's role and intake`) |
| Replayed | **`3ecc0d6`, `d78943a`, `5aff3a2`.** `a076c38` skipped as an already-applied duplicate of the AF-31 relocation, not as noise. |
| Plan section 16 class | `5aff3a2` is the same tenant-integrity pattern as AF-28 and was kept: `applications` gains composite FKs on **both** `(role_id, organization_id)` and `(intake_id, organization_id)`, so an application cannot point at another tenant's role or another tenant's file intake. Database-level, not application filtering. |
| Conflicts | `package.json` on the first pick. |
| Resolution — resolver generalized | Every branch from here on still registers `tests/unit/csv-text-sniff.test.ts`, which AF-31 relocated, so the union resolver aborted again. Rather than hand-resolving this on each of the remaining replays, the resolver now recognises a deliberate relocation: a registered path missing from disk is dropped **only** when a file of the same name exists in another test directory, and is still fatal otherwise. That distinguishes "moved" from "deleted or renamed away" instead of trusting either blindly. Result: unit 12, integration 30, architecture 4, `typecheck:tests` intact. |
| Migration changes | **`0015_applications_and_import_finalization.sql` renumbered to `0016_`**, colliding with AF-30's `0015_canonical_text_extractions.sql`. Its tables reference `organizations`, `roles` and `file_intakes` from `0002`/`0009`/`0013`, so ordering is satisfied at `0016`. No external references. Guard confirms uniqueness. |
| Tests executed | 18 migrations replayed from an empty database; full `pnpm check`. |
| Result | exit 0 — 82 unit, 316 integration, 20 architecture, 27 Python, zero failures. |
| Product check | Import finalization creates application rows idempotently. No score, rank, or automatic decision. |

### PR #42 — AF-33 processing/failure status UI

| | |
|---|---|
| Original base | `feature/AF-32-idempotent-import-finalization` |
| Original head | `feature/AF-33-import-status-ui` |
| Commits in range | 4: `1bff684` (AF-33), `390560e` + `0b49166` (stale carry-forwards), `dc305de` (AF-31 csv relocation, already applied) |
| Replayed | `1bff684` only. |
| Conflicts | `package.json` (registry). Resolved automatically by the generalized resolver, which dropped the stale relocated `csv-text-sniff` registration and unioned the rest: unit 12 + 1 = 13, integration 30, architecture 4; `typecheck:tests` intact. |
| Migration changes | None. |
| Tests executed | 18 migrations replayed from an empty database; full `pnpm check`. |
| Result | exit 0 — 87 unit, 316 integration, 20 architecture, 27 Python, zero failures. |
| Product check | Status and error surfaces for an import. Read-only reporting; no score, rank, or automatic decision. |

**Block complete: #35 through #42 (AF-26 to AF-33) replayed.**

## Block 2 — the AF-45 line

### PR #44 — AF-45 tenant-scoped application review queue

| | |
|---|---|
| Original base | `feature/AF-33-import-status-ui` |
| Original head | `feature/AF-45-tenant-scoped-application-review-queue` |
| Commits in range | 2: `3085cc4` (AF-45), `39c3152` (`test: guard against a registered test file that does not exist`) |
| Replayed | **`3085cc4` only.** `39c3152` adds `tests/architecture/test-file-registration.test.ts`, a second registration guard. Its own header states that AF-22's `test-registration.test.ts` "is the version that should survive", that this is "a deliberate local copy, not a duplicate to reconcile now", and to "fold it into AF-22's version when that actually arrives". On this baseline AF-22's guard is already present, so that condition is satisfied. Verified the baseline version covers the same three drift directions (on-disk-unregistered, registered-missing, registered-twice) before skipping, rather than taking the comment's word for it. |
| Conflicts | `package.json` (registry) and `packages/db/src/index.ts` (3 hunks). |
| Resolution | Registry: union, unit 14, integration 31; `typecheck:tests` intact. `packages/db`: hunk boundaries again fell inside function bodies, so HEAD was kept for all three hunks and the genuinely missing declarations lifted across as complete units. Ported: `listApplicationsForRole`, `listEvidenceExtractionRunsForEntities`, `assertApplicationQueueTenantIsolation`, plus the private `ApplicationRow` and `rowToApplication` that the first typecheck proved were dangling. `InferenceKillSwitchRow` and `getInferenceKillSwitchStatus` were **deliberately not ported**: they belong to AF-42, whose PR is not on `develop`, and pulling them in would drag an unrelated ticket into this branch. |
| Tooling added | `port_exports.py` in the scratchpad: lifts a complete top-level declaration (doc comment included) by brace matching, then asserts each requested name is declared exactly once. Written because keep-both concatenation across a mid-function hunk boundary produces a file that does not parse. |
| Gate failure and fix | The first full gate **failed**: `assertApplicationQueueTenantIsolation` loaded `0012_file_intakes.sql` and `0015_applications_and_import_finalization.sql` by name, both renumbered earlier in this reconstruction. It surfaced only as an `ENOENT` inside a probe at test time, never at build time. Remapped to `0013_` and `0016_`. |
| Extra fix | Added a fourth invariant to the migration guard: **every migration filename hard-coded in source must exist on disk**, scanning `packages`, `apps`, `scripts` and `tests` rather than a hand-kept list. Comment lines are skipped, since a filename in prose records history and is not a dependency the code resolves. Negative control: reintroducing the `0012_file_intakes.sql` reference in real code fails the test, while the same name in a comment does not. |
| Migration changes | None of its own. |
| Tests executed | 18 migrations replayed from an empty database; full `pnpm check`. |
| Result | exit 0 — 96 unit, 321 integration, 21 architecture, 27 Python, zero failures. |
| Product check | A tenant-scoped queue with explicit state counts. `buildApplicationReviewQueue` rejects counts that do not partition the total. No score, rank, or automatic decision. |

### PR #47 — AF-46 preserve original applicant ordering

| | |
|---|---|
| Original base | `feature/AF-45-tenant-scoped-application-review-queue` |
| Original head | `feature/AF-46-preserve-original-applicant-ordering` |
| Commits in range | 1: `fa86dfa` |
| Replayed | `fa86dfa`. |
| Conflicts | `package.json` (registry). Union: unit 15, integration 31; `typecheck:tests` intact. |
| Gate failure and fix | Failed first on the same class as AF-45: the new `assertApplicantOrderingPreserved` probe loads `0012_file_intakes.sql` by name. Automated it rather than hand-patching each time, since every remaining ported probe will carry historical filenames: `remap_migrations.py` matches on the descriptive suffix, which renumbering never changes, and **refuses to guess** when a suffix matches zero or several files on disk. Repointed `0012_file_intakes` to `0013_` and `0015_applications_and_import_finalization` to `0016_`. |
| Note on gate ordering | The hard-coded-reference guard added during AF-45 does catch this, but `pnpm check` runs integration before architecture, so the `ENOENT` surfaces first. The guard remains the durable net; the remapper is what keeps it from recurring. |
| Migration changes | None of its own. |
| Tests executed | 18 migrations replayed from an empty database; full `pnpm check`. |
| Result | exit 0 — 103 unit, 322 integration, 21 architecture, 27 Python, zero failures. |
| Product check | Preserves the employer's original import order as a stable tiebreak. Explicitly not a ranking: order comes from the source file, not from any score. |

### PR #48 — AF-47 explicit state filters

| | |
|---|---|
| Original base | `feature/AF-46-preserve-original-applicant-ordering` |
| Original head | `feature/AF-47-explicit-state-filters` |
| Commits in range | 1: `c8a0f86` |
| Replayed | `c8a0f86`. |
| Conflicts | `package.json` (registry). Union: unit 16, integration 31; `typecheck:tests` intact. |
| Migration changes | None. Remapper reported no stale references. |
| Tests executed | 18 migrations replayed from an empty database; full `pnpm check`. |
| Result | exit 0 — 115 unit, 325 integration, 21 architecture, 27 Python, zero failures. |
| Product check | Filters are explicit and user-chosen, which is the product's stated alternative to hidden ordering. No score, rank, or automatic decision. |

### PR #49 — AF-58 failed-document rate per role (parallel line, plan section 7)

| | |
|---|---|
| Original base | `feature/AF-33-import-status-ui` (the AF-58/AF-60 line, not the AF-45 line) |
| Original head | `feature/AF-58-failed-document-rate` |
| Commits in range | 1: `1fede60` |
| Replayed | `1fede60`. |
| Conflicts | `package.json` plus `packages/contracts`, `packages/db`, `packages/domain`. Expected: AF-58 forks from AF-33 and so predates AF-45/46/47's changes to those files. |
| Resolution | Kept HEAD on every source conflict via `git checkout --ours`, then ported the genuinely missing declarations. Ported: `FailedDocumentCounts`, `FailedDocumentRate`, `summarizeFailedDocuments` (domain); `failedDocumentRateSchema` (contracts); `getFailedDocumentRate`, `assertFailedDocumentRateAccuracy` (db). Wired the four import entries the ported code needed. `InferenceKillSwitchRow` and `getInferenceKillSwitchStatus` again not ported (AF-42, not on `develop`). |
| Tooling defects found and fixed | My first attempt corrupted three files and was reset with `git reset --hard` rather than patched. Two real bugs in the extractor, both of which produced silently truncated code: (1) it searched for the terminating `;` starting at the doc comment, so a semicolon in prose ended the block early, yielding a 12-line fragment of a 135-line function; (2) it tracked only braces, so `export const x = z.strictObject({...}).refine(...)` terminated at the object literal's `}`, before the `)` and the chained calls. Now it locates the end from the declaration and tracks `()`, `[]` and `{}` together. Switched from regex hunk-resolution to `git checkout --ours`, which cannot mis-pair markers. |
| **Database conflict resolved (plan section 16)** | The probe inserted a `file_intakes` row in org B pointing at org A's role, and its comment stated that `file_intakes` "carries INDEPENDENT foreign keys ... with no composite (organization_id, role_id) constraint". **That premise is no longer true on this branch:** AF-28's `cbf85b2`, preserved earlier here, added exactly that composite FK, so the row is now unrepresentable and the insert failed. Resolved by keeping the check and strengthening it: the probe now asserts the database **refuses** the insert with `file_intakes_role_organization_fkey`, which is a stronger statement than asserting a query filtered the row out afterwards, and it fails if that constraint is ever dropped. The stale comment was replaced with the real history. No test was weakened and no constraint was relaxed. |
| Negative control | Removing the composite FK from `0013_file_intakes.sql` fails the strengthened assertion. Confirmed, then restored. |
| Migration changes | None of its own. Remapper repointed three historical references in the ported probe: `0012_file_intakes` to `0013_`, `0013_file_intake_validation` to `0014_`, `0014_canonical_text_extractions` to `0015_`. |
| Tests executed | 18 migrations replayed from an empty database; full `pnpm check`. |
| Result | exit 0 — 121 unit, 328 integration, 21 architecture, 27 Python, zero failures. |
| Product check | A per-role pipeline-health metric over documents. Measures failure rates of processing, not candidates. No score, rank, or automatic decision. |

### PR #50 — AF-48 evidence card with source context

| | |
|---|---|
| Original base | `feature/AF-47-explicit-state-filters` |
| Original head | `feature/AF-48-evidence-card-with-source-context` |
| Commits in range | 2: `be21e38` (AF-48), `9cabe29` (`harden 0016 against five defects found reviewing it`) |
| Replayed | **both.** The second hardens the migration and is part of AF-48's own delta. |
| Conflicts | `package.json`, `packages/db`, `packages/domain`. Kept HEAD on source via `git checkout --ours`, then ported. Ported from domain: `EvidenceCardCitation`, `EvidenceCard`, `EvidenceCardSet`, `buildEvidenceCard`, `buildEvidenceCardSet`. From db: `RecordEvidenceOutcomeInput`, `RecordedEvidenceOutcome`, `recordEvidenceOutcome`, `listCurrentEvidenceOutcomesForApplication`, `getApplicationById`, `assertEvidenceOutcomePersistence`. |
| Migration changes | **`0016_evidence_outcomes.sql` renumbered to `0017_`**, colliding with AF-32's `0016_applications_and_import_finalization.sql`. Confirmed the `9cabe29` hardening travelled with the renamed file (18 constraints present). Remapper repointed three historical references in the ported probe. |
| AF-13 drift resolved | AF-48 predates the tenant-identity change, so its outcome fixtures failed `typecheck:tests` in three places: `tests/unit/evidence-card.test.ts` samples and the `assertEvidenceOutcomePersistence` factory were missing `organizationId`/`candidateId`, and its `contradicted` sample was missing `conflictingCitation`, which `ContradictedEvidence` requires. Fixed by **attributing the fixtures**, not by relaxing the types: the tests now exercise the shape the product actually persists. This is the fourth ticket in this reconstruction to carry AF-13 drift. |
| Tests executed | 19 migrations replayed from an empty database; full `pnpm check`. |
| Result | exit 0 — 131 unit, 329 integration, 21 architecture, 27 Python, zero failures. |
| Product check | An evidence card shows the quote and its source location for human reading. Presentation of cited evidence, no score or ranking. |

### PR #51 — AF-49 append-only evidence corrections

| | |
|---|---|
| Original base | `feature/AF-48-evidence-card-with-source-context` |
| Original head | `feature/AF-49-append-only-evidence-corrections` |
| Commits in range | 1: `b843fe6` |
| Replayed | `b843fe6`. |
| Conflicts | `package.json` and `packages/db`. Kept HEAD on source, ported `CorrectEvidenceOutcomeInput`, `EvidenceCorrectionResult`, `RecordedEvidenceRevision`, `correctEvidenceOutcome`, `listEvidenceRevisionsForApplication`, `assertEvidenceCorrectionsAppendOnly`. |
| Migration changes | **`0017_evidence_corrections.sql` renumbered to `0018_`**, colliding with AF-48's `0017_evidence_outcomes.sql`. Remapper repointed four historical references. |
| Third extractor defect found and fixed | `EvidenceCorrectionResult` is a three-member union of object literals; the tool kept only the first member, because a member ends its line with `}` and the rule "brace closed and nothing follows on this line" was satisfied. That silently produced a type that compiled at the declaration but failed at every other use (`"nothing_to_correct"` not assignable to `"recorded"`). Now a `type` alias terminates only on `;`, and the brace rule additionally refuses to stop when the next non-whitespace character continues the expression (`|`, `&`, `.`, `)`, `,`, `]`, `}`). |
| AF-13 drift resolved | Again, in two places: the `assertEvidenceCorrectionsAppendOnly` outcome factory and `tests/unit/evidence-corrections.test.ts`'s `supported`/`notFound` helpers. Attributed with `organizationId`/`candidateId` rather than relaxing the types. |
| Tests executed | 20 migrations replayed from an empty database; full `pnpm check`. |
| Result | exit 0 — 140 unit, 330 integration, 21 architecture, 27 Python, zero failures. |
| Product check | Corrections are append-only: a correction supersedes rather than overwrites, so the original evidence and its revision history both survive. Supports auditability; no score or ranking. |

### PR #52 — AF-50 require correction reason and actor

| | |
|---|---|
| Original base | `feature/AF-49-append-only-evidence-corrections` |
| Original head | `feature/AF-50-require-correction-reason-and-actor` |
| Commits in range | 2: `f1a57c2` (AF-50), `4b5c0bf` (`drop the duplicate registration guard, correct the kill-switch claim`) |
| Replayed | **both.** The chore does three things here: deleting the duplicate guard (a no-op, since AF-45's copy was already skipped), unregistering it in `package.json` (applied), and correcting a false comment in AF-50's migration (kept). |
| Migration changes | **`0018_correction_attribution.sql` renumbered to `0019_`**, colliding with AF-49's `0018_evidence_corrections.sql`. The chore's comment correction removed a claim that `0009`'s kill-switch reason uses `length(trim(x)) > 0`; accurate on this branch, where the baseline already carries AF-42's `0010_kill_switch_reason_non_whitespace.sql` POSIX-class fix. |
| Conflicts | `package.json` twice, plus `packages/contracts` and `packages/db`. Registry resolved to the chore's intent, with `tests/architecture/test-file-registration.test.ts` unregistered on both sides and asserts that AF-22's surviving guard and `typecheck:tests` both remain. |
| Two flaws found in my own tooling | (1) The remapper missed `"../../packages/db/migrations/0018_correction_attribution.sql"` because its pattern required a quote immediately before the digits, so path-qualified references were invisible. (2) Worse, it **rewrote historical filenames inside comments**, silently falsifying the guard's own explanation of why `0013_file_intake_validation.sql` was renumbered. Reverted that file and fixed the tool: it now skips comment lines and matches path-qualified names. |
| Latent baseline defect found | With the path pattern fixed, the remapper found a stale reference inherited from the baseline: `tests/integration/rubric-contracts.test.ts` told an operator to point the database at `packages/db/migrations/0010_rubrics.sql`, which PR #82 renumbered to `0011_`. A wrong filename in a setup instruction, corrected. |
| AF-13 drift resolved | `tests/integration/correction-attribution.test.ts` fixtures attributed. Wrote `attribute_outcomes.py` for this, now the fifth ticket carrying the same drift. |
| Tests executed | 21 migrations replayed from an empty database; full `pnpm check`. |
| Result | exit 0 — 140 unit, 336 integration, 21 architecture, 27 Python, zero failures. |
| Product check | Requires a named actor and a non-whitespace reason on every correction. Strengthens attribution and auditability; no score or ranking. |

### PR #55 — AF-60 report every metric with its sample size and limitations

| | |
|---|---|
| Original base | `feature/AF-58-failed-document-rate` (parallel line) |
| Original head | `feature/AF-60-sample-sizes-and-limitations` |
| Commits in range | 2: `4fbfacb` (AF-60), `13499be` (`docs: record why there is no sample-pooling helper`) |
| Replayed | both. |
| Conflicts | `package.json`, `packages/contracts`, `packages/domain`. Kept HEAD on source, then ported. |
| Ported | domain: `METRIC_LIMITATION_CODES`, `MetricLimitationCode`, `MetricLimitation`, `MetricSample`, `SummarizeMetricInput`, `summarizeMetric`, `describeFailedDocumentRate`. contracts: `metricLimitationSchema`, `metricSampleSchema`, plus the **non-exported** `metricSampleObjectSchema` that `metricSampleSchema` is built from, which the export-only scan missed and the typecheck caught. Wired `MetricLimitation`/`MetricSample` as type imports and `METRIC_LIMITATION_CODES` as a value import into contracts. |
| Migration changes | None. |
| Tests executed | 21 migrations replayed from an empty database; full `pnpm check`. |
| Result | exit 0 — 148 unit, 342 integration, 21 architecture, 27 Python, zero failures. |
| Product check | Every metric is reported with its sample size and an explicit limitations list, which is the opposite of a bare score. Directly supports the product's honesty constraints; no ranking introduced. |

### PR #56 — AF-51 named human advance/hold/decline recording

| | |
|---|---|
| Original base | `feature/AF-50-require-correction-reason-and-actor` |
| Original head | `feature/AF-51-named-human-decision-recording` |
| Commits in range | 1: `6328d2a` |
| Replayed | `6328d2a`. |
| Conflicts | `package.json`, `packages/contracts`, `packages/db`, `packages/domain`. Kept HEAD on source, then ported the decision types, schemas, writers and the `assertCandidateDecisionIntegrity` probe. |
| Registry | AF-51 predates AF-50's chore, so it re-registers the deleted `test-file-registration.test.ts`. Added that path to the resolver as an explicit **deliberate removal** (distinct from the relocation rule): a branch predating a removal re-registering the file is not a suite going missing. Its own new `decision-path-isolation.test.ts` was registered normally, giving architecture 5. |
| Migration changes | **`0019_candidate_decisions.sql` renumbered to `0020_`**, colliding with AF-50's `0019_correction_attribution.sql`. Remapper repointed six historical references in the ported probe. |
| Tooling added | `wire_imports.py`: ported declarations reference domain names the target file does not import, and the caller must state type-versus-value, since passing a value name as a type compiles here and fails at runtime. |
| Test conflict resolved | Three checks in `tests/unit/candidate-decisions.test.ts` failed `typecheck:tests` as comparisons with no overlap. Cause: `assert.equal` carries an assertion signature in the pinned `@types/node`, so asserting on `status.status` narrows the union at the call site, making the defensive checks that followed unreachable or always-true. Resolved by removing the one unreachable `throw` and **unwrapping** the two conditional blocks so their assertions run unconditionally, which is stronger than guarding them with a condition the compiler has proven cannot be false. The fourth guard, inside the `CANDIDATE_DECISION_KINDS` loop, has no narrowing assertion before it and was left alone. No assertion was deleted or weakened. |
| Tests executed | 22 migrations replayed from an empty database; full `pnpm check`. |
| Result | exit 0 — 157 unit, 343 integration, 21 architecture, 27 Python, zero failures. |
| Product check | Records a **named human's** advance/hold/decline with a rationale, and derives status by following supersedes links rather than by timestamp. This is the human-decision path the product requires; no automatic decision, score or ranking. |


## PR #83 review, round 2

Three findings from Sai, all on code this branch introduced in round 1. Two of
them were the same mistake twice, so it is recorded as one lesson rather than
two entries: **a fix asserted at both ends of a boundary, with nothing tested
across it.**

| | |
|---|---|
| Finding (P1) | `archiveUninspectable` never reached `evaluateFileValidation`. The sniffer set it, the evaluator honoured it, both had passing unit tests, and the validate route omitted the field. A ZIP64 or malformed DOCX validated exactly as before. |
| Fix | `7bec118` — one field added to the evaluation input. |
| Why it survived round 1 | The only coverage was a unit test either side of the wire. Neither could observe the wire. |

| | |
|---|---|
| Finding (P2) | `ObjectTooLargeError` and `ObjectChangedError` were created so callers could respond, and no caller was changed. Both reached the generic catch and answered 500, leaving an oversized object `uploaded` and retryable forever and a substituted one `validated` and failing opaquely. |
| Fix | `e20cbc0` — validate quarantines and answers 413 on an oversized read; the four post-validation readers answer 409 (quarantining via `invalidateChangedIntake`) on a hash mismatch and 413 on an oversized read, the latter deliberately leaving status alone because a size refusal says nothing about whether the bytes are the approved ones. |
| Contract change | `payload_too_large` added to `API_ERROR_CODES`, mapped to 413. |
| Schema-adjacent change | `RecordFileValidationInput.sha256Hash` is now optional, so a rejection occurring before any bytes are read can still be recorded. No migration. |
| Extra defect found | The `extract-text` route's import block had been corrupted by a round-1 edit, leaving the file syntactically invalid. `typecheck:tests` does not cover `apps/web`, so nothing caught it; only writing a test that imports the route did. Repaired in the same commit. |

| | |
|---|---|
| Finding (P1) | The idempotency protocol was not atomic with the action. Claim, action and completion were three calls on three connections; a fault after the action committed left the key at `response_status = NULL` permanently, wedging same-key retries at `in_flight` and driving clients to rotate the key, which recorded a second human decision. |
| Fix | `6c5cc45` — `recordCandidateDecision` and `correctEvidenceOutcome` take an optional `IdempotencyContext` and claim and complete on their own connection inside their own transaction. Routes make one call. Outcomes that record nothing roll the claim back with the action. `releaseIdempotentRequest` is gone from both routes: it only covered faults the process lived to observe. |
| Test mistake caught by its own control | The first regression injected a fault with an `AFTER INSERT` trigger and asserted nothing survived. It passed **with the completion moved back after `COMMIT`**, i.e. against the exact defect being fixed, because a fault at the insert rolls everything back in both shapes. Replaced by a `DEFERRABLE INITIALLY DEFERRED` constraint trigger that fires at `COMMIT` and reads what the transaction is about to make durable: 201 when the completion is inside, NULL when it is not. |
| Negative controls run | Four, all failing with the fix reverted: claim split into its own transaction; decision completion moved after `COMMIT`; correction completion moved after `COMMIT`; and the legacy three-call shape, reproduced inside the probe, which still commits the action alone, wedges the key and duplicates the decision on key rotation. |
| Coverage of the second route | `6ed0500` — the finding named both routes and the first fix commit proved only one, which is the same pattern as the dead wire above. The correction writer now has the same commit-time witness and a same-key replay check. |

**New test infrastructure:** `tests/support/ingestion-storage-stub.ts` redirects
`@signal-audit/ingestion` for route tests. Only object storage is faked, because
CI provides Postgres and no object store. The errors are the real classes
re-exported from the real module, so the `instanceof` checks under test are the
ones that run in production; a hand-rolled look-alike would pass here and fail
in production.

**Registration:** `tests/integration/file-intake-route-errors.test.ts` was added
to `test:integration`. The existing `test-registration` architecture guard
caught the omission before CI did.

**Same shape, found by sweeping for it:** `packages/ai` exports three error
classes (`InferenceKillSwitchEngagedError`, `AiUsageUnavailableError`,
`AiStructuredCallParseError`) that nothing catches. Not a live defect, because
nothing imports `@signal-audit/ai` on this branch, so there is no caller to add
a handler to. Adding one would mean inventing the consumer.

What was actually wrong was that this class of bug depended on a reviewer
noticing it, twice in one round. `tests/architecture/typed-error-handling.test.ts`
now asserts every exported `Error` subclass is narrowed by some caller outside
its own module, with the three `packages/ai` classes recorded as exemptions.

The exemptions are written to expire on their own: each names the package whose
absent consumer is its entire justification, and a third check reads the
workspace dependency graph and fails the moment anything depends on that
package. So the handlers become required exactly when someone is in a position
to decide what they should do, rather than sitting on a list of permanent
excuses nobody re-reads. Verified with three controls: a new unexempted error
class, an exemption for a class that is in fact handled, and adding
`@signal-audit/ai` to `apps/worker`'s dependencies.

**Result:** full `pnpm check` exit 0 locally; CI green 7/7 on `6ed0500`. All 10
review threads on PR #83 replied to and resolved.

## PR #83 review, round 3

Two findings, both from a review by Pradeep0111, neither a correctness bug.

| | |
|---|---|
| Finding (doc accuracy) | `deriveCandidateWorkflowStatus` attributed the single-head invariant to prefix `0019`, which is correction_attribution and unrelated to decisions. |
| Swept | Eighteen more references were wrong the same way. One cause: the reconstruction renumbered nine migrations and `remap_migrations.py` only rewrote path-qualified references, so every bare number silently came to point at whatever now occupies it. |
| Verified against the defining migration | evidence_outcomes' append-only trigger is 0017, not 0016 (0016 has no triggers at all); `supersedes_evidence_outcome_id` and its unique index are 0018, not 0017; the corrector membership FK and non-blank reason CHECK are 0019, not 0018; everything about candidate_decisions is 0020, not 0019; the rubrics table and its one-draft-per-role index are 0011, not 0010. |
| Wrong twice over | The reviewer's line also claimed a guarantee that did not hold. 0020's partial unique index excludes NULLs by its own predicate, so it says nothing about first decisions: two concurrent first decisions really did produce two heads until 0021 added the single-root index. The comment now names both indexes and which case each covers. |
| Fix | `088031b` — all nineteen corrected, every remaining bare reference converted to the filename form, and `migration-ordering.test.ts` extended to check comments rather than only string literals. The old version skipped comments because prose is not a dependency the code resolves, which is true and beside the point: a wrong reference sends whoever is debugging that invariant to a file that does not contain it. Bare numbers in comments are now rejected outright, with backticks as the escape hatch for prose about numbering itself. |
| Controls | Restoring the reviewer's exact original line fails the new check, as does naming a nonexistent migration file, as does making the history exemption stop covering anything. The guard also caught its own docstring on first run. |

| | |
|---|---|
| Finding (efficiency) | ~48 sites opened a dedicated `pg.Client` per call, so one `POST .../decisions` paid four TCP, TLS and auth handshakes in sequence. Measured before the fix: six sequential calls, six backends, six sessions. |
| Fix | `c6d122c` — one `Pool` per connection string for the 39 request-path functions. Keyed per connection string because tests and probes legitimately target different databases in one process. `allowExitOnIdle` is load-bearing: without it an idle pooled connection is an open handle and `node --test` would hang. |
| Deliberately not pooled | `checkDatabaseConnection`, because a liveness probe answering from a warm pooled connection reports the pool's health and not the database's; and the `assert*`/`provision*` probes, because they run `SET search_path`, `SET LOCAL ROLE` and CREATE/DROP SCHEMA, which on a shared connection would leak onto the next borrower. A leaked `search_path` would send a later query to another tenant's schema, which is worse than the latency pooling removes. |
| Proof | A pool that exists but is not reused behaves exactly like the defect while looking correct at the call site, so reuse is measured rather than inspected: `pg_backend_pid()` and `pg_stat_database.sessions`, against a database the probe creates and drops so parallel tests cannot pollute the count. The unpooled health check runs in the same probe as a control, so a measurement blind to new connections fails instead of reporting reuse for everything. |
| Second guard | `tests/architecture/pooled-connection-safety.test.ts` covers the hazard pooling introduces rather than the one it fixes: no pooled function may issue a statement outliving its transaction, every pooled function must release, and the pooled/dedicated split must stay real so neither check goes vacuous. Its first regex flagged every `UPDATE ... SET` in the file; tightened to statement-initial `SET`. |
| Controls | Making `acquireConnection` build a per-call pool fails the reuse test with 6 backends for 6 calls. Adding `SET search_path` to a pooled function, dropping a `release()`, and unpooling the exempted probe each fail exactly one architecture check. |

**Result:** full `pnpm check` exit 0 locally, 162 unit, 364 integration, 34
architecture, zero failures.

## PR #83 review, round 4

Four findings from an end-to-end review that drove the real user journey against
live Postgres and MinIO rather than reading code. All four verified
independently before fixing; one of the proposed fixes was wrong.

| | |
|---|---|
| Finding (REV-001, raised to HIGH after live repro) | `normalizeAppliedAt` compared the parsed instant's UTC fields against the literal date parts, so any offset crossing midnight read as a calendar error. `2026-01-31T23:00:00-05:00` is 1 February in UTC; `2026-01-01T00:00:00+05:30` is 31 December of the previous year. Both were returned to the operator as "not a valid date". The regex admits `[+-]HH:MM`, so this was a broken accepted format. A live three-row import dropped two candidates. |
| **The suggested fix was wrong** | Scoping the year and month checks to the date-only branch, as the day check already was, would accept `2026-02-30T00:00:00Z`: `new Date` returns 2026-03-02 for it, not NaN. That trades a false rejection for silent corruption, storing a date nobody wrote. The cases that settled it are not a claim in this log: they are encoded in the two tests `tests/unit/csv-import-finalization.test.ts` adds, which between them assert every accepted offset and every rejected impossible date, and which fail against the original code and the suggested fix respectively. |
| Fix | `b82cf88` — the calendar question is asked of the literal date parts via `Date.UTC`, independent of any offset; the instant is used only for the stored value. |
| Controls | The original code fails the offset test; the suggested fix fails the impossible-date test. Both run. |

| | |
|---|---|
| Finding (REV-002) | `getMembershipsForUser` makes the same cross-organization lookup the login path makes and was the only one of the two without the RLS visibility guard. Under a role RLS applies to it returns zero rows rather than failing, so every authenticated caller looks like it holds no memberships and all 16 routes answer `not_found`: the product denies everyone while appearing to enforce permissions, with nothing in the logs. |
| Fix | `afbefdc` — guarded, checked once per connection string and schema since RLS applicability cannot change while the process runs. Cached before awaiting so concurrent first requests share one check, evicted on failure so a fixed deployment is not served a cached error. |
| Sweep | The other two live `memberships` queries: `emailHasMembership` is the login path and was already guarded. This was the only gap. |
| Proof | A real `NOSUPERUSER NOBYPASSRLS` role, which is the only way to observe it. The superuser read is a control so a failure is attributable to RLS, and the raw zero-row result is asserted so the test cannot pass vacuously. |
| Side effect | The pooling guard flagged the new `assertMembershipLookupVisibleOnce` as a probe. Renamed to `require*` rather than exempted: in packages/db, `assert*`/`provision*` means a probe that owns its connection and `require*` means a request-path precondition that may pool. That convention is now stated in the guard. |

| | |
|---|---|
| Finding (REV-003) | `SESSION_SECRET` was absent from every env template and read at request time, so a deployment following `.env.example` booted, passed the environment health check, and then threw on every authenticated request with no request id and nothing in the log stream. Four further hosted vars were also undocumented. |
| Fix | `14f3dde` — `apps/web/src/instrumentation.ts`. Next.js calls `register()` once and waits for it before serving, so throwing there makes absence a boot failure. Verified against the Next docs rather than assumed. |
| Deliberately not | Adding `SESSION_SECRET` to `packages/config`'s shared schema. `apps/worker` loads the same schema and signs no sessions, so that would make the worker fail to boot over a secret it never reads. |
| Guard | Reads the variable names out of the config schema and out of the web app's direct `process.env` reads instead of keeping a list, because a hand-kept list is exactly what drifted. `PREVIEW_*` excluded as pipeline-injected. |
| Controls | Removing either variable fails the template check; downgrading the boot assertion to a warning fails the other. |

| | |
|---|---|
| Finding (REV-004) | The exemption list claimed `0006` and `0009` "were already duplicated on the baseline". `git ls-tree` on the merge base shows both `0006` files on develop but only one `0009`: `0009_roles.sql` arrives with this reconstruction, so the branch creates that collision and then exempts it, which the docstring says the test exists to prevent. |
| Kept, not renumbered | There is no free integer between `0009` and `0011`, since roles must precede `0011_rubrics.sql` which references it. Moving it means renumbering the whole tail, which is what produced nineteen wrong references last round. |
| Fix | `a83675d` — the comment is corrected, and the exemption is earned mechanically: same-prefix migrations must touch disjoint tables, so filename sort order cannot matter. Both current pairs are disjoint. |
| Control | The real hazard this reconstruction hit was not disjoint: renaming `0014_file_intake_validation.sql` back to `0013_` reproduces it and the new check fails. The prose claim never would have. |

**Sai's separate blocker, resolved before this round:** `pnpm dev:infra` could
not start because `infra/compose/runtime.yml` pinned `minio/minio` on Docker Hub,
whose manifest was unavailable. Fixed by Sai's own `0e12a0b`, which repoints both
MinIO images at Quay. Re-verified here against the live registry:
`quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z`,
`quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z` and
`postgres:17.10-alpine3.23` all resolve.

**Answered rather than fixed:** the product-entry bootstrap gap, which is a
different thing from the compose blocker above. Verified against live Jira that
no ticket covered it, then filed **AF-97** under EPIC 2. A fresh deployment has
no organization, user or membership and no way to create the first of any; every
`INSERT INTO organizations` is a test fixture, and the AF-16 invite machinery has
no HTTP route. AF-73 (recruiter workflow E2E) cannot pass until it exists.

**Result:** full `pnpm check` exit 0 — 164 unit, 367 integration, 35 architecture.

## PR #83 review, round 5

Two findings raised against the head that fixed Sai's compose blocker, both
resolvable inline threads (REV-013, REV-014).

| | |
|---|---|
| Finding (REV-013, P1) | `x-runtime-environment` never passed `SESSION_SECRET`, so `docker compose up` built a web container that `instrumentation.ts` (REV-003) then killed before it could accept a request. The shared block also omitted `PUBLIC_APP_ORIGIN` and the three `MAGIC_LINK_EMAIL_*` values, so a hosted `APP_ENV` (staging/production) would fail `loadEnvironmentConfig`'s own validation for the same reason `.env.example` once did. |
| Fix | `SESSION_SECRET` added to the `web` service only, not the shared block: `apps/worker` loads the same config schema and signs no session, so requiring the secret there would fail worker boot over a value it never reads (already the stated reasoning for keeping it out of `packages/config`, REV-003). `PUBLIC_APP_ORIGIN` and `MAGIC_LINK_EMAIL_*` added to the shared block, defaulted to empty so `development`/`test` compose runs behave exactly as before and a hosted `APP_ENV` fails at config load if left unset, rather than at request time. |
| Regression | `tests/integration/environment-policy.test.ts` reads the compose file's `x-runtime-environment` block and its `web`/`worker` service blocks directly, asserting the four hosted vars are in the shared block, `SESSION_SECRET` is present only on `web`, and absent from both the shared block and `worker`. |
| Control | Reverted to the pre-fix file: fails exactly as expected (missing vars, missing per-service secret). |

| | |
|---|---|
| Finding (REV-014, P2) | `csv-preview` answered 413 on `ObjectTooLargeError` from a post-validation read but left the intake `validated`, on the theory that a size refusal says nothing about whether the stored bytes are the approved ones. That theory doesn't hold: validation itself enforces the identical limit (`evaluateFileValidation`, REV-P1 round 1), so bytes that now exceed it during a later read cannot be the bytes that were approved -- the object was replaced after validation, exactly like the hash-mismatch case `ObjectChangedError` already handles. Left `validated`, the intake was permanently stuck: every later read kept failing the same way with no quarantine/re-upload path. The same branch exists in `extract-text`, `finalize` and `import-status`. |
| Fix | `invalidateOversizedIntake` added to `packages/db`, mirroring `invalidateChangedIntake`: quarantines, records a reason naming the limit, and deliberately does not clear the recorded hash (the evidence of what was approved). All four post-validation readers now call it from their `ObjectTooLargeError` branch, the same one-line pattern each already used for `ObjectChangedError`. |
| Regression | `tests/integration/file-intake-route-errors.test.ts`'s existing oversized-post-validation-read test (previously asserting `validated`, documenting the theory this finding disproved) now asserts `quarantined` and that the hash survives. Driven through `csv-preview`, the route the finding named; the other three call the identical new function so this is the shared fix, not a per-route patch. |
| Control | Reverted `csv-preview` and the new function: the updated test fails, `actual: 'validated'` vs `expected: 'quarantined'`. |

**On verifying this round for real.** No Docker daemon was available in this
environment, so `pnpm dev:infra` could not be used. Postgres 16's own binaries
were on the image; a scratch cluster was initialized directly
(`initdb`/`pg_ctl`, throwaway data directory, discarded after), the 24
migrations replayed against it, and the full suite run against it rather than
skipped: `pnpm run test:unit:ts` (164), `pnpm run test:integration` against
that real database (368, including the DB-dependent file-intake-route-errors
and connection-pooling suites), `pnpm run check:architecture` (35), full
workspace `pnpm run typecheck`, `pnpm run lint`, and `pnpm run build`. All
clean. Object storage was not stood up (no MinIO), so nothing in this round
touched that boundary; both findings here are compose configuration and a
database-only code path.

**Result:** full `pnpm check` exit 0 — 164 unit, 368 integration, 35
architecture, against a real (scratch) Postgres.

## AF-97 — organization and membership bootstrap

The gap this branch filed rather than fixed, now fixed. Not a review round:
a ticket of its own, raised from the PR #83 review after verifying against
live Jira that nothing covered it.

| | |
|---|---|
| The gap | A freshly migrated deployment has zero organizations, users and memberships and no way to create the first of any. `POST /api/auth/magic-link/request` only mails a link when `user !== undefined && memberships.length > 0`, so on an empty database it correctly mailed nobody, forever, and all 16 API routes sat behind a session nobody could obtain. Every `INSERT INTO organizations` in the tree was a test fixture. AF-16's invite machinery (`MagicLinkInvite`, `provisionInvitedMembership`, `createInviteInputSchema`) was complete and had no HTTP route. |
| Why the pieces were green | Token generation, atomic single-use redemption, the verification decision, the session cookie and resource authorization each had passing tests. None of them could observe that there was no way to become the first user. That is the same shape as the `/auth/redeem` 404 in the baseline fixes above: individually-green pieces either side of a missing wire. |
| 1 — first owner | `bootstrapOrganizationOwner` in `packages/db` (organization + user + owner membership, one transaction) behind `pnpm bootstrap:owner`, a command rather than an HTTP route. Whatever creates the first owner cannot itself be authenticated, so as a route it would be an unauthenticated privilege-granting endpoint that must be disabled after first use; "we remembered to disable it" is not a control. Requiring database credentials moves the authorization onto something the deployment already protects. Not refused in production, unlike `pnpm db:seed`, because production is precisely where somebody has to be first. |
| Idempotent | An interrupted run converges: an organization of that name is reused (under `pg_advisory_xact_lock`, since `organizations.name` carries no unique constraint and two real employers may share one), the user is matched by email, and the owner membership is upserted. The result reports `created`/`promoted`/`unchanged`, so the one privilege change it can make to existing data is stated rather than silent. |
| 2 — invites over HTTP | `POST /api/invites`, gated on `access_admin_settings`, not `manage_roles`: a recruiter holds `manage_roles` and can create hiring roles, which is not the authority to add people to the tenant. `createInviteMagicLinkToken` writes the token and its `admin_action` audit row in one transaction, with the audit field required rather than optional, so an unattributable invite cannot be expressed. The audit row's `entity_id` is the token hash, not the invited email: `audit_events` is append-only by trigger with no delete path, and the hash points at the `magic_link_tokens` row that holds the address and can be deleted. |
| Delivery failure | Reported honestly here (503, "created but not emailed"), unlike the deliberate silence on the login endpoint. That one is unauthenticated, so a response varying by address is an account-existence oracle; this one is already authorized against the organization the invitee is joining, so there is nothing the caller could learn that they do not have. |
| 3 — sign-in page | `/` now calls the request endpoint and reads the `?auth=` codes `GET /auth/redeem` has always redirected here with. Both halves were missing: the endpoint had zero `.tsx` callers, and nothing read the codes, so an expired link, an unknown account and a server fault were indistinguishable from a page that had reloaded. The codes are a closed map; an unrecognized one gets the generic message rather than having its text rendered. |
| 4 — navigation | `GET /api/me/organizations` (derived entirely from the caller's own membership rows, so it cannot become an organization directory) plus a `/roles` that resolves the organization itself: an explicit `?organizationId=` still wins, a sole membership is used directly, several offer a switcher. Role rows link to rubric and applications, and `POST /api/roles` finally has a caller. |
| Not linked | The import page needs an `?intakeId=` and nothing in the app can create an intake, so it is left unlinked rather than linked to a dead end. The upload UI is its own ticket. |
| Tests | `tests/integration/deployment-entry-point.test.ts`, 7 cases, driven against a real database through the shipped handlers: empty deployment mails nobody, bootstrap then makes the same request redeemable, re-running converges, an existing member is promoted, an owner's invite redeems into a real membership, a recruiter's invite is 403 and a cross-tenant invite is 404, and the switcher's organizationId is the one the roles API accepts. |
| Refactor carried | The route-loading module hook was inline in two test files and would have been a third. Extracted to `tests/support/web-route-loader.ts` with an optional specifier-redirect map, which is the only thing the two copies differed by; both migrated. |
| Verification | No Docker daemon in this environment, so Postgres 16's own binaries were used to initialize a scratch cluster, as in round 5. `pnpm lint`, full workspace `pnpm typecheck`, `pnpm test:unit:ts` (164), `pnpm test:integration` against that database (375), `pnpm check:architecture` (35) and `pnpm build` all clean. `pnpm bootstrap:owner` was additionally run by hand against a fully migrated schema: first run creates, second reports `unchanged`, a missing flag exits 1 with the usage line, and the resulting rows are one owner membership with a lowercased email. |

### AF-97 — PR #88 review, round 1

Four findings from Copilot on the head above. All four are real; one is
worse than reported.

| | |
|---|---|
| Finding 1 (medium) | The `?auth=` lookup on `/` was a plain object literal, so it was not the closed map its own comment claimed. `?auth=__proto__` resolves to `Object.prototype` and `?auth=constructor` to a function -- both truthy, so `?? GENERIC_AUTH_FAILURE` never fires, and React throws when handed a non-element object. An unauthenticated crash on the one page a stranger can always reach, triggered by sending someone a link. |
| Fix | The mapping moved to `apps/web/src/lib/auth-codes.ts` as a `Map`, which has no inherited keys, behind an `authFailureMessage(code)` that returns a string for any input at all. Extracted rather than fixed in place so the claim is testable: the page is a client component, and a test that rebuilt the map itself would prove nothing about the page that ships. |
| Regression | `tests/unit/sign-in-auth-codes.test.ts`: eight inherited property names each yield the generic message and, specifically, a `string`; arbitrary input always yields a string; the four codes the redeem route emits are present and mutually distinguishable. |
| Control | The pre-fix object lookup, run directly: `__proto__` yields an object and `constructor`/`toString` yield functions. Confirmed. |

| | |
|---|---|
| Finding 2 (medium) | `CreateRole` was rendered whenever an organization was selected, including for an auditor (no `manage_roles`) and for an explicit `?organizationId=` the caller has no membership for. Both get a form guaranteed to be refused. `InviteMember` two lines below already had the gate, and the comment justifying that gate applied word for word to the form without one. |
| Fix | Both forms now gate on `roleHasCapability` against the capability the route will check, and on `activeOrganization !== undefined`, which is exactly the not-a-member case. The page asks ROLE_CAPABILITIES rather than naming roles, so presentation cannot drift from policy; `MembershipRole` replaces the page's re-spelled copy of the union for the same reason. |
| Coverage | The policy itself is covered by `tests/unit/role-capabilities.test.ts` (auditor holds no `manage_roles`), and the enforcement by this file's recruiter-403 case. The rendering gate is presentation with no DOM harness in this repo, so it has no test of its own -- stated rather than implied. |

| | |
|---|---|
| Finding 3 (medium) | `bootstrapOrganizationOwner`'s email check was `indexOf("@") < 1`, and the table's CHECK is only `position('@' in email) > 1`. Both accept `owner@` and `foo@@bar` -- and, not in the finding, `a@b`. All three are rejected by `requestMagicLinkInputSchema`. The one command whose purpose is to create somebody who can sign in could create somebody who provably could not, discovered only when they tried. |
| Fix | Validated at the CLI boundary with contracts' own `storedEmailSchema`, the very object the sign-in endpoint parses with, so no second grammar exists to drift. packages/db may not depend on contracts, so its own check stays structural -- exactly one `@`, non-empty local part, a dotted domain -- and says where the authoritative check lives. |
| Regression | Five rejected addresses driven through `node scripts/environment/bootstrap.mjs` as a real process, asserting exit 1, the reason, and no stack trace. Validation runs before configuration loads, so these need no database. |
| Control | Recorded directly against both predicates: `owner@`, `foo@@bar` and `a@b` all pass the old guard and the table CHECK, and all three fail `z.email()`. |

| | |
|---|---|
| Finding 4 (low) | The invite test treated `POST /api/invites` answering 202 as proof that the `admin_action` audit row had been written. It is not: deleting the `appendAuditEvent` call outright still inserts the token, sends the mail and answers 202. The one assertion covering AF-20's attributability invariant was inferring a write it never read, and the comment asserting otherwise was wrong. |
| Fix | `listAuditEventsForEntity` added to packages/db, for the same reason the assert* probes are exported there. The test now reads the row and asserts every field that makes the action attributable -- organization, actor, action, entity type, the token hash as entity id -- and that the request id matches the one the response returned. |
| Control | Removed the `appendAuditEvent` call from `createInviteMagicLinkToken`: the invite test fails, where before it passed. Confirmed. |

**Result:** `pnpm lint`, full workspace `pnpm typecheck`, `pnpm test:unit:ts`
(168), `pnpm test:integration` against a real scratch Postgres (381),
`pnpm check:architecture` (35) and `pnpm build` all clean.

### AF-97 — PR #88 review, round 2

Eight findings from hemnaath04, one blocking. All eight verified as real and
fixed.

| | |
|---|---|
| Finding (REV-001, HIGH, blocking) | `pnpm bootstrap:owner` could not be run against the deployment this repo ships. `runtime.Dockerfile` copies `apps` and `packages` and not `scripts`, so the script is absent from both runtime stages; and `postgres` sits only on the `private` network, which is `internal: true` with no published port, so there is no path to the database from outside the project either. Both halves confirmed by inspection. For the one ticket whose purpose is that a deployment can be entered, every documented way in was closed, and `README.md` instructed an operation that could not be performed. |
| Fix | `COPY scripts scripts` in the build stage, plus a `bootstrap` service in `runtime.yml` under `profiles: [tools]`, built from `runtime-base`, on the `private` network, using the shared runtime environment: `docker compose --profile tools run --rm bootstrap --organization ... --email ... --name ...`. This keeps the command's security argument intact rather than weakening it -- it runs inside the deployment with the deployment's own credentials, and nothing new is exposed. Deliberately not given `seed`'s production refusal: production is where a first owner is most needed. README and `docs/engineering/environments.md` now document both the local and hosted paths. |
| Regression | `tests/integration/environment-policy.test.ts` asserts the `COPY scripts scripts` line, and that the bootstrap service exists with the right entrypoint, network, profile and shared environment, and does **not** carry the production refusal. |
| Control | Removing the COPY line fails it; removing the service fails it with "expected a bootstrap service". Both confirmed. |

| | |
|---|---|
| Finding (REV-002, MEDIUM) | `POST /api/invites` is also a role-change endpoint. `provisionInvitedMembership` ends in `ON CONFLICT ... DO UPDATE SET role`, unreachable from outside the process until this ticket exposed invite creation. So an invite naming an existing member replaced their role, committed by their own click on a mail that said "Your sign-in link"; and only the invite was audited, never its effect. |
| Fix | Three parts. `previewInviteEffect` resolves what an invite would do before anything is minted; a role replacement is refused with 409 unless the caller passes `replaceExistingRole: true`, so the destructive reading of an ambiguous request cannot happen by accident. The mail now varies by purpose (`MagicLinkPurpose` on the domain port, honoured by both adapters), and the role-change wording tells the recipient that opening the link changes their access. A second `admin_action` row with `entity_type = membership_role_change` records the effect, written at creation where the accountable human is -- not at redemption, where the actor would be the person the change is being done *to*, and where audit_events' membership trigger would turn an offboarded inviter into an unredeemable invite. |
| Limitation stated | The from/to roles travel inside `entity_id` because audit_events has no column for them, and adding one to an append-only table is not a change to make in passing. Semantic content in that column has precedent here (the kill-switch path writes "engaged"/"disengaged"). |

| | |
|---|---|
| Finding (REV-003, MEDIUM) | An invite that would demote an organization's sole owner was created, audited, emailed and answered 202, then failed at redemption forever: the transaction rolls back so `consumed_at` stays null, every retry reproduces it, the invitee lands on `/?auth=error`, and nothing tells the admin who issued it. The undiagnosable bounce this PR's sign-in page exists to end, reintroduced through its invite route. The guard had no test at all, before or after. |
| Fix | The same check runs in the route before minting, answering 409 with the reason, so the refusal lands on the admin who can act on it. Advisory by construction -- it is a read, and `provisionInvitedMembership`'s guard inside the redemption transaction remains the enforcement; what it buys is that the ordinary case fails in the right place. |

| | |
|---|---|
| Finding (REV-007, LOW) | The invite route required an `Idempotency-Key` and then discarded it, so a timed-out retry minted a second live token, a second audit trail and a second email for one act. Worse than not requiring one: it tells the caller the retry is safe. |
| Fix | `0023_invite_idempotency.sql` adds a nullable `idempotency_key` and a partial unique index on `(organization_id, idempotency_key)`; the INSERT is the deduplication, so two concurrent retries cannot both proceed, and a replay writes nothing, sends nothing and answers the same 202. Partial and organization-scoped so login tokens (no organization, no client key) are unaffected. The reviewer's premise was checked and correct: `decisions`, `finalize` and `corrections` all carry their key into the persistence layer, so an invite was the odd one out among consequential writes, not consistent with them. |

| | |
|---|---|
| Findings (REV-004, REV-005, REV-006, REV-008, LOW) | The shared route loader dropped `redirects` on every call after the first, enforcing nothing while its doc comment said to pass it first. The new `globals.css` rules were bare element selectors, restyling the rubric and import pages this PR does not claim to touch. `sign-in-auth-codes.test.ts` compared against a hardcoded code list, so the drift its own comment warned about could not fail it. The bootstrap's `ON CONFLICT (email) DO NOTHING` does not block on a concurrent uncommitted insert, so a loser threw "did not resolve a user". |
| Fixes | The loader throws on a later differing map instead of silently ignoring it, and looks up through a `Map`. The CSS is scoped to `.stacked-form`, leaving the other pages exactly as they were -- global consistency is a deliberate visual decision for the tickets that own those pages, not a side effect of this one. The test now extracts `?auth=` codes from the redeem route's source and asserts both directions; adding a fifth code without a message fails it (confirmed by control). The upsert matches `provisionInvitedMembership`'s `DO UPDATE SET email = EXCLUDED.email`, which takes the row lock, and reads `xmax = 0` to report whether the row was new. |

**New coverage:** three integration cases (role replacement refused then confirmed, with the audit row and the mail's purpose asserted; last-owner invite refused at creation minting nothing; a retried key producing one token, one audit row and one email), plus the REV-001 infrastructure assertions.

**Result:** `pnpm lint`, full workspace `pnpm typecheck`, `pnpm test:unit:ts`
(168), `pnpm test:integration` against a real scratch Postgres (385),
`pnpm check:architecture` (35) and `pnpm build` all clean. The 24 migrations
replay from empty and then replay again idempotently, which the migrate
service requires.

### AF-97 — merging develop (AF-67 monitoring) into PR #88

`develop` gained AF-67's monitoring and alerts (PR #89) while this branch was
waiting on review, and the PR went un-mergeable.

| | |
|---|---|
| Textual conflict | `package.json` only, in `test:unit:ts` and `test:integration` — both sides registered new test files. Resolved as a union: this branch's `sign-in-auth-codes` and `deployment-entry-point`, develop's `budgeted-inference` and `observability`. `tests/architecture/test-registration.test.ts` then confirms the result is complete on disk and free of duplicates, which is exactly the drift that list exists to catch. |
| Semantic conflict | Nothing textual, and the merge still broke the build. AF-67 added `observability.test.ts`, which walks every `apps/web/src/**/*.ts` and asserts no `console.error` survives anywhere: handled 500s must go through `captureServerError`, which sanitizes the diagnostic before it reaches the telemetry sink. This branch's two new routes were written before that rule existed, so they carried three raw `console.error` calls. Merged cleanly, failed honestly — the reason the gate runs after a merge and not before. |
| Fix | `/api/me/organizations` and `/api/invites` converted to the same shape develop gave every other route: handler renamed to `handleGET`/`handlePOST`, exported through `withServerOperation`, and the outer catch replaced with `captureServerError`. The invite route's delivery-failure branch follows the magic-link request route's precedent verbatim -- `describeError` into the existing `magic_link.delivery_failed` structured event, carrying `errorName`/`errorCode` rather than a raw error. |
| Scope held | `organization.list` and `invite.create` added to `WEB_OPERATIONS` so their spans and events carry a real name instead of collapsing into `web.request`, and deliberately **not** to the alerts script's narrower `MONITORED_OPERATIONS`. That p95 alert set is AF-67's to widen; `role.*` and `rubric.*` already sit in exactly this position, so this follows the existing split rather than inventing one. |

**Result:** `pnpm lint`, full workspace `pnpm typecheck`, `pnpm test:unit:ts`
(171), `pnpm test:integration` against a real scratch Postgres (402),
`pnpm check:architecture` (35) and `pnpm build` all clean on the merge commit.

### AF-97 — PR #88 review, round 3

One finding from Saikrishnaa-vr, blocking. Verified as real before fixing.

| | |
|---|---|
| Finding (REV-009, MEDIUM, blocking) | The `0023_invite_idempotency.sql` fix (round 2, REV-007) made a replayed `Idempotency-Key` answer 202 without writing a second row -- but the unique index is scoped to `(organization_id, idempotency_key)` alone, with no binding to *what* the key claimed. A key reused against a different email, role, or `replaceExistingRole` -- a client bug, a copy-pasted header, a key minted once per admin session instead of once per submission -- hit the same conflict path as a genuine retry and got the same silent-success 202. The invite named in that second call was never created, and its caller was told it was. |
| Fix | `0024_invite_idempotency_fingerprint.sql` adds a nullable `idempotency_fingerprint` column. `createInviteMagicLinkToken` now hashes `{email, organizationId, role, replaceExistingRole}` the same way `claimIdempotentRequest` already hashes its `payload`, stores it alongside the key, and on conflict reads back the fingerprint that actually claimed the key: matching fingerprint replays (202, nothing written), differing fingerprint is refused with the existing `idempotency_key_conflict` (409) rather than silently discarded -- the same code `finalizeCsvImport` already answers when a key is reused against a different mapping. `replaceExistingRole` is now a required field on `CreateInviteMagicLinkTokenInput`, not defaulted inside the function, so the fingerprint reflects what the caller actually sent rather than an assumption. |
| Design note | Kept as invite's own column rather than routed through the generic `idempotent_requests`/`claimIdempotentRequest` mechanism 0022 already provides: no route in this tree uses that table yet, and the local convention for a consequential write is its own bespoke idempotency column with its own comparison (`import_finalizations.idempotency_key` + `mapping`, `magic_link_tokens.idempotency_key` from round 2). Reusing the generic table would have been a second, inconsistent pattern introduced to fix one route. |
| Regression | Two integration cases in `deployment-entry-point.test.ts`: reusing a key across two different invitees, and across the same invitee with a different role, both now 409 rather than 202, and the invite the key legitimately claimed is unaffected and still redeems; and reusing a key with a different `replaceExistingRole` answer, specifically chosen so `previewInviteEffect`'s own REV-002 gate (`changes_role` requiring opt-in) does not fire -- proving the fingerprint, not that gate, is what catches it. |
| Control | Both new cases written first against the reverted (round-2) behavior: confirmed they fail with `202 !== 409`, then confirmed green again with the fix restored. The first draft of the second case also caught its own bug this way -- it asserted the role had changed without redeeming the invite that changes it, since `provisionInvitedMembership` applies a role at redemption, not at invite creation. |

**Result:** `pnpm lint`, full workspace `pnpm typecheck`, `pnpm test:unit:ts`
(171), `pnpm test:integration` against a real scratch Postgres (404),
`pnpm check:architecture` (35) and `pnpm build` all clean. The 25 migrations
replay from empty and then replay again idempotently.

### AF-97 — merging develop (AF-102 durable extraction queue) into PR #88

`develop` moved again while round 3 was in flight: PR #92 (AF-102, a durable
evidence-extraction worker queue) merged in as `33f33d5`.

| | |
|---|---|
| Conflict | `package.json` only, same shape as the AF-67 merge: both sides registered a new test file in `test:unit:ts` and `test:integration`. Resolved as a union -- this branch's `sign-in-auth-codes`/`deployment-entry-point`, develop's `evidence-extraction-job`/`evidence-extraction-worker` -- and `tests/architecture/test-registration.test.ts` confirms the result is complete and duplicate-free. |
| Checked and clean | AF-102 touches `apps/web/src/lib/observability.ts`, `packages/db/src/index.ts`, `packages/contracts/src/index.ts` and `packages/security/src/index.ts`, all files this branch also touches; every one auto-merged with no textual conflict. Re-checked for the same class of semantic break the AF-67 merge caused (a new no-`console.error` or similar rule this branch's code predates): none -- `grep -rn console.error apps/web/src apps/worker/src` is empty. A new migration, `0026_evidence_extraction_jobs.sql`, leaves a numbering gap after this branch's `0024` (no `0025` in the merged tree); `migration-ordering.test.ts` has no rule against a gap and all 8 of its cases still pass, so this is left alone rather than renumbered on a branch that doesn't own it. |

**Result:** `pnpm lint`, full workspace `pnpm typecheck`, `pnpm test:unit:ts`
(176), `pnpm test:integration` against a real scratch Postgres (423),
`pnpm check:architecture` (35) and `pnpm build` all clean on the merge commit.

### AF-97 — PR #88 review, round 4

Two findings from Saikrishnaa-vr, both blocking. Verified as real before fixing.

| | |
|---|---|
| Finding (REV-010, MEDIUM, blocking) | `replaceExistingRole` was only ever checked against the membership state `previewInviteEffect` saw at invite *creation*. An invite issued while the address has no membership carries `replaceExistingRole: false` and needs no opt-in -- but if a second admin, a second invite, or bootstrap grants that address a different role before this token is redeemed, `provisionInvitedMembership`'s unconditional `ON CONFLICT ... DO UPDATE SET role` applied the originally requested role over it: the opt-in REV-002 added at creation was never consulted at redemption, because nothing recorded what the caller had actually opted into. |
| Fix (REV-010) | `0027_invite_role_replacement_intent.sql` adds a nullable `replace_existing_role` column, populated by `createInviteMagicLinkToken` from the same `replaceExistingRole` already required for the REV-009 fingerprint, and read back by `redeemMagicLinkToken`. `provisionInvitedMembership` now takes it as a parameter and, inside the same transaction that locks the membership row `FOR UPDATE`, refuses (throws, rolls back, nothing applied) when a membership already exists with a different role and the token did not opt in. The plain, non-invite `createMagicLinkToken` gained the same optional field for the RLS/replay probes that construct tokens directly rather than through the route -- nothing shipped calls it with `invite` set. |
| Finding (REV-011, MEDIUM, blocking) | `GET /auth/redeem` consumed the token and provisioned or changed a membership on an ordinary GET. A corporate mail gateway's prefetch of the emailed link -- indistinguishable from the recipient's own click -- could silently create the membership or apply a role change and burn the single-use token before the invitee ever acted; the invitee's own later click then landed on a dead token with nothing to explain why. |
| Fix (REV-011) | A new, non-mutating `peekMagicLinkTokenIsInvite` (packages/db) tells `GET /auth/redeem` whether a token is a still-live invite without consuming it. A plain login token's GET is unchanged -- redemption there only mints a session, the tradeoff already documented on that route and left as-is. A live invite token instead redirects (non-mutating) to a new `/auth/confirm` page, which requires an explicit "Accept invite" click before POSTing to the same `POST /api/auth/magic-link/redeem` every other redemption in this app already uses. |
| Regression | Two integration cases in `deployment-entry-point.test.ts`. REV-010: an invite is issued while the address has no membership, a second invite grants a different role and is redeemed first, then the first invite's redemption is confirmed refused (500, the same undiagnosable-bounce shape REV-003's last-owner guard already has) and the role is confirmed to still be exactly what the second invite granted. REV-011: the actual delivered `/auth/redeem?token=...` URL is driven through the actual GET handler; the response is confirmed to redirect to `/auth/confirm` with no session cookie, that no membership was provisioned (proven indirectly, by re-inviting the same address with a different role and confirming `previewInviteEffect` still sees `creates_membership` rather than `changes_role`), and that only the follow-up POST -- what clicking "Accept invite" does -- actually redeems the token and creates the membership. |
| Control | Both fixes reverted in turn (the REV-010 check short-circuited, the REV-011 redirect short-circuited), packages rebuilt, and the corresponding new test confirmed to fail each time before the fix was restored and the suite confirmed green again. |

**Result:** `pnpm lint`, full workspace `pnpm typecheck`, `pnpm test:unit:ts`
(176), `pnpm test:integration` against a real scratch Postgres (425),
`pnpm check:architecture` (35) and `pnpm build` all clean.

Saikrishnaa-vr approved with both fixed, leaving one further finding, non-blocking.

| | |
|---|---|
| Finding (REV-012, MEDIUM, non-blocking) | The REV-010 fix above locks the target membership row `FOR UPDATE` before the pre-existing owner-set `FOR UPDATE` query. Two concurrent redemptions demoting two *different* owners of the same organization could each hold the row the other needs next -- transaction A locks A's row then waits on B's, transaction B locks B's row then waits on A's -- a lock cycle Postgres breaks by aborting one with a deadlock error, rather than the last-owner refusal this scenario is actually supposed to produce. |
| Fix | A `pg_advisory_xact_lock(hashtext(organizationId))`, the same pattern `bootstrapOrganizationOwner` already uses (there, on organization name), taken in `provisionInvitedMembership` before either row lock. It serializes every redemption for one organization, so only one is ever inside the section that takes the two row locks at a time -- the cross-wait cannot form regardless of which row either happens to lock first. |
| Regression | Two cases. First, a deterministic one: naturally-timed concurrent redemptions did not reliably land in the exact interleaving that deadlocks -- three attempts against the reverted fix all passed by accident, one transaction consistently finishing before the other's conflicting query was even issued on this fast a local connection. So `assertUnserializedOwnerDemotionsCanDeadlock` (packages/db) forces the interleaving by hand across two raw connections, proving the hazard is real rather than theoretical, independent of the fix's own state. Second, the realistic one: two owners, two invites demoting each concurrently, redeemed via `Promise.allSettled` directly against `redeemMagicLinkToken` so the raw thrown error is inspectable -- asserts exactly one succeeds, the other is refused with the last-owner message (explicitly not a `40P01` Postgres deadlock code), and the organization ends with exactly one owner. |
| Control | The deterministic probe (which does not exercise the fix at all, by design -- an advisory lock's serialization is a structural guarantee, not something worth re-proving empirically) was confirmed to reproduce a genuine deadlock every time it was run against the hazardous lock order. The realistic scenario's fix was then reverted, rebuilt, and confirmed to pass regardless (since natural timing does not reliably hit the window either way) -- which is exactly why the deterministic probe exists: it is the one that actually distinguishes fixed from unfixed. |

**Result:** `pnpm lint`, full workspace `pnpm typecheck`, `pnpm test:unit:ts`
(176), `pnpm test:integration` against a real scratch Postgres (427),
`pnpm check:architecture` (35) and `pnpm build` all clean.
