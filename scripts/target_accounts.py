"""AF-74: the deterministic qualifier behind the 30-account target list.

The list that feeds Gate 1 (20 employer interviews) is only as good as the
rule that decides what belongs on it. Kept in a founder's head, that rule
drifts toward "companies I can get a meeting with." So it lives here
instead: one mechanical pass over a register of accounts, three possible
outcomes per account, and a source-dated claim behind every qualifier.

Nothing here touches candidate data. These states describe employer
accounts in a sales register -- POL-002/POL-003 in docs/PRODUCT_BOUNDARY.md
are about candidates, and no part of this file may ever be pointed at one.

Run it against the register:

    uv run python scripts/target_accounts.py path/to/target-accounts.json

See docs/validation/target-account-list.md for the qualification contract
this implements and where the real register lives.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from datetime import date
from enum import Enum

# The ticket's band: below 50 there is no requisition volume to audit,
# above 1,000 the buyer is a committee and the pilot is not a pilot.
MINIMUM_HEADCOUNT = 50
MAXIMUM_HEADCOUNT = 1_000

# "High-volume" from the diligence memo, per requisition, in the window.
MINIMUM_APPLICATIONS_PER_REQUISITION = 200
OBSERVATION_WINDOW_DAYS = 90

# A claim observed longer ago than this is not evidence any more. Headcount,
# ATS, and hiring volume all move; a year-old note is a guess.
EVIDENCE_FRESHNESS_DAYS = 90

# What AF-74 asks for.
TARGET_ACCOUNT_COUNT = 30

# Every qualifier below has to be backed by a dated, sourced claim.
REQUIRED_CLAIMS = ("headcount", "hiring_volume", "ats", "buyer")


class AtsFraudTooling(str, Enum):
    """Whether the account's ATS already ships fraud/spam detection.

    Recorded as observed, never inferred from the platform name: Greenhouse
    and Ashby both sell the capability without every customer enabling it,
    and that difference is the whole prioritization.
    """

    # No native fraud/spam tooling on the platform at all.
    ABSENT = "absent"
    # Platform sells it; this account has not turned it on (verified).
    AVAILABLE_NOT_ENABLED = "available_not_enabled"
    # Crosschq ApplicantX, Ashby fraud detection, Greenhouse Real Talent, or
    # Lever with the Employ/ID.me add-on -- already covered, disqualified.
    NATIVE = "native"
    # Not yet checked. Not a disqualifier; a research to-do.
    UNKNOWN = "unknown"


class Qualification(str, Enum):
    """Mechanical outcome of the rules below. Not a ranking."""

    QUALIFIED = "qualified"
    # Fails a hard rule and will keep failing it -- off the list.
    DISQUALIFIED = "disqualified"
    # Nothing rules it out; a required claim is missing or stale.
    NEEDS_EVIDENCE = "needs_evidence"


class Tier(str, Enum):
    """Outreach order among qualified accounts, by how exposed the account
    is to the problem this product addresses -- not by how attractive the
    logo is."""

    # No native tooling: the pitch is honest without caveats.
    A = "A"
    # Tooling available but off: honest, with a "before you enable it" frame.
    B = "B"
    NONE = "none"


_PLATFORMS_WITHOUT_NATIVE_TOOLING = frozenset(
    {"lever", "workable", "jazzhr", "breezy", "recruitee", "other"}
)

# Titles that can sign a $500 pilot without a committee. A recruiter or a
# sourcer can be a champion, but they are not the buyer AF-74 asks for.
BUYER_TITLES = frozenset(
    {
        "head_of_talent",
        "director_of_talent",
        "vp_talent",
        "head_of_recruiting",
        "recruiting_operations_lead",
        "talent_acquisition_lead",
    }
)


class RegisterError(ValueError):
    """The register file is malformed. Distinct from an account failing a
    rule: a failing account is an answer, a malformed file is not."""


@dataclass(frozen=True)
class Claim:
    """One dated, sourced observation. The register's unit of evidence."""

    claim: str
    source: str
    observed_on: date

    def is_fresh(self, as_of: date) -> bool:
        return 0 <= (as_of - self.observed_on).days <= EVIDENCE_FRESHNESS_DAYS


@dataclass(frozen=True)
class Account:
    account_id: str
    company: str
    headcount: int
    remote_technical_hiring: bool
    applications_per_requisition: int
    ats_platform: str
    ats_fraud_tooling: AtsFraudTooling
    buyer_title: str
    # Honoring an opt-out is not optional, and the register is where it is
    # remembered. Contact details never live here -- see the doc.
    do_not_contact: bool = False
    claims: tuple[Claim, ...] = ()

    def claim_for(self, name: str) -> Claim | None:
        for claim in self.claims:
            if claim.claim == name:
                return claim
        return None


