import { z } from "zod";

export const APP_ENVIRONMENTS = [
  "development",
  "test",
  "preview",
  "staging",
  "production"
] as const;

export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

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
    MAGIC_LINK_EMAIL_ENDPOINT: optionalUrl,
    MAGIC_LINK_EMAIL_API_KEY: optionalSecret,
    MAGIC_LINK_EMAIL_FROM: optionalEmailAddress
  })
  .superRefine((value, context) => {
    // A hosted environment has no terminal for anyone to read, so the
    // console sender cannot deliver there. Requiring the delivery
    // settings here means the failure is a startup config error naming
    // the missing variable, not a 202 for a link that never arrives.
    if (value.APP_ENV === "staging" || value.APP_ENV === "production") {
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

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

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
