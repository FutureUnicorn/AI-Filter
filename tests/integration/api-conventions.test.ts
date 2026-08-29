import assert from "node:assert/strict";
import test from "node:test";

import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  REQUEST_ID_HEADER,
  apiErrorBodySchema,
  buildApiError,
  checkIdempotencyRequirement,
  generateRequestId,
  idempotencyErrorResponse,
  idempotencyKeySchema,
  requestIdSchema,
  withRequestId
} from "../../packages/contracts/src/index.ts";

test("generateRequestId produces a value that satisfies requestIdSchema", () => {
  const requestId = generateRequestId();
  assert.equal(requestIdSchema.safeParse(requestId).success, true);
  assert.match(requestId, /^req_/);
});

test("requestIdSchema rejects ids without the req_ prefix or a malformed uuid", () => {
  assert.equal(requestIdSchema.safeParse(crypto.randomUUID()).success, false);
  assert.equal(requestIdSchema.safeParse("req_not-a-uuid").success, false);
});

test("withRequestId sets the header without disturbing existing headers", () => {
  const requestId = generateRequestId();
  const headers = withRequestId({ "content-type": "application/json" }, requestId);
  assert.equal(headers.get(REQUEST_ID_HEADER), requestId);
  assert.equal(headers.get("content-type"), "application/json");
});

test("withRequestId refuses a malformed request id instead of emitting a contract-invalid header", () => {
  // `RequestId` is a plain alias, so the compiler cannot stop this; a
  // caller propagating an untrusted inbound X-Request-Id must fail here
  // rather than emit a header that fails requestIdSchema.
  for (const malformed of ["bad", "", "req_not-a-uuid", crypto.randomUUID()]) {
    assert.throws(
      () => withRequestId({}, malformed),
      /withRequestId requires a well-formed RequestId/,
      `expected withRequestId to reject ${JSON.stringify(malformed)}`
    );
  }
});

test("every API_ERROR_CODES entry has exactly one status in API_ERROR_STATUS", () => {
  assert.deepEqual(new Set(Object.keys(API_ERROR_STATUS)), new Set(API_ERROR_CODES));
});

test("buildApiError produces a payload that validates and matches its status table", () => {
  const requestId = generateRequestId();
  const { status, body } = buildApiError({
    requestId,
    code: "not_found",
    message: "Case not found."
  });
  assert.equal(status, API_ERROR_STATUS.not_found);
  assert.equal(apiErrorBodySchema.safeParse(body).success, true);
  assert.equal(body.error.details, undefined);
});

test("buildApiError carries optional details through when provided", () => {
  const { body } = buildApiError({
    requestId: generateRequestId(),
    code: "invalid_request",
    message: "Bad payload.",
    details: { field: "criterionId" }
  });
  assert.deepEqual(body.error.details, { field: "criterionId" });
});

test("buildApiError rejects a non-finite details value that would serialize to a different value", () => {
  // TypeScript's `number` admits Infinity/NaN, so these calls type-check
  // fully. Left unchecked they produced a body that failed the very
  // apiErrorBodySchema this function advertises, and JSON.stringify
  // turned them into `null` -- a silently changed value, not a rejection.
  for (const nonFinite of [Infinity, -Infinity, NaN]) {
    assert.throws(
      () =>
        buildApiError({
          requestId: generateRequestId(),
          code: "internal_error",
          message: "Something broke.",
          details: { count: nonFinite }
        }),
      /buildApiError produced a body that fails apiErrorBodySchema/,
      `expected buildApiError to reject details: { count: ${String(nonFinite)} }`
    );
  }
});

test("buildApiError rejects negative zero, which is finite but does not round-trip through JSON", () => {
  // -0 slips past a plain `.finite()` check because it genuinely is
  // finite, yet `JSON.stringify(-0)` emits `0`: the value handed in is
  // not the value that comes back out, which is the exact invariant this
  // schema exists to enforce.
  assert.equal(JSON.stringify(-0), "0");
  assert.equal(Object.is(-0, 0), false);
  assert.throws(
    () =>
      buildApiError({
        requestId: generateRequestId(),
        code: "internal_error",
        message: "Something broke.",
        details: { delta: -0 }
      }),
    /buildApiError produced a body that fails apiErrorBodySchema/
  );
});

