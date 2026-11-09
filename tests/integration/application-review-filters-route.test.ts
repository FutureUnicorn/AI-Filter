import assert from "node:assert/strict";
import test from "node:test";

import {
  listApplicationIdsWithCandidateDecisions,
  listCurrentEvidenceOutcomeKindsForApplications,
  listCurrentEvidenceOutcomesForApplication,
  publishRubric,
  recordEvidenceOutcome,
  upsertDraftRubric
} from "../../packages/db/src/index.ts";
import { applicationReviewQueueSchema } from "../../packages/contracts/src/index.ts";
import { CONTRACT_SCHEMA_VERSION } from "../../packages/domain/src/index.ts";
import type { EvidenceOutcome } from "../../packages/domain/src/index.ts";
import { withApiRouteHarness } from "../support/route-harness.ts";
import type { RouteHarness } from "../support/route-harness.ts";

/**
 * AF-47: each review filter, driven through the real queue route after the
 * real decision and correction routes have changed what is persisted.
 *
 * The acceptance recheck asked for the filters to be wired to persisted
 * outcomes and for each state to be tested. A unit test of the derivation
 * proves the rule; only a request proves the route reads the rows the rule
 * is about, and reads the current one after a correction rather than the
 * first one written.
 */

const QUEUE_ROUTE = "roles/[roleId]/applications";
const DECISIONS_ROUTE = "roles/[roleId]/applications/[applicationId]/decisions";
const CORRECTIONS_ROUTE = "roles/[roleId]/applications/[applicationId]/evidence/[criterionId]/corrections";

// The probe files one supported outcome under its own criterion. The rubric
// adds four more: three that get a finished answer up front, and one
// ("variable") whose outcome each step changes.
const FILLERS = ["filler_one", "filler_two", "filler_three"] as const;
const VARIABLE = "variable";

const citation = (quote: string) => ({ document: "candidates.csv", pageOrSection: "Experience", offset: 0, quote });

function outcome(harness: RouteHarness, criterionId: string, kind: "not_found" | "contradicted" | "invalid_source"): EvidenceOutcome {
  const base = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: harness.probe.organizationId,
    candidateId: harness.probe.applicationId,
    criterionId
  };
  if (kind === "contradicted") {
    return {
      ...base,
      kind,
      citation: citation("Ran Postgres in production for four years."),
      conflictingCitation: citation("Has not used a relational database.")
    } as EvidenceOutcome;
  }
  if (kind === "invalid_source") {
    return { ...base, kind, reason: "source document could not be opened" } as EvidenceOutcome;
  }
  return { ...base, kind } as EvidenceOutcome;
}

async function queue(harness: RouteHarness, query: Record<string, string> = {}) {
  const response = await harness.request({
    route: QUEUE_ROUTE,
    method: "GET",
    params: { roleId: harness.probe.roleId },
    as: "recruiter",
    query
  });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  const parsed = applicationReviewQueueSchema.safeParse(body);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  return parsed.data;
}

async function shownFor(harness: RouteHarness, filter: string): Promise<number> {
  return (await queue(harness, { filter })).shownCount;
}

