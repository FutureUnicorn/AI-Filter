import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

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

/**
 * Local-development adapter. It has to actually deliver something: an
 * earlier revision only emitted the `magic_link.queued` event and
 * dropped both inputs, which reports success to the caller while making
 * sign-in impossible -- the developer has no way to reach the link.
 *
 * Delivery here is "write it to stderr", and deliberately NOT through
 * logStructured: a magic link is a bearer credential and the recipient
 * is PII, so it must never enter the structured log stream that gets
 * shipped and retained. It goes straight to the local terminal instead,
 * and only ever in a non-hosted environment -- constructing this sender
 * for staging or production throws rather than printing a credential
 * where it could be captured.
 */
/**
 * Validated outbound-email settings. Declared structurally here rather
 * than imported from packages/config, because the workspace boundary
 * rules allow packages/security to depend only on contracts and domain
 * (see tests/architecture/check-workspace-boundaries.mjs). The caller
 * passes values that packages/config has already validated.
 */
export interface MagicLinkEmailDelivery {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly from: string;
}

/**
 * `appEnv` has no default ON PURPOSE. It used to default to
 * "development", so the one production call site --
 * `createConsoleMagicLinkEmailSender()` in the magic-link request route
 * -- type-checked while never passing an environment, which made the
 * hosted-environment guard below unreachable dead code. A hosted deploy
 * therefore selected the local console sender silently. Requiring the
 * argument turns that mistake into a compile error, the same way
 * OpenAiAdapterConfig.checkKillSwitch is mandatory rather than optional.
 *
 * Prefer createMagicLinkEmailSender below; it is the single place the
 * adapter is chosen from environment configuration.
 */
export function createConsoleMagicLinkEmailSender(appEnv: string): MagicLinkEmailSender {
  if (appEnv === "staging" || appEnv === "production") {
    throw new Error(
      "createConsoleMagicLinkEmailSender is local-development only; a hosted environment needs a real email adapter"
    );
  }
  return {
    async sendMagicLink(input: { readonly email: string; readonly link: string }): Promise<void> {
      // The structured log records that delivery happened and carries no
      // PII or credential. That property is unchanged and load-bearing:
      // logStructured output is retained, shipped and searchable, so a
      // magic link in it is a durable bearer credential sitting in a log
      // store.
      logStructured("info", "magic_link.queued");
      // stderr is a DIFFERENT channel from that retained log stream, and
      // this is the one place the real link is allowed to appear. It is
      // the local developer's only way to obtain the token, because no
      // email is actually sent in a local environment.
      //
      // An earlier revision redacted the token here too. That looked
      // like defence in depth and was really a denial of service against
      // the whole feature: the request stored a valid token and returned
      // 202, but no channel anywhere yielded the credential, so the
      // redeem endpoint -- and every session-gated route behind it,
      // including role creation -- became unreachable without editing
      // the database by hand.
      //
      // Do not "harden" this back. The guard above already makes it
      // impossible to reach in staging or production, which is where a
      // leak would matter; the selection in
      // createMagicLinkEmailSender enforces the same thing from the
      // other side.
      process.stderr.write(
        `\n[dev magic link] to: ${input.email}\n[dev magic link] open: ${input.link}\n\n`
      );
    }
  };
}

/**
 * Vendor-neutral hosted delivery: one authenticated HTTPS POST. An
 * endpoint, a bearer key and a from address are the shape Resend,
 * Postmark, SendGrid and Mailgun all accept, so no provider SDK is
 * chosen here -- consistent with this file's existing position that the
 * vendor is not this ticket's decision.
 */
export function createHttpMagicLinkEmailSender(
  delivery: MagicLinkEmailDelivery
): MagicLinkEmailSender {
  return {
    async sendMagicLink(input: { readonly email: string; readonly link: string }): Promise<void> {
      const response = await fetch(delivery.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${delivery.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          from: delivery.from,
          to: input.email,
          subject: "Your sign-in link",
          text: `Open this link to sign in. It expires shortly and can be used once.\n\n${input.link}\n`
        })
      });
      if (!response.ok) {
        // Deliberately does not include the response body: a provider
        // error payload can echo the recipient address back, and this
        // message reaches error logs.
        throw new Error(`Magic-link email delivery failed with status ${response.status}`);
      }
      // Same non-PII structured event the console path emits, so the
      // two adapters are indistinguishable in the retained log stream.
      logStructured("info", "magic_link.queued");
    }
  };
}

