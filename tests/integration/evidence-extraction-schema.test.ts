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

interface SchemaNode {
  readonly type?: string | readonly string[];
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly properties?: Record<string, SchemaNode>;
}

const conflictingSide = {
  quote: "Left the role in 2019.",
  source: { document: "resume.txt", page_or_section: "History", offset: 40 }
};

test("every EVIDENCE_EXTRACTION_STATES value parses as a valid item", () => {
  for (const state of EVIDENCE_EXTRACTION_STATES) {
    // contradicted is the one citing state that needs a second citation:
    // AF-13's ContradictedEvidence requires both sides, so an item with
    // one quote cannot become a persistable outcome.
    const item =
      state === "not_found"
        ? { ...notFoundItem, state }
        : state === "contradicted"
          ? { ...citingItem, state, conflicting: conflictingSide }
          : { ...citingItem, state };
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
  assert.deepEqual(
    new Set(item.required),
    new Set(["criterion_id", "state", "quote", "source", "conflicting"]),
    "strict mode requires every property to be listed, including the null-union conflicting side"
  );
  const conflicting = (item.properties as Record<string, SchemaNode>).conflicting;
  assert.ok(conflicting?.properties?.source, "the conflicting side declares a nested source");
  assert.equal(conflicting.additionalProperties, false, "the conflicting side is an object level too");
  assert.equal(conflicting.properties.source.additionalProperties, false, "and so is its nested source");
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

/**
 * Constrained only when state is contradicted. Same reason the list above
 * exists -- strict mode cannot express "required for one enum value" -- but
 * kept separate so the distinction stays visible: these are absent for
 * every state except one, rather than present-but-unconstrained.
 */
const CONDITIONAL_ON_CONTRADICTED = ["conflicting.quote", "conflicting.source"] as const;

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
  const classified = new Set<string>([
    ...UNCONDITIONALLY_NON_EMPTY,
    ...CONDITIONALLY_CONSTRAINED,
    ...CONDITIONAL_ON_CONTRADICTED,
    "state"
  ]);
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

// ---- a contradiction has two sides ----
//
// AF-13's review made ContradictedEvidence require BOTH `citation` and
// `conflictingCitation`. This schema supplied one quote, so a contradicted
// item could never map to a persistable outcome -- `contradicted` was an
// unreachable kind no matter what the model returned, and AF-36 had to
// route every one of them to a retryable extraction_error that could never
// succeed on retry. These tests pin the second side.

const SOURCE = { document: "cv.pdf", page_or_section: "Experience", offset: 0 };
const CONFLICTING = {
  quote: "Left the role in 2019.",
  source: { document: "cv.pdf", page_or_section: "History", offset: 40 }
};
const contradicted = (over = {}) => ({
  criterion_id: "python_production",
  state: "contradicted",
  quote: "Still in the role as of 2026.",
  source: SOURCE,
  conflicting: CONFLICTING,
  ...over
});

test("a contradicted item carries both sides of the conflict", () => {
  assert.equal(evidenceExtractionItemSchema.safeParse(contradicted()).success, true);
});

test("a contradicted item without the conflicting side is rejected", () => {
  // Was previously accepted, and produced an outcome that could not be
  // persisted -- the failure surfaced far downstream in AF-36's mapper
  // instead of here where the shape is decided.
  const withoutIt: Record<string, unknown> = { ...contradicted() };
  delete withoutIt.conflicting;
  const missing = evidenceExtractionItemSchema.safeParse(withoutIt);
  assert.equal(missing.success, false);
  assert.match(missing.error?.issues[0]?.message ?? "", /contradiction has two sides/);
  assert.equal(evidenceExtractionItemSchema.safeParse(contradicted({ conflicting: null })).success, false);
});

test("the conflicting side gets the same coordinate rules as the primary citation", () => {
  // Otherwise a contradicted outcome fails sourceCitationSchema for a
  // second, subtler reason after passing this validator.
  for (const bad of [
    { ...CONFLICTING, quote: "   " },
    { ...CONFLICTING, source: { ...CONFLICTING.source, page_or_section: "" } },
    { ...CONFLICTING, source: { ...CONFLICTING.source, offset: -1 } }
  ]) {
    assert.equal(evidenceExtractionItemSchema.safeParse(contradicted({ conflicting: bad })).success, false);
  }
});

test("only a contradiction may carry a conflicting side", () => {
  // A supported item with a second citation would be evidence a reviewer
  // was meant to see that nothing downstream reads.
  const smuggled = evidenceExtractionItemSchema.safeParse({
    criterion_id: "python_production",
    state: "supported",
    quote: "Built and ran the service.",
    source: SOURCE,
    conflicting: CONFLICTING
  });
  assert.equal(smuggled.success, false);
  assert.match(smuggled.error?.issues[0]?.message ?? "", /only state contradicted/);
});

test("the model-facing schema asks for the conflicting side as a null union", () => {
  // strict: true cannot express "omit this key sometimes", so optionality
  // is spelled as a null union with the key always required.
  const item = (EVIDENCE_EXTRACTION_JSON_SCHEMA as unknown as { properties: { items: { items: SchemaNode } } })
    .properties.items.items;
  assert.ok(item.required?.includes("conflicting"), "strict mode requires every property to be listed");
  const conflicting = item.properties?.conflicting;
  assert.ok(conflicting, "the conflicting side is declared in the model-facing schema");
  assert.deepEqual(conflicting.type, ["object", "null"]);
  assert.equal(conflicting.additionalProperties, false);
});
