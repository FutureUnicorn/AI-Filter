import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from schema import EvidenceItem, EvidenceState, Source  # noqa: E402
from validate_citations import validate_citation  # noqa: E402

SOURCE = "Built and maintained Python microservices processing 2M+ events/day."


def _item(state: EvidenceState, quote: str, offset: int = 0) -> EvidenceItem:
    return EvidenceItem(
        criterion_id="test_criterion",
        state=state,
        quote=quote,
        source=Source(document="resume.txt", page_or_section="Experience", offset=offset),
    )


def test_genuine_quote_passes():
    item = _item(EvidenceState.SUPPORTED, "Built and maintained Python microservices processing 2M+ events/day")
    result = validate_citation(item, SOURCE)
    assert result.valid


def test_hallucinated_quote_fails():
    item = _item(EvidenceState.SUPPORTED, "Designed PostgreSQL schemas for the core transactional workload")
    result = validate_citation(item, SOURCE)
    assert not result.valid
    assert "hallucination" in result.reason


def test_not_found_with_empty_quote_passes():
    item = _item(EvidenceState.NOT_FOUND, "", offset=-1)
    result = validate_citation(item, SOURCE)
    assert result.valid


def test_not_found_with_a_quote_fails():
    item = _item(EvidenceState.NOT_FOUND, "some quote", offset=-1)
    result = validate_citation(item, SOURCE)
    assert not result.valid


def test_supported_with_empty_quote_fails():
    item = _item(EvidenceState.SUPPORTED, "")
    result = validate_citation(item, SOURCE)
    assert not result.valid


def test_quote_at_wrong_offset_fails():
    item = _item(EvidenceState.SUPPORTED, "Built and maintained Python microservices processing 2M+ events/day", offset=5)
    result = validate_citation(item, SOURCE)
    assert not result.valid
    assert "offset" in result.reason