@dataclass(frozen=True)
class AccountAssessment:
    account: Account
    qualification: Qualification
    tier: Tier
    # Why it is disqualified, or which claims are missing or stale.
    reasons: tuple[str, ...] = ()


@dataclass(frozen=True)
class RegisterReport:
    assessments: tuple[AccountAssessment, ...]
    as_of: date
    counts: dict[str, int] = field(default_factory=dict)

    @property
    def qualified(self) -> tuple[AccountAssessment, ...]:
        return tuple(
            a for a in self.assessments if a.qualification is Qualification.QUALIFIED
        )

    @property
    def meets_target(self) -> bool:
        return len(self.qualified) >= TARGET_ACCOUNT_COUNT

    @property
    def shortfall(self) -> int:
        return max(0, TARGET_ACCOUNT_COUNT - len(self.qualified))


def _disqualifiers(account: Account) -> list[str]:
    """Hard rules. An account failing one of these does not become qualified
    by finding better evidence -- it is the wrong account."""
    reasons: list[str] = []

    if account.do_not_contact:
        reasons.append("account asked not to be contacted")

    if not MINIMUM_HEADCOUNT <= account.headcount <= MAXIMUM_HEADCOUNT:
        reasons.append(
            f"headcount {account.headcount} is outside "
            f"{MINIMUM_HEADCOUNT}-{MAXIMUM_HEADCOUNT}"
        )

    if not account.remote_technical_hiring:
        reasons.append("no remote or distributed technical hiring")

    if account.applications_per_requisition < MINIMUM_APPLICATIONS_PER_REQUISITION:
        reasons.append(
            f"{account.applications_per_requisition} applications per requisition "
            f"is below {MINIMUM_APPLICATIONS_PER_REQUISITION}"
        )

    if account.ats_fraud_tooling is AtsFraudTooling.NATIVE:
        reasons.append(
            f"{account.ats_platform} already ships native fraud/spam tooling for "
            "this account -- the pitch cannot honestly claim to beat it"
        )

    if account.buyer_title not in BUYER_TITLES:
        reasons.append(
            f"buyer title {account.buyer_title!r} is not a talent/recruiting-ops "
            "decision maker"
        )

    return reasons


def _evidence_gaps(account: Account, as_of: date) -> list[str]:
    """Soft rules: what research is still owed before this account counts."""
    gaps: list[str] = []

    for required in REQUIRED_CLAIMS:
        claim = account.claim_for(required)
        if claim is None:
            gaps.append(f"no sourced claim for {required}")
        elif not claim.is_fresh(as_of):
            gaps.append(
                f"{required} claim from {claim.observed_on.isoformat()} is older than "
                f"{EVIDENCE_FRESHNESS_DAYS} days"
            )

    if account.ats_fraud_tooling is AtsFraudTooling.UNKNOWN:
        gaps.append(
            f"fraud/spam tooling on {account.ats_platform} has not been checked"
        )

    return gaps


def _tier(account: Account) -> Tier:
    if (
        account.ats_fraud_tooling is AtsFraudTooling.ABSENT
        and account.ats_platform in _PLATFORMS_WITHOUT_NATIVE_TOOLING
    ):
        return Tier.A
    if account.ats_fraud_tooling is AtsFraudTooling.AVAILABLE_NOT_ENABLED:
        return Tier.B
    return Tier.NONE


def assess(account: Account, as_of: date) -> AccountAssessment:
    """Qualify one account. Disqualifiers win over missing evidence: an
    account outside the headcount band stays off the list however well
    sourced the rest of its record is."""
    disqualifiers = _disqualifiers(account)
    if disqualifiers:
        return AccountAssessment(
            account, Qualification.DISQUALIFIED, Tier.NONE, tuple(disqualifiers)
        )

    gaps = _evidence_gaps(account, as_of)
    if gaps:
        return AccountAssessment(
            account, Qualification.NEEDS_EVIDENCE, Tier.NONE, tuple(gaps)
        )

    tier = _tier(account)
    if tier is Tier.NONE:
        # Reachable only if a platform is recorded as having no native
        # tooling but is not on the known-clean list: that is a research
        # answer to record, not an account to start calling.
        return AccountAssessment(
            account,
            Qualification.NEEDS_EVIDENCE,
            Tier.NONE,
            (
                f"platform {account.ats_platform!r} is not a known "
                "no-native-tooling platform; confirm and add it before tiering",
            ),
        )

    return AccountAssessment(account, Qualification.QUALIFIED, tier)


