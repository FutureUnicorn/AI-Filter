import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeJobAdministration,
  buildDeadLetterOutcome,
  buildEvidenceCard,
  describeQualifiedPreservation,
  identifyStuckJobs,
  summarizeEvidenceStrength,
  summarizeFailedDocuments,
  summarizeQualifiedPreservation
} from "../../packages/domain/src/index.ts";
import type {
  CandidateAdjudication,
  EvidenceCard,
  FailedDocumentCounts,
  SurfacedCandidate
} from "../../packages/domain/src/index.ts";

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
    buildEvidenceCard(buildDeadLetterOutcome(criterionId), RECORDED_AT)
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

// ---- REV-002: the failed-document rate ----
//
// This suite covered AF-56 preservation only, so it said nothing about the
// failed-document rate, which is the metric an import dead-letter would
// have touched. A stuck import is a validated intake with no canonical
// text: neither failed nor succeeded, so it is inFlight. Dead-lettering an
// import is now refused, and this proves the refusal does not move the
// rate either way. It is NOT a proof that the rate is right: a stuck upload
// sitting in inFlight forever, dead-lettered or not, is its own defect and
// its own ticket. Do not read this test as "the metric is fixed".

test("a stuck import stays inFlight whether or not a dead-letter was attempted", () => {
  const now = new Date("2026-08-29T12:00:00.000Z");
  const organizationId = "11111111-1111-4111-8111-111111111111";
  // One upload that validated and never produced canonical text.
  const counts: FailedDocumentCounts = {
    uploaded: 1,
    quarantined: 0,
    rejected: 0,
    extractionEmpty: 0,
    extractionSucceeded: 0
  };
  const before = summarizeFailedDocuments(organizationId, "role-1", counts);

  const [job] = identifyStuckJobs(
    [{ jobId: "intake-1", kind: "import", organizationId, terminal: false, attempts: 3, waitingSince: "2026-08-29T08:00:00.000Z" }],
    now
  );
  const decision = authorizeJobAdministration(
    job,
    { jobId: "intake-1", action: "dead_letter", reason: "file is corrupt and will never parse", operatorUserId: "op-1" },
    {
      grant: {
        grantId: "grant-1",
        organizationId,
        operatorUserId: "op-1",
        reason: "customer reported a stuck upload",
        grantedByUserId: "op-2",
        grantedAt: "2026-08-29T11:00:00.000Z",
        expiresAt: "2026-08-29T13:00:00.000Z"
      },
      now
    }
  );
  assert.equal(decision.allowed ? undefined : decision.refusal, "dead_letter_unsupported_for_import");

  // Nothing was written, so the counts the rate is computed from are unchanged.
  const after = summarizeFailedDocuments(organizationId, "role-1", counts);
  assert.deepEqual(after, before);
  assert.equal(after.inFlight, 1, "the stuck import is still in flight");
  assert.equal(after.failed, 0, "and it is still not counted as failed, which is ticket (b), not fixed here");
});
