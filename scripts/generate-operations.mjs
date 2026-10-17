#!/usr/bin/env node
/**
 * openapi.json → src/operations.gen.ts: the route table behind the resource
 * namespaces (`client.forum.topics.list(…)`) and `client.request(operationId)`.
 *
 *   pnpm --filter @forumulate/sdk generate-operations
 *
 * Run it after every spec refresh, in the same commit as `schema.ts`. The
 * namespaces are GENERATED rather than written because a hand-written surface
 * covered 30 of 1,800 operations and every route added after it was invisible
 * from the SDK; `src/coverage.test.ts` fails when the table and the spec
 * disagree, so a new route cannot be silently missed.
 *
 * Placement: an operationId is `<Tag>_<method>`. The tag decides where it
 * lives — `STEMS` below maps a tag prefix to `namespace` or `namespace.sub`,
 * longest prefix wins, and the rest of the tag names the sub-namespace
 * (`ForumTaxonomy` → `forum.taxonomy`). A `Public` prefix or suffix lands in a
 * `public…` sub (`PublicForumTopic` → `forum.publicTopic`). A tag nothing
 * matches becomes its own namespace, so a brand-new area still gets a home
 * without anyone editing this file. The method is the operationId's own
 * method part, so the SDK and the API reference use the same word.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(join(root, 'openapi.json'), 'utf8'));

/** `stem target`: target is `ns` or `ns.subBase`; `=` before a stem matches it exactly only. */
const STEMS = `
Health health|Auth auth|Sessions auth.sessions|DeviceKeys auth.deviceKeys
SsoAuth auth.sso|SamlAuth auth.saml|LtiAuth auth.lti|DiscourseConnectAuth auth.discourseConnect
SsoAdmin sso|SamlAdmin sso.saml|LtiAdmin sso.lti|ScimAdmin sso.scim|DiscourseConnectAdmin sso.discourseConnect
AtlasEnterprise sso.atlasEnterprise|Scim scim
Pat tokens|ServiceAccount tokens.serviceAccounts
User users|Avatar users.avatar|MyActivity users.activity|Wallet users.wallet|Progression users.progression
Onboarding users.onboarding
Rbac roles.capabilities|Roles roles|CustomRole roles.custom|GroupGrant grants|BadgeQueryGrant grants.badgeQuery
Group groups|Member members|Invite invites
TranslationOverride i18n.overrides
SpaceTypes spaceTypes|BlockSchema meta.blockSchema|MarkdownDialect meta.markdownDialect|Icons meta.icons
SectionLibrary meta.sectionLibrary
=Content content|ContentLibrary content.libraries|ContentModel content.model|ContentLocales content.locales
ContentEntryLocales content.entryLocales|ContentAi content.ai|ContentStudio content.studio
ContentWorkflow content.workflow|ContentRule docs.contentRules
Entry content.entry|EntryCard content.entries|PreviewSessions content.previewSessions
PreviewStatus content.previewStatus|PreviewExchange delivery.previewExchange
Library content|=Library docs.variables|LibraryMedia content.assets|LibraryItem content.items
LibraryDomain content.domains|LibraryAsset content.assetCandidates
ReferenceCandidates content.referenceCandidates|ModelIo content.modelIo|Environments content.environments
Releases content.releases|DeliveryKeys content.keys|DeployStatus content.deployStatus
HostedOutput content.hostedOutput|Delivery delivery
Legal legal|LegalUpdates legal.updates|ReaderLegalGate legal.readerGate
Reader readers|VisitorOidc readers.visitorOidc
Org orgs|OrgAnalytics analytics.tags|OrgLens ai.lens|OrgImportJob orgs.imports|Organizations orgs.directory
Manifest orgs.manifest|Audit orgs.audit|CustomField orgs.customFields|Screening orgs.screening
Settings orgs.settings|Problems orgs.problems|CaptchaAdmin orgs.captcha|Template orgs.templates
Billing billing
Space spaces|=Spaces spaces.bulk|SpaceSnapshot snapshots|HubIntro spaces.hubIntro|Preview spaces.preview
Address spaces.addresses|ShareLink spaces.shareLinks
Course courses|MyLearning courses.myLearning|MyCoursePaths courses.myPaths
Collection collections|Page pages|Revision pages.revisions|Collab pages.collab|PublishAll pages.publishAll
ChangeRequest changeRequests|CommentModeration comments
=Search docs.search|Discovery docs.discovery|Version docs.versions|Versioning docs.versioning
Translation docs.translations|Import docs.import|OpenApi openapi|SdkPublishing openapi.sdkPublishing
Webhook webhooks|Notification notifications|Push notifications.push
Mail mail|Unsubscribe mail.unsubscribe|EmailTemplates mail.templates|Newsletter newsletter
Asset assets|Domain domains|AcmeChallenge domains.acme
Blog blog|Forum forum|Automation forum.automations|Roadmap roadmap
Community community|Extras community.extras|Reputation community.reputation|CannedReply community.cannedReplies
Relationship community.relationships|ComposerDraft community.drafts|CustomEmoji community.customEmoji
Moderation moderation|CustomFlagType moderation.flagTypes
Growth analytics.growth|ApiActivity analytics.apiActivity
Changelog changelog|ReleaseReview changelog.review|ReleaseTranslation changelog.translation
Event events|=Events events
Embed embeds|EmbeddableHost embeds.hosts
Form forms|=Forms forms|Contact forms.contact
Ai ai|UnifiedSearch search|Retrieval search.retrieval|EmbeddingProvider search.embeddingProvider
Chat chat|Messages messages|InboundEmail integrations.inboundEmail
Item items|Questions questions|Status status|Shape shapes
Careers careers|GoogleIndexing careers.googleIndexing
Theme themes|Extension extensions|ExtApi extensions.api|Render extensions.render|Registry extensions.registry
StripeWebhook extensions.stripeWebhook
Github integrations.github|AtlasWebhook integrations.atlasWebhook|SecretScanning integrations.secretScanning
Connectors integrations.connectors|ConnectorProviders integrations.connectorProviders
CustomProviders integrations.customProviders|ConnectorKb integrations.connectorKb|Integrations integrations
Slack integrations.slack|Deepl integrations.deepl
Site sites|Faq faq|Viewer public.viewer|UpdatesRss public.updatesFeed|AddressIndex public.addressIndex
PrivacyExecutor privacy.executor|CookieMunch privacy.cookieMunch|Consent privacy.consent
Mcp mcp
`
  .split(/[|\n]/)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((row) => {
    const [stem, target] = row.split(' ');
    const exact = stem.startsWith('=');
    const [ns, subBase = ''] = target.split('.');
    return { stem: exact ? stem.slice(1) : stem, exact, ns, subBase };
  });

