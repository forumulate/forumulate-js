/**
 * The policy acceptance gate, from your server: `client.policies`.
 *
 *   status      what this user still has to accept before this event
 *   accept      record an acceptance your own UI collected (server-verified)
 *   claim       redeem a sign-up receipt for the account you just created
 *   ticket      mint a ticket online (when your server holds a PAT, not the gate key)
 *   verify      check an acceptance token online (offline: `verifyAcceptanceToken`)
 *   acceptances the acceptance log; `export` as CSV or JSON
 *   erase       a data-subject request: delete one person's acceptances
 *   list        the policies themselves, from the policy feed (signed or public)
 *   release     one exact published version, for ever
 *
 * Hand-written over the transport, like `./translations`, because the
 * generated `schema.ts` is refreshed from the DEPLOYED spec and these routes
 * ship with this release. The shapes are the contract in
 * `packages/shared/src/policy-gate/dtos.ts`, restated: the SDK has no runtime
 * dependencies, so it cannot import them.
 */
import type { PolicyFeedList } from './policy-feed';
import { signPolicyFeedRequest } from './policy-feed';
import type { PolicyGateEvent } from './policy-tokens';

type Send = <T>(
  method: string,
  path: string,
  opts?: {
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
    headers?: Record<string, string>;
    kind?: 'json' | 'text';
    maxRetries?: number;
  },
) => Promise<T>;

export type PolicyPresentation =
  | 'checkbox'
  | 'checkbox-modal'
  | 'modal'
  | 'inline-scroll'
  | 'page'
  | 'link';

export type PolicyGateReason =
  | 'sign_up'
  | 'never_accepted'
  | 'new_version'
  | 'grace_period'
  | 'grace_expired'
  | 'accepted'
  | 'reaccept_never'
  | 'not_for_event'
  | 'not_yet_effective';

/** One policy's verdict for a subject and event. */
export interface PolicyGateStatusItem {
  key: string;
  title: string;
  /** Show it now. */
  ask: boolean;
  /** Withhold the event until it is accepted. */
  blocking: boolean;
  reason: PolicyGateReason;
  required: boolean;
  version: string | null;
  effectiveAt: string | null;
  contentUrl: string | null;
  /** SHA-256 (hex) of `contentHtml`: send it back when recording the acceptance. */
  contentSha256: string | null;
  /** With `includeContent: true`. */
  contentHtml?: string | null;
  summaryOfChanges: string | null;
  acceptedVersion: string | null;
  /** When a grace period ends. */
  dueAt: string | null;
  /** A future version that can be accepted early. */
  upcoming: { version: string; effectiveAt: string } | null;
  presentation: PolicyPresentation;
  requireScroll: boolean;
  showSummary: boolean;
  decline: 'allow' | 'block';
  dismissible: boolean;
  reaccept: 'never' | 'next_sign_in' | 'grace_days';
  events: PolicyGateEvent[];
  /** Which level decided each behaviour field: `call`, `space`, `org`, `policy` or `default`. */
  sources: Record<string, string>;
}

export interface PolicyGateStatus {
  enabled: boolean;
  subject: string | null;
  event: PolicyGateEvent;
  /** Nothing blocks the event. */
  satisfied: boolean;
  /** Keys still blocking. */
  pending: string[];
  /** Keys asked but not required. */
  optional: string[];
  policies: PolicyGateStatusItem[];
  /** The database clock the rules were evaluated at. */
  evaluatedAt: string;
}

/** One policy being accepted: which version, the hash of what was shown, and how. */
export interface PolicyAcceptanceItem {
  key: string;
  version: string;
  contentSha256: string;
  presentation: PolicyPresentation;
  scrolledToEnd?: boolean;
}

export interface PolicyAcceptanceRow {
  id: string;
  spaceId: string;
  subject: string;
  subjectEmailHash: string | null;
  key: string;
  version: string;
  contentSha256: string;
  presentation: PolicyPresentation;
  display: 'checkbox' | 'scroll' | 'link';
  scrolledToEnd: boolean;
  event: PolicyGateEvent | null;
  /** `server`, `ticket`, `receipt` or `unverified`. */
  verification: string;
  sourceApp: string | null;
  locale: string | null;
  ip: string | null;
  userAgent: string | null;
  batchId: string;
  acceptedAt: string;
}

