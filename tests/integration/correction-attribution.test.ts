import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { correctionReasonSchema } from "../../packages/contracts/src/index.ts";
import { CONTRACT_SCHEMA_VERSION, buildCorrectedEvidenceCard } from "../../packages/domain/src/index.ts";
import type { EvidenceRevision } from "../../packages/domain/src/index.ts";

// AF-50: "Every correction records who made it and why -- needed for
// both quality data and future dispute/audit questions."
//
// Integration rather than unit for the same mechanical reason as
// csv-text-sniff: this imports packages/contracts, which imports
// @signal-audit/domain through node_modules and therefore needs that
// package's built dist. CI's Unit job checks out fresh and runs
// `pnpm test:unit` with no build step, so the file would fail to load
// there. test:integration runs build:packages first. Caught by re-running
// test:unit from a no-dist state, which a combined `pnpm check` hides
// because typecheck builds the packages as a side effect.

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/db/migrations/0018_correction_attribution.sql"
);

const BLANK_REASONS = ["", " ", "   ", "\t", "\n", "\t\n ", " ", "　"];
const REAL_REASONS = ["quote is from another candidate", " padded but real ", "x", "​"];

test("a reason with no non-whitespace character is rejected, including tabs and newlines", () => {
  // `length(trim(x)) > 0` -- the convention used elsewhere in these
  // migrations -- accepts "\t\n", because Postgres trim() strips spaces
  // only. That was the first version of this rule and it let a
  // tab-and-newline reason through on a real database.
  for (const reason of BLANK_REASONS) {
    assert.equal(
      correctionReasonSchema.safeParse(reason).success,
      false,
      `expected ${JSON.stringify(reason)} to be rejected`
    );
  }
});

test("a reason with any real content is accepted, including one that is merely short", () => {
  for (const reason of REAL_REASONS) {
    assert.equal(
      correctionReasonSchema.safeParse(reason).success,
      true,
      `expected ${JSON.stringify(reason)} to be accepted`
    );
  }
});

test("the contract and the database ask the same question, so neither is the looser layer", () => {
  // Tripwire, not a substitute for running the SQL: if someone relaxes
  // 0018 back toward length(trim(...)) the two layers silently diverge
  // and the database becomes the weaker one.
  const migration = readFileSync(MIGRATION, "utf8");
  assert.ok(
    migration.includes("correction_reason ~ '[^[:space:]]'"),
    "0018 no longer uses the non-whitespace class the contract mirrors"
  );
  const executable = migration
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  assert.ok(
    !executable.includes("length(trim(correction_reason))"),
    "0018 reverted to length(trim(...)), which accepts a tab-and-newline reason"
  );
});

test("the corrector must be constrained to a membership, not merely to a user", () => {
  const executable = readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  assert.ok(
    executable.includes("REFERENCES memberships (organization_id, user_id)"),
    "0018 must constrain the corrector to a member of the organization whose evidence changed"
  );
});

const citation = { document: "cv.pdf", pageOrSection: "Skills", offset: 3, quote: "Ran Postgres." };
const original: EvidenceRevision = {
  evidenceOutcomeId: "rev-1",
  outcome: { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "supported", criterionId: "postgres", citation },
  recordedAt: "2026-08-29T10:00:00.000Z"
};

function correctionWith(overrides: Partial<EvidenceRevision>): EvidenceRevision {
  return {
    evidenceOutcomeId: "rev-2",
    outcome: { schemaVersion: CONTRACT_SCHEMA_VERSION, kind: "not_found", criterionId: "postgres" },
    recordedAt: "2026-08-29T11:00:00.000Z",
    correctedByUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    correctionReason: "quote is from another candidate",
    supersedesEvidenceOutcomeId: "rev-1",
    ...overrides
  };
}

test("a card claims a correction only when it can name who, why and what it replaced", () => {
  const complete = correctionWith({});
  assert.notEqual(buildCorrectedEvidenceCard([original, complete], complete).correction, undefined);

  for (const [label, partial] of [
    ["no actor", correctionWith({ correctedByUserId: undefined })],
    ["no reason", correctionWith({ correctionReason: undefined })],
    ["blank reason", correctionWith({ correctionReason: "   " })],
    ["no predecessor", correctionWith({ supersedesEvidenceOutcomeId: undefined })]
  ] as const) {
    const card = buildCorrectedEvidenceCard([original, partial], partial);
    assert.equal(
      card.correction,
      undefined,
      `a card with ${label} must not present itself as an attributed correction`
    );
    // The corrected value is still shown -- only the unsupported claim
    // about provenance is withheld.
    assert.equal(card.kind, "not_found");
  }
});

test("the reason a card reports is the one that was recorded, never a placeholder", () => {
  // This previously defaulted to "" when the reason was missing, which
  // produced a card that said "corrected" and could not say why.
  const complete = correctionWith({ correctionReason: "re-read the source; the original was right" });
  const card = buildCorrectedEvidenceCard([original, complete], complete);
  assert.equal(card.correction?.reason, "re-read the source; the original was right");
});