/** Names a path param must not take: they are the call's own option keys. */
const RESERVED = new Set([
  'query',
  'body',
  'headers',
  'idempotencyKey',
  'signal',
  'raw',
  'maxRetries',
]);
/** Plain-English aliases where the operationId uses another word and the name is free. */
const ALIASES = { remove: 'delete', read: 'get', patch: 'update' };

const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const upperFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** Keep in step with `CamelCase` in src/resources.ts (the type-level twin). */
const camel = (s) => {
  const parts = s.split('_').filter(Boolean);
  return parts[0] + parts.slice(1).map(upperFirst).join('');
};

function place(tag) {
  let core = tag;
  let isPublic = false;
  if (/^Public[A-Z]/.test(core) || core === 'Public') {
    core = core.slice('Public'.length);
    isPublic = true;
  } else if (/[a-z]Public$/.test(core)) {
    core = core.slice(0, -'Public'.length);
    isPublic = true;
  }
  let best = null;
  for (const s of STEMS) {
    const hit = s.exact ? core === s.stem : core.startsWith(s.stem);
    if (!hit) continue;
    if (
      !best ||
      s.stem.length > best.stem.length ||
      (s.stem.length === best.stem.length && s.exact)
    )
      best = s;
  }
  let ns;
  let sub;
  if (best) {
    ns = best.ns;
    sub = lowerFirst(
      best.subBase ? best.subBase + core.slice(best.stem.length) : core.slice(best.stem.length),
    );
  } else if (isPublic) {
    ns = 'public';
    sub = lowerFirst(core);
  } else {
    ns = lowerFirst(core);
    sub = '';
  }
  if (isPublic && ns !== 'public') sub = sub ? 'public' + upperFirst(sub) : 'public';
  return sub ? `${ns}.${sub}` : ns;
}

/** Shorthand for the prefixes almost every path starts with; expanded in src/resources.ts. */
const PREFIXES = [
  ['~P', '/public/orgs/{orgId}/spaces/{spaceId}'],
  ['~L', '/orgs/{orgId}/content/libraries/{libraryId}'],
  ['~s', '/orgs/{orgId}/spaces/{spaceId}'],
  ['~o', '/orgs/{orgId}'],
];
const shorten = (p) => {
  for (const [k, v] of PREFIXES) if (p === v || p.startsWith(v + '/')) return k + p.slice(v.length);
  return p;
};