test("every accepted details value survives a JSON round trip unchanged", () => {
  // The general property the individual rejections above are protecting:
  // whatever buildApiError accepts must come back out of JSON identical.
  const details = { count: 42, ratio: -0.5, zero: 0, nested: { list: [1, 2, 3], flag: true, empty: null } };
  const { body } = buildApiError({
    requestId: generateRequestId(),
    code: "invalid_request",
    message: "Bad payload.",
    details
  });
  assert.deepEqual(JSON.parse(JSON.stringify(body)), body);
});

test("buildApiError still accepts ordinary finite and nested JSON details", () => {
  const details = { count: 42, ratio: -0.5, nested: { list: [1, 2, 3], flag: true, empty: null } };
  const { body } = buildApiError({
    requestId: generateRequestId(),
    code: "invalid_request",
    message: "Bad payload.",
    details
  });
  assert.deepEqual(body.error.details, details);
  assert.equal(apiErrorBodySchema.safeParse(body).success, true);
});

test("apiErrorBodySchema rejects an unrecognized top-level property", () => {
  const { body } = buildApiError({
    requestId: generateRequestId(),
    code: "internal_error",
    message: "Something broke."
  });
  const result = apiErrorBodySchema.safeParse({ ...body, retryAfterMs: 500 });
  assert.equal(result.success, false);
});

test("apiErrorBodySchema rejects an unrecognized property inside error", () => {
  const { body } = buildApiError({
    requestId: generateRequestId(),
    code: "internal_error",
    message: "Something broke."
  });
  const result = apiErrorBodySchema.safeParse({
    ...body,
    error: { ...body.error, recommendedAction: "retry" }
  });
  assert.equal(result.success, false);
});

test("GET and HEAD never require an Idempotency-Key", () => {
  assert.deepEqual(checkIdempotencyRequirement("GET", null), { required: false });
  assert.deepEqual(checkIdempotencyRequirement("HEAD", "anything"), { required: false });
});

test("mutating methods without a header are missing, not silently allowed", () => {
  const result = checkIdempotencyRequirement("POST", null);
  assert.deepEqual(result, { required: true, outcome: "missing" });
});

test("mutating methods are recognized case-insensitively", () => {
  const result = checkIdempotencyRequirement("post", "abc-123");
  assert.equal(result.required, true);
  assert.equal(result.required && result.outcome, "present");
});

test("an invalid Idempotency-Key is distinguished from a missing one", () => {
  const result = checkIdempotencyRequirement("PUT", "has a space");
  assert.equal(result.required, true);
  assert.equal(result.required && result.outcome, "invalid");
  assert.equal(idempotencyKeySchema.safeParse("has a space").success, false);
});

test("an explicitly empty Idempotency-Key header is invalid, not missing", () => {
  // Headers.get() returns "" for a header the caller actually sent
  // empty, distinct from null for a header never sent at all -- these
  // are different mistakes and must not collapse into the same outcome.
  const result = checkIdempotencyRequirement("PUT", "");
  assert.equal(result.required, true);
  assert.equal(result.required && result.outcome, "invalid");
});

test("a well-formed Idempotency-Key is echoed back exactly", () => {
  const result = checkIdempotencyRequirement("DELETE", "retry-2026-08-21_1");
  assert.deepEqual(result, { required: true, outcome: "present", key: "retry-2026-08-21_1" });
});

test("idempotencyErrorResponse is undefined when the check passes or does not apply", () => {
  const requestId = generateRequestId();
  assert.equal(idempotencyErrorResponse({ required: false }, requestId), undefined);
  assert.equal(
    idempotencyErrorResponse({ required: true, outcome: "present", key: "k" }, requestId),
    undefined
  );
});

test("idempotencyErrorResponse maps missing and invalid to distinct, consistent-shape errors", () => {
  const requestId = generateRequestId();

  const missing = idempotencyErrorResponse({ required: true, outcome: "missing" }, requestId);
  assert.equal(missing?.status, API_ERROR_STATUS.missing_idempotency_key);
  assert.equal(missing?.body.error.code, "missing_idempotency_key");
  assert.equal(apiErrorBodySchema.safeParse(missing?.body).success, true);

  const invalid = idempotencyErrorResponse(
    { required: true, outcome: "invalid", reason: "too long" },
    requestId
  );
  assert.equal(invalid?.status, API_ERROR_STATUS.invalid_request);
  assert.match(invalid?.body.error.message ?? "", /too long/);
});
