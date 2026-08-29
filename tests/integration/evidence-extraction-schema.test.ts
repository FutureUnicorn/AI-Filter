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

test("a citing state with a whitespace-only quote is rejected", () => {
  const result = evidenceExtractionItemSchema.safeParse({ ...citingItem, quote: "   " });
  assert.equal(result.success, false);
});

test("a citing state with an empty page_or_section is rejected", () => {
  const result = evidenceExtractionItemSchema.safeParse({
    ...citingItem,
    source: { ...citingItem.source, page_or_section: "" }
  });
  assert.equal(result.success, false);
});

test("a citing state with a negative offset is rejected", () => {
  const result = evidenceExtractionItemSchema.safeParse({
    ...citingItem,
    source: { ...citingItem.source, offset: -1 }
  });
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

test("EVIDENCE_EXTRACTION_JSON_SCHEMA enforces the non-empty criterion_id constraint used by the Zod validator", () => {
  const root = EVIDENCE_EXTRACTION_JSON_SCHEMA as {
    properties: {
      items: {
        items: {
          properties: { criterion_id: { minLength: number } };
        };
      };
    };
  };
  assert.equal(root.properties.items.items.properties.criterion_id.minLength, 1);
});

test("EVIDENCE_EXTRACTION_JSON_SCHEMA's state enum matches EVIDENCE_EXTRACTION_STATES exactly", () => {
  const root = EVIDENCE_EXTRACTION_JSON_SCHEMA as {
    properties: { items: { items: { properties: { state: { enum: readonly string[] } } } } };
  };
  const stateEnum = root.properties.items.items.properties.state.enum;
  assert.deepEqual(new Set(stateEnum), new Set(EVIDENCE_EXTRACTION_STATES));
});

// ---- AF-35 review: the schema the model sees must not permit what the
// validator will reject ----
//
// A divergence here is not a type error, it is a wasted call: the
// provider is asked for a shape that then fails post-parse validation,
// and the model is never told what it did wrong.
//
// The list below is written out rather than derived from the Zod schema
// because Zod's introspection does not distinguish "min(1) always" from
// "min(1) only when state is citing", and that distinction is the whole
// point: OpenAI's strict mode cannot express a conditional, so a field
// that is only sometimes required must stay unconstrained in the
// model-facing schema and be enforced at parse time instead.

const SCHEMA_ITEM_PROPERTIES = (
  (EVIDENCE_EXTRACTION_JSON_SCHEMA as Record<string, never>).properties as unknown as {
    items: { items: { properties: Record<string, { type?: string; minLength?: number; properties?: Record<string, { type?: string; minLength?: number }> }> } };
  }
).items.items.properties;

/** Non-empty in the validator no matter what state the item carries. */
const UNCONDITIONALLY_NON_EMPTY = ["criterion_id", "source.document"] as const;

/** Constrained only for citing states, so the flat schema cannot say it. */
const CONDITIONALLY_CONSTRAINED = ["quote", "source.page_or_section", "source.offset"] as const;

function schemaFor(path: string): { type?: string; minLength?: number } | undefined {
  const [head, tail] = path.split(".");
  const top = SCHEMA_ITEM_PROPERTIES[head ?? ""];
  return tail === undefined ? top : top?.properties?.[tail];
}

test("every unconditionally non-empty field is also non-empty in the schema the model sees", () => {
  // source.document was missing this after criterion_id was fixed --
  // the same divergence, one field over, in the same object.
  for (const path of UNCONDITIONALLY_NON_EMPTY) {
    assert.equal(
      schemaFor(path)?.minLength,
      1,
      `${path} is required non-empty by the validator, so the model-facing schema must say minLength: 1`
    );
  }
});

test("every string field in the schema is accounted for, so a new one cannot slip through unclassified", () => {
  // The half that catches the NEXT field rather than the last one. A
  // property added to the schema and to neither list fails here, which
  // forces the author to decide which kind it is.
  const classified = new Set<string>([...UNCONDITIONALLY_NON_EMPTY, ...CONDITIONALLY_CONSTRAINED, "state"]);
  const paths: string[] = [];
  for (const [key, value] of Object.entries(SCHEMA_ITEM_PROPERTIES)) {
    if (value.properties === undefined) {
      paths.push(key);
      continue;
    }
    for (const nested of Object.keys(value.properties)) {
      paths.push(`${key}.${nested}`);
    }
  }
  const unclassified = paths.filter((path) => !classified.has(path));
  assert.deepEqual(
    unclassified,
    [],
    `these schema fields are neither unconditionally non-empty nor conditionally constrained: ${unclassified.join(", ")}`
  );
});

test("a conditionally-constrained field stays unconstrained in the schema, and is caught at parse time", () => {
  // The negative half. Adding minLength to quote would make the model
  // unable to return a valid not_found item at all.
  for (const path of CONDITIONALLY_CONSTRAINED) {
    assert.equal(
      schemaFor(path)?.minLength,
      undefined,
      `${path} is only required for citing states; strict mode cannot express that, so the schema must stay silent`
    );
  }
  const notFound = evidenceExtractionItemSchema.safeParse({
    criterion_id: "c",
    state: "not_found",
    quote: "",
    source: { document: "cv.pdf", page_or_section: "", offset: -1 }
  });
  assert.equal(notFound.success, true, "a not_found item with no citation coordinates is legitimate");
});