const BINARY = /^(application\/(pdf|zip|gzip|octet-stream)|image\/|text\/event-stream|\*\/\*)/;
const tags = new Map();
const pathParamsSeen = new Set();
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [verb, op] of Object.entries(item)) {
    if (!op || typeof op !== 'object' || !op.operationId) continue;
    const id = op.operationId;
    const cut = id.indexOf('_');
    if (cut < 1) throw new Error(`operationId ${id} is not <Tag>_<method>`);
    const tag = id.slice(0, cut);
    const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) =>
      p.$ref ? spec.components.parameters[p.$ref.split('/').pop()] : p,
    );
    for (const name of path.match(/\{([^}]+)\}/g) ?? []) {
      const n = name.slice(1, -1);
      pathParamsSeen.add(n);
      if (RESERVED.has(n)) throw new Error(`${id}: path param "${n}" collides with a call option`);
    }
    let flags = '';
    if (params.some((p) => p.in === 'query' && p.name === 'cursor')) flags += 'p';
    const ok = Object.entries(op.responses ?? {}).find(([k]) => /^2/.test(k))?.[1];
    const types = Object.keys(ok?.content ?? {});
    if (types.length && !types.includes('application/json'))
      flags += types.some((t) => BINARY.test(t)) ? 'b' : 't';
    if (op.requestBody?.content?.['multipart/form-data']) flags += 'm';
    const entry = tags.get(tag) ?? { placement: place(tag), methods: new Map() };
    const method = camel(id.slice(cut + 1));
    if (entry.methods.has(method))
      throw new Error(`${tag}: two operations camel-case to "${method}"`);
    const suffix = id.slice(cut + 1);
    const route = `${verb.toUpperCase()} ${shorten(path)}${flags ? ' ' + flags : ''}`;
    entry.methods.set(method, { suffix, route });
    tags.set(tag, entry);
  }
}
for (const entry of tags.values()) {
  for (const [from, to] of Object.entries(ALIASES)) {
    if (entry.methods.has(from) && !entry.methods.has(to))
      entry.methods.set(to, entry.methods.get(from));
  }
}

// Placements must be one tag each, and a method must not share a name with a sub-namespace.
const byPlacement = new Map();
for (const [tag, { placement }] of tags) {
  if (byPlacement.has(placement))
    throw new Error(`${tag} and ${byPlacement.get(placement)} both land at ${placement}`);
  byPlacement.set(placement, tag);
}
for (const [tag, { placement, methods }] of tags) {
  if (placement.includes('.')) continue;
  for (const m of methods.keys()) {
    if (byPlacement.has(`${placement}.${m}`))
      throw new Error(`${tag}: method ${placement}.${m} is also a namespace`);
  }
}

const version = spec.components?.parameters?.ForumulateVersion?.schema?.example ?? '2026-12-01';
const sorted = [...tags].sort(([, a], [, b]) => a.placement.localeCompare(b.placement));
const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const key = (s) => (/^[A-Za-z_$][\w$]*$/.test(s) ? s : q(s));
const lines = sorted.map(([tag, { placement, methods }]) => {
  // The operationId is `<Tag>_<method>`; it is spelled out only where the method differs from it.
  const ms = [...methods]
    .map(([m, v]) => `${key(m)}: ${q(v.suffix === m ? v.route : `=${v.suffix} ${v.route}`)}`)
    .join(', ');
  return `  ${tag}: [${q(placement)}, { ${ms} }],`;
});

const out = `// GENERATED by scripts/generate-operations.mjs from openapi.json — do not edit.
// One line per operationId tag: [placement, { method: '[=idSuffix ]VERB path [flags]' }].
// The operationId is <Tag>_<method> unless an =idSuffix says otherwise (aliases, underscores).
// Flags: p = cursor-paged list, b = binary/stream response, t = text response, m = multipart body.
// Path shorthand: ${PREFIXES.map(([k, v]) => `${k} = ${v}`).join(', ')}.

/** The newest API version this table was generated from; sent by the namespace methods. */
export const API_VERSION = ${q(version)};

export const PATH_PREFIXES = { ${PREFIXES.map(([k, v]) => `${q(k)}: ${q(v)}`).join(', ')} } as const;

export const OPERATIONS = {
${lines.join('\n')}
} as const;
`;
const target = join(root, 'src', 'operations.gen.ts');
if (process.argv.includes('--check')) {
  // Used by coverage.test.ts: the committed table must be what the committed spec generates.
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    /* missing counts as stale */
  }
  if (current !== out) {
    console.error(
      'operations.gen.ts is stale — run `pnpm --filter @forumulate/sdk generate-operations`',
    );
    process.exit(1);
  }
  process.exit(0);
}
writeFileSync(target, out);
const opCount = [...tags.values()].reduce((n, t) => n + t.methods.size, 0);
console.log(
  `operations.gen.ts: ${tags.size} tags, ${opCount} methods (incl. aliases), ${out.length} bytes`,
);