export interface PolicyAcceptanceResult {
  acceptances: PolicyAcceptanceRow[];
  /** A signed acceptance token for the subject. */
  token: string;
  expiresAt: string;
  satisfied: boolean;
  pending: string[];
}

/** Email, or its hash: who the subject is, for a later data-subject request. */
export interface PolicySubjectIdentity {
  /** Hashed on arrival, never stored. */
  email?: string;
  /** SHA-256 hex of the trimmed, lower-cased email (`policyEmailHash`). */
  emailHash?: string;
}

export interface PolicyGateSpace {
  orgId: string;
  /** The Legal space whose published policies gate your app. */
  spaceId: string;
}

export interface PolicyStatusInput extends PolicyGateSpace {
  /** Your id for the user. Omit on a sign-up: everything is asked. */
  subject?: string;
  event: PolicyGateEvent;
  /** Include each version's `contentHtml` (to show it in your own UI). */
  includeContent?: boolean;
}

export interface PolicyAcceptInput extends PolicyGateSpace, PolicySubjectIdentity {
  subject: string;
  event?: PolicyGateEvent;
  policies: PolicyAcceptanceItem[];
  /** Recorded as `sourceApp` (`web`, `ios`). */
  sourceApp?: string;
  /** The END USER's IP, which your server saw and Forumulate did not. */
  ip?: string;
  /** The END USER's user agent. */
  userAgent?: string;
  locale?: string;
}

export interface PolicyListInput {
  /** The Legal space. */
  spaceId: string;
  /** One policy only. */
  key?: string;
  /**
   * The link's shared secret (`whsec_…`) from **Policy sources**: reads the
   * signed feed. Without it, the public feed is read (404 unless the space
   * turned it on).
   */
  secret?: string;
  /** Sign with `atlas-*` headers at the Atlas address instead. */
  prefix?: 'forumulate' | 'atlas';
}

/**
 * The acceptance items for every policy a status asks for — what to send to
 * `accept` once your own UI has shown them. `presentation` is how YOU showed
 * them; it is recorded as such.
 */
export function acceptanceItemsFrom(
  status: Pick<PolicyGateStatus, 'policies'>,
  shown: { presentation: PolicyPresentation; scrolledToEnd?: boolean; keys?: string[] },
): PolicyAcceptanceItem[] {
  return status.policies
    .filter((p) => p.ask && p.version && p.contentSha256)
    .filter((p) => !shown.keys || shown.keys.includes(p.key))
    .map((p) => ({
      key: p.key,
      version: p.version!,
      contentSha256: p.contentSha256!,
      presentation: shown.presentation,
      ...(shown.scrolledToEnd === undefined ? {} : { scrolledToEnd: shown.scrolledToEnd }),
    }));
}

const e = encodeURIComponent;

