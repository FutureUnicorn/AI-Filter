import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from target_accounts import (  # noqa: E402
    _ALLOWED_RECORD_KEYS,
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


def _record(**overrides) -> dict:
    """A well-formed register record, as it would appear in the JSON file."""
    record = {
        "account_id": "northwind-robotics",
        "company": "Northwind Robotics",
        "headcount": 240,
        "remote_technical_hiring": True,
        "applications_per_requisition": 430,
        "ats_platform": "lever",
        "ats_fraud_tooling": "absent",
        "buyer_title": "head_of_talent",
        "claims": [
            {"claim": name, "source": "https://example.invalid", "observed_on": "2026-09-10"}
            for name in ("headcount", "hiring_volume", "ats", "buyer")
        ],
    }
    record.update(overrides)
    return record


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
    assessment = assess(_account(outreach_opt_out=True), AS_OF)
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


def test_a_claim_dated_in_the_future_is_not_evidence_and_says_why():
    """A mistyped year must not read as "go re-source a note you took this
    morning" -- the reason strings are this tool's working output."""
    assessment = assess(_account(claims=_claims(date(2026, 10, 1))), AS_OF)
    assert assessment.qualification is Qualification.NEEDS_EVIDENCE
    assert all("check the date" in reason for reason in assessment.reasons)
    assert all("older than" not in reason for reason in assessment.reasons)


def test_a_disqualifier_wins_over_missing_evidence():
    """An account outside the band stays off the list however well sourced the
    rest of its record is -- the reasons should say so, not ask for research."""
    assessment = assess(_account(headcount=5_000, claims=()), AS_OF)
    assert assessment.qualification is Qualification.DISQUALIFIED
    assert all("no sourced claim" not in reason for reason in assessment.reasons)


def test_unrecognized_clean_platform_is_flagged_rather_than_tiered():
    """Pinned to "other" specifically: that is the value a researcher writes
    when the platform has not been identified, so it is the one that must not
    reach tier A. An arbitrary unknown string would pass this test while
    "other" sailed through."""
    for platform in ("other", "Other", "bespoke-internal-ats"):
        assessment = assess(_account(ats_platform=platform), AS_OF)
        assert assessment.qualification is Qualification.NEEDS_EVIDENCE, platform
        assert assessment.tier is Tier.NONE
        assert any("not a known" in reason for reason in assessment.reasons)


def test_platform_names_are_normalized_on_parse():
    """"Lever", "lever " and "lever" are one platform, not two rejections
    and a pass."""
    account = parse_account(_record(ats_platform="  LEVER "))
    assert account.ats_platform == "lever"
    assert assess(account, AS_OF).tier is Tier.A


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


def _assert_register_error(callable_, expected: str):
    try:
        callable_()
    except RegisterError as error:
        assert expected in str(error), f"expected {expected!r}, got {str(error)!r}"
    else:
        raise AssertionError(f"expected a RegisterError mentioning {expected!r}")


def test_register_parsing_rejects_malformed_input():
    for raw, expected in [
        ("{}", "must be a JSON array"),
        ("not json", "not valid JSON"),
        ('[{"company": "No Id"}]', "non-empty string account_id"),
        ('[{"account_id": "x", "company": "X"}]', "missing required field"),
    ]:
        _assert_register_error(lambda raw=raw: load_register(raw), expected)


def test_a_quoted_boolean_is_rejected_rather_than_coerced():
    """bool("false") is True, and a register exported from a spreadsheet or a
    CRM is exactly where a quoted boolean comes from. This is the one field
    where coercion would turn a disqualified account into a qualified one
    with no reason recorded."""
    for value in ("false", "no", 0, 1, None):
        _assert_register_error(
            lambda value=value: parse_account(_record(remote_technical_hiring=value)),
            "expected a JSON boolean",
        )
        _assert_register_error(
            lambda value=value: parse_account(_record(outreach_opt_out=value)),
            "expected a JSON boolean",
        )


def test_an_unknown_field_is_rejected_by_name():
    """Person-shaped data must fail at the first run, not sit unread on disk."""
    _assert_register_error(
        lambda: parse_account(
            _record(buyer_name="A Person", notes="spoke to them Tuesday")
        ),
        "unknown field(s) ['buyer_name', 'notes']",
    )
    _assert_register_error(
        lambda: parse_account(
            _record(claims=[{"claim": "buyer", "source": "s", "observed_on": "2026-09-10", "contact": "a@example.invalid"}])
        ),
        "unknown field(s) ['contact']",
    )


def test_two_claims_for_one_qualifier_are_rejected():
    """Otherwise a fresh claim and a stale one for the same qualifier resolve
    by array order -- the one property a mechanical check must not have."""
    _assert_register_error(
        lambda: parse_account(
            _record(
                claims=[
                    {"claim": "headcount", "source": "s", "observed_on": "2026-09-10"},
                    {"claim": "headcount", "source": "s", "observed_on": "2026-02-01"},
                ]
            )
        ),
        "more than one 'headcount' claim",
    )


def test_an_unknown_fraud_tooling_value_is_a_register_error_not_a_guess():
    _assert_register_error(
        lambda: parse_account(_record(ats_fraud_tooling="probably_fine")),
        "unknown ats_fraud_tooling",
    )


def test_a_claim_without_an_iso_date_is_a_register_error():
    _assert_register_error(
        lambda: parse_account(
            _record(claims=[{"claim": "headcount", "source": "s", "observed_on": "last spring"}])
        ),
        "ISO date",
    )


def test_an_unhashable_buyer_title_is_a_register_error_not_a_crash():
    """buyer_title lands in a frozenset membership check (BUYER_TITLES).
    Before REV-011's fix, an unhashable value there raised a bare
    TypeError instead of the documented malformed-register outcome."""
    for bad in ([], {}, ["head_of_talent"]):
        _assert_register_error(
            lambda bad=bad: parse_account(_record(buyer_title=bad)),
            "expected a string",
        )


def test_an_unhashable_claim_name_is_a_register_error_not_a_crash():
    """A claim's name lands in a set (seen_claims) before an Account is
    even built, so this has to be caught earlier than buyer_title's."""
    for bad in ([], {}):
        _assert_register_error(
            lambda bad=bad: parse_account(
                _record(claims=[{"claim": bad, "source": "s", "observed_on": "2026-09-10"}])
            ),
            "expected a string",
        )


def test_a_non_string_company_or_claim_source_is_a_register_error():
    _assert_register_error(
        lambda: parse_account(_record(company=12345)),
        "expected a string",
    )
    _assert_register_error(
        lambda: parse_account(
            _record(claims=[{"claim": "headcount", "source": [], "observed_on": "2026-09-10"}])
        ),
        "expected a string",
    )


def test_a_non_string_observed_on_is_a_register_error():
    for bad in (None, [], 20260910):
        _assert_register_error(
            lambda bad=bad: parse_account(
                _record(claims=[{"claim": "headcount", "source": "s", "observed_on": bad}])
            ),
            "ISO date",
        )


def test_cli_reports_an_unhashable_buyer_title_as_a_clean_exit_2():
    """REV-011: the CLI must surface malformed input as the documented
    exit 2 and a one-line error, never a Python traceback. Runs the real
    script as a subprocess so this checks what a researcher actually sees,
    not just that parse_account raises the right exception in-process."""
    import subprocess
    import tempfile

    repository_root = Path(__file__).resolve().parents[1]
    register = [
        {
            "account_id": "x",
            "company": "X",
            "headcount": 240,
            "remote_technical_hiring": True,
            "applications_per_requisition": 430,
            "ats_platform": "lever",
            "ats_fraud_tooling": "absent",
            "buyer_title": [],
            "claims": [],
        }
    ]
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        json.dump(register, handle)
        register_path = handle.name

    try:
        result = subprocess.run(
            [sys.executable, "scripts/target_accounts.py", register_path, "--as-of", "2026-09-20"],
            cwd=repository_root,
            capture_output=True,
            text=True,
            timeout=30,
        )
    finally:
        Path(register_path).unlink()

    assert result.returncode == 2, (
        f"expected exit 2 for a malformed register, got {result.returncode}\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )
    assert "Traceback" not in result.stderr, f"CLI crashed instead of reporting a clean error:\n{result.stderr}"
    assert "expected a string" in result.stderr


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
    domains to mistake for research, and no named individuals at all.

    Stated as a subset of the schema's keys rather than a list of field names
    to forbid: a denylist passes every key nobody thought of, which is how a
    pasted `contact_email` or `call_notes` would have got in."""
    records = json.loads(EXAMPLE_REGISTER.read_text(encoding="utf-8"))
    for record in records:
        assert "SYNTHETIC" in record["company"]
        unknown = set(record) - _ALLOWED_RECORD_KEYS
        assert not unknown, f"{record['account_id']} carries unknown field(s) {unknown}"
    for source in (claim["source"] for r in records for claim in r.get("claims", [])):
        assert "http" not in source or ".invalid" in source
