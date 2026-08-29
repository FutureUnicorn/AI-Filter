import assert from "node:assert/strict";
import test from "node:test";

import { MEMBERSHIP_ROLES } from "../../packages/domain/src/index.ts";

test("MEMBERSHIP_ROLES is exactly the four roles named in the AF-15 ticket, no duplicates", () => {
  assert.equal(MEMBERSHIP_ROLES.length, new Set(MEMBERSHIP_ROLES).size);
  assert.deepEqual(new Set(MEMBERSHIP_ROLES), new Set(["owner", "admin", "recruiter", "auditor"]));
});
