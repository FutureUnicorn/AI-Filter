import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

import { REQUEST_ID_HEADER, metricSampleSchema } from "../../packages/contracts/src/index.ts";
import { createReviewTimeMetricFixture } from "../../packages/db/src/index.ts";
import { REVIEW_TIME_REDUCTION_MINIMUM_SAMPLE_SIZE } from "../../packages/domain/src/index.ts";
import { SESSION_COOKIE_NAME, createSessionToken } from "../../packages/security/src/index.ts";
import type { ReviewTimeMetricFixture } from "../../packages/db/src/index.ts";

// AF-55, and the finding that produced this file: the reduction was a
// pure function nothing called. Unit tests at both ends of a boundary
// prove nothing about the boundary, so this exercises the real route
// handler against real Postgres -- authorization, the baseline it
// accepts, the sample it refuses to report, and the payload it returns.
//
// The route imports its neighbours the way Next resolves them
// ("../../lib/session", no extension), which plain Node ESM will not
// resolve. The hook below adds the extension on the second attempt. It
// is the price of testing the actual shipped file rather than a copy of
// its body, which is exactly the substitution that let the gap open.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".")) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  }
});

const { GET } = await import(
  "../../apps/web/src/app/api/roles/[roleId]/metrics/review-time-reduction/route.ts"
);

const SESSION_SECRET = "review-time-reduction-route-test-secret";

function requestFor(url: string, token?: string): Parameters<typeof GET>[0] {
  const request = {
    nextUrl: new URL(url),
    cookies: {
      get(name: string): { name: string; value: string } | undefined {
        return name === SESSION_COOKIE_NAME && token !== undefined ? { name, value: token } : undefined;
      }
    }
  };
  return request as unknown as Parameters<typeof GET>[0];
}

interface CallOptions {
  readonly roleId: string;
  readonly userId?: string;
  readonly query?: string;
}

