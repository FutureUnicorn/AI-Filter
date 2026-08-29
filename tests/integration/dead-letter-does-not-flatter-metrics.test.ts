import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDeadLetterOutcome,
  buildEvidenceCard,
  describeQualifiedPreservation,
  summarizeEvidenceStrength,
  summarizeQualifiedPreservation
} from "../../packages/domain/src/index.ts";
import type { CandidateAdjudication, EvidenceCard, SurfacedCandidate } from "../../packages/domain/src/index.ts";

// AF-65 x AF-56. The tempting implementation of dead-lettering excludes
// those candidates from the safety metric's denominator -- "we could not
// process them, so they do not count". That would let the North Star
// number be raised by dead-lettering everything difficult, which is the
// single worst incentive this system could contain.
//
// A dead-lettered candidate is precisely a candidate the workflow failed
// to surface. These assert that it keeps counting as one, end to end
// through the real card and metric code rather than a fixture.

const RECORDED_AT = "2026-08-29T12:00:00.000Z";
const CRITERIA = ["python_production", "aws_certification", "team_leadership"];
const STRONG: readonly string[] = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];

function adjudications(): readonly CandidateAdjudication[] {
  return STRONG.map((applicationId) => ({
    applicationId,
    verdict: "strong" as const,
    blindToWorkflowOutput: true
  }));
}

function citedCards(): readonly EvidenceCard[] {
  return CRITERIA.map((criterionId) =>
    buildEvidenceCard(
      {
        schemaVersion: 1,
        kind: "supported",
        criterionId,
        citation: {
          document: "resume.txt",
          pageOrSection: "Experience",
          offset: 0,
          quote: "Built and maintained Python microservices."
        }
      } as never,
      RECORDED_AT
    )
  );
}

function deadLetteredCards(): readonly EvidenceCard[] {
  return CRITERIA.map((criterionId) =>
    buildEvidenceCard(buildDeadLetterOutcome(criterionId, "document is password-protected"), RECORDED_AT)
  );
}

test("a dead-lettered card is not verifiable, so its evidence strength is none", () => {
  // The link in the chain that everything else depends on. If a
  // dead-letter card counted as verifiable, the candidate would look
  // surfaced-with-evidence and the metric would improve.
  const strength = summarizeEvidenceStrength(deadLetteredCards());
  assert.equal(strength.strength, "none");
  assert.equal(strength.citedCount, 0);
});

test("dead-lettering a strong candidate LOWERS preservation, it does not exclude them", () => {
  const before = summarizeQualifiedPreservation(
    adjudications(),
    STRONG.map((applicationId): SurfacedCandidate => ({
      applicationId,
      evidence: summarizeEvidenceStrength(citedCards())
    }))
  );
  assert.equal(before.preservationRate, 1);

  const after = summarizeQualifiedPreservation(adjudications(), [
    { applicationId: STRONG[0] ?? "", evidence: summarizeEvidenceStrength(citedCards()) },
    { applicationId: STRONG[1] ?? "", evidence: summarizeEvidenceStrength(deadLetteredCards()) }
  ]);

  assert.equal(after.preservationRate, 0.5, "the dead-lettered candidate must count against us");
  assert.ok(after.preservationRate! < before.preservationRate!, "dead-lettering must never improve the metric");
  assert.equal(after.adjudicatedStrong, 2, "the denominator is unchanged: they were still adjudicated strong");
  assert.equal(after.missedWithoutEvidence, 1);
});

test("dead-lettering every difficult candidate drives the metric to zero, not to one", () => {
  // The gaming scenario, stated plainly. If this ever returned 1, the
  // safest-looking possible report would be produced by giving up on
  // everybody.
  const allDeadLettered = summarizeQualifiedPreservation(
    adjudications(),
    STRONG.map((applicationId): SurfacedCandidate => ({
      applicationId,
      evidence: summarizeEvidenceStrength(deadLetteredCards())
    }))
  );
  assert.equal(allDeadLettered.preservationRate, 0);
  assert.equal(allDeadLettered.adjudicatedStrong, 2, "giving up does not shrink the denominator");
});

test("the reportable metric also falls, so the flattering path is closed at the report too", () => {
  // Checked separately because the suppression envelope could in
  // principle have masked the drop.
  const sample = describeQualifiedPreservation(
    summarizeQualifiedPreservation(adjudications(), [
      { applicationId: STRONG[0] ?? "", evidence: summarizeEvidenceStrength(citedCards()) },
      { applicationId: STRONG[1] ?? "", evidence: summarizeEvidenceStrength(deadLetteredCards()) }
    ]),
    1
  );
  assert.equal(sample.value, 0.5);
  assert.equal(sample.metric, "qualified_candidate_preservation");
});

test("a dead-lettered candidate is visible as given-up-on, not absent", () => {
  // missedWithoutEvidence rather than missedAbsent: they reached review,
  // there was simply nothing to read. The two are fixed by different work,
  // and an operator's dead-letter must not read as a pipeline loss.
  const result = summarizeQualifiedPreservation(adjudications(), [
    { applicationId: STRONG[0] ?? "", evidence: summarizeEvidenceStrength(citedCards()) },
    { applicationId: STRONG[1] ?? "", evidence: summarizeEvidenceStrength(deadLetteredCards()) }
  ]);
  assert.equal(result.missedWithoutEvidence, 1);
  assert.equal(result.missedAbsent, 0);
});