/**
 * The single point at which the delivery adapter is chosen, so no route
 * decides for itself. Local environments get the console sender and its
 * real stderr link; hosted environments get real email and fail closed
 * if it is not configured.
 */
export function createMagicLinkEmailSender(input: {
  readonly appEnv: string;
  readonly delivery?: MagicLinkEmailDelivery | undefined;
}): MagicLinkEmailSender {
  if (input.appEnv === "staging" || input.appEnv === "production") {
    if (input.delivery === undefined) {
      // Fails closed rather than degrading to console. packages/config
      // already requires these variables for staging/production, so
      // reaching this means someone constructed a config by hand; it
      // must still not silently mint undeliverable credentials.
      throw new Error(
        `Magic-link email delivery is not configured for ${input.appEnv}; refusing to fall back to the local console sender, which cannot deliver in a hosted environment`
      );
    }
    return createHttpMagicLinkEmailSender(input.delivery);
  }
  // A local environment may still have delivery configured (pointing at
  // a mail catcher, say); honour it rather than overriding the operator.
  return input.delivery === undefined
    ? createConsoleMagicLinkEmailSender(input.appEnv)
    : createHttpMagicLinkEmailSender(input.delivery);
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
const UUID_PATTERN = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const REJECTED_LOG_MESSAGE = "log.rejected_message";
const REDACTED = "[REDACTED]";

/**
 * Closed set of event names this system is allowed to log, not a
 * character-class pattern. A pattern is not a PII boundary: any
 * user-derived text made only of permitted characters passes it, so
 * `buildLogEntry("info", "alice.smith")` or `"ssn.123-45-6789"` would
 * log that value verbatim as the message. Only names registered here
 * can ever be emitted; anything else becomes REJECTED_LOG_MESSAGE.
 * Adding a log line means adding its event name here, deliberately.
 */
export const LOG_EVENT_NAMES = [
  "log.rejected_message",
  "magic_link.queued",
  "web.environment_health_failed",
  "worker.environment_health_failed",
  "worker.health_listening",
  "worker.ready"
] as const;

export type LogEventName = (typeof LOG_EVENT_NAMES)[number];

const LOG_EVENT_NAME_SET: ReadonlySet<string> = new Set<string>(LOG_EVENT_NAMES);

interface Span {
  readonly start: number;
  readonly end: number;
}

/** Sorts by position and coalesces overlapping or touching spans. */
function mergeSpans(spans: readonly Span[]): readonly Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
    } else {
      merged.push(span);
    }
  }
  return merged;
}

function findEmailSpans(value: string): readonly Span[] {
  const spans: Span[] = [];
  let index = 0;
  while (index < value.length) {
    if (/\s/u.test(value[index] ?? "")) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < value.length && !/\s/u.test(value[end] ?? "")) {
      end += 1;
    }
    const token = value.slice(index, end);
    EMAIL_PATTERN.lastIndex = 0;
    if (EMAIL_PATTERN.test(token)) {
      spans.push({ start: index, end });
    }
    index = end;
  }
  return mergeSpans(spans);
}

function findUuidSpans(value: string): readonly Span[] {
  const spans: Span[] = [];
  for (const match of value.matchAll(UUID_PATTERN)) {
    if (match.index === undefined || match[0].length === 0) {
      continue;
    }
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return mergeSpans(spans);
}

function findIpv4Spans(value: string): readonly Span[] {
  const spans: Span[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!/[0-9]/u.test(value[index] ?? "")) {
      continue;
    }
    let cursor = index;
    const groups: number[] = [];
    while (groups.length < 4 && cursor < value.length) {
      const groupStart = cursor;
      while (cursor < value.length && /[0-9]/u.test(value[cursor] ?? "")) {
        cursor += 1;
      }
      const digits = value.slice(groupStart, cursor);
      if (digits.length === 0 || Number(digits) > 255) {
        break;
      }
      groups.push(Number(digits));
      if (groups.length === 4) {
        break;
      }
      if (cursor >= value.length || value[cursor] !== ".") {
        break;
      }
      cursor += 1;
    }
    if (groups.length === 4) {
      spans.push({ start: index, end: cursor });
      index = cursor - 1;
    }
  }
  return mergeSpans(spans);
}

