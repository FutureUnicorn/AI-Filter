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
  readonly evidenceState: "pending_extraction" | "queued" | "processing" | "extraction_failed" | "extracted";
  readonly extractionRunCount: number;
  readonly lastExtractionAt?: string;
  readonly job?: {
    readonly state: "ready" | "running" | "completed" | "failed";
    readonly attemptCount: number;
    readonly maxAttempts: number;
    readonly failureCode?: string;
  };
}

interface ReviewQueue {
  readonly roleId: string;
  readonly totalCount: number;
  readonly pendingExtractionCount: number;
  readonly queuedCount: number;
  readonly processingCount: number;
  readonly extractionFailedCount: number;
  readonly extractedCount: number;
  readonly appliedStates: readonly QueueEntry["evidenceState"][];
  readonly shownCount: number;
  readonly entries: readonly QueueEntry[];
}

type QueueState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly queue: ReviewQueue };

const EVIDENCE_STATE_LABELS: Readonly<Record<QueueEntry["evidenceState"], string>> = {
  pending_extraction: "Not yet queued",
  queued: "Queued",
  processing: "Processing",
  extraction_failed: "Extraction failed",
  extracted: "Evidence extracted"
};

// Lifecycle order, matching APPLICATION_EVIDENCE_STATES in @signal-audit/domain.
const FILTERABLE_STATES: readonly QueueEntry["evidenceState"][] = [
  "pending_extraction",
  "queued",
  "processing",
  "extraction_failed",
  "extracted"
];

/**
 * What a recruiter needs to know about the attempts behind a state: a
 * queued job that has already failed once is retrying, not new, and a
 * failed one is not going to finish on its own. The failure code is a
 * closed machine token (0026's CHECK), never provider text.
 */
function describeJob(entry: QueueEntry): string {
  const job = entry.job;
  if (job === undefined) return "Never queued";
  const attempts = `attempt ${job.attemptCount} of ${job.maxAttempts}`;
  if (job.state === "failed") return `Gave up after ${attempts}${job.failureCode ? ` (${job.failureCode})` : ""}`;
  if (job.state === "ready" && job.attemptCount > 0) {
    return `Retrying after ${attempts}${job.failureCode ? ` (${job.failureCode})` : ""}`;
  }
  if (job.state === "running") return `Running, ${attempts}`;
  return job.state === "ready" ? "Waiting for a worker" : `Finished, ${attempts}`;
}

/**
 * AF-47 names four filters. Three of them cannot be answered from
 * anything stored: incomplete, contradiction and error are per-criterion
 * EvidenceOutcome kinds, and nothing persists those. They are shown
 * disabled with the reason rather than omitted, because a recruiter who
 * filters for contradictions and gets an empty list would reasonably
 * conclude there are none -- offering a filter that quietly matches
 * nothing is worse than not offering it.
 */
const UNAVAILABLE_FILTERS: readonly string[] = ["Incomplete", "Contradiction", "Error"];

/**
 * AF-45: the recruiter's main working view for a role. Each row shows
 * where the application is in processing (not queued, queued, processing,
 * failed, extracted) from AF-102's job table, plus the attempts behind it.
 * There is still no per-criterion verdict column: that is the evidence
 * card's job, and a processing state must never read as a verdict.
 *
 * AF-47: filters are explicit checkboxes that name the state they
 * select, and the counts they are compared against stay whole, so the
 * screen can always say how much a filter is hiding. The three states
 * the ticket names that nothing persists are shown disabled with the
 * reason, not omitted.
 *
 * AF-46: the order is the employer's own file order, and the caption
 * says so out loud. That is a product guarantee, not an implementation
 * detail -- a recruiter has to be able to tell that this list is not
 * quietly ranked, and the only way to tell from a screen is to be told.
 */
export default function ApplicationReviewQueuePage() {
  const params = useParams<{ roleId: string }>();
  const roleId = params.roleId;
  const [state, setState] = useState<QueueState>({ kind: "loading" });
  const [selected, setSelected] = useState<readonly QueueEntry["evidenceState"][]>([]);

  useEffect(() => {
    if (roleId === undefined) {
      setState({ kind: "error", message: "Missing roleId in the URL." });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    const query = selected.map((value) => `state=${encodeURIComponent(value)}`).join("&");
    fetch(`/api/roles/${encodeURIComponent(roleId)}/applications${query === "" ? "" : `?${query}`}`, {
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
            queuedCount: body.queuedCount ?? 0,
            processingCount: body.processingCount ?? 0,
            extractionFailedCount: body.extractionFailedCount ?? 0,
            extractedCount: body.extractedCount ?? 0,
            appliedStates: body.appliedStates ?? [],
            shownCount: body.shownCount ?? 0,
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
  }, [roleId, selected]);

  const toggle = (value: QueueEntry["evidenceState"]): void => {
    setSelected((current) =>
      current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value]
    );
  };

  return (
    <main>
      <p className="eyebrow">Review queue</p>
      <h1>Applications</h1>

      {state.kind === "loading" && <p>Loading applications…</p>}
      {state.kind === "error" && <p role="alert">Could not load the review queue: {state.message}</p>}

      {state.kind === "ready" && (
        <>
          <p>
            {state.queue.appliedStates.length === 0
              ? `${state.queue.totalCount} imported ${state.queue.totalCount === 1 ? "application" : "applications"}`
              : `Showing ${state.queue.shownCount} of ${state.queue.totalCount}`}{" "}
            · {state.queue.extractedCount} extracted · {state.queue.processingCount} processing ·{" "}
            {state.queue.queuedCount} queued · {state.queue.extractionFailedCount} failed ·{" "}
            {state.queue.pendingExtractionCount} not yet queued.
          </p>

          <fieldset>
            <legend>Filter by state</legend>
            {FILTERABLE_STATES.map((value) => (
              <label key={value}>
                <input type="checkbox" checked={selected.includes(value)} onChange={() => toggle(value)} />{" "}
                {EVIDENCE_STATE_LABELS[value]}
              </label>
            ))}
            {UNAVAILABLE_FILTERS.map((label) => (
              <label key={label} title="Needs per-criterion evidence outcomes, which are not stored yet.">
                <input type="checkbox" disabled />
                {" "}
                {label} <span aria-hidden="true">—</span>{" "}
                <small>not available yet: per-criterion evidence outcomes are not stored</small>
              </label>
            ))}
          </fieldset>

          {state.queue.totalCount === 0 ? (
            <p>No applications imported for this role yet.</p>
          ) : state.queue.shownCount === 0 ? (
            <p>
              No applications match this filter. {state.queue.totalCount} are hidden by it — clear the filter to see
              them.
            </p>
          ) : (
            <table>
              <caption>
                Every imported application for this role, in the order the file was uploaded in. This queue is never
                ranked, scored or prioritised. There is no score to sort by. Evidence state is where the application
                is in processing; it is never a verdict about the candidate.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col">Candidate</th>
                  <th scope="col">Email</th>
                  <th scope="col">Evidence state</th>
                  <th scope="col">Attempts</th>
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
                    <td>{describeJob(entry)}</td>
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
