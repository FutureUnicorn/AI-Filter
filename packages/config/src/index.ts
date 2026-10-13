import { z } from "zod";

export const APP_ENVIRONMENTS = [
  "development",
  "test",
  "preview",
  "staging",
  "production"
] as const;

export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

/**
 * The environments that have a terminal a developer can actually read, and
 * are therefore allowed to deliver magic links through the local console
 * sender. Everything else in APP_ENVIRONMENTS is hosted -- including
 * `preview`, which is a per-PR/per-SHA deployment, not a workstation.
 *
 * Mirrors LOCAL_CONSOLE_ENVIRONMENTS in packages/security. The two are
 * separate because packages/security must not depend on packages/config
 * (see dependency-cruiser.config.cjs); an architecture test asserts they
 * stay identical so they cannot drift.
 */
export const LOCAL_CONSOLE_ENVIRONMENTS: readonly AppEnvironment[] = ["development", "test"];

/** True for every environment that must use a real delivery adapter. */
export function isHostedEnvironment(appEnv: AppEnvironment): boolean {
  return !LOCAL_CONSOLE_ENVIRONMENTS.includes(appEnv);
}

const booleanValue = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const portValue = z.coerce.number().int().min(1).max(65_535);
const optionalPreviewId = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().regex(/^pr-[1-9][0-9]*$/u).optional()
);
const optionalPreviewCommitSha = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().regex(/^[a-f0-9]{7,64}$/u).optional()
);

// Outbound magic-link email delivery. Optional in the schema and then
// REQUIRED for staging/production by the superRefine below, so a hosted
// deployment that forgets them fails at config load rather than silently
// falling back to the local console sender -- which is exactly how a
// hosted environment ended up minting sign-in tokens that nothing could
// deliver and nobody could redeem.
//
// Deliberately vendor-neutral: an endpoint, a bearer key and a from
// address are what Resend, Postmark, SendGrid and Mailgun all accept, so
// packages/security keeps its "no vendor is chosen by this ticket"
// position instead of taking a dependency on one provider's SDK.
/**
 * An absolute http(s) origin and nothing else: no path, query or fragment. A
 * value like `https://app.example/redeem` would silently produce
 * `https://app.example/redeem/auth/redeem?token=...`, so the shape is pinned
 * here rather than trusted to the caller.
 */
const optionalOrigin = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string()
    .url()
    .refine((value) => {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return false;
      }
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        (parsed.pathname === "" || parsed.pathname === "/") &&
        parsed.search === "" &&
        parsed.hash === "" &&
        parsed.username === "" &&
        parsed.password === ""
      );
    }, "PUBLIC_APP_ORIGIN must be a bare http(s) origin with no path, query, fragment or credentials")
    .transform((value) => new URL(value).origin)
    .optional()
);

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional()
);
const optionalSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().trim().min(1).optional()
);
const optionalEmailAddress = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().email().optional()
);

