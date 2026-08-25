import { createHash, randomBytes } from "node:crypto";

import { buildApiError } from "@signal-audit/contracts";
import type { ApiErrorResponse, BoundaryContract, RequestId } from "@signal-audit/contracts";
import { roleHasCapability } from "@signal-audit/domain";
import type {
  Capability,
  DomainPort,
  MagicLinkEmailSender,
  MagicLinkInvite,
  MagicLinkRedemptionAttempt,
  MagicLinkVerification,
  Membership,
  MembershipRole
} from "@signal-audit/domain";

/** Auth and authorization vendors will remain outside the domain here. */
export interface SecurityAdapterBoundary {
  readonly contract: BoundaryContract;
  readonly domain: DomainPort;
}

// ---- AF-16: invite-only magic-link authentication ----
//
// Everything here is pure: no database, no network, no email provider.
// packages/db owns the atomic single-use redemption SQL; the caller
// (a future endpoint) wires this decision logic to that query and to a
// real MagicLinkEmailSender adapter. No vendor is chosen by this ticket.

const TOKEN_BYTES = 32;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export interface GeneratedMagicLinkToken {
  /** Raw, single-use secret. Send it in the link; never persist it as-is. */
  readonly token: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export function hashMagicLinkToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateMagicLinkToken(
  now: Date = new Date(),
  ttlMs: number = DEFAULT_TTL_MS
): GeneratedMagicLinkToken {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return {
    token,
    tokenHash: hashMagicLinkToken(token),
    expiresAt: new Date(now.getTime() + ttlMs)
  };
}

function buildValidOutcome(email: string, invite: MagicLinkInvite | undefined): MagicLinkVerification {
  return invite === undefined ? { outcome: "valid", email } : { outcome: "valid", email, invite };
}

/**
 * Pure decision over a redemption attempt packages/db already made
 * atomically. `justRedeemed` distinguishes "this call validly consumed
 * the token" from "some earlier call already did" -- a distinction that
 * cannot be recovered from `record` alone once `consumedAt` is set.
 */
export function verifyMagicLinkToken(
  attempt: MagicLinkRedemptionAttempt,
  now: Date = new Date()
): MagicLinkVerification {
  const { record } = attempt;
  if (record === undefined) {
    return { outcome: "not_found" };
  }
  if (attempt.justRedeemed) {
    return buildValidOutcome(record.email, record.invite);
  }
  if (record.consumedAt !== undefined) {
    return { outcome: "already_consumed" };
  }
  if (record.expiresAt.getTime() <= now.getTime()) {
    return { outcome: "expired" };
  }
  // Not consumed, not expired, yet the atomic UPDATE still didn't match:
  // a boundary race right at expiry. Report the safe, retryable reason.
  return { outcome: "expired" };
}

/** Dev-only adapter: records that a link was queued. Never logs the recipient or raw token. */
export function createConsoleMagicLinkEmailSender(): MagicLinkEmailSender {
  return {
    async sendMagicLink(): Promise<void> {
      logStructured("info", "magic_link.queued");
    }
  };
}

// ---- AF-19: server-side resource authorization ----
//
// "Never trust a client-supplied organization/job ID alone" means: the
// role used for the capability check comes only from a membership row
// this function was handed (fetched server-side for the authenticated
// user), never from anything the request itself claims. A request that
// asks for an organizationId the caller has no membership row for is
// treated exactly like a request for an organization that doesn't
// exist, not "found but forbidden" -- see resourceAuthorizationErrorResponse.

/**
 * Explicit, non-collapsing outcomes: "no membership" (this
 * organizationId isn't one of the caller's, whether or not it even
 * exists) and "insufficient capability" (it is the caller's
 * organization, but their role there doesn't cover this action) are
 * structurally distinct, not one generic "forbidden".
 */
export type ResourceAuthorization =
  | { readonly outcome: "authorized"; readonly role: MembershipRole }
  | { readonly outcome: "no_membership" }
  | { readonly outcome: "insufficient_capability"; readonly role: MembershipRole };

function canonicalizeUuid(value: string): string {
  return value.toLowerCase();
}

/**
 * `memberships` must be fetched server-side. The check is bound to
 * `authenticatedUserId`: a row for a different user is ignored even if
 * it is in the array, and UUID letter-case is not treated as a
 * different identity.
 */
export function authorizeResourceAccess(
  memberships: readonly Membership[],
  organizationId: string,
  capability: Capability,
  authenticatedUserId: string
): ResourceAuthorization {
  const callerId = canonicalizeUuid(authenticatedUserId);
  const requestedOrgId = canonicalizeUuid(organizationId);
  const membership = memberships.find(
    (candidate) =>
      canonicalizeUuid(candidate.userId) === callerId &&
      canonicalizeUuid(candidate.organizationId) === requestedOrgId
  );
  if (membership === undefined) {
    return { outcome: "no_membership" };
  }
  if (!roleHasCapability(membership.role, capability)) {
    return { outcome: "insufficient_capability", role: membership.role };
  }
  return { outcome: "authorized", role: membership.role };
}

/**
 * `no_membership` maps to `not_found`, not `forbidden`: telling a caller
 * with no relationship to an organization that it exists but they can't
 * touch it would confirm the organizationId is real. A membership that
 * exists but lacks the capability gets the honest `forbidden`.
 */
export function resourceAuthorizationErrorResponse(
  authorization: ResourceAuthorization,
  requestId: RequestId
): ApiErrorResponse | undefined {
  if (authorization.outcome === "authorized") {
    return undefined;
  }
  if (authorization.outcome === "no_membership") {
    return buildApiError({
      requestId,
      code: "not_found",
      message: "Organization not found."
    });
  }
  return buildApiError({
    requestId,
    code: "forbidden",
    message: `Role ${authorization.role} does not have this capability.`
  });
}

// ---- AF-21: PII-safe structured logging ----
//
// Three layers, matching "structured, redacted logging only" literally.
// Structured: LogContext is a closed set of IDs -- pickLogContext copies
// only those keys at runtime, so an extra candidateName property cannot
// ride along. Messages: only dotted event names are emitted; free text
// (names, resume snippets, addresses) is replaced, not logged. Redacted:
// redactPii still masks email- and phone-shaped substrings in allowed
// fields, after protecting UUID / IPv4 / ISO-date correlation IDs.

const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/gu;
const PHONE_PATTERN = /\+?\d[\d\s().-]{7,}\d/gu;
const UUID_PATTERN = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const ISO_DATE_PATTERN =
  /\b\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?\b/g;
const LOG_EVENT_NAME = /^[a-z][a-z0-9._-]*$/u;
const REJECTED_LOG_MESSAGE = "log.rejected_message";
const REDACTED = "[REDACTED]";
const PROTECT_PREFIX = "__SA_ID_";
const PROTECT_SUFFIX = "__";

export function redactPii(value: string): string {
  const saved: string[] = [];
  const protect = (match: string): string => {
    saved.push(match);
    return `${PROTECT_PREFIX}${saved.length - 1}${PROTECT_SUFFIX}`;
  };
  const protectedValue = value
    .replace(UUID_PATTERN, protect)
    .replace(IPV4_PATTERN, protect)
    .replace(ISO_DATE_PATTERN, protect);
  return protectedValue
    .replace(EMAIL_PATTERN, REDACTED)
    .replace(PHONE_PATTERN, REDACTED)
    .replace(/__SA_ID_(\d+)__/g, (_full, index: string) => saved[Number(index)] ?? "");
}

// ---- AF-23 prerequisite: session issuance ----
//
// AF-16 built magic-link token generation and redemption but never an
// HTTP-facing session -- there was nothing yet that needed to know "who
// is calling" between requests. AF-23 is the first ticket that does
// (role creation must be scoped to the caller's own organization), so
// this completes AF-16's flow rather than starting a new one: redeem a
// magic link once, then carry identity across requests as a signed,
// stateless cookie. Not itself a numbered ticket -- flagged in the PR.
//
// Stateless by design: the payload only ever carries a userId and an
// expiry, both signed with HMAC-SHA256. There is nothing here a stolen
// but unmodified cookie can't already do (impersonate that user until
// expiry), which is the same exposure any session cookie has; the token
// carries no organization or role, so escalation still has to go
// through authorizeResourceAccess and a real, server-fetched membership
// on every request, never through anything the cookie itself claims.

export const SESSION_COOKIE_NAME = "af_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface SessionTokenPayload {
  readonly userId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

function signSessionPayload(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

export function createSessionToken(
  userId: string,
  secret: string,
  now: Date = new Date(),
  ttlMs: number = SESSION_TTL_MS
): string {
  const payload: SessionTokenPayload = {
    userId,
    issuedAt: now.getTime(),
    expiresAt: now.getTime() + ttlMs
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64}.${signSessionPayload(payloadB64, secret)}`;
}

export type SessionVerification =
  | { readonly outcome: "valid"; readonly userId: string }
  | { readonly outcome: "invalid" }
  | { readonly outcome: "expired" };

function isSessionTokenPayload(value: unknown): value is SessionTokenPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).userId === "string" &&
    typeof (value as Record<string, unknown>).expiresAt === "number"
  );
}

export function verifySessionToken(
  token: string,
  secret: string,
  now: Date = new Date()
): SessionVerification {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return { outcome: "invalid" };
  }
  const [payloadB64, signature] = parts as [string, string];
  const expected = Buffer.from(signSessionPayload(payloadB64, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { outcome: "invalid" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { outcome: "invalid" };
  }
  if (!isSessionTokenPayload(parsed)) {
    return { outcome: "invalid" };
  }
  if (parsed.expiresAt <= now.getTime()) {
    return { outcome: "expired" };
  }
  return { outcome: "valid", userId: parsed.userId };
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Closed set of safe structured fields: IDs and metadata only.
 * Deliberately no field for a name, email, phone, address, or
 * free-text content (resume text, notes, JD text) -- needing one of
 * those means this logger is the wrong tool for that call site.
 */
export interface LogContext {
  readonly requestId?: string;
  readonly organizationId?: string;
  readonly actorUserId?: string;
  readonly action?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly statusCode?: number;
  readonly errorCode?: string;
  readonly durationMs?: number;
}

export interface StructuredLogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly timestamp: string;
  readonly context?: LogContext;
}

const LOG_CONTEXT_KEYS = [
  "requestId",
  "organizationId",
  "actorUserId",
  "action",
  "entityType",
  "entityId",
  "statusCode",
  "errorCode",
  "durationMs"
] as const;

function pickLogContext(context: LogContext | undefined): LogContext | undefined {
  if (context === undefined) {
    return undefined;
  }
  const picked: Record<string, unknown> = {};
  for (const key of LOG_CONTEXT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(context, key)) {
      continue;
    }
    const value = context[key];
    if (value === undefined) {
      continue;
    }
    picked[key] = typeof value === "string" ? redactPii(value) : value;
  }
  return Object.keys(picked).length === 0 ? undefined : (picked as LogContext);
}

function eventNameOrRejected(message: string): string {
  return LOG_EVENT_NAME.test(message) ? redactPii(message) : REJECTED_LOG_MESSAGE;
}

export function buildLogEntry(
  level: LogLevel,
  message: string,
  context?: LogContext,
  now: Date = new Date()
): StructuredLogEntry {
  const redactedContext = pickLogContext(context);
  return {
    level,
    message: eventNameOrRejected(message),
    timestamp: now.toISOString(),
    ...(redactedContext === undefined ? {} : { context: redactedContext })
  };
}

/** One JSON line per call, so log aggregators can parse it without a custom format. */
export function logStructured(level: LogLevel, message: string, context?: LogContext): void {
  const line = JSON.stringify(buildLogEntry(level, message, context));
  if (level === "warn" || level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}
