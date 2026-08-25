import assert from "node:assert/strict";
import test from "node:test";

import { MEMBERSHIP_ROLES } from "../../packages/domain/src/index.ts";
import {
  createInviteInputSchema,
  requestMagicLinkInputSchema
} from "../../packages/contracts/src/index.ts";

test("requestMagicLinkInputSchema accepts only an email, nothing else", () => {
  assert.equal(requestMagicLinkInputSchema.safeParse({ email: "user@acme.test" }).success, true);
  assert.equal(requestMagicLinkInputSchema.safeParse({ email: "not-an-email" }).success, false);
  assert.equal(
    requestMagicLinkInputSchema.safeParse({ email: "user@acme.test", password: "hunter2" }).success,
    false
  );
});

test("requestMagicLinkInputSchema lowercases mixed-case emails before they are persisted", () => {
  const result = requestMagicLinkInputSchema.safeParse({ email: "User@Acme.test" });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.email, "user@acme.test");
  }
});

test("createInviteInputSchema requires email, organizationId, and a valid role together", () => {
  const organizationId = "11111111-1111-4111-8111-111111111111";
  assert.equal(
    createInviteInputSchema.safeParse({
      email: "newhire@acme.test",
      organizationId,
      role: "recruiter"
    }).success,
    true
  );
  assert.equal(
    createInviteInputSchema.safeParse({ email: "newhire@acme.test", organizationId }).success,
    false,
    "missing role must be rejected, not defaulted"
  );
  assert.equal(
    createInviteInputSchema.safeParse({
      email: "newhire@acme.test",
      organizationId,
      role: "superadmin"
    }).success,
    false
  );
});

test("createInviteInputSchema's role set matches MEMBERSHIP_ROLES exactly", () => {
  for (const role of MEMBERSHIP_ROLES) {
    const result = createInviteInputSchema.safeParse({
      email: "newhire@acme.test",
      organizationId: "11111111-1111-4111-8111-111111111111",
      role
    });
    assert.equal(result.success, true, `role ${role} should be accepted`);
  }
});
