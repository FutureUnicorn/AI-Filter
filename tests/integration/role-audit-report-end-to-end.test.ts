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
  summarizeMetric,
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

// AF-57 replaced `reviewed: boolean` with the record that establishes
// examination, and this is what an honest live pilot looks like under
// that API: one item proven examined by its own correction, two counted
// because a decision was recorded on the candidate, one nobody touched.
//
// It cannot be written any other way without ceasing to be a live pilot.
// `item_correction` is the only item-level proof a pilot produces, so a
// fixture with no inferred examinations is a fixture where every
// examined item was corrected, which is a precision of 0. The inferred
// denominator is the normal case, not the edge case, and the report has
// to survive it.
function itemHistories(): readonly EvidenceItemHistory[] {
  return [
    { itemId: "i1", dataset: "live_pilot", revisions: [revision("i1")], examinedVia: "candidate_decision" },
    { itemId: "i2", dataset: "live_pilot", revisions: [revision("i2")], examinedVia: "candidate_decision" },
    {
      itemId: "i3",
      dataset: "live_pilot",
      revisions: [revision("i3"), revision("i3-fix", "i3")],
      examinedVia: "item_correction"
    },
    { itemId: "i4", dataset: "live_pilot", revisions: [revision("i4")], examinedVia: "not_examined" }
  ];
}

// The name AF-57 gives a live-pilot sample whose denominator rests on
// candidate-level decisions. Written out once, here, so the assertions
// below read as the report publishing a specific identity rather than
// matching a prefix.
const INFERRED_PRECISION_METRIC = "evidence_precision_live_pilot_examination_inferred";

