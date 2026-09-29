"use client";

import { useEffect, useRef } from "react";

import { beginReviewTiming, recordReviewActivity, sealReviewTiming } from "@signal-audit/domain";
import type { ReviewTimingSpanDraft, ReviewTimingState } from "@signal-audit/domain";

/**
 * AF-54: the thin glue that turns a recruiter reviewing a candidate into
 * a recorded span.
 *
 * Same split as AF-53's keyboard hook, for the same reason: no jsdom in
 * this repository, so nothing decided in here can be tested. Every rule
 * about what counts -- the idle cutoff, what an interruption does to a
 * span, when a span is not worth sending, what endedAt means -- lives in
 * packages/domain and is covered exhaustively in tests/unit. This file
 * subscribes to events, reads the clock, and sends. If a timing question
 * ever gets answered here instead, the unit tests stop describing the
 * behaviour while still passing, which is the failure mode
 * tests/architecture/review-timing-wiring.test.ts exists to catch.
 *
 * Only the per-application review surface uses this. The queue listing
 * is not a candidate being reviewed, and time spent scanning a list is
 * not time spent on any one application -- attributing it to whichever
 * row happened to be focused would invent a measurement.
 */

/**
 * What counts as the reviewer still being here. Pointer movement is
 * included deliberately: reading a candidate for two minutes without
 * clicking, typing or scrolling is ordinary, and without it that review
 * would be truncated and dropped from the median.
 */
const ACTIVITY_EVENTS = ["keydown", "pointerdown", "pointermove", "wheel", "scroll"] as const;

export interface ReviewTimingOptions {
  readonly roleId: string | undefined;
  readonly applicationId: string | undefined;
}

export function useReviewTiming(options: ReviewTimingOptions): void {
  const { roleId, applicationId } = options;
  // A ref, not state: pointer movement must not re-render the page it is
  // measuring.
  const stateRef = useRef<ReviewTimingState | undefined>(undefined);

  useEffect(() => {
    if (roleId === undefined || applicationId === undefined) {
      return;
    }
    const endpoint = `/api/roles/${encodeURIComponent(roleId)}/applications/${encodeURIComponent(
      applicationId
    )}/timing`;
    stateRef.current = beginReviewTiming(Date.now());

    function send(draft: ReviewTimingSpanDraft): void {
      // keepalive rather than navigator.sendBeacon: a beacon cannot set
      // Content-Type: application/json without wrapping the body in a
      // Blob, and keepalive survives the document being torn down, which
      // is when most spans are sent.
      //
      // Failures are swallowed on purpose. A lost measurement must never
      // become an error in front of a recruiter mid-review; the server
      // logs the ones it rejects.
      void fetch(endpoint, {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startedAt: new Date(draft.startedAtMs).toISOString(),
          endedAt: new Date(draft.endedAtMs).toISOString(),
          activeMs: draft.activeMs,
          truncatedByIdle: draft.truncatedByIdle
        })
      }).catch(() => undefined);
    }

    function onActivity(): void {
      const current = stateRef.current;
      if (current === undefined) {
        return;
      }
      const transition = recordReviewActivity(current, Date.now());
      stateRef.current = transition.state;
      if (transition.completed !== undefined) {
        send(transition.completed);
      }
    }

    function flush(): void {
      const current = stateRef.current;
      if (current === undefined) {
        return;
      }
      // Cleared before sending, so the unmount that follows a pagehide
      // cannot send the same span twice.
      stateRef.current = undefined;
      const draft = sealReviewTiming(current, Date.now());
      if (draft !== undefined) {
        send(draft);
      }
    }

    function onVisibilityChange(): void {
      if (document.visibilityState === "hidden") {
        flush();
        return;
      }
      if (stateRef.current === undefined) {
        // Coming back is a new visit rather than a continuation of the
        // old one. Adding the visits up is summarizeReviewTiming's job,
        // and it is the reason that function sums per application before
        // taking a median.
        stateRef.current = beginReviewTiming(Date.now());
      }
    }

    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, onActivity, { passive: true });
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", flush);

    return () => {
      for (const name of ACTIVITY_EVENTS) {
        window.removeEventListener(name, onActivity);
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [roleId, applicationId]);
}