const rawEnvironmentSchema = z
  .object({
    APP_ENV: z.enum(APP_ENVIRONMENTS),
    DEPLOYMENT_COMMIT_SHA: z.string().trim().min(1),
    DATABASE_URL: z.string().url().refine(
      (value) => value.startsWith("postgresql://") || value.startsWith("postgres://"),
      "DATABASE_URL must use the postgres or postgresql scheme"
    ),
    DATABASE_SCHEMA: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/u, "DATABASE_SCHEMA must be a safe PostgreSQL identifier"),
    STORAGE_ENDPOINT: z.string().url(),
    STORAGE_REGION: z.string().trim().min(1),
    STORAGE_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u, "STORAGE_BUCKET must be S3-compatible"),
    STORAGE_ACCESS_KEY_ID: z.string().trim().min(1),
    STORAGE_SECRET_ACCESS_KEY: z.string().min(12),
    STORAGE_FORCE_PATH_STYLE: booleanValue,
    WEB_PORT: portValue,
    WORKER_PORT: portValue,
    PREVIEW_ID: optionalPreviewId,
    PREVIEW_COMMIT_SHA: optionalPreviewCommitSha,
    /**
     * The canonical public origin this deployment is reached at, used to build
     * links that are emailed to people.
     *
     * Not derived from the incoming request. Review (#83) found that building
     * a magic-link URL from `new URL(request.url).origin` lets an
     * unauthenticated caller choose the host: a request submitted for a victim
     * with `Host: attacker.example` produces a real, signed link pointing at
     * the attacker, and the victim clicking it hands over a redeemable bearer
     * token. The request host is attacker-controlled input; this is not.
     */
    PUBLIC_APP_ORIGIN: optionalOrigin,
    MAGIC_LINK_EMAIL_ENDPOINT: optionalUrl,
    MAGIC_LINK_EMAIL_API_KEY: optionalSecret,
    MAGIC_LINK_EMAIL_FROM: optionalEmailAddress
  })
  .superRefine((value, context) => {
    // A hosted environment has no terminal for anyone to read, so the
    // console sender cannot deliver there. Requiring the delivery
    // settings here means the failure is a startup config error naming
    // the missing variable, not a 202 for a link that never arrives.
    //
    // `preview` counts as hosted, which review (#28) caught: an earlier
    // revision listed only staging and production, so a preview
    // deployment with no delivery settings loaded cleanly and then wrote
    // the raw recipient address and bearer link to the stderr of a hosted
    // process. Preview is a per-PR/per-SHA deployment here -- it even
    // derives its own database schema -- not a developer terminal.
    //
    // Derived by exclusion rather than by listing the hosted names, so an
    // environment added to APP_ENVIRONMENTS later is hosted by default
    // instead of silently skipping this requirement.
    if (!LOCAL_CONSOLE_ENVIRONMENTS.includes(value.APP_ENV)) {
      for (const field of [
        "MAGIC_LINK_EMAIL_ENDPOINT",
        "MAGIC_LINK_EMAIL_API_KEY",
        "MAGIC_LINK_EMAIL_FROM"
      ] as const) {
        if (value[field] === undefined) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: `${field} is required for ${value.APP_ENV}; a hosted environment cannot deliver magic links through the local console sender`
          });
        }
      }
      // A hosted deployment must state its own public origin. Falling back to
      // the request host is what made emailed links attacker-steerable, so
      // there is deliberately no fallback here: the deployment fails to boot
      // rather than sending a link to a host it was told at request time.
      if (value.PUBLIC_APP_ORIGIN === undefined) {
        context.addIssue({
          code: "custom",
          path: ["PUBLIC_APP_ORIGIN"],
          message: `PUBLIC_APP_ORIGIN is required for ${value.APP_ENV}; emailed links must come from a configured origin, never from the incoming request host`
        });
      }
    }
    if (value.APP_ENV === "preview") {
      if (value.PREVIEW_ID === undefined) {
        context.addIssue({
          code: "custom",
          path: ["PREVIEW_ID"],
          message: "PREVIEW_ID is required for preview"
        });
      }
      if (value.PREVIEW_COMMIT_SHA === undefined) {
        context.addIssue({
          code: "custom",
          path: ["PREVIEW_COMMIT_SHA"],
          message: "PREVIEW_COMMIT_SHA is required for preview"
        });
      }
      if (
        value.PREVIEW_COMMIT_SHA !== undefined &&
        !value.DEPLOYMENT_COMMIT_SHA.startsWith(value.PREVIEW_COMMIT_SHA)
      ) {
        context.addIssue({
          code: "custom",
          path: ["DEPLOYMENT_COMMIT_SHA"],
          message: "preview deployment must identify the preview commit"
        });
      }
    }
  });

export interface EnvironmentConfig {
  readonly appEnv: AppEnvironment;
  readonly deploymentCommitSha: string;
  readonly database: {
    readonly url: string;
    readonly schema: string;
  };
  readonly storage: {
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly forcePathStyle: boolean;
  };
  readonly ports: {
    readonly web: number;
    readonly worker: number;
  };
  /**
   * The origin to use when building a link that leaves the system. Always
   * present: configured explicitly for a hosted environment (enforced by the
   * schema), and derived from the local web port for development and test.
   * Never taken from an incoming request.
   */
  readonly publicAppOrigin: string;
  readonly preview?: {
    readonly id: string;
    readonly commitSha: string;
  };
  /**
   * Present whenever outbound magic-link email is configured, and
   * guaranteed present for staging/production by the schema above. Its
   * absence is what selects the local console sender, so this being
   * optional is the whole environment decision, not a convenience.
   */
  readonly magicLinkEmail?: {
    readonly endpoint: string;
    readonly apiKey: string;
    readonly from: string;
  };
}

