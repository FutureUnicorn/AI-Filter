import { loadEnvironmentConfig, publicEnvironmentSummary } from "@signal-audit/config";
import { checkDatabaseConnection } from "@signal-audit/db";
import { checkStorageConnection } from "@signal-audit/ingestion";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function componentResult(result: PromiseSettledResult<unknown>): "ok" | "unavailable" {
  return result.status === "fulfilled" ? "ok" : "unavailable";
}

export async function GET(): Promise<Response> {
  try {
    const config = loadEnvironmentConfig(process.env);
    const [database, storage] = await Promise.allSettled([
      checkDatabaseConnection(config.database.url, config.database.schema),
      checkStorageConnection(config.storage)
    ]);
    const healthy = database.status === "fulfilled" && storage.status === "fulfilled";

    return Response.json(
      {
        status: healthy ? "ok" : "unavailable",
        environment: publicEnvironmentSummary(config),
        components: {
          database: componentResult(database),
          storage: componentResult(storage)
        }
      },
      {
        status: healthy ? 200 : 503,
        headers: { "Cache-Control": "no-store" }
      }
    );
  } catch (error) {
    console.error("Environment health check failed", error);
    return Response.json(
      {
        status: "misconfigured",
        components: { database: "unknown", storage: "unknown" }
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
