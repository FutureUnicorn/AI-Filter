# Product boundary

This file exists so that no one — including an AI coding assistant working in this repo later — accidentally builds past the current validated scope. Read this before adding a feature.

## Never build, regardless of stage

| Feature | Reason |
|---|---|
| AI-writing / AI-generated-text detector | Unreliable, evadable, discriminatory risk for non-native writers. No vendor in this market has hit 90% consistency. Structurally wrong, not just premature. |
| Automatic rejection, ranking, or a candidate score | Legal and false-negative exposure. Collapses distinct evidence into an unchallengeable label. A human makes every consequential decision. |
| Face, voice, emotion, or personality inference | Weak validity, unacceptable trust burden. |
| Cross-employer blacklist, reputation score, or public-data enrichment graph | This is the exact fact pattern of a live FCRA lawsuit (Eightfold) — tracking a candidate across employers and furnishing an evaluation to third parties can make you a "consumer reporting agency" under FCRA, with dispute/accuracy/adverse-action obligations this project cannot absorb. Every rubric, application, and evidence result stays scoped to one employer. |
| Universal government ID / biometric verification | Privacy, accessibility, and conversion damage; not needed to answer "does the evidence support this criterion." |

## Do not build yet (gated behind evidence, not time)

| Feature | Unlocks when |
|---|---|
| Hosted web app, database, auth | After 3 paid pilots with repeat/expand intent |
| ATS integration | After 10 paid customers, 5 naming the same ATS friction, 3 committing to the same ATS |
| Reusable rubric templates as a product feature | After 10 similar-role rubrics show they're actually repeatable |
| Automated candidate-proof invitations | After manual completion rates and complaint rates are measured and acceptable |
| Any dashboard / analytics UI | Not needed to prove the core hypothesis |
| RAG, vector database, or autonomous agents | One application + one rubric fits deterministic retrieval; these add failure modes without improving the core test |

## Full context

The reasoning behind every line above lives in the validation diligence memo this repo was built from — see the project owner's records if you need the underlying research (competitive landscape, regulatory exposure, gate thresholds). This file is the operational summary; treat it as binding until a gate above is actually met, not just discussed.