export type InferenceBudgetPeriod = "day" | "month";

export interface WorkerProcessingConfig {
  readonly enabled: boolean;
  readonly workerId?: string;
  readonly openAi?: {
    readonly apiKey: string;
    readonly defaultModel: string;
    readonly escalationModel: string;
  };
  readonly budget?: {
    readonly maxTokensPerPeriod: number;
    readonly alertThresholdRatio: number;
    readonly period: InferenceBudgetPeriod;
    readonly estimatedOutputTokens: number;
  };
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  readonly heartbeatIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly retryBaseDelayMs: number;
  readonly maxAttempts: number;
}

export function loadEvidenceExtractionQueueConfig(source: EnvironmentSource): {
  readonly maxAttempts: number;
} {
  const parsed = optionalPositiveInteger.safeParse(source["WORKER_MAX_ATTEMPTS"]);
  if (!parsed.success) {
    throw new Error("Invalid queue configuration: WORKER_MAX_ATTEMPTS must be a positive integer");
  }
  return { maxAttempts: parsed.data ?? 3 };
}

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export const OBSERVABILITY_SERVICES = ["web", "worker"] as const;
export type ObservabilityService = (typeof OBSERVABILITY_SERVICES)[number];

const optionalDsn = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().refine((value) => value.startsWith("https://"), "SENTRY_DSN must use https").optional()
);
const optionalTraceSampleRate = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.coerce.number().min(0).max(1).optional()
);

const monitoringEnvironmentSchema = z
  .object({
    APP_ENV: z.enum(APP_ENVIRONMENTS),
    DEPLOYMENT_COMMIT_SHA: z.string().trim().min(1),
    SENTRY_DSN: optionalDsn,
    SENTRY_TRACES_SAMPLE_RATE: optionalTraceSampleRate
  })
  .superRefine((value, context) => {
    if (isHostedEnvironment(value.APP_ENV) && value.SENTRY_DSN === undefined) {
      context.addIssue({
        code: "custom",
        path: ["SENTRY_DSN"],
        message: `SENTRY_DSN is required for ${value.APP_ENV}; hosted monitoring cannot be silently disabled`
      });
    }
    if (value.SENTRY_DSN !== undefined && value.SENTRY_TRACES_SAMPLE_RATE === undefined) {
      context.addIssue({
        code: "custom",
        path: ["SENTRY_TRACES_SAMPLE_RATE"],
        message: "SENTRY_TRACES_SAMPLE_RATE is required when Sentry is enabled; sampling must be an explicit operations decision"
      });
    }
  });

export interface MonitoringConfig {
  readonly enabled: boolean;
  readonly service: ObservabilityService;
  readonly environment: AppEnvironment;
  readonly release: string;
  readonly dsn?: string;
  readonly tracesSampleRate?: number;
}

/**
 * Runtime monitoring identity and enablement. Development and test can run
 * without a Sentry account; every hosted environment fails closed if its
 * service-specific DSN was not mapped to SENTRY_DSN by the deployment.
 */
