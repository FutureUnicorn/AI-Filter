import assert from "node:assert/strict";
import test from "node:test";

import { AUDIT_ACTIONS, CONTRACT_SCHEMA_VERSION } from "../../packages/domain/src/index.ts";
import { auditEventSchema } from "../../packages/contracts/src/index.ts";

const base = {
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  auditEventId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  actorUserId: "33333333-3333-4333-8333-333333333333",
  action: "decision_recorded" as const,
  entityType: "application",
  entityId: "app-123",
  requestId: "req_44444444-4444-4444-8444-444444444444",
  occurredAt: "2026-08-21T12:00:00.000Z"
};

test("a well-formed audit event parses successfully", () => {
  assert.equal(auditEventSchema.safeParse(base).success, true);
});

test("every AUDIT_ACTIONS value is accepted", () => {
  for (const action of AUDIT_ACTIONS) {
    const result = auditEventSchema.safeParse({ ...base, action });
    assert.equal(result.success, true, `action ${action} should be accepted`);
  }
});

test("an action outside the closed set is rejected", () => {
  const result = auditEventSchema.safeParse({ ...base, action: "candidate_deleted" });
  assert.equal(result.success, false);
});

test("a requestId without the req_ prefix is rejected, reusing AF-14's requestIdSchema", () => {
  const result = auditEventSchema.safeParse({ ...base, requestId: "not-prefixed" });
  assert.equal(result.success, false);
});

test("an unrecognized property is rejected", () => {
  const result = auditEventSchema.safeParse({ ...base, notes: "should not be here" });
  assert.equal(result.success, false);
});

test("a stale schemaVersion is rejected", () => {
  const result = auditEventSchema.safeParse({ ...base, schemaVersion: "0.9.0" });
  assert.equal(result.success, false);
});