async function call(options: CallOptions): Promise<{ status: number; body: Record<string, unknown> }> {
  const query = options.query ?? "employerReportedMedianActiveMs=600000";
  const token = options.userId === undefined ? undefined : createSessionToken(options.userId, SESSION_SECRET);
  const response = await GET(
    requestFor(`http://localhost:3000/api/roles/${options.roleId}/metrics/review-time-reduction?${query}`, token),
    { params: Promise.resolve({ roleId: options.roleId }) }
  );
  assert.ok(response.headers.get(REQUEST_ID_HEADER), "every response carries its request id");
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function environment(fixture: ReviewTimeMetricFixture, databaseUrl: string): void {
  process.env.APP_ENV = "test";
  process.env.DEPLOYMENT_COMMIT_SHA = "local";
  process.env.DATABASE_URL = databaseUrl;
  process.env.DATABASE_SCHEMA = fixture.schema;
  process.env.STORAGE_ENDPOINT = "http://localhost:9000";
  process.env.STORAGE_REGION = "us-east-1";
  process.env.STORAGE_BUCKET = "signal-audit-test";
  process.env.STORAGE_ACCESS_KEY_ID = "test-access";
  process.env.STORAGE_SECRET_ACCESS_KEY = "test-secret-value";
  process.env.STORAGE_FORCE_PATH_STYLE = "true";
  process.env.WEB_PORT = "3000";
  process.env.WORKER_PORT = "3001";
  process.env.SESSION_SECRET = SESSION_SECRET;
}

test("the review-time reduction is reachable through an authenticated endpoint", async (t) => {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail("SIGNAL_AUDIT_RLS_DATABASE_URL must be set so CI exercises the metric endpoint against real Postgres");
  }
  const fixture = await createReviewTimeMetricFixture(databaseUrl);
  environment(fixture, databaseUrl);
  t.after(async () => {
    await fixture.drop();
  });

  await t.test("an auditor gets a MetricSample computed from the recorded spans", async () => {
    const { status, body } = await call({ roleId: fixture.roleId, userId: fixture.auditorUserId });
    assert.equal(status, 200);
    const parsed = metricSampleSchema.safeParse(body);
    assert.equal(parsed.success, true, `the payload must satisfy its own contract: ${JSON.stringify(body)}`);
    assert.equal(body.metric, "review_time_reduction");
    // Eleven applications at 300,000ms against a 600,000ms baseline.
    assert.equal(body.value, 0.5);
    assert.equal(body.sampleSize, 11);
    assert.equal(body.population, 12);
    assert.equal(body.minimumSampleSize, REVIEW_TIME_REDUCTION_MINIMUM_SAMPLE_SIZE);
  });

  await t.test("the twelfth, interrupted application is reported as an incomplete population", async () => {
    const { body } = await call({ roleId: fixture.roleId, userId: fixture.auditorUserId });
    const codes = (body.limitations as Array<{ code: string }>).map((limitation) => limitation.code);
    // Exhaustive, not `includes`: baseline_self_reported is now on every
    // response this route can produce, and an assertion that tolerated
    // extra codes would stop noticing if it disappeared.
    assert.deepEqual(codes, ["population_incomplete", "baseline_self_reported"]);
  });

  await t.test("every reportable baseline arrives labelled as the employer's own estimate", async () => {
    const { body } = await call({ roleId: fixture.roleId, userId: fixture.auditorUserId });
    const codes = (body.limitations as Array<{ code: string }>).map((limitation) => limitation.code);
    assert.ok(codes.includes("baseline_self_reported"), "the provenance of the baseline must survive the boundary");
  });

  await t.test("no request can obtain an unqualified metric by naming its own baseline source", async () => {
    // REV-002. The route used to read `source` from the query string, so
    // `baselineSource=measured_preassist` removed baseline_self_reported
    // and the reader lost the fact that the two sides of the comparison
    // were not measured the same way. Every spelling of that attempt is
    // swept here rather than the one that was reported, since the point
    // is that no query shape reaches an unlabelled value.
    for (const spoof of [
      "baselineSource=measured_preassist&employerReportedMedianActiveMs=600000",
      "baselineSource=employer_reported&employerReportedMedianActiveMs=600000",
      "baselineSource=MEASURED_PREASSIST&employerReportedMedianActiveMs=600000",
      "baselineSource=&employerReportedMedianActiveMs=600000",
      "employerReportedMedianActiveMs=600000&baselineSource=measured_preassist",
      "baselineSource=measured_preassist&baselineSource=employer_reported&employerReportedMedianActiveMs=600000",
      "baselineMedianActiveMs=600000&baselineSource=measured_preassist"
    ]) {
      const { status, body } = await call({ roleId: fixture.roleId, userId: fixture.auditorUserId, query: spoof });
      assert.equal(status, 400, `naming a baseline source must be refused, not honoured: "${spoof}"`);
      assert.equal((body.error as { code: string }).code, "invalid_request");
    }
  });

  await t.test("there is no query shape that yields a value without the self-reported caveat", async () => {
    // The property behind the sweep above: whatever a caller sends, a
    // reported value carries the caveat or there is no reported value.
    for (const query of [
      "employerReportedMedianActiveMs=600000",
      "employerReportedMedianActiveMs=600000&baselineSource=measured_preassist",
      "employerReportedMedianActiveMs=600000&source=measured_preassist",
      "employerReportedMedianActiveMs=600000&minimumSampleSize=1",
      "employerReportedMedianActiveMs=1"
    ]) {
      const { status, body } = await call({ roleId: fixture.roleId, userId: fixture.auditorUserId, query });
      if (status !== 200) {
        continue;
      }
      const codes = (body.limitations as Array<{ code: string }>).map((limitation) => limitation.code);
      assert.ok(
        body.value === null || codes.includes("baseline_self_reported"),
        `a value crossed the boundary unqualified for "${query}": ${JSON.stringify(body)}`
      );
    }
  });

  await t.test("a role below the minimum sample returns no value over the wire", async () => {
    const { status, body } = await call({ roleId: fixture.sparseRoleId, userId: fixture.auditorUserId });
    assert.equal(status, 200);
    assert.equal(body.value, null, "two applications cannot support the product's headline number");
    const codes = (body.limitations as Array<{ code: string }>).map((limitation) => limitation.code);
    assert.ok(codes.includes("below_minimum_sample"));
  });

  await t.test("the minimum sample cannot be lowered by the caller", async () => {
    // Suppression a request can switch off is not suppression.
    const { body } = await call({
      roleId: fixture.sparseRoleId,
      userId: fixture.auditorUserId,
      query: "employerReportedMedianActiveMs=600000&minimumSampleSize=1"
    });
    assert.equal(body.minimumSampleSize, REVIEW_TIME_REDUCTION_MINIMUM_SAMPLE_SIZE);
    assert.equal(body.value, null);
  });

  await t.test("the payload carries no candidate, application or reviewer identifier", async () => {
    // POL-003 allows a mechanical metric about system processing and
    // forbids anything that reads as a statement about candidates. AF-54
    // adds the reviewer half: this is a product baseline, not a
    // performance-management feed.
    const { body } = await call({ roleId: fixture.roleId, userId: fixture.auditorUserId });
    const serialized = JSON.stringify(body);
    for (const forbidden of ["candidate", "application_id", "applicationId", "reviewer", fixture.recruiterUserId]) {
      assert.equal(serialized.includes(forbidden), false, `the metric payload must not carry ${forbidden}`);
    }
  });

  await t.test("a recruiter cannot read the measurement of their own review time", async () => {
    const { status, body } = await call({ roleId: fixture.roleId, userId: fixture.recruiterUserId });
    assert.equal(status, 403);
    assert.equal((body.error as { code: string }).code, "forbidden");
  });

  await t.test("an unauthenticated request is rejected before anything is read", async () => {
    const { status, body } = await call({ roleId: fixture.roleId });
    assert.equal(status, 401);
    assert.equal((body.error as { code: string }).code, "unauthorized");
  });

  await t.test("a member of another tenant gets not_found, not forbidden", async () => {
    // Confirming the role exists would leak that this organization has one.
    const { status, body } = await call({ roleId: fixture.roleId, userId: fixture.outsiderUserId });
    assert.equal(status, 404);
    assert.equal((body.error as { code: string }).code, "not_found");
  });

  await t.test("an auditor cannot point the endpoint at a sibling tenant's role", async () => {
    const { status } = await call({ roleId: fixture.otherOrganizationRoleId, userId: fixture.auditorUserId });
    assert.equal(status, 404);
  });

  await t.test("a missing, zero or unparseable baseline is a 400, never a 500", async () => {
    // contracts rejects these before describeReviewTimeReduction can
    // throw on them: a zero baseline is a caller error, and a caller
    // error that surfaces as an internal error is unactionable.
    for (const query of [
      "",
      "employerReportedMedianActiveMs=",
      "employerReportedMedianActiveMs=0",
      "employerReportedMedianActiveMs=-600000",
      "employerReportedMedianActiveMs=fifteen%20minutes",
      "baselineMedianActiveMs=600000"
    ]) {
      const { status, body } = await call({ roleId: fixture.roleId, userId: fixture.auditorUserId, query });
      assert.equal(status, 400, `expected 400 for "${query}"`);
      assert.equal((body.error as { code: string }).code, "invalid_request");
    }
  });
});
