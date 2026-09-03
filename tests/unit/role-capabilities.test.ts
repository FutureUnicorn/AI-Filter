import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITIES,
  MEMBERSHIP_ROLES,
  ROLE_CAPABILITIES,
  roleHasCapability
} from "../../packages/domain/src/index.ts";

test("every role's capability list only contains known capabilities", () => {
  for (const role of MEMBERSHIP_ROLES) {
    for (const capability of ROLE_CAPABILITIES[role]) {
      assert.ok(CAPABILITIES.includes(capability), `${role} lists unknown capability ${capability}`);
    }
  }
});

test("owner and admin can do everything", () => {
  for (const role of ["owner", "admin"] as const) {
    for (const capability of CAPABILITIES) {
      assert.equal(roleHasCapability(role, capability), true, `${role} should have ${capability}`);
    }
  }
});

test("recruiter can review candidates, record decisions, and manage roles -- nothing else", () => {
  assert.equal(roleHasCapability("recruiter", "review_candidates"), true);
  assert.equal(roleHasCapability("recruiter", "record_decision"), true);
  assert.equal(roleHasCapability("recruiter", "manage_roles"), true);
  assert.equal(roleHasCapability("recruiter", "approve_rubric"), false);
  assert.equal(roleHasCapability("recruiter", "view_audit_reports"), false);
  assert.equal(roleHasCapability("recruiter", "access_admin_settings"), false);
});

test("auditor is read-only: can view audit reports, cannot review, decide, administer, or manage roles", () => {
  assert.equal(roleHasCapability("auditor", "view_audit_reports"), true);
  assert.equal(roleHasCapability("auditor", "review_candidates"), false);
  assert.equal(roleHasCapability("auditor", "record_decision"), false);
  assert.equal(roleHasCapability("auditor", "approve_rubric"), false);
  assert.equal(roleHasCapability("auditor", "access_admin_settings"), false);
  assert.equal(roleHasCapability("auditor", "manage_roles"), false);
});
