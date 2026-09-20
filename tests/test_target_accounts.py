import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from target_accounts import (  # noqa: E402
    Account,
    AtsFraudTooling,
    Claim,
    Qualification,
    RegisterError,
    TARGET_ACCOUNT_COUNT,
    Tier,
    assess,
    assess_register,
    load_register,
    parse_account,
)

AS_OF = date(2026, 9, 20)
REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
EXAMPLE_REGISTER = REPOSITORY_ROOT / "docs/validation/target-accounts.example.json"


def _claims(observed_on: date = date(2026, 9, 10)) -> tuple[Claim, ...]:
    return tuple(
        Claim(claim=name, source=f"https://example.invalid/{name}", observed_on=observed_on)
        for name in ("headcount", "hiring_volume", "ats", "buyer")
    )


def _account(**overrides) -> Account:
    defaults = dict(
        account_id="northwind-robotics",
        company="Northwind Robotics",
        headcount=240,
        remote_technical_hiring=True,
        applications_per_requisition=430,
        ats_platform="lever",
        ats_fraud_tooling=AtsFraudTooling.ABSENT,
        buyer_title="head_of_talent",
        claims=_claims(),
    )
    defaults.update(overrides)
    return Account(**defaults)


def test_fully_evidenced_account_on_a_clean_platform_qualifies_tier_a():
    assessment = assess(_account(), AS_OF)
    assert assessment.qualification is Qualification.QUALIFIED
    assert assessment.tier is Tier.A
    assert assessment.reasons == ()


def test_platform_with_the_capability_switched_off_is_tier_b():
    assessment = assess(
        _account(
            ats_platform="greenhouse",
            ats_fraud_tooling=AtsFraudTooling.AVAILABLE_NOT_ENABLED,
        ),
        AS_OF,
    )
    assert assessment.qualification is Qualification.QUALIFIED
    assert assessment.tier is Tier.B


def test_native_fraud_tooling_disqualifies():
    assessment = assess(
        _account(ats_platform="ashby", ats_fraud_tooling=AtsFraudTooling.NATIVE), AS_OF
    )
    assert assessment.qualification is Qualification.DISQUALIFIED
    assert any("native fraud/spam tooling" in reason for reason in assessment.reasons)


def test_unchecked_fraud_tooling_is_not_silently_treated_as_absent():
    """The competitive risk in VALIDATION_STATUS.md turns on this field, so an
    unchecked account is research to do, never a tier-B assumption."""
    assessment = assess(_account(ats_fraud_tooling=AtsFraudTooling.UNKNOWN), AS_OF)
    assert assessment.qualification is Qualification.NEEDS_EVIDENCE
    assert assessment.tier is Tier.NONE


def test_headcount_outside_the_band_disqualifies_at_both_ends():
    for headcount in (49, 1_001):
        assessment = assess(_account(headcount=headcount), AS_OF)
        assert assessment.qualification is Qualification.DISQUALIFIED
        assert any("outside 50-1000" in reason for reason in assessment.reasons)


def test_headcount_band_is_inclusive():
    for headcount in (50, 1_000):
        assert assess(_account(headcount=headcount), AS_OF).qualification is (
            Qualification.QUALIFIED
        )


def test_application_volume_below_the_threshold_disqualifies():
    assessment = assess(_account(applications_per_requisition=199), AS_OF)
    assert assessment.qualification is Qualification.DISQUALIFIED
    assert any("below 200" in reason for reason in assessment.reasons)


def test_non_remote_technical_hiring_disqualifies():
    assessment = assess(_account(remote_technical_hiring=False), AS_OF)
    assert assessment.qualification is Qualification.DISQUALIFIED


def test_a_recruiter_is_not_a_buyer():
    assessment = assess(_account(buyer_title="technical_recruiter"), AS_OF)
    assert assessment.qualification is Qualification.DISQUALIFIED
    assert any("decision maker" in reason for reason in assessment.reasons)


def test_opt_out_disqualifies_an_otherwise_perfect_account():
    assessment = assess(_account(do_not_contact=True), AS_OF)
    assert assessment.qualification is Qualification.DISQUALIFIED
    assert any("not to be contacted" in reason for reason in assessment.reasons)


def test_missing_claim_makes_an_account_need_evidence_rather_than_qualify():
    partial = tuple(claim for claim in _claims() if claim.claim != "buyer")
    assessment = assess(_account(claims=partial), AS_OF)
    assert assessment.qualification is Qualification.NEEDS_EVIDENCE
    assert any("no sourced claim for buyer" in reason for reason in assessment.reasons)


def test_stale_claims_stop_counting_as_evidence():
    assessment = assess(_account(claims=_claims(date(2026, 2, 11))), AS_OF)
    assert assessment.qualification is Qualification.NEEDS_EVIDENCE
    assert len(assessment.reasons) == len(_claims())
    assert all("older than 90 days" in reason for reason in assessment.reasons)


def test_a_claim_at_the_freshness_boundary_still_counts():
    assessment = assess(_account(claims=_claims(date(2026, 6, 22))), AS_OF)
    assert assessment.qualification is Qualification.QUALIFIED


