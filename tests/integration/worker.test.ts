import assert from "node:assert/strict";
import test from "node:test";

import { startWorker } from "../../apps/worker/src/index.ts";

test("worker starts without external credentials", () => {
  assert.equal(
    startWorker(),
    "Signal Audit worker ready; dependency center=domain"
  );
});
