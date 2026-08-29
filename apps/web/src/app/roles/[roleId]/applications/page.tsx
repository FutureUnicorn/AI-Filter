"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { ShortcutHelp } from "../../../../lib/ShortcutHelp";
import { useReviewKeyboard } from "../../../../lib/review-keyboard";

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
  readonly appliedStates: readonly QueueEntry["evidenceState"][];
  readonly shownCount: number;
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

const FILTERABLE_STATES: readonly QueueEntry["evidenceState"][] = ["pending_extraction", "extracted"];

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
 * AF-45: the recruiter's main working view for a role.
 *
 * Two things are deliberately absent rather than mocked. There is no
 * per-criterion evidence verdict column, because nothing persists
 * EvidenceOutcome yet -- only whether an extraction run happened. And
 * there are no filters: AF-47 owns those, so inventing them here would
 * be work that ticket then has to undo.
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
  const router = useRouter();
  const entries = state.kind === "ready" ? state.queue.entries : [];
  // AF-53: keyboard navigation over the rows actually shown, so the
  // count follows AF-47's filters rather than the whole role.
  const { focusedIndex, helpVisible } = useReviewKeyboard({
    itemCount: entries.length,
    onOpen: (index) => {
      const target = entries[index];
      if (target !== undefined && roleId !== undefined) {
        router.push(
          `/roles/${encodeURIComponent(roleId)}/applications/${encodeURIComponent(target.application.applicationId)}`
        );
      }
    }
  });

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
      <p>
        <small>Keyboard: j/k to move, Enter to open, ? for all shortcuts.</small>
      </p>
      <ShortcutHelp visible={helpVisible} />

      {state.kind === "loading" && <p>Loading applications…</p>}
      {state.kind === "error" && <p role="alert">Could not load the review queue: {state.message}</p>}

      {state.kind === "ready" && (
        <>
          <p>
            {state.queue.appliedStates.length === 0
              ? `${state.queue.totalCount} imported ${state.queue.totalCount === 1 ? "application" : "applications"}`
              : `Showing ${state.queue.shownCount} of ${state.queue.totalCount}`}{" "}
            · {state.queue.extractedCount} with evidence extracted · {state.queue.pendingExtractionCount} not yet
            processed.
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
                ranked, scored or prioritised — there is no score to sort by. Evidence state reflects whether
                extraction has run; per-criterion verdicts are not stored yet, so none are shown.
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
                {state.queue.entries.map((entry, index) => (
                  <tr
                    key={entry.application.applicationId}
                    aria-selected={index === focusedIndex}
                    // A focus ring the mouse user never sees is the point:
                    // keyboard review is unusable if you cannot tell which
                    // row you are on.
                    style={index === focusedIndex ? { outline: "2px solid" } : undefined}
                  >
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
