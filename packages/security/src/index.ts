import { createHash, randomBytes } from "node:crypto";

import { API_ERROR_CODES, buildApiError } from "@signal-audit/contracts";
import type { ApiErrorResponse, BoundaryContract, RequestId } from "@signal-audit/contracts";
import { AUDIT_ACTIONS, roleHasCapability } from "@signal-audit/domain";
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
export function createConsoleMagicLinkEmailSender(appEnv: string = "development"): MagicLinkEmailSender {
  if (appEnv === "staging" || appEnv === "production") {
    throw new Error(
      "createConsoleMagicLinkEmailSender is local-development only; a hosted environment needs a real email adapter"
    );
  }
  return {
    async sendMagicLink(input: { readonly email: string; readonly link: string }): Promise<void> {
      // Structured log records that delivery happened, with no PII in it.
      logStructured("info", "magic_link.queued");

      // The token is printed IN FULL, deliberately, and the previous
      // version of this line was wrong to redact it.
      //
      // This adapter exists so a developer can complete local sign-in
      // when no mail transport is configured. Redacting the token left a
      // link that cannot be opened -- which is the same outcome as the
      // silent no-op this function was written to replace, just with
      // more ceremony. A credential printed where it cannot be used is
      // not a safer credential, it is a broken feature.
      //
      // Two things make printing it acceptable here, and both are
      // enforced rather than assumed:
      //   - the constructor throws for staging and production, so this
      //     can only ever run against a local environment whose tokens
      //     grant access to a local database;
      //   - it goes to stderr, never through logStructured, so it never
      //     enters the shipped and retained log stream. That is the
      //     boundary that actually matters: the threat is a credential
      //     surviving in retained logs, not one appearing for a moment
      //     in the terminal of the person who just requested it.
      //
      // The recipient stays redacted because nothing needs it: the
      // developer already knows which address they typed, so printing it
      // buys nothing and puts an email address on a terminal.
      process.stderr.write(
        `\n[dev magic link] to: [REDACTED_EMAIL]\n[dev magic link] open: ${input.link}\n\n`
      );
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

    // Only a real calendar date is protected. `dddd-dd-dd` alone is not
    // enough: an eight-digit phone written as `1234-56-78` matched the
    // shape, every one of its digits was then treated as covered by a
    // "date" span, and redactPii returned the phone unchanged --
    // verified before this check existed. A span that is not a date must
    // be allowed to participate in phone redaction, which is the safe
    // direction to be wrong in.
    if (!isCalendarDate(value.slice(index, cursor))) {
      continue;
    }

    const end = cursor;
    spans.push({ start: index, end });
  }
  return mergeSpans(spans);
}

/**
 * True only for a date that exists. Month and day ranges are checked
 * against the actual length of that month, leap years included, because
 * `2026-02-30` and `2026-13-01` are digit runs a phone can hide behind
 * just as easily as `1234-56-78` can.
 */
function isCalendarDate(candidate: string): boolean {
  const year = Number(candidate.slice(0, 4));
  const month = Number(candidate.slice(5, 7));
  const day = Number(candidate.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (daysInMonth[month - 1] ?? 0);
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

/**
 * The entity kinds this system has. A closed, developer-authored set,
 * for the same reason LOG_EVENT_NAMES is one.
 *
 * There was previously a `SAFE_TOKEN` pattern here -- lowercase letters,
 * digits, dot, underscore, hyphen -- used for action, entityType,
 * entityId and errorCode. A shape is not a boundary: `alice`,
 * `alice.smith` and `interview_alice` all satisfy it, redactPii does not
 * recognise a name as email or phone, and so human-derived values were
 * emitted verbatim into retained structured logs. Verified before this
 * change. That is precisely the character-pattern gap the message
 * allowlist was written to close, left open one field over.
 */
const LOG_ENTITY_TYPES: ReadonlySet<string> = new Set([
  "organization",
  "user",
  "membership",
  "magic_link_token",
  "audit_event",
  "evidence_extraction_run",
  "inference_usage",
  "inference_kill_switch",
  "role",
  "rubric",
  "file_intake",
  "canonical_text_extraction",
  "application",
  "import_finalization",
  "import_row",
  "evidence_outcome",
  "candidate_decision"
]);

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
  // Closed sets, not shapes. action and errorCode reuse vocabularies the
  // system already owns, so a log line and an audit row cannot describe
  // the same act with different words -- and adding a value means adding
  // it where it belongs rather than happening to match a regex.
  action: (value) => typeof value === "string" && (AUDIT_ACTIONS as readonly string[]).includes(value),
  entityType: (value) => typeof value === "string" && LOG_ENTITY_TYPES.has(value),
  // Opaque identifiers only. An entity id is a handle, never a name: if
  // a call site has something to say that is not a uuid or a request id,
  // the honest answer is that it does not belong in a retained log.
  entityId: (value) => typeof value === "string" && (UUID_ONLY.test(value) || REQUEST_ID_ONLY.test(value)),
  errorCode: (value) => typeof value === "string" && (API_ERROR_CODES as readonly string[]).includes(value),
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
