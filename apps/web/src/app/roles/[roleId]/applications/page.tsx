"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

interface QueueApplication {
  readonly applicationId: string;
  readonly sourceRowNumber: number;
  readonly candidateFullName: string;
  readonly candidateEmail: string;
  readonly externalReferenceId?: string;
  readonly appliedAt?: string;
  readonly createdAt: string;
}

interface QueueEntry {
  readonly application: QueueApplication;
  readonly evidenceState: "pending_extraction" | "extracted";
  readonly extractionRunCount: number;
  readonly lastExtractionAt?: string;
}

interface ReviewQueue {
  readonly roleId: string;
  readonly totalCount: number;
  readonly pendingExtractionCount: number;
  readonly extractedCount: number;
  readonly entries: readonly QueueEntry[];
}

type QueueState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly queue: ReviewQueue };

const EVIDENCE_STATE_LABELS: Readonly<Record<QueueEntry["evidenceState"], string>> = {
  pending_extraction: "Not yet processed",
  extracted: "Evidence extracted"
};

/**
 * AF-45: the recruiter's main working view for a role.
 *
 * Two things are deliberately absent rather than mocked. There is no
 * per-criterion evidence verdict column, because nothing persists
 * EvidenceOutcome yet -- only whether an extraction run happened.
 * And there are no filters or ordering controls: AF-46 owns applicant
 * ordering and AF-47 owns state filters, so inventing either here would
 * be work those tickets then have to undo. This shows the honest state
 * and the counts, and says plainly what it cannot yet tell you.
 */
export default function ApplicationReviewQueuePage() {
  const params = useParams<{ roleId: string }>();
  const roleId = params.roleId;
  const [state, setState] = useState<QueueState>({ kind: "loading" });

  useEffect(() => {
    if (roleId === undefined) {
      setState({ kind: "error", message: "Missing roleId in the URL." });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    fetch(`/api/roles/${encodeURIComponent(roleId)}/applications`, {
      headers: { Accept: "application/json" }
    })
      .then(async (response) => {
        const body = (await response.json()) as Partial<ReviewQueue> & { error?: { message: string } };
        if (cancelled) return;
        if (!response.ok) {
          setState({ kind: "error", message: body.error?.message ?? `Request failed (${response.status}).` });
          return;
        }
        setState({
          kind: "ready",
          queue: {
            roleId: body.roleId ?? roleId,
            totalCount: body.totalCount ?? 0,
            pendingExtractionCount: body.pendingExtractionCount ?? 0,
            extractedCount: body.extractedCount ?? 0,
            entries: body.entries ?? []
          }
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ kind: "error", message: error instanceof Error ? error.message : "Request failed." });
      });
    return () => {
      cancelled = true;
    };
  }, [roleId]);

  return (
    <main>
      <p className="eyebrow">Review queue</p>
      <h1>Applications</h1>

      {state.kind === "loading" && <p>Loading applications…</p>}
      {state.kind === "error" && <p role="alert">Could not load the review queue: {state.message}</p>}

      {state.kind === "ready" && (
        <>
          <p>
            {state.queue.totalCount} imported {state.queue.totalCount === 1 ? "application" : "applications"} ·{" "}
            {state.queue.extractedCount} with evidence extracted · {state.queue.pendingExtractionCount} not yet
            processed.
          </p>

          {state.queue.totalCount === 0 ? (
            <p>No applications imported for this role yet.</p>
          ) : (
            <table>
              <caption>
                Every imported application for this role, in import order. Evidence state reflects whether extraction
                has run — per-criterion verdicts are not stored yet, so none are shown.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col">Candidate</th>
                  <th scope="col">Email</th>
                  <th scope="col">Evidence state</th>
                  <th scope="col">Last extraction</th>
                </tr>
              </thead>
              <tbody>
                {state.queue.entries.map((entry) => (
                  <tr key={entry.application.applicationId}>
                    <td>{entry.application.sourceRowNumber}</td>
                    <td>{entry.application.candidateFullName}</td>
                    <td>{entry.application.candidateEmail}</td>
                    <td>{EVIDENCE_STATE_LABELS[entry.evidenceState]}</td>
                    <td>{entry.lastExtractionAt ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </main>
  );
}
