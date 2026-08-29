"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

interface SourceCitation {
  readonly document: string;
  readonly pageOrSection: string;
  readonly offset: number;
  readonly quote: string;
}

interface CardCitation {
  readonly role: "supporting" | "conflicting" | "rejected";
  readonly citation: SourceCitation;
}

interface CorrectionProvenance {
  readonly correctedByUserId: string;
  readonly reason: string;
  readonly correctedAt: string;
  readonly previousKind: string;
  readonly previousCitations: readonly CardCitation[];
}

interface EvidenceCard {
  readonly criterionId: string;
  readonly kind: string;
  readonly citations: readonly CardCitation[];
  readonly correction?: CorrectionProvenance;
  readonly verifiable: boolean;
  readonly explanation?: string;
  readonly recordedAt: string;
}

interface WorkflowStatus {
  readonly status: "undecided" | "advance" | "hold" | "decline";
  readonly decidedByUserId?: string;
  readonly rationale?: string;
  readonly decidedAt?: string;
  readonly revisionCount?: number;
}

interface EvidenceCardSet {
  readonly applicationId: string;
  readonly cards: readonly EvidenceCard[];
  readonly verifiableCount: number;
  readonly unverifiableCount: number;
}

type CardState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly cards: EvidenceCardSet };

const CITATION_ROLE_LABELS: Readonly<Record<CardCitation["role"], string>> = {
  supporting: "Quoted evidence",
  conflicting: "Conflicting evidence",
  rejected: "Rejected by citation validation — not evidence"
};

/**
 * AF-48: criterion, state, exact quote and source, for one application.
 *
 * What this cannot do yet, said plainly rather than faked. The ticket
 * asks for the quote "shown beside the original application document".
 * There is no application-to-document link in the schema: applications
 * are created from a CSV import (AF-32), and canonical text extraction
 * (AF-30) runs only on pdf/docx intakes, which nothing associates with a
 * candidate. So the source shown here is the citation's own document,
 * page/section and offset -- everything needed to find the passage by
 * hand, but not the passage rendered next to it. Linking a candidate to
 * their resume document is real, unticketed work, and inventing a
 * plausible-looking side-by-side view over data that does not exist
 * would be worse than saying so.
 *
 * A rejected citation is deliberately still shown, labelled as rejected.
 * That is how a recruiter sees the system caught a hallucination rather
 * than the criterion quietly disappearing.
 *
 * AF-49: a corrected card shows what it was corrected FROM, on the card
 * itself, not behind a link to a history. The original AI output is
 * never overwritten in the database, and a reviewer who has to go
 * looking for the before state is a reviewer who will not check it.
 */
