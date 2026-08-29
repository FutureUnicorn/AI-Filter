"""The structured evidence-item schema. Single source of truth for what a
finding looks like, in code and in the JSON Schema passed to the model.

Deliberately narrow: one criterion in, one evidence item out. No ranking,
no score, no recommendation field exists here on purpose — see
docs/PRODUCT_BOUNDARY.md before adding one.
"""

from dataclasses import dataclass
from enum import Enum


class EvidenceState(str, Enum):
    SUPPORTED = "supported"
    PARTIALLY_SUPPORTED = "partially_supported"
    CONTRADICTED = "contradicted"
    NOT_FOUND = "not_found"
    UNCLEAR = "unclear"
    EXTRACTION_ERROR = "extraction_error"
    # Never a state the model is asked to produce (see MODEL_FACING_STATES
    # below) -- assigned only by extract_evidence.py's own pre-model
    # prompt-injection scan, the same way packages/ai's
    # quarantineForInjection builds a "quarantined" outcome without the
    # model ever being consulted.
    QUARANTINED = "quarantined"


# The subset of EvidenceState the model's structured-output schema is
# allowed to return. QUARANTINED is deliberately excluded: it is decided
# before the model ever runs, never something a compromised or confused
# model call could produce on its own.
MODEL_FACING_STATES: tuple[EvidenceState, ...] = (
    EvidenceState.SUPPORTED,
    EvidenceState.PARTIALLY_SUPPORTED,
    EvidenceState.CONTRADICTED,
    EvidenceState.NOT_FOUND,
    EvidenceState.UNCLEAR,
    EvidenceState.EXTRACTION_ERROR,
)


@dataclass(frozen=True)
class Source:
    document: str
    page_or_section: str
    offset: int


@dataclass(frozen=True)
class EvidenceItem:
    criterion_id: str
    state: EvidenceState
    quote: str
    source: Source


# Strict JSON Schema for the model's structured output. additionalProperties
# is false everywhere on purpose: an extra field from the model is a bug to
# catch, not data to keep.
EVIDENCE_ITEM_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["criterion_id", "state", "quote", "source"],
    "properties": {
        "criterion_id": {"type": "string"},
        "state": {
            "type": "string",
            "enum": [s.value for s in MODEL_FACING_STATES],
        },
        "quote": {
            "type": "string",
            "description": (
                "Exact verbatim substring copied from the source document. "
                "Empty string only when state is not_found or extraction_error."
            ),
        },
        "source": {
            "type": "object",
            "additionalProperties": False,
            "required": ["document", "page_or_section", "offset"],
            "properties": {
                "document": {"type": "string"},
                "page_or_section": {"type": "string"},
                "offset": {"type": "integer"},
            },
        },
    },
}

EVIDENCE_RESPONSE_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["items"],
    "properties": {
        "items": {
            "type": "array",
            "items": EVIDENCE_ITEM_JSON_SCHEMA,
        }
    },
}
