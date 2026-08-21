import assert from "node:assert/strict";
import test from "node:test";

import {
  EVIDENCE_EXTRACTION_JSON_SCHEMA,
  EVIDENCE_EXTRACTION_STATES,
  evidenceExtractionItemSchema,
  evidenceExtractionResponseSchema
} from "../../packages/ai/src/index.ts";

const citingItem = {
  criterion_id: "python_production",
  state: "supported",
  quote: "Built and maintained Python microservices processing 2M+ events/day.",
  source: { document: "resume.txt", page_or_section: "Experience", offset: 0 }
};

const notFoundItem = {
  criterion_id: "aws_certification",
  state: "not_found",
  quote: "",
  source: { document: "resume.txt", page_or_section: "", offset: -1 }
};

test("every EVIDENCE_EXTRACTION_STATES value parses as a valid item", () => {
  for (const state of EVIDENCE_EXTRACTION_STATES) {
    const item = state === "not_found" ? { ...notFoundItem, state } : { ...citingItem, state };
    const result = evidenceExtractionItemSchema.safeParse(item);
    assert.equal(result.success, true, `state ${state} should be accepted`);
  }
});

test("a system-assigned state (citation_invalid) is not a valid model-facing state", () => {
  const result = evidenceExtractionItemSchema.safeParse({ ...citingItem, state: "citation_invalid" });
  assert.equal(result.success, false);
});

test("a pipeline state (extraction_error) is not a valid model-facing state either", () => {
  const result = evidenceExtractionItemSchema.safeParse({ ...citingItem, state: "extraction_error" });
  assert.equal(result.success, false);
});

test("not_found with a non-empty quote is rejected", () => {
  const result = evidenceExtractionItemSchema.safeParse({ ...notFoundItem, quote: "some text" });
  assert.equal(result.success, false);
});

test("a citing state with an empty quote is rejected", () => {
  const result = evidenceExtractionItemSchema.safeParse({ ...citingItem, quote: "" });
  assert.equal(result.success, false);
});

test("an unrecognized property on an item is rejected", () => {
  const result = evidenceExtractionItemSchema.safeParse({ ...citingItem, confidence: 0.9 });
  assert.equal(result.success, false);
});

test("evidenceExtractionResponseSchema validates a full items array", () => {
  const result = evidenceExtractionResponseSchema.safeParse({ items: [citingItem, notFoundItem] });
  assert.equal(result.success, true);
});

test("EVIDENCE_EXTRACTION_JSON_SCHEMA sets additionalProperties:false at every object level", () => {
  const root = EVIDENCE_EXTRACTION_JSON_SCHEMA as {
    additionalProperties: boolean;
    properties: {
      items: {
        items: {
          additionalProperties: boolean;
          required: string[];
          properties: { source: { additionalProperties: boolean; required: string[] } };
        };
      };
    };
  };
  assert.equal(root.additionalProperties, false);
  const item = root.properties.items.items;
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(new Set(item.required), new Set(["criterion_id", "state", "quote", "source"]));
  assert.equal(item.properties.source.additionalProperties, false);
  assert.deepEqual(new Set(item.properties.source.required), new Set(["document", "page_or_section", "offset"]));
});

test("EVIDENCE_EXTRACTION_JSON_SCHEMA's state enum matches EVIDENCE_EXTRACTION_STATES exactly", () => {
  const root = EVIDENCE_EXTRACTION_JSON_SCHEMA as {
    properties: { items: { items: { properties: { state: { enum: readonly string[] } } } } };
  };
  const stateEnum = root.properties.items.items.properties.state.enum;
  assert.deepEqual(new Set(stateEnum), new Set(EVIDENCE_EXTRACTION_STATES));
});
