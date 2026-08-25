import assert from "node:assert/strict";
import test from "node:test";

import { scanCriterionForProtectedCharacteristicProxy } from "../../packages/domain/src/index.ts";

const KNOWN_PROXY_SAMPLES: readonly { readonly label: string; readonly text: string }[] = [
  { label: "age: digital native", text: "Looking for a digital native who picks up new tools fast." },
  { label: "age: recent grad only", text: "Recent graduates only, please." },
  { label: "age: under N", text: "Ideal candidate is under 30." },
  { label: "national origin: native speaker", text: "Must be a native English speaker." },
  { label: "gender: he must", text: "He must be willing to travel 50% of the time." },
  { label: "disability: able-bodied", text: "Requires an able-bodied person for warehouse work." },
  { label: "family status: no children preferred", text: "No children preferred due to travel demands." }
];

const LEGITIMATE_CRITERION_SAMPLES: readonly { readonly label: string; readonly text: string }[] = [
  { label: "ordinary experience requirement", text: "5+ years of backend engineering experience." },
  { label: "ordinary skill requirement", text: "Comfortable writing SQL against a Postgres database." },
  { label: "ordinary travel requirement", text: "Occasional travel to client sites, roughly quarterly." },
  { label: "language as a job skill, not identity", text: "Professional working proficiency in written English." }
];

for (const sample of KNOWN_PROXY_SAMPLES) {
  test(`flags known protected-characteristic proxy: ${sample.label}`, () => {
    const flags = scanCriterionForProtectedCharacteristicProxy(sample.text);
    assert.ok(flags.length > 0, `expected a flag for: ${sample.text}`);
  });
}

for (const sample of LEGITIMATE_CRITERION_SAMPLES) {
  test(`does not false-positive on an ordinary criterion: ${sample.label}`, () => {
    assert.deepEqual(scanCriterionForProtectedCharacteristicProxy(sample.text), []);
  });
}

test("a criterion tripping more than one category reports every match", () => {
  const flags = scanCriterionForProtectedCharacteristicProxy(
    "Looking for a digital native who is a native English speaker."
  );
  const categories = flags.map((flag) => flag.category);
  assert.ok(categories.includes("age"));
  assert.ok(categories.includes("national_origin_or_language"));
});
