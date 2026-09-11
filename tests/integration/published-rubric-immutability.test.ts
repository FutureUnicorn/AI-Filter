import assert from "node:assert/strict";
import test from "node:test";

import { assertPublishedRubricImmutability } from "../../packages/db/src/index.ts";

/**
 * AF-27 (#36) shipped migration 0012's published-rubric immutability trigger
 * and the publishRubric helper with no test of either. That is the specific
 * hazard the stacked-PR chain kept producing: a feature-to-feature PR never
 * triggered the CI workflow, so an integrity control could ship unexercised
 * and look green.
 *
 * Immutability is a claim about what the database refuses, so it is proven
 * here against real Postgres rather than inferred from the DDL.
 */
function requireDatabase(): string {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail("SIGNAL_AUDIT_RLS_DATABASE_URL must point at a Postgres database for this suite");
  }
  return databaseUrl;
}

test("a published rubric version cannot be mutated or deleted, while drafts stay editable", async () => {
  const observed = await assertPublishedRubricImmutability(requireDatabase());

  // The transition itself must pass: OLD.status is 'draft' when publishing,
  // so the trigger has to let exactly this one write through.
  assert.equal(observed.publishSucceeded, true, "publishing a draft must succeed");

  // Application-level race guard: the UPDATE's own WHERE status = 'draft'.
  assert.equal(observed.republishOutcome, "no_draft", "a published rubric must not be publishable again");

  // Database-level guarantee. Asserting the message names the reason keeps
  // this from passing on some unrelated error, such as a missing column.
  assert.match(
    observed.updateRejection,
    /published and immutable/u,
    `UPDATE of a published rubric must be refused by the database, got: ${JSON.stringify(observed.updateRejection)}`
  );
  // DELETE is checked separately on purpose: the trigger is BEFORE UPDATE OR
  // DELETE, and a regression narrowing it to UPDATE would still satisfy the
  // assertion above.
  assert.match(
    observed.deleteRejection,
    /published and immutable/u,
    `DELETE of a published rubric must be refused by the database, got: ${JSON.stringify(observed.deleteRejection)}`
  );

  // Immutability must be scoped to published rows. Freezing the whole table
  // would break AF-25's edit API, which is the reason this could not reuse
  // the generic append-only trigger.
  assert.equal(observed.draftStillMutable, true, "a draft version must remain editable after a publish");
});