function findIsoDateSpans(value: string): readonly Span[] {
  const spans: Span[] = [];
  for (let index = 0; index <= value.length - 4; index += 1) {
    if (!/[0-9]/u.test(value[index] ?? "")) {
      continue;
    }
    const year = value.slice(index, index + 4);
    if (!/^\d{4}$/u.test(year)) {
      continue;
    }
    let cursor = index + 4;
    if (value[cursor] !== "-") {
      continue;
    }
    cursor += 1;
    const month = value.slice(cursor, cursor + 2);
    if (!/^\d{2}$/u.test(month)) {
      continue;
    }
    cursor += 2;
    if (value[cursor] !== "-") {
      continue;
    }
    cursor += 1;
    const day = value.slice(cursor, cursor + 2);
    if (!/^\d{2}$/u.test(day)) {
      continue;
    }
    cursor += 2;
    const end = cursor;
    spans.push({ start: index, end });
  }
  return mergeSpans(spans);
}

/**
 * Scan for phone-shaped digit runs without letting a loose separator pattern
 * swallow neighbouring identifier spans. This is intentionally narrower than
 * the earlier regex and only used as a redaction aid; any digits already
 * covered by UUID / IPv4 / ISO-date spans are filtered out before the value is
 * redacted.
 */
function findPhoneSpans(value: string): readonly Span[] {
  const spans: Span[] = [];
  let index = 0;

  while (index < value.length) {
    const start = index;
    if (value[index] === "+") {
      const next = value[index + 1];
      if (next === undefined || !/[0-9]/u.test(next)) {
        index += 1;
        continue;
      }
      index += 1;
    }

    if (!/[0-9]/u.test(value[index] ?? "")) {
      index += 1;
      continue;
    }

    const phoneStart = start;
    let digits = 0;
    let cursor = index;

    while (cursor < value.length) {
      const character = value[cursor];
      if (/[0-9]/u.test(character ?? "")) {
        digits += 1;
        cursor += 1;
        continue;
      }
      if (/[ .()-]/u.test(character ?? "")) {
        let next = cursor + 1;
        while (next < value.length && /[ .()-]/u.test(value[next] ?? "")) {
          next += 1;
        }
        if (next < value.length && /[0-9]/u.test(value[next] ?? "")) {
          cursor = next;
          continue;
        }
        break;
      }
      break;
    }

    if (digits >= 7) {
      spans.push({ start: phoneStart, end: cursor });
    }
    index = cursor + 1;
  }

  return mergeSpans(spans);
}

const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;

/** True when at least one digit of `span` falls outside every span in `covers`. */
function hasDigitOutside(value: string, span: Span, covers: readonly Span[]): boolean {
  for (let index = span.start; index < span.end; index += 1) {
    const character = value[index];
    if (character === undefined || character < "0" || character > "9") {
      continue;
    }
    if (!covers.some((cover) => index >= cover.start && index < cover.end)) {
      return true;
    }
  }
  return false;
}

/**
 * Positional, never textual. An earlier revision protected correlation
 * IDs by swapping in a `__SA_ID_n__` marker string and restoring it
 * afterward, which is unsafe two ways: input that already contains
 * marker-shaped text gets silently corrupted (the restore step cannot
 * tell a real placeholder from a coincidence), and deleting a forged
 * marker can *join* two short digit runs into a phone number that then
 * escapes redaction entirely. Spans remove that whole class: nothing
 * about the mechanism depends on what the input text contains.
 *
 * The overlap rule is the second half, and the subtler one. Protecting
 * an ID span unconditionally is also wrong: an email or phone can
 * *contain* something ID-shaped (`user@192.0.2.1`, `user@2026-08-21.com`,
 * `Call +1 2026-08-21 now`), and carving the ID out mid-token leaves the
 * PII pattern unable to match the whole thing, so the PII leaks
 * verbatim. So a protected span only survives when every PII match
 * touching it is fully inside it -- that keeps a UUID or ISO date that
 * merely *looks* phone-shaped (`11111111-1111-4111-8111-111111111111`)
 * intact, while letting a genuine email/phone that swallows an ID-shaped
 * substring lose to redaction, which is the safe direction to fail.
 */
