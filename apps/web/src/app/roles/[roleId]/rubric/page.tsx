"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { scanCriterionForProtectedCharacteristicProxy } from "@signal-audit/domain";
import type { ProtectedCharacteristicFlag } from "@signal-audit/domain";

const MIN_CRITERIA = 5;
const MAX_CRITERIA = 10;

interface EditableCriterion {
  readonly criterionId: string;
  description: string;
  evidenceGuidance: string;
}

interface RubricResponse {
  readonly rubricId: string;
  readonly version: number;
  readonly status: "draft" | "published";
  readonly criteria: readonly EditableCriterion[];
}

function blankCriterion(): EditableCriterion {
  return { criterionId: crypto.randomUUID(), description: "", evidenceGuidance: "" };
}

function blankDraft(): EditableCriterion[] {
  return Array.from({ length: MIN_CRITERIA }, blankCriterion);
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly status: "draft" | "published" | "new" };

/**
 * AF-26: the rubric editor. Each criterion is scanned live for
 * protected-characteristic proxy phrasing (packages/domain's
 * scanCriterionForProtectedCharacteristicProxy) -- this flags for the
 * employer to look at, it never blocks saving. Only a draft can be
 * edited here; a published rubric's criteria are shown read-only (AF-27
 * owns the actual immutability enforcement server-side, this UI just
 * doesn't offer inputs for it).
 */
