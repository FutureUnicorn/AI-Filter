"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { APPLICATION_IMPORT_FIELDS, REQUIRED_APPLICATION_IMPORT_FIELDS } from "@signal-audit/domain";
import type { ApplicationImportField } from "@signal-audit/domain";

interface FileIntakeResponse {
  readonly status: string;
  readonly declaredFilename: string;
  readonly sniffedMimeType?: string;
}

interface ImportStatusResponse {
  readonly status: "waiting" | "finalized";
  readonly totalRows: number;
  readonly processedCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
  readonly waitingCount: number;
}

type Mapping = Partial<Record<ApplicationImportField, string>>;

interface StoredAttempt {
  readonly idempotencyKey: string;
  readonly mapping: Mapping;
}

function storageKey(intakeId: string): string {
  return `af-33-import-attempt:${intakeId}`;
}

function loadStoredAttempt(intakeId: string): StoredAttempt | undefined {
  try {
    const raw = window.localStorage.getItem(storageKey(intakeId));
    return raw === null ? undefined : (JSON.parse(raw) as StoredAttempt);
  } catch {
    return undefined;
  }
}

function saveStoredAttempt(intakeId: string, attempt: StoredAttempt): void {
  window.localStorage.setItem(storageKey(intakeId), JSON.stringify(attempt));
}

function mappingToRequestBody(mapping: Mapping): { mapping: { field: ApplicationImportField; csvColumnHeader: string }[] } {
  return {
    mapping: APPLICATION_IMPORT_FIELDS.filter((field) => (mapping[field] ?? "").length > 0).map((field) => ({
      field,
      csvColumnHeader: mapping[field] as string
    }))
  };
}

/**
 * AF-33: the "waiting" bucket here is not an in-progress queue --
 * AF-32's finalize is one atomic transaction, so a CSV is either not
 * finalized yet (every row "waiting") or fully finalized (every row is
 * processed, failed, or skipped). "Retry" is just re-calling finalize:
 * safe because AF-32 already treats a repeat of the same idempotency
 * key and mapping as a replay, not a re-import.
 */
export default function ImportStatusPage() {
  return (
    <Suspense fallback={<main><p>Loading…</p></main>}>
      <ImportStatus />
    </Suspense>
  );
}

function ImportStatus() {
  const roleId = useParams<{ roleId: string }>().roleId;
  const intakeId = useSearchParams().get("intakeId");

  const [intake, setIntake] = useState<FileIntakeResponse | undefined>(undefined);
  const [status, setStatus] = useState<ImportStatusResponse | undefined>(undefined);
  const [headers, setHeaders] = useState<readonly string[] | undefined>(undefined);
  const [mapping, setMapping] = useState<Mapping>({});
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const headersFetchedRef = useRef(false);

  const load = useCallback(async () => {
    if (intakeId === null) return;
    try {
      const [intakeResponse, statusResponse] = await Promise.all([
        fetch(`/api/roles/${roleId}/files/${intakeId}`, { headers: { Accept: "application/json" } }),
        fetch(`/api/roles/${roleId}/files/${intakeId}/import-status`, { headers: { Accept: "application/json" } })
      ]);
      const intakeBody = (await intakeResponse.json()) as FileIntakeResponse & { error?: { message: string } };
      if (!intakeResponse.ok) {
        setLoadError(intakeBody.error?.message ?? `Request failed (${intakeResponse.status}).`);
        return;
      }
      setIntake(intakeBody);

      if (statusResponse.ok) {
        setStatus((await statusResponse.json()) as ImportStatusResponse);
      } else {
        setStatus(undefined);
      }

      if (!headersFetchedRef.current) {
        const previewResponse = await fetch(`/api/roles/${roleId}/files/${intakeId}/csv-preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        });
        if (previewResponse.ok) {
          const previewBody = (await previewResponse.json()) as { headers: readonly string[] };
          headersFetchedRef.current = true;
          setHeaders(previewBody.headers);
        }
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Request failed.");
    }
  }, [roleId, intakeId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (intakeId === null) return;
    const stored = loadStoredAttempt(intakeId);
    if (stored !== undefined) {
      setMapping(stored.mapping);
    }
  }, [intakeId]);

  async function runImport(reuseStored: boolean) {
    if (intakeId === null) return;
    setRunning(true);
    setActionError(undefined);
    try {
      const stored = reuseStored ? loadStoredAttempt(intakeId) : undefined;
      const attempt: StoredAttempt = stored ?? { idempotencyKey: crypto.randomUUID(), mapping };
      saveStoredAttempt(intakeId, attempt);

      const response = await fetch(`/api/roles/${roleId}/files/${intakeId}/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.idempotencyKey },
        body: JSON.stringify(mappingToRequestBody(attempt.mapping))
      });
      const body = (await response.json()) as { error?: { message: string } };
      if (!response.ok) {
        setActionError(body.error?.message ?? `Import failed (${response.status}).`);
        return;
      }
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setRunning(false);
    }
  }

  if (intakeId === null) {
    return (
      <main>
        <p role="alert">Missing intakeId in the URL.</p>
      </main>
    );
  }
  if (loadError !== undefined) {
    return (
      <main>
        <p role="alert">Could not load this import: {loadError}</p>
      </main>
    );
  }
  if (intake === undefined) {
    return (
      <main>
        <p>Loading…</p>
      </main>
    );
  }

  const hasStoredAttempt = loadStoredAttempt(intakeId) !== undefined;

  return (
    <main>
      <p className="eyebrow">Import</p>
      <h1>{intake.declaredFilename}</h1>

      {status === undefined && (
        <p role="alert">
          This file is not ready to import yet (status: {intake.status}). It must be validated as a CSV file first.
        </p>
      )}

      {status !== undefined && (
        <>
          <ul>
            <li>Waiting: {status.waitingCount}</li>
            <li>Processed: {status.processedCount}</li>
            <li>Failed: {status.failedCount}</li>
            <li>Skipped: {status.skippedCount}</li>
            <li>Total rows: {status.totalRows}</li>
          </ul>

          {status.status === "waiting" && (
            <fieldset>
              <legend>Map CSV columns</legend>
              {headers === undefined && <p>Loading columns…</p>}
              {headers !== undefined &&
                APPLICATION_IMPORT_FIELDS.map((field) => (
                  <label key={field} style={{ display: "block" }}>
                    {field}
                    {REQUIRED_APPLICATION_IMPORT_FIELDS.includes(field) ? " (required)" : " (optional)"}
                    <select
                      value={mapping[field] ?? ""}
                      onChange={(event) =>
                        setMapping((prev) => ({ ...prev, [field]: event.target.value || undefined }))
                      }
                    >
                      <option value="">(not mapped)</option>
                      {headers.map((header) => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              <p>
                <button type="button" onClick={() => runImport(false)} disabled={running}>
                  {running ? "Importing…" : "Run import"}
                </button>
              </p>
            </fieldset>
          )}

          {status.status === "finalized" && (
            <p>
              <button type="button" onClick={() => runImport(true)} disabled={running || !hasStoredAttempt}>
                {running ? "Retrying…" : "Retry"}
              </button>{" "}
              {status.failedCount > 0 && (
                <a href={`/api/roles/${roleId}/files/${intakeId}/import-errors`}>Download error list</a>
              )}
            </p>
          )}
        </>
      )}

      {actionError !== undefined && <p role="alert">{actionError}</p>}
    </main>
  );
}