export function policiesApi(send: Send, baseUrl: () => string) {
  const gate = (s: PolicyGateSpace) => `/orgs/${e(s.orgId)}/spaces/${e(s.spaceId)}/policy-gate`;
  const strip = <T extends PolicyGateSpace>(input: T) => {
    const { orgId: _o, spaceId: _s, ...rest } = input;
    return rest;
  };

  return {
    /** What `subject` still has to accept before `event`. `satisfied` false = withhold the event. */
    status: (input: PolicyStatusInput) =>
      send<PolicyGateStatus>('GET', `${gate(input)}/status`, {
        query: {
          subject: input.subject,
          event: input.event,
          include: input.includeContent ? 'content' : undefined,
        },
      }),

    /** Record what your own UI collected. Answers with a signed acceptance token. */
    accept: (input: PolicyAcceptInput) =>
      send<PolicyAcceptanceResult>('POST', `${gate(input)}/acceptances`, { body: strip(input) }),

    /** Redeem a sign-up receipt for the account you just created. Once only. */
    claim: (input: PolicyGateSpace & PolicySubjectIdentity & { receipt: string; subject: string }) =>
      send<PolicyAcceptanceResult>('POST', `${gate(input)}/acceptances/claim`, { body: strip(input) }),

    /**
     * Mint a ticket online. Signing it yourself with `signPolicyTicket` needs
     * no call; this is for a server that holds a PAT but not the gate key.
     */
    ticket: (
      input: PolicyGateSpace &
        PolicySubjectIdentity & {
          subject: string;
          event: PolicyGateEvent;
          sourceApp?: string;
          returnUrl?: string;
          state?: string;
          locale?: string;
          ttlSeconds?: number;
        },
    ) =>
      send<{ ticket: string; expiresAt: string; pageUrl: string }>('POST', `${gate(input)}/tickets`, {
        body: strip(input),
      }),

    /** Verify a token online. Offline (no round trip): `verifyAcceptanceToken`. */
    verify: (input: PolicyGateSpace & { token: string; subject?: string }) =>
      send<{ valid: boolean; reason?: string; claims?: Record<string, unknown> }>(
        'POST',
        `${gate(input)}/tokens/verify`,
        { body: strip(input) },
      ),

    /** The acceptance log, newest first; pass `page.nextCursor` back as `cursor`. */
    acceptances: (
      input: PolicyGateSpace &
        PolicySubjectIdentity & { subject?: string; key?: string; cursor?: string; limit?: number },
    ) =>
      send<{
        acceptances: PolicyAcceptanceRow[];
        page: { limit: number; hasMore: boolean; nextCursor: string | null };
      }>(
        'GET',
        `${gate(input)}/acceptances`,
        { query: strip(input) as Record<string, string | number | undefined> },
      ),

    /** The log as a file (CSV or JSON text). */
    export: (
      input: PolicyGateSpace & { format: 'csv' | 'json'; subject?: string; emailHash?: string; key?: string },
    ) =>
      send<string>('GET', `${gate(input)}/acceptances/export`, {
        query: strip(input) as Record<string, string | undefined>,
        kind: 'text',
      }),

    /** A data-subject erasure: every acceptance of one person, across the org's spaces. */
    erase: (input: { orgId: string } & PolicySubjectIdentity & { subject?: string }) => {
      const { orgId, ...body } = input;
      return send<{ erased: number }>('POST', `/orgs/${e(orgId)}/policy-gate/subjects/erase`, { body });
    },

    /**
     * The policies, from Forumulate policy feed v1. With `secret`, the signed
     * feed (`/policy-feed/spaces/{id}/policies`, or Atlas's address with
     * `prefix: 'atlas'`); without, the public one.
     */
    list: async (input: PolicyListInput): Promise<PolicyFeedList> => {
      const q = input.key ? `?key=${e(input.key)}` : '';
      if (!input.secret) {
        return send<PolicyFeedList>('GET', `/public/spaces/${e(input.spaceId)}/policies${q}`);
      }
      const route =
        input.prefix === 'atlas'
          ? `/atlas/spaces/${e(input.spaceId)}/policies${q}`
          : `/policy-feed/spaces/${e(input.spaceId)}/policies${q}`;
      // The signature covers the path AS REQUESTED, so the base URL's own path
      // (`/api` on forumulate.com) is part of it.
      const prefix = new URL(baseUrl()).pathname.replace(/\/+$/, '');
      const headers = await signPolicyFeedRequest({
        secret: input.secret,
        path: `${prefix}${route}`,
        prefix: input.prefix,
      });
      // No retries: the request id is single-use, so a retry of a request that
      // reached the server is refused as a replay. Call again to re-sign.
      return send<PolicyFeedList>('GET', route, { headers, maxRetries: 0 });
    },

    /** One exact published version — the text behind its `content_url`, which never changes. */
    release: (input: { orgId: string; key: string; version: string }) =>
      send<{
        release: {
          kind: string;
          version: string;
          title: string;
          contentHtml: string;
          contentSha256: string;
          publishedAt: string;
          effectiveAt: string;
          changeNote: string | null;
        };
      }>('GET', `/public/orgs/${e(input.orgId)}/legal/${e(input.key)}/releases/${e(input.version)}`),
  };
}

export type PoliciesApi = ReturnType<typeof policiesApi>;
