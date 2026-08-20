"""The single highest-leverage integrity check in this whole pipeline.

Every evidence item that claims "supported," "partially_supported," or
"contradicted" must carry a quote that exists VERBATIM in the source text
it claims to come from. If it doesn't, the model hallucinated or paraphrased,
and the item must never reach a human reviewer as if it were valid.

This has no dependency on an LLM provider and needs no API key — run it
against fixtures any time, including in CI once this repo has one.
"""

from __future__ import annotations

from dataclasses import dataclass

from schema import EvidenceItem, EvidenceState

# States that are allowed to have an empty quote — everything else must cite.
_STATES_WITHOUT_REQUIRED_QUOTE = {EvidenceState.NOT_FOUND, EvidenceState.EXTRACTION_ERROR}


@dataclass(frozen=True)
class ValidationResult:
    item: EvidenceItem
    valid: bool
    reason: str = ""


def validate_citation(item: EvidenceItem, source_text: str) -> ValidationResult:
    """Check a single evidence item's quote against its claimed source text."""
    if item.state in _STATES_WITHOUT_REQUIRED_QUOTE:
        if item.quote:
            return ValidationResult(
                item, False, f"state={item.state.value} must not carry a quote"
            )
        return ValidationResult(item, True)

    if not item.quote:
        return ValidationResult(item, False, "missing quote for a citing state")

    if item.quote not in source_text:
        return ValidationResult(
            item, False, "quote not found verbatim in source text (likely hallucination)"
        )

    # Exact-offset check: if the model also claimed an offset, it must match
    # an actual occurrence of the quote, not just any occurrence somewhere.
    if 0 <= item.source.offset < len(source_text):
        window = source_text[item.source.offset : item.source.offset + len(item.quote)]
        if window != item.quote:
            return ValidationResult(
                item, False, "quote exists in source but not at the claimed offset"
            )

    return ValidationResult(item, True)


def validate_all(items: list[EvidenceItem], source_text: str) -> list[ValidationResult]:
    return [validate_citation(item, source_text) for item in items]


if __name__ == "__main__":
    from schema import Source

    source = "Built and maintained Python microservices processing 2M+ events/day."

    good = EvidenceItem(
        criterion_id="python_production",
        state=EvidenceState.SUPPORTED,
        quote="Built and maintained Python microservices processing 2M+ events/day",
        source=Source(document="resume.txt", page_or_section="Experience", offset=0),
    )
    hallucinated = EvidenceItem(
        criterion_id="postgres",
        state=EvidenceState.SUPPORTED,
        quote="Designed PostgreSQL schemas for the core transactional workload",
        source=Source(document="resume.txt", page_or_section="Experience", offset=0),
    )
    not_found = EvidenceItem(
        criterion_id="aws",
        state=EvidenceState.NOT_FOUND,
        quote="",
        source=Source(document="resume.txt", page_or_section="", offset=-1),
    )

    for result in validate_all([good, hallucinated, not_found], source):
        status = "PASS" if result.valid else "FAIL"
        print(f"[{status}] {result.item.criterion_id}: {result.reason or 'ok'}")
