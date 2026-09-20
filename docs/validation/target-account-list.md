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

- **Native ATS fraud/spam tooling already in place.** Crosschq ApplicantX,
  Ashby's native fraud detection, Greenhouse Real Talent, or Lever with the
  Employ/ID.me add-on. The pitch cannot honestly claim to beat what they have
  already bought, so it should not be made.
- **Headcount outside the band**, hiring volume below the threshold, or no
  remote/distributed technical hiring.
- **No qualifying buyer title.**
- **An opt-out.** `do_not_contact` is recorded in the register and honored
  permanently, whatever else the record says.

## Priority tiers

Tiers set outreach order among qualified accounts by exposure to the problem —
not by how appealing the logo is.

| Tier | Condition | Frame |
|---|---|---|
| A | Platform ships no native fraud/spam tooling: Lever (no Employ/ID.me), Workable, JazzHR, Breezy, Recruitee | The pitch stands without caveats. |
| B | Platform sells the capability but this account has not enabled it — verified, not assumed | Honest "before you turn that on" conversation. |

An account whose tooling status is `unknown` is not tier B by default. It is
`needs_evidence` until someone checks. Guessing here is how the list quietly
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
repository has no business holding that; `.gitignore` excludes
`docs/validation/target-accounts.json` and `*.accounts.json` for that reason.
Keep the working register at `docs/validation/target-accounts.json` locally,
and keep names, emails, and contact history in the CRM instead.

The record schema carries `buyer_title`, never a person's name — the schema
itself is designed so that a leaked register is a list of companies, not a
list of people.

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
  "do_not_contact": false,
  "claims": [
    {"claim": "headcount", "source": "https://…/about", "observed_on": "2026-09-08"}
  ]
}
```

`ats_fraud_tooling` is one of `absent`, `available_not_enabled`, `native`, or
`unknown`. It is recorded as observed and never inferred from the platform
name: Greenhouse and Ashby both sell the capability without every customer
enabling it, and that difference is the entire prioritization.

## Running the check

```bash
uv run python scripts/target_accounts.py docs/validation/target-accounts.json
```

It prints one line per account with its state and, where it fails, the
specific reason — then the roll-up against the 30-account target. Exit code 0
means AF-74 is met; 1 means the list is short; 2 means the register is
malformed.

Run it against the example to see each outcome:

```bash
uv run python scripts/target_accounts.py docs/validation/target-accounts.example.json
```

## Current status

The qualification contract and its check are in place. The register itself is
empty — **0 of 30 accounts qualified**. Populating it is founder research,
account by account, against the rules above; AF-74 is done when the check
exits 0 on the real register and the roll-up is attached to the ticket.

Until then, no account on the list is "warm" and no number in this document
should be reported as validated evidence.
