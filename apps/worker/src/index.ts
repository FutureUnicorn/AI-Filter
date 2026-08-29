import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";

import { loadEnvironmentConfig, publicEnvironmentSummary } from "@signal-audit/config";
import { checkDatabaseConnection } from "@signal-audit/db";
import { DOMAIN_LAYER_NAME } from "@signal-audit/domain";
import { checkStorageConnection } from "@signal-audit/ingestion";
import { logStructured } from "@signal-audit/security";

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
    } catch {
      logStructured("error", "worker.environment_health_failed");
      response.writeHead(503, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json"
      });
      response.end(JSON.stringify({ status: "unavailable" }));
    }
  });
}

const entryPath = process.argv[1];

if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  startWorker();
  const config = loadEnvironmentConfig(process.env);
  createWorkerHealthServer().listen(config.ports.worker, "0.0.0.0", () => {
    logStructured("info", "worker.health_listening");
  });
}
