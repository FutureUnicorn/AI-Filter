---
name: af-review-remediation
description: Verify and remediate AI-Filter pull request review findings with regression evidence, current-head validation, thread replies, and refreshed Jira handoff.
---

# AF review remediation

Use this skill for requested changes, inline findings, security review, or a re-review after new commits.

Read `docs/engineering/delivery-workflow.md` (AF-DELIVERY-1.0), the complete review discussion, current code, and the affected Jira acceptance criteria.

## Procedure

1. List every finding and its original thread. Reproduce or trace it against the current head and affected callers or consumers.
2. Classify each finding as valid, invalid, already addressed, or needing a human decision. Explain the evidence for invalid findings.
3. Fix valid underlying defects with the smallest safe change. Add regression coverage that fails without the fix.
4. Re-run focused validation and all required repository checks. Record the new head SHA and actual results.
5. Reply in the original review thread when requested. Do not dismiss reviews or resolve another person's threads.
6. Refresh the PR metadata and Jira Ready for review evidence for the new head SHA. A pushed fix can dismiss approvals and requires independent reapproval.

## Output

- Finding-by-finding disposition
- Fix commits and regression tests
- Exact validation and CI evidence
- Review replies completed or pending
- Refreshed Jira handoff evidence
- Remaining decisions or blockers
