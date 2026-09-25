import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";

import { createOpenAiAdapter } from "@signal-audit/ai";
import {
  loadEnvironmentConfig,
  loadWorkerProcessingConfig,
  publicEnvironmentSummary
} from "@signal-audit/config";
import {
  checkDatabaseConnection,
  closeDatabasePools,
  getInferenceKillSwitchStatus
} from "@signal-audit/db";
import { DOMAIN_LAYER_NAME } from "@signal-audit/domain";
import { checkStorageConnection } from "@signal-audit/ingestion";
import { describeError, logStructured } from "@signal-audit/security";
import { runEvidenceExtractionWorker } from "./extraction.ts";
import { captureWorkerError } from "./observability.ts";

export {
  InferenceBudgetCappedError,
  executeBudgetedInference
} from "./inference.ts";
export type { BudgetedInferenceInput } from "./inference.ts";
export {
  processEvidenceExtractionJob,
  processNextEvidenceExtractionJob,
  runEvidenceExtractionWorker
} from "./extraction.ts";
export type { EvidenceExtractionWorkerDependencies } from "./extraction.ts";

export function startWorker(): string {
  const message = `Signal Audit worker ready; dependency center=${DOMAIN_LAYER_NAME}`;
  logStructured("info", "worker.ready");
  return message;
}

export async function runEnvironmentSmokeCheck(
  source: Readonly<Record<string, string | undefined>> = process.env
): Promise<{
  readonly status: "ok";
  readonly environment: ReturnType<typeof publicEnvironmentSummary>;
}> {
  const config = loadEnvironmentConfig(source);
  await Promise.all([
    checkDatabaseConnection(config.database.url, config.database.schema),
    checkStorageConnection(config.storage)
  ]);
  return {
    status: "ok",
    environment: publicEnvironmentSummary(config)
  };
}

export function createWorkerHealthServer(
  source: Readonly<Record<string, string | undefined>> = process.env
): Server {
  return createServer(async (request, response) => {
    if (request.method !== "GET" || request.url !== "/health/environment") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "not_found" }));
      return;
    }

    try {
      const result = await runEnvironmentSmokeCheck(source);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json"
      });
      response.end(JSON.stringify(result));
    } catch (error) {
      const diagnostic = describeError(error);
      logStructured("error", "worker.environment_health_failed", {
        errorName: diagnostic.errorName,
        errorCode: diagnostic.errorCode,
        statusCode: 503
      });
      response.writeHead(503, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json"
      });
      response.end(JSON.stringify({ status: "unavailable" }));
    }
  });
}

const entryPath = process.argv[1];

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

/**
 * Leases and heartbeats identify one running process, not a deployment-wide
 * label. The configured value remains a recognizable prefix while the boot
 * suffix prevents two replicas (or a restarted replica) sharing ownership.
 */
export function createWorkerRuntimeId(
  configuredWorkerId: string,
  bootId: string = randomUUID()
): string {
  const safeBootId = bootId.replace(/[^A-Za-z0-9._:-]/gu, "");
  if (safeBootId.length === 0 || safeBootId.length > 64) {
    throw new Error("Worker boot identity must contain safe machine-identity characters");
  }
  const prefix = configuredWorkerId.slice(0, 128 - safeBootId.length - 1);
  if (prefix.length === 0) {
    throw new Error("Configured worker identity cannot be empty");
  }
  return `${prefix}:${safeBootId}`;
}

async function main(): Promise<void> {
  startWorker();
  const environment = loadEnvironmentConfig(process.env);
  const processing = loadWorkerProcessingConfig(process.env);
  const server = createWorkerHealthServer();
  const abortController = new AbortController();

  server.once("error", (error) => {
    captureWorkerError(error, "worker.startup");
    process.exitCode = 1;
    abortController.abort();
  });
  server.listen(environment.ports.worker, "0.0.0.0", () => {
    logStructured("info", "worker.health_listening");
  });

  let processingLoop: Promise<void> | undefined;
  if (processing.enabled) {
    if (processing.workerId === undefined || processing.openAi === undefined || processing.budget === undefined) {
      throw new Error("Enabled worker processing configuration was not fully validated");
    }
    const openAi = processing.openAi;
    const runtimeWorkerId = createWorkerRuntimeId(processing.workerId);
    const adapters = new Map<string, ReturnType<typeof createOpenAiAdapter>>();
    processingLoop = runEvidenceExtractionWorker(
      {
        databaseUrl: environment.database.url,
        schema: environment.database.schema,
        config: {
          ...processing,
          enabled: true,
          workerId: runtimeWorkerId,
          openAi: processing.openAi,
          budget: processing.budget
        },
        adapterForModel(model) {
          const existing = adapters.get(model);
          if (existing !== undefined) return existing;
          const created = createOpenAiAdapter({
            apiKey: openAi.apiKey,
            model,
            checkKillSwitch: () =>
              getInferenceKillSwitchStatus(environment.database.url, environment.database.schema)
          });
          adapters.set(model, created);
          return created;
        }
      },
      abortController.signal
    ).catch((error: unknown) => {
      captureWorkerError(error, "worker.job");
      process.exitCode = 1;
      abortController.abort();
    });
    logStructured("info", "worker.processing_started");
  } else {
    logStructured("info", "worker.processing_disabled");
  }

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      abortController.abort();
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    abortController.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await Promise.allSettled([
    processingLoop ?? Promise.resolve(),
    closeServer(server),
    closeDatabasePools()
  ]);
}

if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().catch((error: unknown) => {
    captureWorkerError(error, "worker.startup");
    process.exitCode = 1;
  });
}
