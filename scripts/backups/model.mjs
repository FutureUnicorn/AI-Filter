const HOSTED_ENVIRONMENTS = new Set(["staging", "production"]);
const SAFE_BUCKET_NAME = /^(?!.*\.\.)(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const SAFE_REGION = /^[a-z0-9][a-z0-9-]{0,62}$/u;

function required(source, name) {
  const value = source[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required when hosted backups are enabled`);
  }
  return value;
}

function positiveInteger(source, name) {
  const value = required(source, name);
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe integer`);
  }
  return String(parsed);
}

function secureEndpoint(source) {
  const raw = required(source, "BACKUP_ENDPOINT");
  let endpoint;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("BACKUP_ENDPOINT must be a valid URL");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error("BACKUP_ENDPOINT must be an HTTPS origin without credentials, query, or fragment");
  }
  if (endpoint.pathname !== "/") {
    throw new Error("BACKUP_ENDPOINT must not contain a path");
  }
  return endpoint.origin;
}

export function requireBackupControls(appEnv, source) {
  if (!HOSTED_ENVIRONMENTS.has(appEnv)) {
    return { enabled: false, variables: {} };
  }

  const enabledValue = source.BACKUP_ENABLED?.trim() || "false";
  if (enabledValue !== "true" && enabledValue !== "false") {
    throw new Error("BACKUP_ENABLED must be true or false");
  }
  if (enabledValue === "false") {
    return { enabled: false, variables: { BACKUP_ENABLED: "false" } };
  }

  const bucket = required(source, "BACKUP_BUCKET");
  if (!SAFE_BUCKET_NAME.test(bucket)) {
    throw new Error("BACKUP_BUCKET must be a valid S3 bucket name");
  }
  const region = required(source, "BACKUP_REGION");
  if (!SAFE_REGION.test(region)) {
    throw new Error("BACKUP_REGION must be a safe region identifier");
  }
  const pathStyle = source.BACKUP_PATH_STYLE?.trim() || "auto";
  if (!new Set(["auto", "on", "off"]).has(pathStyle)) {
    throw new Error("BACKUP_PATH_STYLE must be auto, on, or off");
  }
  const accessKeyId = required(source, "BACKUP_ACCESS_KEY_ID");
  const secretAccessKey = source.BACKUP_SECRET_ACCESS_KEY;
  if (secretAccessKey === undefined || secretAccessKey.length < 20) {
    throw new Error("BACKUP_SECRET_ACCESS_KEY must be at least 20 characters");
  }

  return {
    enabled: true,
    variables: {
      BACKUP_ENABLED: "true",
      BACKUP_ENDPOINT: secureEndpoint(source),
      BACKUP_REGION: region,
      BACKUP_BUCKET: bucket,
      BACKUP_ACCESS_KEY_ID: accessKeyId,
      BACKUP_SECRET_ACCESS_KEY: secretAccessKey,
      BACKUP_INTERVAL_SECONDS: positiveInteger(source, "BACKUP_INTERVAL_SECONDS"),
      BACKUP_RETENTION_DAYS: positiveInteger(source, "BACKUP_RETENTION_DAYS"),
      BACKUP_PATH_STYLE: pathStyle,
      BACKUP_CONTROL_OWNER: required(source, "BACKUP_CONTROL_OWNER"),
      BACKUP_ENCRYPTION_REFERENCE: required(source, "BACKUP_ENCRYPTION_REFERENCE")
    }
  };
}
