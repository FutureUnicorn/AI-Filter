import assert from "node:assert/strict";
import test from "node:test";

import {
  ROLE_AUDIT_METRICS,
  buildRoleAuditReport,
  describeAuditSampleProvenance,
  renderRoleAuditReport,
  selectAuditSample,
  summarizeMetric
} from "../../packages/domain/src/index.ts";
import type { MetricSample, RoleAuditMetric } from "../../packages/domain/src/index.ts";

// AF-59: "The actual pilot deliverable: time saved, preservation,
// precision, corrections, and failures for one role, in a form an
// employer can read without a login."

const ORG = "11111111-1111-4111-8111-111111111111";
const ROLE = "33333333-3333-4333-8333-333333333333";

function sample(metric: RoleAuditMetric, value: number | null, sampleSize = 40, population = 40): MetricSample {
  return summarizeMetric({ metric, value, sampleSize, population, minimumSampleSize: 10 });
}

function metrics(overrides: Partial<Record<RoleAuditMetric, MetricSample | null>> = {}) {
  const base = {
    review_time_reduction: sample("review_time_reduction", 0.52),
    qualified_candidate_preservation: sample("qualified_candidate_preservation", 0.97),
    evidence_precision_live_pilot: sample("evidence_precision_live_pilot", 0.985),
    failed_document_rate: sample("failed_document_rate", 0.02)
  };
  return { ...base, ...overrides };
}

function report(overrides: Record<string, unknown> = {}) {
  return buildRoleAuditReport({
    organizationId: ORG,
    roleId: ROLE,
    generatedAt: "2026-08-29T18:00:00.000Z",
    metrics: metrics(),
    corrections: { reviewedItems: 200, correctedItems: 3, correctionEvents: 4 },
    auditSample: { seed: "pilot-1", eligibleCount: 60, sampledCount: 10 },
    ...overrides
  });
}

