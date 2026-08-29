import assert from "node:assert/strict";
import test from "node:test";

import {
  ROLE_AUDIT_METRICS,
  buildRoleAuditReport,
  describeAuditSampleProvenance,
  describeEvidencePrecision,
  describeQualifiedPreservation,
  describeReviewTimeReduction,
  renderRoleAuditReport,
  selectAuditSample,
  summarizeEvidencePrecision,
  summarizeQualifiedPreservation,
  summarizeReviewTiming,
  CONTRACT_SCHEMA_VERSION
} from "../../packages/domain/src/index.ts";
import type {
  CandidateAdjudication,
  EvidenceItemHistory,
  EvidenceRevision,
  MetricSample,
  ReviewTimingSpan,
  RoleAuditMetric
} from "../../packages/domain/src/index.ts";

// AF-59. The report is assembled from four independently-built metrics.
// These tests run the real producers rather than hand-made samples, so a
// rename or a shape change on either side shows up here instead of in a
// customer's inbox.

const ORG = "11111111-1111-4111-8111-111111111111";
const ROLE = "33333333-3333-4333-8333-333333333333";
const APPLICATIONS = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
];

function timingSpans(): readonly ReviewTimingSpan[] {
  return APPLICATIONS.map((applicationId) => ({ applicationId, activeMs: 300_000, truncatedByIdle: false }));
}

function adjudications(): readonly CandidateAdjudication[] {
  return APPLICATIONS.map((applicationId) => ({
    applicationId,
    verdict: "strong" as const,
    blindToWorkflowOutput: true
  }));
}

function revision(evidenceOutcomeId: string, supersedes?: string): EvidenceRevision {
  return {
    evidenceOutcomeId,
    outcome: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      kind: "not_found",
      organizationId: ORG,
      candidateId: APPLICATIONS[0] ?? "",
      criterionId: "python_production"
    },
    recordedAt: "2026-08-29T12:00:00.000Z",
    ...(supersedes === undefined ? {} : { supersedesEvidenceOutcomeId: supersedes, correctedByUserId: "u", correctionReason: "wrong" })
  };
}

function itemHistories(): readonly EvidenceItemHistory[] {
  return [
    { itemId: "i1", revisions: [revision("i1")], reviewed: true },
    { itemId: "i2", revisions: [revision("i2")], reviewed: true },
    { itemId: "i3", revisions: [revision("i3"), revision("i3-fix", "i3")], reviewed: true },
    { itemId: "i4", revisions: [revision("i4")], reviewed: false }
  ];
}

function assembled() {
  const timing = summarizeReviewTiming(timingSpans(), APPLICATIONS.length);
  const preservation = summarizeQualifiedPreservation(
    adjudications(),
    APPLICATIONS.map((applicationId) => ({
      applicationId,
      evidence: { strength: "cited" as const, citedCount: 3, uncitedCount: 0, totalCriteria: 3 }
    }))
  );
  const precision = summarizeEvidencePrecision(itemHistories());
  const metrics: Record<RoleAuditMetric, MetricSample | null> = {
    review_time_reduction: describeReviewTimeReduction(
      timing,
      { source: "employer_reported", medianActiveMs: 600_000 },
      1
    ),
    qualified_candidate_preservation: describeQualifiedPreservation(preservation, 1),
    evidence_precision_live_pilot: describeEvidencePrecision(precision, "live_pilot", 1),
    failed_document_rate: null
  };
  return {
    metrics,
    precision,
    report: buildRoleAuditReport({
      organizationId: ORG,
      roleId: ROLE,
      generatedAt: "2026-08-29T18:00:00.000Z",
      metrics,
      corrections: {
        reviewedItems: precision.reviewedItems,
        correctedItems: precision.correctedItems,
        correctionEvents: precision.correctionEvents
      },
      auditSample: describeAuditSampleProvenance(
        selectAuditSample(
          APPLICATIONS.map((applicationId) => ({ applicationId, strength: "weak" as const })),
          "pilot-1",
          2
        )
      )
    })
  };
}

test("every metric the report declares is actually produced by a describe* function under that name", () => {
  // Two readings that have to agree: the report's key set and the metric
  // names the producers emit. A rename on either side currently silently
  // yields a report section that is permanently "not measured".
  const { metrics } = assembled();
  const produced = new Set(
    ROLE_AUDIT_METRICS.map((metric) => metrics[metric]?.metric).filter((name): name is string => name !== undefined)
  );
  for (const metric of ROLE_AUDIT_METRICS) {
    if (metrics[metric] === null) {
      continue;
    }
    assert.ok(produced.has(metric), `no producer emits a sample named ${metric}`);
  }
});

test("the rendered numbers match what the metric functions computed", () => {
  const { report, metrics } = assembled();
  const rendered = renderRoleAuditReport(report);
  const reduction = metrics.review_time_reduction?.value;
  assert.equal(reduction, 0.5);
  assert.match(rendered, /Review time saved\n {2}50\.0%/);
  assert.match(rendered, /Qualified candidates preserved\n {2}100\.0%/);
  // 3 reviewed items, 1 corrected -> 2/3
  assert.match(rendered, /Evidence precision\n {2}66\.7%/);
});

test("the employer-reported caveat survives all the way into the rendered report", () => {
  // AF-55 attaches it, AF-60's envelope carries it, AF-59 has to print
  // it. Three modules, and the caveat is worthless if any one drops it.
  const { report } = assembled();
  const rendered = renderRoleAuditReport(report);
  assert.match(rendered, /Note: .*employer's own estimate/);
});

test("the unread evidence backlog reaches the report as a stated limitation", () => {
  // AF-57 keeps unreviewed items in population and out of sampleSize;
  // summarizeMetric turns that into population_incomplete; this asserts
  // the employer actually sees it.
  const { report } = assembled();
  const rendered = renderRoleAuditReport(report);
  assert.match(rendered, /Note: 1 of 4 in scope are not yet counted toward evidence_precision_live_pilot/);
});

test("an end-to-end report still carries no candidate identifier", () => {
  // Repeated against the real assembly rather than a fixture, because
  // every producer here handles candidate-level data and only the report
  // boundary is supposed to drop it.
  const { report } = assembled();
  const serialised = JSON.stringify(report) + renderRoleAuditReport(report);
  for (const applicationId of APPLICATIONS) {
    assert.ok(!serialised.includes(applicationId), `report leaked ${applicationId}`);
  }
});

test("a metric that was never computed is visible as not measured, end to end", () => {
  const { report } = assembled();
  assert.equal(report.metrics.failed_document_rate, null);
  assert.match(renderRoleAuditReport(report), /Documents that could not be processed\n {2}Not measured for this role\./);
});
