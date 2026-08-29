# Signal Audit product-policy invariants

## Status

This document is the binding product-policy contract for AI-Filter (Signal Audit). It implements [AF-9](https://hemnaathusa.atlassian.net/browse/AF-9) under the [AF-1 Product Foundation and Architecture epic](https://hemnaathusa.atlassian.net/browse/AF-1).

The rules below apply to every product surface and implementation stage. They define internal product policy; they do not, by themselves, establish legal or regulatory compliance.

Normative terms have these meanings:

- **MUST** and **MUST NOT** state binding requirements.
- **SHOULD** states a strong recommendation where implementation choice remains.
- **MAY** identifies an explicitly optional behavior.

## Purpose and product north star

Signal Audit helps an employer review candidate-provided material against requirements that the employer has defined or approved. Its intended flow is:

```text
Employer defines requirements
-> candidates are imported
-> AI extracts source-cited evidence
-> deterministic validation checks it
-> a recruiter reviews and may correct it
-> a named human decides
-> the system reports whether review became faster without losing strong candidates
```

The governing principle is:

> **AI provides evidence; humans make employment decisions.**

AI output MUST remain reviewable evidence. It MUST NOT become a ranking, score, recommendation, disposition, communication, or other employment decision, whether directly or through downstream automation.

## Definitions

### Evidence

Information from employer-authorized candidate material that is relevant to an employer-defined requirement and traceable to a specific source location or record. Evidence is not a hiring conclusion.

### Source citation

A reference that lets a reviewer trace an evidence claim to its originating candidate material. An evidence-bearing AI output MUST retain this traceability.

### Deterministic validation

Non-generative structural or mechanical checks such as contract conformance, required-field checks, citation presence and resolvability, tenant ownership, and allowed state transitions. Validation MUST NOT judge candidate quality or suitability.

### Recruiter review

A review step in which an authorized human inspects AI-produced evidence and, where the workflow permits, confirms or corrects it before an employment decision is recorded.

### Named human decision

An employment decision attributable to a specific authorized human actor. The product MUST NOT represent AI output or a missing decision as a human decision.

### Employment decision

An action or recommendation that determines or materially directs candidate disposition, including rejection, advancement, selection, hiring-stage movement, or candidate contact.

### Employer-defined requirement

A job-related requirement supplied or explicitly approved by an employer-authorized human. AI MUST NOT invent requirements for evaluating candidates.

### Cross-employer aggregation

Combining, comparing, profiling, benchmarking, or deriving candidate-level conclusions from information belonging to separate employer tenants.

## Numbered policy invariants

### POL-001: Human decision authority

AI-Filter MUST preserve human authority over every employment decision. AI MAY support review with evidence, but a named authorized human MUST make the decision.

- Machine-produced evidence, human corrections, and human decisions MUST remain distinguishable.
- A decision record MUST be attributable to the human who made it.
- Missing human action MUST NOT be replaced with an AI-generated or inferred decision.
- Terms such as `recommended_outcome`, `suggested_disposition`, `pass`, `fail`, `best_candidate`, or `likely_hire` MUST NOT be used to recreate AI decision-making.

### POL-002: Evidence, not ranking

AI MAY extract and organize source-cited evidence under employer-defined requirements. AI-Filter MUST NOT rank candidates, comparatively order candidates by desirability, identify a top or best candidate, or maintain a hidden ranking key.

Ordering by a neutral operational property, such as submission time or an explicitly selected workflow state, MAY be supported only when it does not encode candidate quality, suitability, or priority.

### POL-003: No candidate scoring

AI-Filter MUST NOT assign or derive a score, grade, tier, probability, confidence value, weighted total, or equivalent signal that expresses candidate suitability, quality, fit, hiring desirability, or decision priority.

Mechanical metrics MAY describe system processing, such as citation-validation status or parser health. They MUST NOT be presented, sorted, or reused as candidate-quality signals.

### POL-004: No automatic rejection

AI-Filter MUST NOT automatically reject a candidate, set a rejected disposition, hide or remove a candidate because AI judged them unsuitable, send a rejection outcome, or instruct another system to perform an automatic rejection.

Missing, unclear, invalid, or failed evidence MUST NOT imply rejection.

### POL-005: No automatic advancement

AI-Filter MUST NOT automatically advance, shortlist, select, or move a candidate to another hiring stage. It MUST NOT queue an advancement action based on AI output.

An authorized human MAY use reviewed evidence when independently deciding whether to advance a candidate.

### POL-006: No automatic candidate contact

AI-Filter MUST NOT automatically contact a candidate for any purpose. This includes invitations, outreach, rejection messages, interview requests, follow-ups, and messages sent through a connected tool or downstream automation.

A future workflow MAY help a human prepare or initiate contact only when the final send is a deliberate, attributable human action and no prohibited AI recommendation or disposition triggers it.

### POL-007: No ATS-status writes

AI-Filter MUST NOT write candidate status, stage, disposition, or equivalent employment-decision state into an applicant tracking system (ATS).

Future ATS integration MAY provide the minimum employer-authorized read/import capabilities needed for the evidence workflow. Read/import permission MUST remain technically and semantically separate from write authority. A human-facing button that ultimately causes AI-Filter to write ATS status still violates this invariant.

### POL-008: No AI-writing detection

AI-Filter MUST NOT determine, estimate, flag, or score whether candidate material was written or assisted by AI. Suspected AI authorship MUST NOT appear in evidence extraction or candidate review.

### POL-009: No biometric inference

AI-Filter MUST NOT infer biometric, identity, emotion, health, demographic, or protected characteristics from images, video, voice, text, metadata, or other candidate inputs for candidate evaluation.

Identity verification and biometric profiling MUST NOT be disguised as evidence relevant to a job requirement.

### POL-010: No personality inference

AI-Filter MUST NOT infer personality, temperament, psychological traits, motivation, leadership personality, behavioral archetypes, or culture fit for employment evaluation.

Evidence about explicitly stated experience is distinct from an inferred personality trait.

### POL-011: No cross-employer aggregation

AI-Filter MUST NOT aggregate candidate information across employers for evaluation, comparison, profiling, benchmarking, reputation, or employment-decision support.

Candidate information from Employer A MUST NOT be retrieved or used to produce candidate-level evidence or conclusions for Employer B. Data access, retrieval context, AI context, and audit records MUST remain employer-scoped.

### POL-012: Traceable evidence before human review

Candidate-related AI output used in the review workflow MUST be evidence-oriented, tied to employer-authorized source material, and checked by deterministic validation before it is relied upon in recruiter review.

- Evidence-bearing states MUST contain resolvable source citations.
- Citation validity MUST NOT be treated as candidate quality.
- AI uncertainty MUST remain uncertainty and MUST NOT become a negative decision.
- Extraction or validation failure MUST remain a processing state.
- The recruiter MUST be able to inspect and, where supported, correct evidence before making a decision.

## Allowed and forbidden behavior

| Behavior | Policy | Condition or reason |
|---|---|---|
| Extract evidence from authorized candidate material | Allowed | Evidence MUST remain distinct from a hiring conclusion. |
| Group evidence under employer-defined requirements | Allowed | Grouping MUST NOT create ranking or scoring. |
| Cite a source supporting an evidence claim | Required | The review workflow depends on traceability. |
| Deterministically validate citation structure and resolution | Allowed | Validation MUST remain mechanical, not evaluative. |
| Let a recruiter inspect and correct evidence | Allowed | Human oversight and attribution MUST be preserved. |
| Record a named human decision in a future product workflow | Potentially allowed | It MUST be human-authored, attributable, and must not cause an ATS-status write. |
| Let a human deliberately initiate candidate contact | Potentially allowed | The final action MUST be human-triggered and attributable. |
| Read or import authorized ATS data | Potentially allowed | Permissions MUST exclude candidate status, stage, and disposition writes. |
| Rank or comparatively order candidates by desirability | Forbidden | Violates POL-002. |
| Score, grade, tier, or label candidate fit | Forbidden | Violates POL-003. |
| Automatically reject, advance, shortlist, or select | Forbidden | Violates POL-004 or POL-005. |
| Automatically contact a candidate | Forbidden | Violates POL-006. |
| Write candidate status, stage, or disposition to an ATS | Forbidden | Violates POL-007. |
| Detect AI-written candidate material | Forbidden | Violates POL-008. |
| Infer biometric or personality characteristics | Forbidden | Violates POL-009 or POL-010. |
| Aggregate candidate information across employers | Forbidden | Violates POL-011. |
| Treat missing or invalid evidence as rejection | Forbidden | Processing and evidence states are not decisions. |
| Display model confidence as candidate quality | Forbidden | A score remains a score when renamed. |

## Human review, attribution, and failure states

AI-authored evidence, deterministic validation results, human corrections, and human decisions MUST NOT become indistinguishable in an audit trail.

When those capabilities are implemented, the audit trail MUST preserve at least the conceptual identity of the human actor, action time, action type, relevant source or review context, and correction history. This requirement does not prescribe a persistence schema.

Operational and evidence states including the following MUST remain non-decisional:

```text
not_found
unclear
failed
quarantined
invalid_source
citation_invalid
extraction_error
processing
retrying
unsupported_file
```

None of these states may mean or trigger `rejected`, `unqualified`, `low_quality`, `do_not_contact`, or any equivalent employment outcome.

## Requirements inherited by future implementation

### AI layer

The AI layer MUST extract evidence only against employer-defined requirements, return traceable evidence, isolate employer context, and represent missing or uncertain evidence without evaluation. Its prompts, tools, and structured outputs MUST exclude ranking, scoring, recommendations, disposition, contact actions, AI-writing detection, and biometric or personality inference.

### User interface

The UI MUST present requirement-level evidence and source context without leaderboards, overall fit summaries, suitability labels, score-like visualizations, AI-authored decisions, or controls that trigger prohibited automation. It MUST clearly distinguish unreviewed AI output, validated evidence, human corrections, and named human actions.

### APIs and integrations

APIs and service identities MUST use least privilege. Contracts and tools MUST NOT expose operations that rank, score, reject, advance, automatically contact, or write ATS status. Integration permissions SHOULD be structurally incapable of prohibited writes rather than relying only on UI hiding or prompt instructions.

### Data and domain models

Future schemas MUST keep evidence, validation results, human corrections, human decisions, processing failures, and audit events distinct. They MUST NOT contain hidden ranking or suitability fields. Every candidate-related record and retrieval path MUST remain employer-scoped.

### Testing

Future automated tests MUST include negative coverage showing that each prohibited behavior is absent from prompts, schemas, APIs, permissions, UI behavior, tools, state transitions, and integrations. End-to-end tests MUST demonstrate that evidence reaches a reviewer only after deterministic validation and that only an attributable human action can produce a human decision or initiate contact.

## Examples and anti-patterns

### Compliant evidence presentation

```text
Requirement: 5+ years of TypeScript experience
Evidence state: partially_supported
Source quote: "Built TypeScript services from 2022 to present."
Source: resume.txt, Experience
Review status: unreviewed
```

This states what the source supports and leaves the decision to a human.

### Prohibited circumvention

A prohibited behavior remains prohibited when implemented under a different name, hidden field, derived metric, visual treatment, prompt, tool call, integration, or downstream automation.

| Prohibited concept | Non-compliant workaround |
|---|---|
| Candidate score | `match_strength`, `fit_index`, `quality_grade`, or a hidden weighted total |
| Ranking | `priority_order`, `top_matches`, or sorting by model confidence |
| Automatic rejection | `archive_unqualified` or a disposition event delegated to another tool |
| Automatic advancement | `promote_candidate` or an AI-triggered shortlist |
| AI decision | `recommended_outcome`, `likely_hire`, or `suggested_disposition` |
| Automatic contact | A queued invitation or message that requires no deliberate human send action |
| ATS-status write | A UI action whose backend writes stage or disposition through AI-Filter |
| Personality inference | `culture_profile`, `behavioral_archetype`, or `leadership_persona` |
| AI-writing detection | `authenticity_probability` or an AI-authorship flag |

## Current validation-stage gates

These development gates limit premature scope in addition to the permanent invariants above. Passing a gate does not override any numbered invariant.

| Feature | Earliest evidence gate |
|---|---|
| Hosted web app, database, or authentication | Three paid pilots with repeat or expansion intent |
| Read/import-only ATS integration | Ten paid customers, five naming the same ATS friction, and three committing to the same ATS |
| Reusable rubric templates as a product feature | Ten similar-role rubrics demonstrate genuine repeatability |
| Human-triggered candidate-proof contact workflow | Manual completion and complaint rates are measured and acceptable |
| Dashboard or analytics UI | A validated product need beyond the core hypothesis |
| RAG, vector database, or autonomous agents | Evidence that deterministic retrieval is inadequate and the additional failure modes are justified |

### AF-11 synthetic infrastructure validation exception

[AF-11](https://hemnaathusa.atlassian.net/browse/AF-11) may provision the minimum
hosted infrastructure needed to verify development, preview, staging, and
production environment isolation before the hosted-product evidence gate is
passed. This is a narrow infrastructure-validation exception, not permission to
launch or operate the product.

Resources created under this exception:

- MUST contain synthetic data only;
- MUST NOT process real applicant or employer data;
- MUST NOT be used by customers or design partners;
- MUST NOT enable authentication or a production hiring workflow;
- MUST use separate non-production and production-shaped credentials;
- MUST use minimal capacity, explicit spend controls, and automatic preview
  cleanup;
- MUST restrict and audit production-shaped administrative access; and
- MUST remain disabled unless the repository's AF-11 environment controls and
  AF-12 green-revision gate authorize the deployment.

The environment named `production` under this exception is an empty,
production-shaped validation environment. Customer-facing production use is
still prohibited until the hosted-product evidence gate is passed. No numbered
policy invariant is weakened or suspended by this exception.

## Change control

Any future change that weakens, removes, or materially reinterprets a numbered invariant MUST be explicit, reviewed, traceable to a Jira product decision, and reflected in this canonical policy before dependent code is merged.

When proposed work conflicts with an invariant, implementation MUST stop until the conflict is recorded and the policy change is approved. A feature pull request MUST NOT silently redefine this policy.

## Future-ticket and pull-request checklist

- [ ] Does the change preserve named-human decision authority?
- [ ] Does candidate AI output remain evidence-oriented and source-traceable?
- [ ] Does deterministic validation remain separate from candidate evaluation?
- [ ] Does the change avoid candidate ranking and hidden comparative ordering?
- [ ] Does it avoid candidate suitability scoring and score-like labels?
- [ ] Does it avoid automatic rejection?
- [ ] Does it avoid automatic advancement or shortlisting?
- [ ] Does it avoid automatic candidate contact?
- [ ] Does it avoid ATS candidate status, stage, and disposition writes?
- [ ] Does it avoid AI-writing detection?
- [ ] Does it avoid biometric and protected-characteristic inference?
- [ ] Does it avoid personality and culture-fit inference?
- [ ] Does it preserve employer-scoped access, retrieval, AI context, and audit records?
- [ ] Are processing, missing-evidence, and validation-failure states non-decisional?
- [ ] Are AI evidence, human corrections, and human decisions distinguishable?
- [ ] Are human decisions and human-triggered contact attributable to a named actor?
- [ ] Do negative tests cover every relevant prohibition?

## AF-9 requirement trace

| Jira requirement | Policy location |
|---|---|
| AI provides evidence | POL-001, POL-002, POL-012 |
| Humans make employment decisions | POL-001 |
| No ranking | POL-002 |
| No scoring | POL-003 |
| No automatic rejection | POL-004 |
| No automatic advancement | POL-005 |
| No automatic contact | POL-006 |
| No ATS-status writes | POL-007 |
| No AI-writing detection | POL-008 |
| No biometric inference | POL-009 |
| No personality inference | POL-010 |
| No cross-employer aggregation | POL-011 |
| AI-layer constraints | Requirements inherited by future implementation: AI layer |
| UI constraints | Requirements inherited by future implementation: User interface |
| API-permission constraints | Requirements inherited by future implementation: APIs and integrations |
| Data-model constraints | Requirements inherited by future implementation: Data and domain models |
| Testing constraints | Requirements inherited by future implementation: Testing |