test("the report carries no candidate identifier, because it is read without a login", () => {
  // POL-011. A link forwarded to a personal inbox must not have leaked a
  // named candidate. Asserted over the serialised report so a field added
  // later cannot smuggle one in unnoticed.
  const selection = selectAuditSample(
    [
      { applicationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", strength: "none" },
      { applicationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", strength: "weak" }
    ],
    "pilot-1",
    2
  );
  assert.equal(selection.sampledApplicationIds.length, 2, "the selection itself does carry ids");

  const built = report({ auditSample: describeAuditSampleProvenance(selection) });
  const serialised = JSON.stringify(built) + renderRoleAuditReport(built);
  for (const applicationId of selection.sampledApplicationIds) {
    assert.ok(!serialised.includes(applicationId), `report leaked ${applicationId}`);
  }
  assert.equal(built.auditSample?.sampledCount, 2, "the count survives; the identities do not");
});

test("every named figure is a required key, so none can be silently absent", () => {
  // A section merely missing from a customer-facing report reads as "no
  // problems here".
  const rendered = renderRoleAuditReport(report());
  // Driven off ROLE_AUDIT_METRICS rather than a hand-listed set, so a
  // metric added to the constant without a heading fails here instead of
  // rendering as an untitled block.
  const headings: Record<string, RegExp> = {
    review_time_reduction: /Review time saved/,
    qualified_candidate_preservation: /Qualified candidates preserved/,
    evidence_precision_live_pilot: /Evidence precision/,
    failed_document_rate: /Documents that could not be processed/
  };
  for (const metric of ROLE_AUDIT_METRICS) {
    const heading = headings[metric];
    assert.ok(heading !== undefined, `no expected heading declared for ${metric}`);
    assert.match(rendered, heading);
  }
  assert.equal(Object.keys(headings).length, ROLE_AUDIT_METRICS.length, "headings and metrics must stay in step");
  assert.match(rendered, /Review time saved/);
  assert.match(rendered, /Qualified candidates preserved/);
  assert.match(rendered, /Evidence precision/);
  assert.match(rendered, /Documents that could not be processed/);
  assert.match(rendered, /Corrections/);
  assert.match(rendered, /Audit sample/);
});

test("a metric that was never computed renders as 'not measured', not as absent", () => {
  const rendered = renderRoleAuditReport(report({ metrics: metrics({ qualified_candidate_preservation: null }) }));
  assert.match(rendered, /Qualified candidates preserved\n {2}Not measured for this role\./);
});

test("a suppressed metric renders as 'not enough data', never blank and never zero", () => {
  // Blank beside four real numbers reads as zero, and zero is a claim.
  const suppressed = sample("qualified_candidate_preservation", 0.5, 2, 40);
  const rendered = renderRoleAuditReport(report({ metrics: metrics({ qualified_candidate_preservation: suppressed }) }));
  assert.match(rendered, /Qualified candidates preserved\n {2}Not enough data to report\./);
  assert.ok(!rendered.includes("0.0%"), "a suppressed metric must not print a number at all");
});

test("limitations are printed with the number, not dropped", () => {
  // Every guard AF-55/56/57 added lives in `limitations`. A renderer that
  // shows value and drops them undoes all of it.
  const withCaveat: MetricSample = {
    ...sample("review_time_reduction", 0.52),
    limitations: [{ code: "baseline_self_reported", detail: "the baseline is the employer's own estimate" }]
  };
  const rendered = renderRoleAuditReport(report({ metrics: metrics({ review_time_reduction: withCaveat }) }));
  assert.match(rendered, /52\.0%/);
  assert.match(rendered, /Note: the baseline is the employer's own estimate/);
});

test("a negative review-time reduction keeps its sign", () => {
  // Dropping the sign turns "we made review 20% slower" into its
  // opposite -- the most important result this report can carry.
  const slower = sample("review_time_reduction", -0.2);
  const rendered = renderRoleAuditReport(report({ metrics: metrics({ review_time_reduction: slower }) }));
  assert.match(rendered, /-20\.0%/);
});

test("a sample filed under the wrong key is rejected rather than mislabelled", () => {
  // A preservation figure printed under "Evidence precision" is worse
  // than a missing one, because it is believable.
  assert.throws(
    () =>
      report({
        metrics: metrics({
          evidence_precision_live_pilot: sample("qualified_candidate_preservation", 0.97)
        })
      }),
    /carries a sample for "qualified_candidate_preservation"/
  );
});

test("more corrected items than reviewed items is rejected", () => {
  assert.throws(
    () => report({ corrections: { reviewedItems: 3, correctedItems: 4, correctionEvents: 4 } }),
    /correctedItems cannot exceed reviewedItems/
  );
});

test("corrections report items and events separately", () => {
  const rendered = renderRoleAuditReport(report());
  assert.match(rendered, /3 of 200 reviewed evidence items were corrected, across 4 correction\(s\)\./);
});

test("the audit sample tells the employer how to reproduce it", () => {
  // The point of AF-52's seed: an auditor who suspects cherry-picking can
  // re-run the selection and get the same candidates.
  const rendered = renderRoleAuditReport(report());
  assert.match(rendered, /10 of 60 eligible candidates, drawn with seed pilot-1/);
  assert.match(rendered, /re-run the selection with that seed and reproduce the same sample/);
});

test("the report says who else can reproduce the sample, not just that it is reproducible", () => {
  // The seed is a reconstruction key: anyone holding the role's candidate
  // list can recompute exactly which candidates were sampled. Verified
  // empirically, not assumed. That is the point for the employer, whose
  // data it is, and inert for a stranger holding neither -- but it makes
  // the report unsafe to forward to a third party with an overlapping
  // candidate set. The reader is the one choosing who to forward it to,
  // so the warning has to reach them, not just a ticket.
  const rendered = renderRoleAuditReport(report());
  assert.match(rendered, /should not be forwarded to a party that holds candidate data of its own/);
});

test("the published seed really does reconstruct the sample, which is why the warning is there", () => {
  // A negative control baked in: if selectAuditSample ever stopped being
  // seed-deterministic, the warning would be false and this fails rather
  // than leaving a scary sentence nobody re-checked.
  const candidates = Array.from({ length: 30 }, (_, index) => ({
    applicationId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    strength: (index % 2 === 0 ? "weak" : "none") as "weak" | "none"
  }));
  const drawn = selectAuditSample(candidates, "pilot-1", 5);
  const provenance = describeAuditSampleProvenance(drawn);
  const recomputed = selectAuditSample(candidates, provenance.seed, provenance.sampledCount);
  assert.deepEqual(recomputed.sampledApplicationIds, drawn.sampledApplicationIds);
  assert.notDeepEqual(
    selectAuditSample(candidates, "a-different-seed", provenance.sampledCount).sampledApplicationIds,
    drawn.sampledApplicationIds,
    "without the seed the sample is not recoverable, which is what keeps a bare leak inert"
  );
});

test("no audit sample renders as an explicit statement, not silence", () => {
  const rendered = renderRoleAuditReport(report({ auditSample: null }));
  assert.match(rendered, /No audit sample was drawn for this role\./);
});

test("the report is pinned to the contract schema version", () => {
  assert.equal(report().schemaVersion, buildRoleAuditReport({
    organizationId: ORG,
    roleId: ROLE,
    generatedAt: "2026-08-29T18:00:00.000Z",
    metrics: metrics(),
    corrections: null,
    auditSample: null
  }).schemaVersion);
});
