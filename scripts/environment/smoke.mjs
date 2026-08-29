import {
  assertSyntheticDataAllowed,
  loadEnvironmentConfig,
  publicEnvironmentSummary
} from "../../packages/config/dist/index.js";
import {
  checkDatabaseConnection,
  verifySyntheticDatabaseFixture
} from "../../packages/db/dist/index.js";
import {
  checkStorageConnection,
  verifySyntheticStorageRoundTrip
} from "../../packages/ingestion/dist/index.js";

const config = loadEnvironmentConfig(process.env);
await Promise.all([
  checkDatabaseConnection(config.database.url, config.database.schema),
  checkStorageConnection(config.storage)
]);

if (config.appEnv !== "production") {
  assertSyntheticDataAllowed(config.appEnv);
  await Promise.all([
    verifySyntheticDatabaseFixture(config.database.url, config.database.schema),
    verifySyntheticStorageRoundTrip(config.storage, `${config.appEnv}/af-11`)
  ]);
}

console.log(JSON.stringify({ status: "ok", environment: publicEnvironmentSummary(config) }));
