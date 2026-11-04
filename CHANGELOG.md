# Changelog

Releases of `@forumulate/sdk`. Earlier versions are described in the git history of
`packages/sdk` (`release(sdk): …` commits).

## 0.13.1

- Types for the 2026-11-04 batch: the manifest's `readerAuth` is described (its three
  forms, and that `"atlas"` keeps the live `atlas_byo` provider's order and settings),
  and a write's `?dry_run=true` / `?dryrun=true` now plan exactly like `?dryRun=true`
  (they were ignored and the write happened).
- This changelog gains the 0.13.0 entry it shipped without.

## 0.13.0

- `startHeartbeat({ url, everyMs, check?, timeoutMs?, onError? })` keeps a heartbeat
  monitor green from a long-running process and returns a `stop()` function. It never
  throws and never leaks a rejected ping. A `check` that throws, or answers
  `ok: false`, is sent as `{ ok: false, detail }`, so the status page shows a partial
  outage in the job's own words. Each ping has its own timeout.
- Types and operations for the 2026-11-03 batch: the compare (`/vs/`) page type,
  careers and about page settings, space `description` and `siteId` on create, the
  heartbeat monitor's `pingUrl`, and the `executor_key.expiring` webhook event.

## 0.12.1

- A CSV export over the API's row threshold answers `202` with a job instead of the
  file. Every `exportCsv` (and any GET that answers 202 with an `export.csv` job) now
  waits for the job and returns the file, the same as the `200`; a failed job throws
  `ForumulateError` with the job's error, and 30 minutes without a result throws
  `export.timeout`. Pass `raw: true` to get the `202` itself.

## 0.12.0

Types and operations for the 2026-11-01 batch: connector `knowledge` state and the token
response, monitor `headers` / `headersSet` / `json`, domain `settling` and manifest
`domains[].state`, `readerIdentity`, `releases`, `legalDocuments`, page
`metadata.frontMatter`, consent `webhookLastFailure`, `DELETE /orgs/{orgId}/members`
by external id, `POST …/reader-auth/jwt/check`, `POST …/reader-sessions/revoke`, and the
external_jwt `testVector` on reader-auth setup.

## 0.11.4

### Added
- Types and operations for export jobs (`GET /orgs/{orgId}/exports/{id}` and its
  `/download`), `?nav=lean|lean-all|lean-listing` on the public space and site
  overviews, and `GET /public/orgs/{org}/spaces/{space}/nav/{nodeId}/children`.

### Changed
- A CSV export past 20,000 rows answers `202` with the job; `exportCsv()` returns
  that job (follow `links.result` once it completes) instead of the CSV text.

## 0.11.0

Every settings object writable by PATCH, site-level settings, a whole site from one manifest, and stable method names.

### Added

- `PATCH` beside every org, space, site and provider settings object, with `?dryRun` (the diff, nothing written) and `?prune` where the write merges: for example `spaceSettings.patchSeo`, `patchHomePage`, `patchVisitorAuth`, `patchPreset` (and `getPreset`), `org.patchSiem`, `orgPayments.patch`, `aiProvider.patch`, `ssoAdmin.patch`, `samlAdmin.patch`, `mailProvider.patch`, `edgeProvider.patch` / `getOne`, `sdkPublishing.getRegistry` / `patchRegistry`, the course, blog, events, status, consent and policy-gate settings. A read of an unset object now round-trips into a write.
- `siteSettings.*`, `siteReaderPolicy.*` (legal gate, reader identity), `siteReaderAuth.*`, `siteConsent.*` and `siteBrand.patch`, `siteFrontPage.patch`, `siteLabels.labels`: a site sets everything a space does (SEO, analytics, comments, discovery, AI, reader themes, visitor auth, consent), and `siteSettings.themeOrigins` / `removeThemeOrigin` / `restoreThemeOrigin` manage the origins its theme discovers. `siteConsentPublic.resolved` reads the consent a reader sees.
- `seoReport.forSpace()` / `forSite()`: what the reader's `<head>` states and where each value came from. `objectSchema.site()` / `space()`: the JSON Schema of one object's configuration.
- `Manifest_apply` (`PUT /orgs/{orgId}/manifest`) now carries `posts`, `authors`, `topics`, `openapi`, `homeDoc`, `translationOverrides` and `orgSettings`, plus publisher units: space languages, SEO, translations, front door, contact form and About, pages from Markdown with locale twins, and sites. Strict settings: an unknown key is named, not dropped. `contact.replaceForm()` (`Contact_replaceForm`) and `policySources.putFields()` complete the set.
- `spaces.labels.labels()` and `integrations.customProviders.get()` / `patch()`.

### Changed

