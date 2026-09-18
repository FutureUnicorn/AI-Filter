import assert from "node:assert/strict";
import test from "node:test";

import { assertConnectionsAreReused } from "../../packages/db/src/index.ts";

/**
 * PR #83 review: every function in packages/db opened its own `Client`, so one
 * request that called getRoleById, getMembershipsForUser, getApplicationById
 * and recordCandidateDecision paid four TCP, TLS and authentication handshakes
 * in sequence and left four Postgres backends to start and stop.
 *
 * The risk in fixing it is a pool that exists but is not actually reused: a
 * pool acquired and ended per call looks like pooling at the call site and
 * behaves exactly like the defect. So this measures reuse rather than
 * inspecting the code, from Postgres' own counters.
 */
test("sequential database calls share one connection", async () => {
  const databaseUrl = process.env.SIGNAL_AUDIT_RLS_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    assert.fail("SIGNAL_AUDIT_RLS_DATABASE_URL must be set so connection reuse is measured against real Postgres");
  }
  const observed = await assertConnectionsAreReused(databaseUrl);

  // One backend served all of them. Before pooling this equalled the call
  // count exactly.
  assert.equal(
    observed.distinctBackends,
    1,
    `${observed.calls} sequential calls must share one backend, saw ${observed.distinctBackends}`
  );

  // The independent check, from Postgres' own session counter rather than from
  // which backend answered. A pool that reconnects per call would show the
  // same PID only by luck, but cannot hide the sessions.
  assert.equal(
    observed.sessionsEstablished,
    1,
    `${observed.calls} sequential calls must establish one session, saw ${observed.sessionsEstablished}`
  );

  // The control, in the same run: checkDatabaseConnection is deliberately
  // unpooled, because a liveness probe answering from a warm pooled connection
  // reports the pool's health and not the database's. It must still open its
  // own session -- otherwise the measurement above cannot see a new connection
  // at all, and would report reuse even for code that pools nothing.
  assert.equal(
    observed.healthCheckSessions,
    1,
    "the unpooled health check must still open its own session, or this measurement proves nothing"
  );
});