export function redactPii(value: string): string {
  // Emails are whitespace-delimited and unambiguous, so they always win:
  // this is what stops `user@192.0.2.1` or `user@2026-08-21.com` from
  // leaking because an identifier-shaped substring got carved out of the
  // middle and left the email pattern unable to match the whole token.
  const emailSpans = findEmailSpans(value);
  const protectedSpans = mergeSpans([
    ...findUuidSpans(value),
    ...findIpv4Spans(value),
    ...findIsoDateSpans(value)
  ]).filter((candidate) => !emailSpans.some((email) => overlaps(candidate, email)));

  // A phone match only counts when at least one of its digits is not
  // already part of a recognized identifier. Without that test the loose
  // phone shape happily starts inside one UUID and runs on through the
  // next identifier, so `<uuid> <uuid> <iso-date> <ipv4>` reads as a
  // single "phone number" and every real correlation ID in the string is
  // destroyed. With it, digits belonging entirely to identifiers are
  // left alone, while `Call +1 2026-08-21 now` is still redacted -- the
  // leading `1` sits outside the date, which is what makes it a phone
  // number rather than a date sitting on its own.
  const phoneSpans = findPhoneSpans(value).filter((phone) =>
    hasDigitOutside(value, phone, protectedSpans)
  );

  let result = "";
  let cursor = 0;
  for (const span of mergeSpans([...emailSpans, ...phoneSpans])) {
    result += value.slice(cursor, span.start);
    result += REDACTED;
    cursor = span.end;
  }
  return result + value.slice(cursor);
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
  /** HTTP status code when available; values outside 100..599 are dropped. */
  readonly statusCode?: number;
  readonly errorCode?: string;
  /** Milliseconds since start, non-negative only. */
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

const UUID_ONLY = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const REQUEST_ID_ONLY = /^req_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
/** Lowercase machine token: an action, entity type, or error code. */
const SAFE_TOKEN = /^[a-z][a-z0-9._-]{0,63}$/u;

/**
 * Per-field validators, because an allowlist of *keys* is not a PII
 * boundary on its own. Two real gaps it leaves open: a non-string value
 * was previously copied through untouched, so `{ durationMs: { email:
 * "x@y.test" } }` serialized the email intact; and a correctly-typed
 * string was only run through redactPii, which by design only masks
 * email/phone shapes, so `{ entityId: "Alice Smith" }`, `{ action:
 * "Interview Jane Doe" }` and `{ entityId: "555-1234" }` all passed
 * through verbatim. Each field now has to look like the identifier or
 * code it claims to be; anything else is replaced with REDACTED rather
 * than dropped, so the key's presence still shows up in the log and the
 * bad call site is findable.
 */
const LOG_CONTEXT_VALIDATORS: Readonly<Record<(typeof LOG_CONTEXT_KEYS)[number], (value: unknown) => boolean>> = {
  requestId: (value) => typeof value === "string" && REQUEST_ID_ONLY.test(value),
  organizationId: (value) => typeof value === "string" && UUID_ONLY.test(value),
  actorUserId: (value) => typeof value === "string" && UUID_ONLY.test(value),
  action: (value) => typeof value === "string" && SAFE_TOKEN.test(value),
  entityType: (value) => typeof value === "string" && SAFE_TOKEN.test(value),
  entityId: (value) => typeof value === "string" && (UUID_ONLY.test(value) || SAFE_TOKEN.test(value)),
  errorCode: (value) => typeof value === "string" && SAFE_TOKEN.test(value),
  statusCode: (value) => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599,
  durationMs: (value) => typeof value === "number" && Number.isFinite(value) && value >= 0
};

function pickLogContext(context: LogContext | undefined): LogContext | undefined {
  if (context === undefined) {
    return undefined;
  }
  const picked: Partial<Record<keyof LogContext, LogContext[keyof LogContext]>> = {};
  for (const key of LOG_CONTEXT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(context, key)) {
      continue;
    }
    const value = context[key];
    if (value === undefined) {
      continue;
    }
    // redactPii stays as a second layer for the string fields it applies
    // to, but the validator above is what actually decides whether a
    // value is loggable at all. Invalid numeric fields are dropped rather
    // than coerced to a string, because the stored shape must remain
    // LogContext-compatible.
    if (!LOG_CONTEXT_VALIDATORS[key](value)) {
      if (key === "statusCode" || key === "durationMs") {
        continue;
      }
      picked[key] = REDACTED as LogContext[keyof LogContext];
      continue;
    }
    picked[key] = typeof value === "string" ? (redactPii(value) as LogContext[keyof LogContext]) : value;
  }
  return Object.keys(picked).length === 0 ? undefined : (picked as LogContext);
}

/**
 * Only a name registered in LOG_EVENT_NAMES is emitted. Anything else
 * (including user-derived text that happens to look like a dotted key)
 * collapses to REJECTED_LOG_MESSAGE, so the message field can never
 * carry caller data. A registered name is developer-authored and needs
 * no redaction -- running one through redactPii could corrupt it, since
 * a long digit run inside a name would get spliced with "[REDACTED]".
 */
function eventNameOrRejected(message: string): string {
  return LOG_EVENT_NAME_SET.has(message) ? message : REJECTED_LOG_MESSAGE;
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
