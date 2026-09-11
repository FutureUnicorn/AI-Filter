# Reconstruction log: integration/rebuild-feature-stack

Executes `AI_Filter_PR_Cleanup_Plan.md`. Every historical PR is replayed as its own
base-to-head delta onto a modern baseline, never as a wholesale branch merge.

## Baseline

| | |
|---|---|
| Baseline ref | `origin/integrate-af23-25` @ `616464f` (head of PR #82) |
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