export default function RubricEditorPage() {
  const roleId = useParams<{ roleId: string }>().roleId;
  const [criteria, setCriteria] = useState<EditableCriterion[]>(blankDraft());
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/roles/${roleId}/rubric`, { headers: { Accept: "application/json" } })
      .then(async (response) => {
        if (cancelled) return;
        if (response.status === 404) {
          setCriteria(blankDraft());
          setState({ kind: "ready", status: "new" });
          return;
        }
        const body = (await response.json()) as RubricResponse & { error?: { message: string } };
        if (!response.ok) {
          setState({ kind: "error", message: body.error?.message ?? `Request failed (${response.status}).` });
          return;
        }
        setCriteria(body.criteria.map((c) => ({ ...c })));
        setState({ kind: "ready", status: body.status });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ kind: "error", message: error instanceof Error ? error.message : "Request failed." });
      });
    return () => {
      cancelled = true;
    };
  }, [roleId]);

  const readOnly = state.kind === "ready" && state.status === "published";

  function updateField(criterionId: string, field: "description" | "evidenceGuidance", value: string) {
    setCriteria((prev) => prev.map((c) => (c.criterionId === criterionId ? { ...c, [field]: value } : c)));
  }

  function addCriterion() {
    setCriteria((prev) => (prev.length >= MAX_CRITERIA ? prev : [...prev, blankCriterion()]));
  }

  function removeCriterion(criterionId: string) {
    setCriteria((prev) => (prev.length <= MIN_CRITERIA ? prev : prev.filter((c) => c.criterionId !== criterionId)));
  }

  async function save() {
    setSaving(true);
    setSaveError(undefined);
    try {
      const response = await fetch(`/api/roles/${roleId}/rubric`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          criteria: criteria.map(({ criterionId, description, evidenceGuidance }) => ({
            criterionId,
            description,
            evidenceGuidance
          }))
        })
      });
      const body = (await response.json()) as RubricResponse & { error?: { message: string } };
      if (!response.ok) {
        setSaveError(body.error?.message ?? `Save failed (${response.status}).`);
        return;
      }
      setState({ kind: "ready", status: body.status });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  /**
   * AF-27: a named human approves and freezes this version. approvedBy
   * is never chosen client-side -- the server sets it from the session,
   * this button only triggers the call.
   */
  async function publish() {
    setPublishing(true);
    setPublishError(undefined);
    try {
      const response = await fetch(`/api/roles/${roleId}/rubric/publish`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() }
      });
      const body = (await response.json()) as RubricResponse & { error?: { message: string } };
      if (!response.ok) {
        setPublishError(body.error?.message ?? `Publish failed (${response.status}).`);
        return;
      }
      setCriteria(body.criteria.map((c) => ({ ...c })));
      setState({ kind: "ready", status: body.status });
    } catch (error) {
      setPublishError(error instanceof Error ? error.message : "Publish failed.");
    } finally {
      setPublishing(false);
    }
  }

  const canPublish = state.kind === "ready" && state.status === "draft";

  return (
    <main>
      <p className="eyebrow">Rubric</p>
      <h1>Evaluation criteria</h1>

      {state.kind === "loading" && <p>Loading…</p>}
      {state.kind === "error" && <p role="alert">Could not load the rubric: {state.message}</p>}

      {state.kind === "ready" && (
        <>
          {readOnly && <p role="status">This rubric is published and read-only. Editing starts a new version.</p>}

          {criteria.map((criterion, index) => (
            <CriterionEditor
              key={criterion.criterionId}
              index={index}
              criterion={criterion}
              readOnly={readOnly}
              canRemove={!readOnly && criteria.length > MIN_CRITERIA}
              onChange={(field, value) => updateField(criterion.criterionId, field, value)}
              onRemove={() => removeCriterion(criterion.criterionId)}
            />
          ))}

          {!readOnly && (
            <p>
              <button type="button" onClick={addCriterion} disabled={criteria.length >= MAX_CRITERIA}>
                Add criterion
              </button>{" "}
              <span>
                {criteria.length} of {MAX_CRITERIA} max ({MIN_CRITERIA} minimum)
              </span>
            </p>
          )}

          {!readOnly && (
            <p>
              <button type="button" onClick={save} disabled={saving || criteria.length < MIN_CRITERIA}>
                {saving ? "Saving…" : "Save draft"}
              </button>
            </p>
          )}
          {saveError !== undefined && <p role="alert">{saveError}</p>}

          {canPublish && (
            <p>
              <button type="button" onClick={publish} disabled={publishing}>
                {publishing ? "Publishing…" : "Approve and publish"}
              </button>{" "}
              <span>Freezes this version. Further changes start a new one.</span>
            </p>
          )}
          {publishError !== undefined && <p role="alert">{publishError}</p>}
        </>
      )}
    </main>
  );
}

function flagSummary(flags: readonly ProtectedCharacteristicFlag[]): string {
  const categories = [...new Set(flags.map((flag) => flag.category.replaceAll("_", " ")))];
  return `Reads like a possible ${categories.join(", ")} proxy. Double-check this criterion measures a real job requirement.`;
}

function CriterionEditor({
  index,
  criterion,
  readOnly,
  canRemove,
  onChange,
  onRemove
}: {
  index: number;
  criterion: EditableCriterion;
  readOnly: boolean;
  canRemove: boolean;
  onChange: (field: "description" | "evidenceGuidance", value: string) => void;
  onRemove: () => void;
}) {
  const flags = [
    ...scanCriterionForProtectedCharacteristicProxy(criterion.description),
    ...scanCriterionForProtectedCharacteristicProxy(criterion.evidenceGuidance)
  ];

  return (
    <fieldset>
      <legend>Criterion {index + 1}</legend>
      <label>
        What is being evaluated
        <textarea
          value={criterion.description}
          onChange={(event) => onChange("description", event.target.value)}
          readOnly={readOnly}
          rows={2}
        />
      </label>
      <label>
        What counts as evidence for it
        <textarea
          value={criterion.evidenceGuidance}
          onChange={(event) => onChange("evidenceGuidance", event.target.value)}
          readOnly={readOnly}
          rows={2}
        />
      </label>
      {flags.length > 0 && <p role="alert">{flagSummary(flags)}</p>}
      {canRemove && (
        <button type="button" onClick={onRemove}>
          Remove
        </button>
      )}
    </fieldset>
  );
}