export function loadMonitoringConfig(
  source: EnvironmentSource,
  service: ObservabilityService
): MonitoringConfig {
  const parsed = monitoringEnvironmentSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid monitoring configuration: ${details}`);
  }
  return {
    enabled: parsed.data.SENTRY_DSN !== undefined,
    service,
    environment: parsed.data.APP_ENV,
    release: parsed.data.DEPLOYMENT_COMMIT_SHA,
    ...(parsed.data.SENTRY_DSN === undefined ? {} : { dsn: parsed.data.SENTRY_DSN }),
    ...(parsed.data.SENTRY_TRACES_SAMPLE_RATE === undefined
      ? {}
      : { tracesSampleRate: parsed.data.SENTRY_TRACES_SAMPLE_RATE })
  };
}

export function loadEnvironmentConfig(source: EnvironmentSource): EnvironmentConfig {
  const parsed = rawEnvironmentSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  const value = parsed.data;
  return {
    appEnv: value.APP_ENV,
    deploymentCommitSha: value.DEPLOYMENT_COMMIT_SHA,
    database: {
      url: value.DATABASE_URL,
      schema: value.DATABASE_SCHEMA
    },
    storage: {
      endpoint: value.STORAGE_ENDPOINT,
      region: value.STORAGE_REGION,
      bucket: value.STORAGE_BUCKET,
      accessKeyId: value.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: value.STORAGE_SECRET_ACCESS_KEY,
      forcePathStyle: value.STORAGE_FORCE_PATH_STYLE
    },
    ports: {
      web: value.WEB_PORT,
      worker: value.WORKER_PORT
    },
    // Hosted environments must configure this; the schema refuses to load
    // without it. Development and test fall back to the local web port, which
    // is a fixed local value rather than anything a request can influence.
    publicAppOrigin: value.PUBLIC_APP_ORIGIN ?? `http://localhost:${value.WEB_PORT}`,
    ...(value.PREVIEW_ID !== undefined && value.PREVIEW_COMMIT_SHA !== undefined
      ? {
          preview: {
            id: value.PREVIEW_ID,
            commitSha: value.PREVIEW_COMMIT_SHA
          }
        }
      : {}),
    ...(value.MAGIC_LINK_EMAIL_ENDPOINT !== undefined &&
    value.MAGIC_LINK_EMAIL_API_KEY !== undefined &&
    value.MAGIC_LINK_EMAIL_FROM !== undefined
      ? {
          magicLinkEmail: {
            endpoint: value.MAGIC_LINK_EMAIL_ENDPOINT,
            apiKey: value.MAGIC_LINK_EMAIL_API_KEY,
            from: value.MAGIC_LINK_EMAIL_FROM
          }
        }
      : {})
  };
}

const optionalNonEmpty = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.string().trim().min(1).optional()
);
const optionalPositiveInteger = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.coerce.number().int().positive().optional()
);
const optionalWorkerConcurrency = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.coerce.number().int().positive().max(16).optional()
);
const optionalRatio = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.coerce.number().min(0).max(1).optional()
);