def test_a_claim_dated_in_the_future_is_not_evidence():
    assessment = assess(_account(claims=_claims(date(2026, 10, 1))), AS_OF)
    assert assessment.qualification is Qualification.NEEDS_EVIDENCE


def test_a_disqualifier_wins_over_missing_evidence():
    """An account outside the band stays off the list however well sourced the
    rest of its record is -- the reasons should say so, not ask for research."""
    assessment = assess(_account(headcount=5_000, claims=()), AS_OF)
    assert assessment.qualification is Qualification.DISQUALIFIED
    assert all("no sourced claim" not in reason for reason in assessment.reasons)


def test_unrecognized_clean_platform_is_flagged_rather_than_tiered():
    assessment = assess(_account(ats_platform="bespoke-internal-ats"), AS_OF)
    assert assessment.qualification is Qualification.NEEDS_EVIDENCE
    assert any("not a known" in reason for reason in assessment.reasons)


def test_register_rolls_up_counts_and_reports_the_shortfall():
    report = assess_register(
        [
            _account(account_id="a", company="A"),
            _account(
                account_id="b",
                company="B",
                ats_platform="greenhouse",
                ats_fraud_tooling=AtsFraudTooling.AVAILABLE_NOT_ENABLED,
            ),
            _account(account_id="c", company="C", headcount=4_000),
            _account(account_id="d", company="D", claims=()),
        ],
        AS_OF,
    )
    assert report.counts["qualified"] == 2
    assert report.counts["disqualified"] == 1
    assert report.counts["needs_evidence"] == 1
    assert report.counts["tier_A"] == 1
    assert report.counts["tier_B"] == 1
    assert not report.meets_target
    assert report.shortfall == TARGET_ACCOUNT_COUNT - 2


def test_the_target_is_met_only_at_thirty_qualified_accounts():
    accounts = [
        _account(account_id=f"account-{index}", company=f"Company {index}")
        for index in range(TARGET_ACCOUNT_COUNT)
    ]
    assert assess_register(accounts, AS_OF).meets_target
    assert not assess_register(accounts[:-1], AS_OF).meets_target


def test_duplicate_account_ids_are_rejected():
    """Two records for one company would otherwise count twice toward 30."""
    try:
        assess_register([_account(), _account(company="Northwind Robotics Inc.")], AS_OF)
    except RegisterError as error:
        assert "duplicate account_id" in str(error)
    else:
        raise AssertionError("expected a RegisterError for a duplicate account_id")


def test_register_parsing_rejects_malformed_input():
    for raw, expected in [
        ("{}", "must be a JSON array"),
        ("not json", "not valid JSON"),
        ('[{"company": "No Id"}]', "non-empty string account_id"),
        ('[{"account_id": "x", "company": "X"}]', "missing required field"),
    ]:
        try:
            load_register(raw)
        except RegisterError as error:
            assert expected in str(error)
        else:
            raise AssertionError(f"expected a RegisterError mentioning {expected!r}")


def test_an_unknown_fraud_tooling_value_is_a_register_error_not_a_guess():
    record = {
        "account_id": "x",
        "company": "X",
        "headcount": 100,
        "remote_technical_hiring": True,
        "applications_per_requisition": 300,
        "ats_platform": "lever",
        "ats_fraud_tooling": "probably_fine",
        "buyer_title": "head_of_talent",
    }
    try:
        parse_account(record)
    except RegisterError as error:
        assert "unknown ats_fraud_tooling" in str(error)
    else:
        raise AssertionError("expected a RegisterError for an unknown tooling value")


def test_a_claim_without_an_iso_date_is_a_register_error():
    record = {
        "account_id": "x",
        "company": "X",
        "headcount": 100,
        "remote_technical_hiring": True,
        "applications_per_requisition": 300,
        "ats_platform": "lever",
        "ats_fraud_tooling": "absent",
        "buyer_title": "head_of_talent",
        "claims": [{"claim": "headcount", "source": "s", "observed_on": "last spring"}],
    }
    try:
        parse_account(record)
    except RegisterError as error:
        assert "ISO date" in str(error)
    else:
        raise AssertionError("expected a RegisterError for a non-ISO observed_on")


def test_the_example_register_parses_and_covers_every_outcome():
    accounts = load_register(EXAMPLE_REGISTER.read_text(encoding="utf-8"))
    report = assess_register(accounts, AS_OF)
    states = {assessment.qualification for assessment in report.assessments}
    tiers = {a.tier for a in report.assessments if a.qualification is Qualification.QUALIFIED}
    assert states == set(Qualification)
    assert tiers == {Tier.A, Tier.B}
    assert not report.meets_target


def test_the_example_register_holds_no_real_company_or_contact_data():
    """It ships in the repository, so it must stay obviously synthetic: no real
    domains to mistake for research, and no named individuals at all."""
    raw = EXAMPLE_REGISTER.read_text(encoding="utf-8")
    records = json.loads(raw)
    for record in records:
        assert "SYNTHETIC" in record["company"]
        assert "buyer_name" not in record
        assert "contact" not in record
    for source in (claim["source"] for r in records for claim in r.get("claims", [])):
        assert "http" not in source or ".invalid" in source
