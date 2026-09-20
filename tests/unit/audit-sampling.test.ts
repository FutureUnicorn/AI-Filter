import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_SCHEMA_VERSION,
  selectAuditSample,
  summarizeEvidenceStrength
} from "../../packages/domain/src/index.ts";
import type { AuditSampleCandidate, EvidenceCard } from "../../packages/domain/src/index.ts";

// AF-52: "Randomly sample low-ranked/low-evidence candidates for
// independent review -- this is how false negatives get caught, not by
// trusting the model's confidence."

const citation = { document: "cv.pdf", pageOrSection: "Skills", offset: 1, quote: "Ran Postgres." };

function card(criterionId: string, verifiable: boolean): EvidenceCard {
  return verifiable
    ? {
        criterionId,
        kind: "supported",
        citations: [{ role: "supporting", citation }],
        verifiable: true,
        recordedAt: "2026-08-29T10:00:00.000Z"
      }
    : {
        criterionId,
        kind: "not_found",
        citations: [],
        verifiable: false,
        explanation: "No relevant material was found.",
        recordedAt: "2026-08-29T10:00:00.000Z"
      };
}

test("an application with no citable evidence at all is 'none'", () => {
  const summary = summarizeEvidenceStrength([card("a", false), card("b", false)]);
  assert.equal(summary.strength, "none");
  assert.equal(summary.citedCount, 0);
  assert.equal(summary.uncitedCount, 2);
});

test("half or fewer criteria cited is 'weak'; a clear majority is 'cited'", () => {
  assert.equal(summarizeEvidenceStrength([card("a", true), card("b", false)]).strength, "weak");
  assert.equal(
    summarizeEvidenceStrength([card("a", true), card("b", true), card("c", false)]).strength,
    "cited"
  );
});

test("the counts always partition the criteria", () => {
  const summary = summarizeEvidenceStrength([card("a", true), card("b", false), card("c", false)]);
  assert.equal(summary.citedCount + summary.uncitedCount, summary.totalCriteria);
});

const population: readonly AuditSampleCandidate[] = [
  { applicationId: "app-01", strength: "none" },
  { applicationId: "app-02", strength: "weak" },
  { applicationId: "app-03", strength: "cited" },
  { applicationId: "app-04", strength: "none" },
  { applicationId: "app-05", strength: "cited" },
  { applicationId: "app-06", strength: "weak" }
];

test("well-evidenced candidates are never sampled: the pool is the low-evidence ones", () => {
  const selection = selectAuditSample(population, "seed-1", 4);
  assert.equal(selection.eligibleCount, 4);
  for (const id of selection.sampledApplicationIds) {
    assert.ok(["app-01", "app-02", "app-04", "app-06"].includes(id), `${id} should not be eligible`);
  }
});

test("the same seed and population always give the same draw", () => {
  // The property the whole feature rests on. A sample nobody can
  // reproduce cannot be audited.
  const first = selectAuditSample(population, "seed-1", 2);
  const second = selectAuditSample([...population].reverse(), "seed-1", 2);
  assert.deepEqual(first.sampledApplicationIds, second.sampledApplicationIds);
});

test("a different seed gives a different draw, so the seed is doing the work", () => {
  // Without this, "deterministic" could be satisfied by returning the
  // first N in input order and ignoring the seed entirely.
  const seeds = ["seed-1", "seed-2", "seed-3", "seed-4"];
  const draws = new Set(seeds.map((seed) => selectAuditSample(population, seed, 2).sampledApplicationIds.join(",")));
  assert.ok(draws.size > 1, `every seed produced the same draw: ${[...draws]}`);
});

test("asking for more than are eligible returns all of them, not an error", () => {
  const selection = selectAuditSample(population, "seed-1", 99);
  assert.equal(selection.sampledApplicationIds.length, 4);
});

test("asking for none, or having none eligible, returns an empty draw", () => {
  assert.deepEqual(selectAuditSample(population, "seed-1", 0).sampledApplicationIds, []);
  const allCited = population.map((candidate) => ({ ...candidate, strength: "cited" as const }));
  const selection = selectAuditSample(allCited, "seed-1", 3);
  assert.equal(selection.eligibleCount, 0);
  assert.deepEqual(selection.sampledApplicationIds, []);
});

test("nothing in the selection consults a score, because there is no score to consult", () => {
  // POL-003: the candidate shape carries an id and an evidence KIND and
  // nothing else. If a numeric field ever appears here, someone will
  // sort by it and it becomes a rank in all but name.
  const keys = new Set(Object.keys(population[0] as object));
  assert.deepEqual([...keys].sort(), ["applicationId", "strength"]);
  const selection = selectAuditSample(population, "seed-1", 2);
  assert.deepEqual(Object.keys(selection).sort(), ["eligibleCount", "sampledApplicationIds", "seed"]);
});

test("the draw is reported with its seed, so a reader can re-run it", () => {
  assert.equal(selectAuditSample(population, "audit-2026-08", 2).seed, "audit-2026-08");
});

test("the input array is not mutated by sorting", () => {
  const order = population.map((candidate) => candidate.applicationId);
  selectAuditSample(population, "seed-1", 3);
  assert.deepEqual(population.map((candidate) => candidate.applicationId), order);
});

test("the evidence card shape the reviewer sees is the shape the sampler judges", () => {
  // The sampler must not develop its own private notion of "low
  // evidence", or a candidate could be sampled for a reason the
  // reviewer cannot see on the card in front of them.
  const cards = [card("a", false), card("b", true)];
  const summary = summarizeEvidenceStrength(cards);
  assert.equal(summary.citedCount, cards.filter((entry) => entry.verifiable).length);
  assert.equal(CONTRACT_SCHEMA_VERSION, "1.0.0");
});
