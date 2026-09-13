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