export default function EvidenceCardPage() {
  const params = useParams<{ roleId: string; applicationId: string }>();
  const { roleId, applicationId } = params;
  const [state, setState] = useState<CardState>({ kind: "loading" });
  const [workflow, setWorkflow] = useState<WorkflowStatus | undefined>(undefined);

  useEffect(() => {
    if (roleId === undefined || applicationId === undefined) {
      setState({ kind: "error", message: "Missing roleId or applicationId in the URL." });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    fetch(
      `/api/roles/${encodeURIComponent(roleId)}/applications/${encodeURIComponent(applicationId)}/evidence`,
      { headers: { Accept: "application/json" } }
    )
      .then(async (response) => {
        const body = (await response.json()) as Partial<EvidenceCardSet> & { error?: { message: string } };
        if (cancelled) return;
        if (!response.ok) {
          setState({ kind: "error", message: body.error?.message ?? `Request failed (${response.status}).` });
          return;
        }
        setState({
          kind: "ready",
          cards: {
            applicationId: body.applicationId ?? applicationId,
            cards: body.cards ?? [],
            verifiableCount: body.verifiableCount ?? 0,
            unverifiableCount: body.unverifiableCount ?? 0
          }
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ kind: "error", message: error instanceof Error ? error.message : "Request failed." });
      });
    // AF-51: the workflow status is read from the decision log, which is
    // the only thing that holds it. Deliberately a separate request:
    // failing to load a status must not blank the evidence, and failing
    // to load evidence must not imply a candidate is undecided.
    fetch(
      `/api/roles/${encodeURIComponent(roleId)}/applications/${encodeURIComponent(applicationId)}/decisions`,
      { headers: { Accept: "application/json" } }
    )
      .then(async (response) => (response.ok ? ((await response.json()) as WorkflowStatus) : undefined))
      .then((value) => {
        if (!cancelled) setWorkflow(value);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [roleId, applicationId]);

  return (
    <main>
      <p className="eyebrow">Evidence</p>
      <h1>Evidence for this application</h1>

      {workflow !== undefined && (
        <p>
          <strong>Workflow status:</strong>{" "}
          {workflow.status === "undecided"
            ? "No decision recorded yet"
            : `${workflow.status} — recorded by ${workflow.decidedByUserId ?? "unknown"} on ${workflow.decidedAt ?? "unknown"}`}
          {workflow.status !== "undecided" && workflow.rationale !== undefined && (
            <>
              <br />
              <small>Rationale: {workflow.rationale}</small>
            </>
          )}
          {workflow.revisionCount !== undefined && workflow.revisionCount > 0 && (
            <>
              <br />
              <small>
                Revised {workflow.revisionCount} {workflow.revisionCount === 1 ? "time" : "times"}; every earlier
                decision is kept.
              </small>
            </>
          )}
        </p>
      )}

      {state.kind === "loading" && <p>Loading evidence…</p>}
      {state.kind === "error" && <p role="alert">Could not load evidence: {state.message}</p>}

      {state.kind === "ready" && (
        <>
          <p>
            {state.cards.cards.length} rubric {state.cards.cards.length === 1 ? "criterion" : "criteria"} ·{" "}
            {state.cards.verifiableCount} with a quote you can verify · {state.cards.unverifiableCount} with nothing
            to verify.
          </p>
          <p>
            <small>
              Source is shown as the citation&rsquo;s own document, section and character offset. The original
              document is not rendered beside it: nothing in the schema links a candidate to their source file yet.
            </small>
          </p>

          {state.cards.cards.map((card) => (
            <article key={card.criterionId} aria-label={`Evidence for ${card.criterionId}`}>
              <h2>{card.criterionId}</h2>
              <p>
                <strong>State:</strong> {card.kind}
                {card.correction !== undefined && <> · corrected by a reviewer</>}
              </p>
              {card.explanation !== undefined && <p>{card.explanation}</p>}

              {card.correction !== undefined && (
                <aside aria-label={`Correction history for ${card.criterionId}`}>
                  <p>
                    <strong>Corrected from &ldquo;{card.correction.previousKind}&rdquo;</strong> on{" "}
                    {card.correction.correctedAt} by {card.correction.correctedByUserId}.
                  </p>
                  <p>Reason: {card.correction.reason}</p>
                  {card.correction.previousCitations.length > 0 && (
                    <>
                      <p>
                        <small>What the original AI output quoted — kept, never overwritten:</small>
                      </p>
                      {card.correction.previousCitations.map((entry, index) => (
                        <figure key={`${card.criterionId}-before-${index}`}>
                          <blockquote cite={entry.citation.document}>{entry.citation.quote}</blockquote>
                          <p>
                            <small>
                              {entry.citation.document} · {entry.citation.pageOrSection} · character offset{" "}
                              {entry.citation.offset}
                            </small>
                          </p>
                        </figure>
                      ))}
                    </>
                  )}
                </aside>
              )}

              {card.citations.length === 0 ? (
                <p>
                  <em>Nothing to verify for this criterion.</em>
                </p>
              ) : (
                card.citations.map((entry, index) => (
                  <figure key={`${card.criterionId}-${entry.role}-${index}`}>
                    <figcaption>{CITATION_ROLE_LABELS[entry.role]}</figcaption>
                    <blockquote cite={entry.citation.document}>{entry.citation.quote}</blockquote>
                    <p>
                      <small>
                        {entry.citation.document} · {entry.citation.pageOrSection} · character offset{" "}
                        {entry.citation.offset}
                      </small>
                    </p>
                  </figure>
                ))
              )}
            </article>
          ))}
        </>
      )}
    </main>
  );
}