const workerProcessingSchema = z
  .object({
    WORKER_PROCESSING_ENABLED: z.preprocess(
      (value) => (value === "" || value === undefined ? "false" : value),
      booleanValue
    ),
    WORKER_INSTANCE_ID: z.preprocess(
      (value) => (value === "" || value === undefined ? undefined : value),
      z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u).optional()
    ),
    OPENAI_API_KEY: optionalNonEmpty,
    OPENAI_MODEL: optionalNonEmpty,
    OPENAI_ESCALATION_MODEL: optionalNonEmpty,
    INFERENCE_MAX_TOKENS_PER_PERIOD: optionalPositiveInteger,
    INFERENCE_ALERT_THRESHOLD_RATIO: optionalRatio,
    INFERENCE_BUDGET_PERIOD: z.preprocess(
      (value) => (value === "" || value === undefined ? undefined : value),
      z.enum(["day", "month"]).optional()
    ),
    INFERENCE_ESTIMATED_OUTPUT_TOKENS: optionalPositiveInteger,
    WORKER_CONCURRENCY: optionalWorkerConcurrency,
    WORKER_POLL_INTERVAL_MS: optionalPositiveInteger,
    WORKER_HEARTBEAT_INTERVAL_MS: optionalPositiveInteger,
    WORKER_LEASE_DURATION_MS: optionalPositiveInteger,
    WORKER_RETRY_BASE_DELAY_MS: optionalPositiveInteger,
    WORKER_MAX_ATTEMPTS: optionalPositiveInteger
  })
  .superRefine((value, context) => {
    if (!value.WORKER_PROCESSING_ENABLED) {
      return;
    }
    for (const field of [
      "WORKER_INSTANCE_ID",
      "OPENAI_API_KEY",
      "OPENAI_MODEL",
      "OPENAI_ESCALATION_MODEL",
      "INFERENCE_MAX_TOKENS_PER_PERIOD",
      "INFERENCE_ALERT_THRESHOLD_RATIO",
      "INFERENCE_BUDGET_PERIOD"
    ] as const) {
      if (value[field] === undefined) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required when WORKER_PROCESSING_ENABLED=true`
        });
      }
    }
    const lease = value.WORKER_LEASE_DURATION_MS ?? 60_000;
    const heartbeat = value.WORKER_HEARTBEAT_INTERVAL_MS ?? 10_000;
    if (heartbeat * 2 >= lease) {
      context.addIssue({
        code: "custom",
        path: ["WORKER_HEARTBEAT_INTERVAL_MS"],
        message: "heartbeat interval must be less than half the lease duration"
      });
    }
  });

export function loadWorkerProcessingConfig(source: EnvironmentSource): WorkerProcessingConfig {
  const parsed = workerProcessingSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid worker processing configuration: ${details}`);
  }
  const value = parsed.data;
  const base = {
    enabled: value.WORKER_PROCESSING_ENABLED,
    concurrency: value.WORKER_CONCURRENCY ?? 1,
    pollIntervalMs: value.WORKER_POLL_INTERVAL_MS ?? 1_000,
    heartbeatIntervalMs: value.WORKER_HEARTBEAT_INTERVAL_MS ?? 10_000,
    leaseDurationMs: value.WORKER_LEASE_DURATION_MS ?? 60_000,
    retryBaseDelayMs: value.WORKER_RETRY_BASE_DELAY_MS ?? 5_000,
    maxAttempts: value.WORKER_MAX_ATTEMPTS ?? 3
  } as const;
  if (!value.WORKER_PROCESSING_ENABLED) {
    return base;
  }
  return {
    ...base,
    workerId: value.WORKER_INSTANCE_ID!,
    openAi: {
      apiKey: value.OPENAI_API_KEY!,
      defaultModel: value.OPENAI_MODEL!,
      escalationModel: value.OPENAI_ESCALATION_MODEL!
    },
    budget: {
      maxTokensPerPeriod: value.INFERENCE_MAX_TOKENS_PER_PERIOD!,
      alertThresholdRatio: value.INFERENCE_ALERT_THRESHOLD_RATIO!,
      period: value.INFERENCE_BUDGET_PERIOD!,
      estimatedOutputTokens: value.INFERENCE_ESTIMATED_OUTPUT_TOKENS ?? 2_000
    }
  };
}

export function assertDestructiveOperationAllowed(
  appEnv: AppEnvironment,
  operation: string
): void {
  if (appEnv === "production" || appEnv === "staging") {
    throw new Error(`${operation} is forbidden in ${appEnv}`);
  }
}

export function assertSyntheticDataAllowed(appEnv: AppEnvironment): void {
  if (appEnv === "production") {
    throw new Error("Synthetic development fixtures must never be seeded in production");
  }
}

export interface EnvironmentIdentity {
  readonly name: AppEnvironment;
  readonly databaseBoundary: string;
  readonly storageBoundary: string;
  readonly credentialIdentity: string;
}

export function assertEnvironmentIsolation(
  environments: readonly EnvironmentIdentity[]
): void {
  for (const property of [
    "databaseBoundary",
    "storageBoundary",
    "credentialIdentity"
  ] as const) {
    const seen = new Map<string, AppEnvironment>();
    for (const environment of environments) {
      const previous = seen.get(environment[property]);
      if (previous !== undefined) {
        throw new Error(
          `${property} is shared by ${previous} and ${environment.name}; environments must be isolated`
        );
      }
      seen.set(environment[property], environment.name);
    }
  }
}

export function publicEnvironmentSummary(config: EnvironmentConfig): {
  appEnv: AppEnvironment;
  deploymentCommitSha: string;
  previewId?: string;
} {
  return {
    appEnv: config.appEnv,
    deploymentCommitSha: config.deploymentCommitSha,
    ...(config.preview === undefined ? {} : { previewId: config.preview.id })
  };
}
