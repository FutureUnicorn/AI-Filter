# Target account list — qualification contract

## Status

This document implements [AF-74](https://hemnaathusa.atlassian.net/browse/AF-74)
under the [AF-8 Customer Validation & Paid Pilots epic](https://hemnaathusa.atlassian.net/browse/AF-8).

It defines what belongs on the initial 30-account target list, what evidence
an account needs before it counts, and how the list is checked. The rules are
executable: `scripts/target_accounts.py` is the only thing that decides
whether the list meets AF-74, and this document is its prose.

The list feeds Gate 1 in [`../VALIDATION_STATUS.md`](../VALIDATION_STATUS.md) —
20 employer interviews, of which at least 12 must have seen 200+ applications
in the last 90 days. A list assembled from whoever answers a cold email will
not produce that evidence, which is why qualification is mechanical here
rather than a judgment call per account.

## Scope boundary

This is prospect research about employers. It contains no candidate data and
never will.

`Qualification` and `Tier` in `scripts/target_accounts.py` describe accounts
in a sales register. The prohibitions on ranking and scoring in
[`../PRODUCT_BOUNDARY.md`](../PRODUCT_BOUNDARY.md) (POL-002, POL-003) are
about candidates; nothing in this workflow may be pointed at candidate
material, and no code path connects the two.

## Hard qualifiers

Every one of these must hold. They come straight from the AF-74 description
and the diligence memo the repository is built from.

| Qualifier | Rule | Why |
|---|---|---|
| Headcount | 50–1,000 employees | Below 50 there is not enough requisition volume to audit; above 1,000 the buyer becomes a committee and a $500 pilot stops being a decision anyone can make alone. |
| Hiring shape | Remote or distributed technical hiring | Remote technical roles are where unfiltered application volume actually lands. |
| Volume | ≥200 applications per requisition, observed within 90 days | The problem does not exist below this. It is also the threshold Gate 1 needs interviewees to clear. |
| Buyer | A named talent or recruiting-ops decision maker exists | A champion without budget authority produces a pleasant call and no pilot. |
| ATS | Platform and fraud-tooling status both recorded | The competitive risk in `VALIDATION_STATUS.md` makes this the deciding field, not a nice-to-have. |

Accepted buyer titles: Head of Talent, Director of Talent, VP Talent, Head of
Recruiting, Recruiting Operations Lead, Talent Acquisition Lead. Recruiters
and sourcers can be champions; they are not the buyer this gate needs.

## Disqualifiers

An account that trips any of these is off the list and does not come back with
better research:

- **Native ATS fraud/spam tooling already in place**, observed on this
  account. Known examples: Crosschq ApplicantX, Ashby's Fraudulent Candidate
  Detection, Greenhouse Real Talent, and Employ's ID.me identity verification
  on its own platforms. The pitch cannot honestly claim to beat what they have
  already bought, so it should not be made.
- **Headcount outside the band**, hiring volume below the threshold, or no
  remote/distributed technical hiring.
- **No qualifying buyer title.**
- **An opt-out.** `outreach_opt_out` is recorded in the register and honored
  permanently, whatever else the record says. (The field is deliberately not
  called `do_not_contact`: that token is reserved in
  [`../PRODUCT_BOUNDARY.md`](../PRODUCT_BOUNDARY.md) for a prohibited
  *candidate* outcome. Different subject, opposite intent.)

## Priority tiers

Tiers set outreach order among qualified accounts by exposure to the problem —
not by how appealing the logo is.

| Tier | Condition | Frame |
|---|---|---|
| A | Fraud/spam tooling observed **absent** on a platform we recognize: Lever, Workable, JazzHR, Breezy, Recruitee | The pitch stands without caveats. |
| B | Tooling available on the platform but **not enabled** on this account — verified, not assumed | Honest "before you turn that on" conversation. |

Read the tier A list as the platforms whose posture we know well enough to
act on a recorded `absent` — **not** as a claim that these platforms ship
nothing. Employ sells ID.me identity verification into Lever and JazzHR
alike, and Ashby has said its fraud detection is included on all plans, so
the platform name never settles the question. `ats_fraud_tooling`, observed
per account, does.

Two values do not reach a tier at all:

- `unknown` — nobody has checked. `needs_evidence`, not an optimistic tier B.
- `other` as the platform — nobody has identified the ATS. An unidentified
  platform cannot support tier A's claim that the pitch stands without
  caveats, so it is `needs_evidence` too. Guessing here is how a list quietly
  fills up with accounts that already solved the problem.

## Evidence rule

Every hard qualifier needs a dated, sourced claim in the record: `headcount`,
`hiring_volume`, `ats`, and `buyer`. A claim observed more than **90 days**
ago is not evidence any more — headcount, ATS choice, and hiring volume all
move, and a stale note is a guess wearing a citation.

An account missing a claim, or carrying only stale ones, is `needs_evidence`:
not rejected, just not yet countable toward the 30. This mirrors how the
evidence pipeline treats an unsupported claim — see
`scripts/validate_citations.py`. The same standard the product applies to
candidate evidence applies to the founder's own research.

Sources should be checkable by someone else: a careers page, an
application-form footer that names the ATS, a press release, dated call notes.

## Where the register lives

The register is a JSON array of account records. **It is not committed.**

Prospect research accumulates named individuals and call notes, and this
repository has no business holding that. `.gitignore` excludes every `.json`
file under `docs/validation/` except the `.example.json`, plus anything
matching `*accounts*.json` anywhere in the tree — by directory rather than by
one filename, so a dated copy, a Q4 register or an underscore instead of a
hyphen is not committable either. Keep the working register at
`docs/validation/target-accounts.json` locally, and keep names, emails, and
contact history in the CRM instead.

The record schema carries `buyer_title` and no person field at all, and
`parse_account` **rejects any key it does not know** rather than ignoring it.
That is what makes a leaked register a list of companies rather than a list of
people: an accidental CRM paste fails at the first run instead of sitting
unread on disk. If the schema genuinely needs a new field, add it to
`_ALLOWED_RECORD_KEYS` deliberately.

[`target-accounts.example.json`](target-accounts.example.json) is a synthetic
example covering each outcome. Every company in it is invented; the domains
are `.invalid` on purpose.

### Record shape

```json
{
  "account_id": "northwind-robotics",
  "company": "Northwind Robotics",
  "headcount": 240,
  "remote_technical_hiring": true,
  "applications_per_requisition": 430,
  "ats_platform": "lever",
  "ats_fraud_tooling": "absent",
  "buyer_title": "head_of_talent",
  "outreach_opt_out": false,
  "claims": [
    {"claim": "headcount", "source": "https://…/about", "observed_on": "2026-09-08"}
  ]
}
```

`ats_fraud_tooling` is one of `absent`, `available_not_enabled`, `native`, or
`unknown`. It is recorded as observed and never inferred from the platform
name: a platform can sell the capability without a given customer having it
on, and that difference is the entire prioritization.

Booleans must be real JSON booleans — a quoted `"false"` is refused rather
than coerced, because `bool("false")` is `True` and a register exported from
a spreadsheet is exactly where a quoted boolean comes from. One qualifier
gets one claim: two `headcount` claims are refused rather than resolved by
array order, so a contradiction is settled by a human.

## Running the check

```bash
uv run python scripts/target_accounts.py docs/validation/target-accounts.json
```

It prints one line per account with its state and, where it fails, the
specific reason — then the roll-up against the 30-account target. Exit code 0
means AF-74 is met; 1 means the list is short; 2 means the register is
malformed.

Run it against the example to see each outcome. The example's dates are
fixed, so pin the assessment date too — otherwise every claim in it ages past
the 90-day rule and the whole file reads as `needs_evidence`:

```bash
uv run python scripts/target_accounts.py \
  docs/validation/target-accounts.example.json --as-of 2026-09-20
```

That run reports two qualified (one tier A, one tier B), two needing
evidence, two disqualified, and exits 1 on the 28-account shortfall.

## Current status

The qualification contract and its check are in place. The register itself is
empty — **0 of 30 accounts qualified**. Populating it is founder research,
account by account, against the rules above; AF-74 is done when the check
exits 0 on the real register and the roll-up is attached to the ticket.

Until then, no account on the list is "warm" and no number in this document
should be reported as validated evidence.