function assembled() {
  const timing = summarizeReviewTiming(timingSpans(), APPLICATIONS.length);
  const preservation = summarizeQualifiedPreservation(
    adjudications(),
    APPLICATIONS.map((applicationId) => ({
      applicationId,
      evidence: { strength: "cited" as const, citedCount: 3, uncitedCount: 0, totalCriteria: 3 }
    }))
  );
  const precision = summarizeEvidencePrecision(itemHistories(), "live_pilot");
  const metrics: Record<RoleAuditMetric, MetricSample | null> = {
    review_time_reduction: describeReviewTimeReduction(
      timing,
      { source: "employer_reported", medianActiveMs: 600_000 },
      1
    ),
    qualified_candidate_preservation: describeQualifiedPreservation(preservation, 1),
    evidence_precision_live_pilot: describeEvidencePrecision(precision, 1),
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
        examinedItems: precision.examinedItems,
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

test("every metric the report declares is filed under a name that section accepts", () => {
  // Two readings that have to agree: the report's key set and the metric
  // names the producers emit. A rename on either side silently yields a
  // report section that is permanently "not measured", which is the one
  // way this document can be wrong that reads as good news.
  //
  // AF-57 made that a live risk rather than a hypothetical: precision now
  // renames itself when its denominator is inferred, so "agree" has to
  // mean "the metric or a declared qualification of it", and the report
  // is what decides which qualifications exist.
  const { metrics, report } = assembled();
  for (const metric of ROLE_AUDIT_METRICS) {
    const sample = metrics[metric];
    if (sample === null) {
      continue;
    }
    // buildRoleAuditReport already threw if it disagreed; this is the
    // reading of that, plus proof the sample reached the report whole.
    assert.equal(report.metrics[metric]?.metric, sample.metric);
  }
  assert.equal(
    metrics.evidence_precision_live_pilot?.metric,
    INFERRED_PRECISION_METRIC,
    "a live-pilot denominator built from candidate decisions must not claim the measured metric's name"
  );
});

test("a live-pilot precision figure reaches the report at all", () => {
  // The regression this guards is a refusal, not a wrong number. AF-57's
  // rename plus AF-59's fixed key set meant buildRoleAuditReport rejected
  // every precision sample a live pilot can actually produce, and the
  // section a report cannot publish renders as "Not measured for this
  // role" -- which an employer reads as nothing to report.
  const { report } = assembled();
  const sample = report.metrics.evidence_precision_live_pilot;
  assert.equal(sample?.metric, INFERRED_PRECISION_METRIC);
  assert.equal(sample?.value, 2 / 3);
});

test("the heading carries the qualification, not just the note underneath it", () => {
  // The reason AF-57 renamed the metric instead of attaching a caveat is
  // that a caveat travels in prose and the number travels in a slide. A
  // heading that still read "Evidence precision" would undo that at the
  // last boundary, where the only reader is someone with no one present
  // to explain it.
  const rendered = renderRoleAuditReport(assembled().report);
  assert.match(rendered, /Evidence precision \(examination inferred, not measured item by item\)/);
  assert.ok(
    !/Evidence precision\n/u.test(rendered),
    "the unqualified heading must not appear over an inferred denominator"
  );
});

test("a sample belonging to another metric is still refused", () => {
  // The qualification rule widened what a section accepts, so this
  // asserts what it did not widen. Built by hand: the producers cannot
  // emit a sample under the wrong section, which is exactly why the
  // boundary check is the only thing standing between a hand-assembled
  // report and a preservation figure printed as precision.
  const { report } = assembled();
  assert.throws(
    () =>
      buildRoleAuditReport({
        organizationId: report.organizationId,
        roleId: report.roleId,
        generatedAt: report.generatedAt,
        metrics: {
          ...report.metrics,
          evidence_precision_live_pilot: summarizeMetric({
            metric: "qualified_candidate_preservation",
            value: 0.97,
            sampleSize: 3,
            population: 4,
            minimumSampleSize: 1
          })
        },
        corrections: report.corrections,
        auditSample: report.auditSample
      }),
    /carries a sample for "qualified_candidate_preservation"/
  );
});

test("the rendered numbers match what the metric functions computed", () => {
  const { report, metrics } = assembled();
  const rendered = renderRoleAuditReport(report);
  const reduction = metrics.review_time_reduction?.value;
  assert.equal(reduction, 0.5);
  assert.match(rendered, /Review time saved\n {2}50\.0%/);
  assert.match(rendered, /Qualified candidates preserved\n {2}100\.0%/);
  // 3 examined items, 1 corrected -> 2/3
  assert.match(rendered, /Evidence precision \(examination inferred, not measured item by item\)\n {2}66\.7%/);
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
  assert.match(
    rendered,
    new RegExp(`Note: 1 of 4 in scope are not yet counted toward ${INFERRED_PRECISION_METRIC}`)
  );
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

test("the corrections line and the precision line are two readings of one denominator", () => {
  // buildRoleAuditReport now refuses a report whose corrections and
  // evidence_precision_live_pilot disagree on how many items a human
  // reviewed. This asserts that constraint is the one the real producers
  // already satisfy rather than a rule invented at the report boundary:
  // describeEvidencePrecision takes sampleSize straight from the same
  // EvidencePrecision the corrections are read off.
  const { report, precision, metrics } = assembled();
  assert.equal(report.corrections?.examinedItems, precision.examinedItems);
  assert.equal(metrics.evidence_precision_live_pilot?.sampleSize, precision.examinedItems);

  const rendered = renderRoleAuditReport(report);
  // The reader can divide one line and land on the other: 1 of 3
  // corrected is the 66.7% printed above it.
  assert.match(
    rendered,
    /Evidence precision \(examination inferred, not measured item by item\)\n {2}66\.7% \(from 3 of 4\)/
  );
  assert.match(rendered, /1 of 3 examined evidence items were corrected, across 1 correction\(s\)\./);
});

test("a metric that was never computed is visible as not measured, end to end", () => {
  const { report } = assembled();
  assert.equal(report.metrics.failed_document_rate, null);
  assert.match(renderRoleAuditReport(report), /Documents that could not be processed\n {2}Not measured for this role\./);
});