test("each review filter follows real decisions, outcomes and corrections through the queue route", async () => {
  await withApiRouteHarness(async (harness) => {
    const { databaseUrl, probe } = harness;
    const criteria = [probe.criterionId, ...FILLERS, VARIABLE].map((criterionId) => ({
      criterionId,
      description: `Synthetic ${criterionId}`,
      evidenceGuidance: `Look for ${criterionId}`
    }));
    const draft = await upsertDraftRubric(databaseUrl, probe.schema, probe.roleId, criteria);
    assert.equal(draft.outcome, "saved");
    if (draft.outcome !== "saved") return;
    assert.equal(
      (await publishRubric(databaseUrl, probe.schema, draft.rubric.rubricId, harness.userId("admin"))).outcome,
      "published"
    );
    for (const filler of FILLERS) {
      await recordEvidenceOutcome(databaseUrl, probe.schema, {
        organizationId: probe.organizationId,
        applicationId: probe.applicationId,
        outcome: outcome(harness, filler, "not_found")
      });
    }

    // 1. No decision, and the variable criterion has no outcome yet.
    let current = await queue(harness);
    assert.deepEqual(current.entries[0]?.reviewFlags, ["unreviewed", "incomplete"]);
    assert.deepEqual(current.reviewFilterCounts, { unreviewed: 1, incomplete: 1, contradiction: 0, error: 0 });
    assert.equal(await shownFor(harness, "incomplete"), 1);
    const hidden = await queue(harness, { filter: "contradiction" });
    assert.equal(hidden.shownCount, 0);
    assert.equal(hidden.totalCount, 1, "a filter that matches nothing still reports the whole role");

    // 2. The pipeline files a contradiction for the variable criterion.
    await recordEvidenceOutcome(databaseUrl, probe.schema, {
      organizationId: probe.organizationId,
      applicationId: probe.applicationId,
      outcome: outcome(harness, VARIABLE, "contradicted")
    });
    current = await queue(harness);
    assert.deepEqual(current.entries[0]?.reviewFlags, ["unreviewed", "contradiction"]);
    assert.equal(await shownFor(harness, "contradiction"), 1);
    assert.equal(await shownFor(harness, "incomplete"), 0, "every rubric criterion now has an answer");

    // 3. A recruiter corrects it through the real route. The newest row is
    //    what counts, so the contradiction filter must stop matching.
    const corrected = await harness.request({
      route: CORRECTIONS_ROUTE,
      method: "POST",
      params: { roleId: probe.roleId, applicationId: probe.applicationId, criterionId: VARIABLE },
      as: "recruiter",
      idempotencyKey: "af47-correction-1",
      body: { outcome: outcome(harness, VARIABLE, "not_found"), reason: "the conflicting line belongs to another candidate" }
    });
    assert.equal(corrected.status, 201, await corrected.clone().text());
    current = await queue(harness);
    assert.deepEqual(current.entries[0]?.reviewFlags, ["unreviewed"]);
    assert.equal(await shownFor(harness, "contradiction"), 0);

    // 4. A recruiter records a decision through the real route.
    const decided = await harness.request({
      route: DECISIONS_ROUTE,
      method: "POST",
      params: { roleId: probe.roleId, applicationId: probe.applicationId },
      as: "recruiter",
      idempotencyKey: "af47-decision-1",
      body: { decision: "hold", rationale: "waiting on a reference check" }
    });
    assert.equal(decided.status, 201, await decided.clone().text());
    current = await queue(harness);
    assert.deepEqual(current.entries[0]?.reviewFlags, []);
    assert.equal(await shownFor(harness, "unreviewed"), 0);

    // 5. The pipeline reports an unusable source for the probe's criterion.
    await recordEvidenceOutcome(databaseUrl, probe.schema, {
      organizationId: probe.organizationId,
      applicationId: probe.applicationId,
      outcome: outcome(harness, probe.criterionId, "invalid_source")
    });
    current = await queue(harness);
    assert.deepEqual(current.entries[0]?.reviewFlags, ["error"]);
    assert.equal(await shownFor(harness, "error"), 1);
    assert.equal((await queue(harness, { filter: "unreviewed,error" })).shownCount, 1, "any of several filters");

    // The batched read and the per-application read used by the evidence
    // card must agree on what is current, or a filter and the card disagree.
    const batched = await listCurrentEvidenceOutcomeKindsForApplications(databaseUrl, probe.schema, probe.organizationId, [
      probe.applicationId
    ]);
    const single = await listCurrentEvidenceOutcomesForApplication(databaseUrl, probe.schema, probe.organizationId, probe.applicationId);
    assert.deepEqual(
      batched.map((row) => [row.criterionId, row.kind]).sort(),
      single.map((row) => [row.outcome.criterionId, row.outcome.kind]).sort()
    );
  });
});

test("the review filter reads cannot be pointed at another tenant's application", async () => {
  await withApiRouteHarness(async (harness) => {
    const { databaseUrl, probe } = harness;
    const decided = await harness.request({
      route: DECISIONS_ROUTE,
      method: "POST",
      params: { roleId: probe.roleId, applicationId: probe.applicationId },
      as: "recruiter",
      idempotencyKey: "af47-decision-tenant",
      body: { decision: "advance", rationale: "strong evidence" }
    });
    assert.equal(decided.status, 201, await decided.clone().text());

    assert.deepEqual(
      await listApplicationIdsWithCandidateDecisions(databaseUrl, probe.schema, probe.organizationId, [probe.applicationId]),
      [probe.applicationId]
    );
    assert.equal(
      (await listCurrentEvidenceOutcomeKindsForApplications(databaseUrl, probe.schema, probe.organizationId, [probe.applicationId]))
        .length,
      1
    );
    // The IDOR half: a real application id paired with another organization.
    assert.deepEqual(
      await listApplicationIdsWithCandidateDecisions(databaseUrl, probe.schema, probe.outsiderOrganizationId, [probe.applicationId]),
      []
    );
    assert.deepEqual(
      await listCurrentEvidenceOutcomeKindsForApplications(databaseUrl, probe.schema, probe.outsiderOrganizationId, [
        probe.applicationId
      ]),
      []
    );
  });
});

test("an unknown or empty review filter is a 400, never the whole queue", async () => {
  await withApiRouteHarness(async (harness) => {
    for (const filter of ["contradiciton", "score", ""]) {
      const response = await harness.request({
        route: QUEUE_ROUTE,
        method: "GET",
        params: { roleId: harness.probe.roleId },
        as: "recruiter",
        query: { filter }
      });
      assert.equal(response.status, 400, `filter=${JSON.stringify(filter)}`);
    }
    const outsider = await harness.request({
      route: QUEUE_ROUTE,
      method: "GET",
      params: { roleId: harness.probe.roleId },
      as: "outsider",
      query: { filter: "error" }
    });
    assert.equal(outsider.status, 404, "a filter does not change who may read the queue");
  });
});
