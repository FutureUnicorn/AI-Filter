import assert from "node:assert/strict";
import test from "node:test";

import {
  CANDIDATE_DECISION_KINDS,
  CONTRACT_SCHEMA_VERSION,
  deriveCandidateWorkflowStatus
} from "../../packages/domain/src/index.ts";
import type { CandidateDecision } from "../../packages/domain/src/index.ts";

// AF-51: "The only place a candidate's workflow status changes. Always a
// named human action with a rationale field."

const ORG = "11111111-1111-4111-8111-111111111111";
const APP = "55555555-5555-4555-8555-555555555555";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function decision(overrides: Partial<CandidateDecision> & { readonly decisionId: string }): CandidateDecision {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    organizationId: ORG,
    applicationId: APP,
    decision: "advance",
    rationale: "strong evidence against every criterion",
    decidedByUserId: USER,
    decidedAt: "2026-08-29T10:00:00.000Z",
    ...overrides
  };
}

test("a candidate nobody has ruled on is undecided, which is a state and not a gap", () => {
  // Collapsing "nobody has looked" into "hold" would let an untouched
  // application read as a deliberate outcome.
  assert.deepEqual(deriveCandidateWorkflowStatus([]), { status: "undecided" });
});

test("one decision is the status, with the person and the reason attached", () => {
  const status = deriveCandidateWorkflowStatus([decision({ decisionId: "d1" })]);
  assert.equal(status.status, "advance");
  if (status.status === "undecided") {
    throw new Error("expected a decided status");
  }
  assert.equal(status.decidedByUserId, USER);
  assert.match(status.rationale, /strong evidence/);
  assert.equal(status.revisionCount, 0);
});

test("a revision supersedes the earlier decision and is counted", () => {
  const status = deriveCandidateWorkflowStatus([
    decision({ decisionId: "d1", decision: "advance" }),
    decision({
      decisionId: "d2",
      decision: "decline",
      supersedesDecisionId: "d1",
      rationale: "reference check contradicted the claim",
      decidedAt: "2026-08-29T11:00:00.000Z"
    })
  ]);
  assert.equal(status.status, "decline");
  if (status.status !== "undecided") {
    assert.equal(status.revisionCount, 1);
    assert.equal(status.decisionId, "d2");
  }
});

test("a revision recorded with an EARLIER timestamp than what it replaced still stands", () => {
  // The chain is a stored fact (0019's supersedes link), not an
  // inference from clocks -- so skew or two rows in the same microsecond
  // cannot invert which decision is current.
  const status = deriveCandidateWorkflowStatus([
    decision({ decisionId: "d1", decision: "advance", decidedAt: "2026-08-29T11:00:00.000Z" }),
    decision({
      decisionId: "d2",
      decision: "hold",
      supersedesDecisionId: "d1",
      decidedAt: "2026-08-29T09:00:00.000Z"
    })
  ]);
  assert.equal(status.status, "hold");
});

test("a chain of three resolves to the last, not the newest-looking", () => {
  const status = deriveCandidateWorkflowStatus([
    decision({ decisionId: "d1", decision: "advance" }),
    decision({ decisionId: "d2", decision: "hold", supersedesDecisionId: "d1", decidedAt: "2026-08-29T11:00:00.000Z" }),
    decision({
      decisionId: "d3",
      decision: "decline",
      supersedesDecisionId: "d2",
      decidedAt: "2026-08-29T12:00:00.000Z"
    })
  ]);
  assert.equal(status.status, "decline");
  if (status.status !== "undecided") {
    assert.equal(status.revisionCount, 2);
  }
});

test("the order decisions arrive in does not change the answer", () => {
  const chain = [
    decision({ decisionId: "d1", decision: "advance" }),
    decision({ decisionId: "d2", decision: "hold", supersedesDecisionId: "d1", decidedAt: "2026-08-29T11:00:00.000Z" }),
    decision({
      decisionId: "d3",
      decision: "decline",
      supersedesDecisionId: "d2",
      decidedAt: "2026-08-29T12:00:00.000Z"
    })
  ];
  const forward = deriveCandidateWorkflowStatus(chain);
  for (const permutation of [[2, 0, 1], [1, 2, 0], [2, 1, 0]]) {
    assert.deepEqual(deriveCandidateWorkflowStatus(permutation.map((i) => chain[i] as CandidateDecision)), forward);
  }
});

test("every decision kind round-trips through the status", () => {
  for (const kind of CANDIDATE_DECISION_KINDS) {
    const status = deriveCandidateWorkflowStatus([decision({ decisionId: `d-${kind}`, decision: kind })]);
    assert.equal(status.status, kind);
  }
});

test("a status can never be produced without a person and a reason", () => {
  // The type makes an unattributed decision unrepresentable; this pins
  // that the derivation carries both through rather than dropping them.
  for (const kind of CANDIDATE_DECISION_KINDS) {
    const status = deriveCandidateWorkflowStatus([decision({ decisionId: `d-${kind}`, decision: kind })]);
    if (status.status === "undecided") {
      throw new Error("expected a decided status");
    }
    assert.ok(status.decidedByUserId.length > 0);
    assert.ok(/\S/u.test(status.rationale));
  }
});

test("a cycle reports undecided rather than picking an arbitrary row", () => {
  // Unrepresentable through recordCandidateDecision, but returning some
  // row from a structure that is already wrong would present a confident
  // status derived from nonsense.
  const status = deriveCandidateWorkflowStatus([
    decision({ decisionId: "d1", supersedesDecisionId: "d2" }),
    decision({ decisionId: "d2", supersedesDecisionId: "d1" })
  ]);
  assert.deepEqual(status, { status: "undecided" });
});