def assess_register(accounts: list[Account], as_of: date) -> RegisterReport:
    seen: set[str] = set()
    for account in accounts:
        if account.account_id in seen:
            raise RegisterError(f"duplicate account_id {account.account_id!r}")
        seen.add(account.account_id)

    assessments = tuple(assess(account, as_of) for account in accounts)
    counts = {state.value: 0 for state in Qualification}
    counts.update({f"tier_{tier.value}": 0 for tier in (Tier.A, Tier.B)})
    for assessment in assessments:
        counts[assessment.qualification.value] += 1
        if assessment.tier in (Tier.A, Tier.B):
            counts[f"tier_{assessment.tier.value}"] += 1

    return RegisterReport(assessments=assessments, as_of=as_of, counts=counts)


def _require(record: dict, key: str, account_id: str):
    if key not in record:
        raise RegisterError(f"account {account_id!r} is missing required field {key!r}")
    return record[key]


def parse_account(record: dict) -> Account:
    if not isinstance(record, dict):
        raise RegisterError(f"expected an account object, got {type(record).__name__}")

    account_id = record.get("account_id")
    if not isinstance(account_id, str) or not account_id:
        raise RegisterError("every account needs a non-empty string account_id")

    claims: list[Claim] = []
    for raw in record.get("claims", []):
        try:
            claims.append(
                Claim(
                    claim=raw["claim"],
                    source=raw["source"],
                    observed_on=date.fromisoformat(raw["observed_on"]),
                )
            )
        except (KeyError, TypeError) as error:
            raise RegisterError(
                f"account {account_id!r} has a claim missing claim/source/observed_on"
            ) from error
        except ValueError as error:
            raise RegisterError(
                f"account {account_id!r} has a claim whose observed_on is not an "
                "ISO date (YYYY-MM-DD)"
            ) from error

    # Every _require call stays outside the try blocks below: RegisterError is
    # itself a ValueError, so a missing field caught there would be reported as
    # a malformed one, pointing the reader at the wrong problem.
    raw_tooling = _require(record, "ats_fraud_tooling", account_id)
    company = _require(record, "company", account_id)
    raw_headcount = _require(record, "headcount", account_id)
    raw_volume = _require(record, "applications_per_requisition", account_id)
    ats_platform = _require(record, "ats_platform", account_id)
    buyer_title = _require(record, "buyer_title", account_id)
    remote = _require(record, "remote_technical_hiring", account_id)

    try:
        tooling = AtsFraudTooling(raw_tooling)
    except ValueError as error:
        raise RegisterError(
            f"account {account_id!r} has an unknown ats_fraud_tooling value; "
            f"expected one of {[t.value for t in AtsFraudTooling]}"
        ) from error

    try:
        headcount = int(raw_headcount)
        applications_per_requisition = int(raw_volume)
    except (TypeError, ValueError) as error:
        raise RegisterError(
            f"account {account_id!r} has a non-numeric headcount or "
            f"applications_per_requisition: {error}"
        ) from error

    return Account(
        account_id=account_id,
        company=company,
        headcount=headcount,
        remote_technical_hiring=bool(remote),
        applications_per_requisition=applications_per_requisition,
        ats_platform=ats_platform,
        ats_fraud_tooling=tooling,
        buyer_title=buyer_title,
        do_not_contact=bool(record.get("do_not_contact", False)),
        claims=tuple(claims),
    )


def load_register(raw: str) -> list[Account]:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RegisterError(f"register is not valid JSON: {error}") from error

    if not isinstance(parsed, list):
        raise RegisterError("register must be a JSON array of account objects")

    return [parse_account(record) for record in parsed]


def format_report(report: RegisterReport) -> str:
    lines = [f"Target account register — assessed {report.as_of.isoformat()}", ""]

    for assessment in report.assessments:
        label = assessment.qualification.value.upper()
        if assessment.qualification is Qualification.QUALIFIED:
            label = f"{label} (tier {assessment.tier.value})"
        lines.append(f"[{label}] {assessment.account.company}")
        for reason in assessment.reasons:
            lines.append(f"    - {reason}")

    qualified = len(report.qualified)
    lines.extend(
        [
            "",
            f"qualified: {qualified}/{TARGET_ACCOUNT_COUNT}"
            f"  (tier A: {report.counts.get('tier_A', 0)},"
            f" tier B: {report.counts.get('tier_B', 0)})",
            f"needs evidence: {report.counts.get(Qualification.NEEDS_EVIDENCE.value, 0)}",
            f"disqualified: {report.counts.get(Qualification.DISQUALIFIED.value, 0)}",
        ]
    )

    if not report.meets_target:
        lines.append(
            f"\nAF-74 is not met: {report.shortfall} more qualified accounts needed."
        )

    return "\n".join(lines)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(
            "usage: python scripts/target_accounts.py <register.json>\n"
            "example register: docs/validation/target-accounts.example.json",
            file=sys.stderr,
        )
        return 2

    try:
        with open(argv[1], encoding="utf-8") as handle:
            accounts = load_register(handle.read())
        report = assess_register(accounts, date.today())
    except (OSError, RegisterError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    print(format_report(report))
    return 0 if report.meets_target else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