- **Breaking: renamed operationIds and generated methods.** The nine routes the generator had numbered `[0]`, `[1]`, ... now have stable names (the numbering depended on registration order):
  - `courses.packageFiles.file[0]` ... `file[9]` are `file`, `fileDepth2` ... `fileDepth10`.
  - `delivery.entries`: `types[1]`, `list[1]`, `query[1]`, `one[1]`, `global[1]`, `schema[1]`, `openapi[1]` (the `/k/{keyId}` routes) are `typesByKey`, `listByKey`, `queryByKey`, `oneByKey`, `globalByKey`, `schemaByKey`, `openapiByKey`; the `[0]` forms lose the suffix.
  - `delivery.site`: `routes`, `resolve`, `redirects`, `sitemap`, `search` the same way (`routesByKey`, ...).
  - `integrations.githubWebhook`: `receive[0]` is `receive`, `receive[1]` is `receiveGithub`.
  Anything that called `client.request('DeliveryEntries_list[0]')` or the bracketed property must use the new name.
- The generated default `Forumulate-Version` is now `2027-02-01` (was `2027-01-01`). From that version a search door (docs, reader, site, organization, chat and public forum search) answers an empty `q` with 422 `validation.failed` instead of 200 with no hits. A short term still answers 200 with `minQueryLength`. Pass `apiVersion: '2027-01-01'` to keep the old answer.
- An unknown dated `Forumulate-Version` rounds down to the newest released one and says so; the bad-version 400 suggests the newest.

### Fixed

- Unset settings objects (reader auth, consent) read as unset rather than blank, and PATCH-after-GET round-trips.
- The embed manifest's tenant budget is measured in UTF-8 bytes, not characters.
- Translation and author maps in manifests keep their shape when the value schema comes from another copy of zod.

## 0.10.0

Cache, trash and destroy under their own names; publish runs; the token, named.

### Added

- `client.cache.purge({ orgId, space?, page? })` and the generated `cache.purgePage`,
  `cache.purgeSpace`, `cache.purgeOrg` (`Cache_*`): drop cached copies — our web tier and
  every CDN the org configured — and answer which addresses went and which `edge` took them
  (`none` when no CDN fronts them). Nothing is deleted.
- `cache.providers.*` (`EdgeProvider_*`): configure Fastly, Bunny, KeyCDN or a signed purge
  webhook beside Cloudflare.
- `spaces.destroy()` / `pages.destroy()` (`Space_destroy`, `Page_destroy`): delete a TRASHED
  space or page for good, with `confirm: '<slug>'`. `spaces.purge()` / `pages.purge()` remain
  as deprecated names; from `Forumulate-Version: 2027-01-01` they require `confirm` too.
- `pages.publishRuns.*` (`PublishRun_*`): report, list and read docs-as-code runs, and
  `syncState` — which pages were edited since the last sync, by whom and when.
- `pages.publish()` takes `purge: 'page' | 'space' | 'none'` and `syncBaseline`, and answers
  `purged`. `auth.me()` names the token: `id`, `name`, `last4`, `expiresAt`, `capabilities`,
  `constraints`.
- Webhook event `publish.completed`.

### Deprecated

- `privacy.consent.purgeSpace()` / `purgeOrg()`: use `cache.purge()`.

## 0.9.0

The policy acceptance gate, from your server.

### Added

- `client.policies`: `status`, `accept`, `claim`, `ticket`, `verify`, `acceptances`, `export`,
  `erase`, `list` (Forumulate policy feed v1, signed with a link secret or public) and `release`
  (one exact published version).
- `verifyAcceptanceToken(token, { keys | secret | jwks | jwksUrl, subject?, spaceId?, orgId?,
  requireSatisfied? })`: offline verification of the gate's acceptance tokens and receipts
  (HS256 JWT, `kid`-selected keyring, so a key rotation never breaks a token in flight). Refuses a
  ticket presented as an acceptance (`wrong_use`), `alg` other than HS256, and expired tokens.
- `signPolicyTicket`, `policyGatePageUrl` and `readPolicyReturn`: the hosted acceptance page round
  trip with no API call. `verifyPolicyTicket` checks a ticket of yours that comes back to your
  server (a bridge between an auth platform's redirect and the hosted page). `parsePolicyGateKeys` reads `FORUMULATE_POLICY_GATE_KEYS`;
  `policyEmailHash` and `policySha256Hex` are the gate's two hashes.
- `acceptanceItemsFrom(status, { presentation })`: the items to record after your own UI showed
  the policies.
- Forumulate policy feed v1 protocol: `signPolicyFeedRequest` / `verifyPolicyFeedRequest`
  (`forumulate-*` or `atlas-*` headers, millisecond timestamps, rotation, replay hook) and
  `verifyPolicyWebhook` / `signPolicyWebhook` (Standard Webhooks, `whsec_` secrets) for
  `policy.published` and `policy.retired`.

Not published to npm yet: publishing is the integrator's release step.
