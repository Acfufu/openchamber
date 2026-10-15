/**
 * The curated external-services catalog: one bundled, typed list of services
 * worth connecting to OpenChamber. Adding or removing entries and changing
 * their URLs is a reviewed change; a URL change reaches users with the next
 * release. What belongs here and how to vet a candidate before adding it:
 * DOCUMENTATION.md next to this file.
 *
 * An entry is one integration and may bundle several components: an MCP
 * server, an OpenCode plugin, and skills can arrive together the way vendors
 * ship them. Field names follow the official MCP Registry `server.json`
 * where they overlap, so importing from it stays possible.
 *
 * Vendor URLs were checked against vendor docs on 2026-10-01 (OPE-282 launch
 * list). Recheck one when you touch it.
 */
import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';

/** Card groups behind the category filter chips. */
export type CatalogCategory = 'product' | 'code' | 'design' | 'cloud' | 'data' | 'quality' | 'ai' | 'other';

export type CatalogEntryStatus = 'stable' | 'beta';

/** How a service authenticates. `none` covers no-auth remotes and local servers. */
export type CatalogAuthKind = 'oauth' | 'token' | 'none';

/** A region/site/org picker that feeds `{id}` tokens inside a URL or command. */
export type CatalogInput = {
  /** Token name the entry interpolates: `{region}` inside `url` or `command`. */
  id: string;
  /** Label key, translated with t() in the component. */
  labelKey: I18nKey;
  placeholder: string;
  defaultValue?: string;
  /** Blocks install while empty; without it a default value satisfies the input. */
  required?: boolean;
};

/**
 * One installable part of an integration. At most one MCP component per
 * entry: the entry id doubles as the MCP server name.
 */
export type CatalogMcpComponent = {
  kind: 'mcp';
  auth: CatalogAuthKind;
  /**
   * Carries `{inputId}` tokens for entries with `inputs`.
   */
  remote?: {
    url: string;
    /** For `auth: 'token'`: the header that carries the token, e.g. Bearer. */
    tokenHeader?: { name: string; valuePrefix?: string };
    /** True when the token is optional and install works without it. */
    tokenOptional?: boolean;
  };
  /** Local servers run on the machine OpenCode runs on. */
  local?: {
    /** May carry `{inputId}` tokens for entries with `inputs`. */
    command: string[];
    /** First run downloads a package; OpenCode's default timeout is too tight. */
    timeoutMs?: number;
    /** Prerequisites shown as a note on the card. */
    requires?: Array<'node' | 'python' | 'docker'>;
  };
  /** Where the user creates a token, for `auth: 'token'`. */
  tokenHelpUrl?: string;
};

export type CatalogPluginComponent = {
  kind: 'plugin';
  /** npm spec with a pinned major, installed through the plugins routes. */
  spec: string;
  license?: string;
};

export type CatalogSkillComponent = {
  kind: 'skill';
  /** Git source the Skills catalog page accepts, e.g. `openai/skills`. */
  source: string;
  /** Path inside the repository that holds the skill directory. */
  subpath: string;
  /** The skill's directory name, used for the installed check. */
  skillDir: string;
  /**
   * The name OpenCode reports for the skill (its SKILL.md frontmatter name),
   * when it differs from the folder basename. Drives the installed check and
   * the uninstall lookup.
   */
  skillName?: string;
  /**
   * Vendor terms that govern the skill instead of an open-source license;
   * installing it accepts them, so the detail page links them.
   */
  termsUrl?: string;
};

/** An OpenChamber extension installed from its Git repository. */
type CatalogExtensionComponent = {
  kind: 'extension';
  /** The extension's `panel.id`, which is its id once installed. */
  guestId: string;
  /** The Git URL the one-click install accepts. */
  gitUrl: string;
};

export type CatalogComponent = CatalogMcpComponent | CatalogPluginComponent | CatalogSkillComponent | CatalogExtensionComponent;

export type CatalogEntry = {
  /** Stable identifier, and the MCP server name when the entry ships an MCP component. */
  id: string;
  name: string;
  publisher: string;
  /** True when the endpoint is run by the vendor itself. */
  verified: boolean;
  /** Full i18n key under `integrationsCatalog.entry.<id>.description`, typed against the english dictionary. */
  descriptionKey: I18nKey;
  /** Longer detail-page description under `integrationsCatalog.entry.<id>.details`, typed against the english dictionary. */
  detailsKey: I18nKey;
  categories: CatalogCategory[];
  /** Fallback mark for entries whose brand has no glyph in brand-icons.ts. */
  icon: IconName;
  homepage: string;
  status: CatalogEntryStatus;
  /** The installable parts, at least one. */
  components: [CatalogComponent, ...CatalogComponent[]];
  /** Pickers that feed `{id}` tokens in this entry's component urls or commands. */
  inputs?: CatalogInput[];
};

/** Local packages download on first run; OpenCode's default startup timeout is 5000ms. */
const LOCAL_TIMEOUT_MS = 30000;

export const CATALOG_ENTRIES: readonly CatalogEntry[] = [
  // --- Project and work tools (remote, OAuth) ---
  {
    id: 'linear',
    name: 'Linear',
    publisher: 'Linear',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.linear.description',
    detailsKey: 'integrationsCatalog.entry.linear.details',
    categories: ['product'],
    icon: 'linear',
    homepage: 'https://linear.app',
    status: 'stable',
    components: [
      { kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.linear.app/mcp' } },
      { kind: 'skill', source: 'openai/skills', subpath: 'skills/.curated/linear', skillDir: 'linear' },
    ],
  },
  {
    id: 'atlassian',
    name: 'Atlassian',
    publisher: 'Atlassian',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.atlassian.description',
    detailsKey: 'integrationsCatalog.entry.atlassian.details',
    categories: ['product'],
    icon: 'briefcase',
    homepage: 'https://www.atlassian.com',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.atlassian.com/v2/mcp' } }],
  },
  {
    id: 'notion',
    name: 'Notion',
    publisher: 'Notion',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.notion.description',
    detailsKey: 'integrationsCatalog.entry.notion.details',
    categories: ['product'],
    icon: 'booklet',
    homepage: 'https://www.notion.com',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.notion.com/mcp' } }],
  },
  {
    id: 'asana',
    name: 'Asana',
    publisher: 'Asana',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.asana.description',
    detailsKey: 'integrationsCatalog.entry.asana.details',
    categories: ['product'],
    icon: 'list-check-2',
    homepage: 'https://asana.com',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.asana.com/v2/mcp' } }],
  },
  {
    id: 'monday',
    name: 'monday.com',
    publisher: 'monday.com',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.monday.description',
    detailsKey: 'integrationsCatalog.entry.monday.details',
    categories: ['product'],
    icon: 'layout-column',
    homepage: 'https://monday.com',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.monday.com/mcp' } }],
  },
  {
    id: 'granola',
    name: 'Granola',
    publisher: 'Granola',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.granola.description',
    detailsKey: 'integrationsCatalog.entry.granola.details',
    categories: ['product'],
    icon: 'mic',
    homepage: 'https://www.granola.ai',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.granola.ai/mcp' } }],
  },
  {
    id: 'clickup',
    name: 'ClickUp',
    publisher: 'ClickUp',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.clickup.description',
    detailsKey: 'integrationsCatalog.entry.clickup.details',
    categories: ['product'],
    icon: 'task',
    homepage: 'https://clickup.com',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.clickup.com/mcp' } }],
  },
  {
    id: 'shortcut',
    name: 'Shortcut',
    publisher: 'Shortcut',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.shortcut.description',
    detailsKey: 'integrationsCatalog.entry.shortcut.details',
    categories: ['product'],
    icon: 'task',
    homepage: 'https://www.shortcut.com',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.shortcut.com/mcp' } }],
  },
  {
    id: 'dropbox',
    name: 'Dropbox',
    publisher: 'Dropbox',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.dropbox.description',
    detailsKey: 'integrationsCatalog.entry.dropbox.details',
    categories: ['product'],
    icon: 'archive',
    homepage: 'https://www.dropbox.com',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.dropbox.com/mcp' } }],
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    publisher: 'GitLab',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.gitlab.description',
    detailsKey: 'integrationsCatalog.entry.gitlab.details',
    categories: ['code'],
    icon: 'gitlab',
    homepage: 'https://about.gitlab.com',
    status: 'beta',
    components: [{ kind: 'mcp', auth: 'oauth', remote: { url: 'https://gitlab.com/api/v4/mcp' } }],
  },
  {
    id: 'figma',
    name: 'Figma',
    publisher: 'Figma',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.figma.description',
    detailsKey: 'integrationsCatalog.entry.figma.details',
    categories: ['design'],
    icon: 'pencil-ruler-2',
    homepage: 'https://www.figma.com',
    status: 'stable',
    components: [
      { kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.figma.com/mcp' } },
      { kind: 'skill', source: 'openai/skills', subpath: 'skills/.curated/figma', skillDir: 'figma', termsUrl: 'https://www.figma.com/legal/developer-terms/' },
    ],
  },
  {
    id: 'canva',
    name: 'Canva',
    publisher: 'Canva',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.canva.description',
    detailsKey: 'integrationsCatalog.entry.canva.details',
    categories: ['design'],
    icon: 'palette',
    homepage: 'https://www.canva.com',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.canva.com/mcp' } }],
  },
  {
    id: 'miro',
    name: 'Miro',
    publisher: 'Miro',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.miro.description',
    detailsKey: 'integrationsCatalog.entry.miro.details',
    categories: ['design'],
    icon: 'pencil-ruler-2',
    homepage: 'https://miro.com',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.miro.com/' } }],
  },

  // --- Cloud and infrastructure (remote, OAuth) ---
  {
    id: 'supabase',
    name: 'Supabase',
    publisher: 'Supabase',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.supabase.description',
    detailsKey: 'integrationsCatalog.entry.supabase.details',
    categories: ['data'],
    icon: 'database-2',
    homepage: 'https://supabase.com',
    status: 'stable',
    components: [
      { kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.supabase.com/mcp' } },
      { kind: 'skill', source: 'supabase/agent-skills', subpath: 'skills/supabase', skillDir: 'supabase' },
      { kind: 'skill', source: 'supabase/agent-skills', subpath: 'skills/supabase-postgres-best-practices', skillDir: 'supabase-postgres-best-practices' },
    ],
  },
  {
    id: 'neon',
    name: 'Neon',
    publisher: 'Neon',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.neon.description',
    detailsKey: 'integrationsCatalog.entry.neon.details',
    categories: ['data'],
    icon: 'database-2',
    homepage: 'https://neon.tech',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.neon.tech/mcp' } }],
  },
  {
    id: 'airtable',
    name: 'Airtable',
    publisher: 'Airtable',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.airtable.description',
    detailsKey: 'integrationsCatalog.entry.airtable.details',
    categories: ['data'],
    icon: 'table-2',
    homepage: 'https://airtable.com',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.airtable.com/mcp' } }],
  },
  {
    id: 'hex',
    name: 'Hex',
    publisher: 'Hex',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.hex.description',
    detailsKey: 'integrationsCatalog.entry.hex.details',
    categories: ['data'],
    icon: 'bar-chart-box',
    homepage: 'https://hex.tech',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'oauth', remote: { url: 'https://app.hex.tech/mcp' } }],
  },
  {
    id: 'stripe',
    name: 'Stripe',
    publisher: 'Stripe',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.stripe.description',
    detailsKey: 'integrationsCatalog.entry.stripe.details',
    categories: ['other'],
    icon: 'scales-3',
    homepage: 'https://stripe.com',
    status: 'beta',
    components: [
      { kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.stripe.com' } },
      { kind: 'skill', source: 'stripe/agent-toolkit', subpath: 'skills/stripe-best-practices', skillDir: 'stripe-best-practices' },
      { kind: 'skill', source: 'stripe/agent-toolkit', subpath: 'skills/stripe-docs', skillDir: 'stripe-docs' },
    ],
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    publisher: 'Cloudflare',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.cloudflare.description',
    detailsKey: 'integrationsCatalog.entry.cloudflare.details',
    categories: ['cloud'],
    icon: 'cloudflare',
    homepage: 'https://www.cloudflare.com',
    status: 'stable',
    components: [
      { kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.cloudflare.com/mcp' } },
      { kind: 'skill', source: 'cloudflare/skills', subpath: 'skills/cloudflare', skillDir: 'cloudflare' },
      { kind: 'skill', source: 'cloudflare/skills', subpath: 'skills/wrangler', skillDir: 'wrangler' },
      { kind: 'skill', source: 'cloudflare/skills', subpath: 'skills/workers-best-practices', skillDir: 'workers-best-practices' },
    ],
  },
  {
    id: 'vercel',
    name: 'Vercel',
    publisher: 'Vercel',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.vercel.description',
    detailsKey: 'integrationsCatalog.entry.vercel.details',
    categories: ['cloud'],
    icon: 'rocket',
    homepage: 'https://vercel.com',
    status: 'beta',
    components: [
      { kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.vercel.com' } },
      { kind: 'skill', source: 'vercel-labs/agent-skills', subpath: 'skills/deploy-to-vercel', skillDir: 'deploy-to-vercel' },
      { kind: 'skill', source: 'vercel-labs/agent-skills', subpath: 'skills/react-best-practices', skillDir: 'react-best-practices', skillName: 'vercel-react-best-practices' },
    ],
  },
  {
    id: 'sentry',
    name: 'Sentry',
    publisher: 'Sentry',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.sentry.description',
    detailsKey: 'integrationsCatalog.entry.sentry.details',
    categories: ['quality'],
    icon: 'bug',
    homepage: 'https://sentry.io',
    status: 'stable',
    components: [
      { kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.sentry.dev/mcp' } },
      { kind: 'skill', source: 'openai/skills', subpath: 'skills/.curated/sentry', skillDir: 'sentry' },
    ],
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    publisher: 'Hugging Face',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.huggingface.description',
    detailsKey: 'integrationsCatalog.entry.huggingface.details',
    categories: ['ai'],
    icon: 'robot-2',
    homepage: 'https://huggingface.co',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'oauth', remote: { url: 'https://huggingface.co/mcp' } }],
  },
  {
    id: 'zapier',
    name: 'Zapier',
    publisher: 'Zapier',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.zapier.description',
    detailsKey: 'integrationsCatalog.entry.zapier.details',
    categories: ['other'],
    icon: 'flashlight',
    homepage: 'https://zapier.com',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.zapier.com/mcp' } }],
  },
  {
    id: 'aws',
    name: 'AWS',
    publisher: 'Amazon Web Services',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.aws.description',
    detailsKey: 'integrationsCatalog.entry.aws.details',
    categories: ['cloud'],
    icon: 'cloud',
    homepage: 'https://aws.amazon.com',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'oauth', remote: { url: 'https://aws-mcp.{region}.api.aws/mcp' } }],
    inputs: [{ id: 'region', labelKey: 'integrationsCatalog.input.region', placeholder: 'us-east-1', defaultValue: 'us-east-1' }],
  },
  {
    id: 'datadog',
    name: 'Datadog',
    publisher: 'Datadog',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.datadog.description',
    detailsKey: 'integrationsCatalog.entry.datadog.details',
    categories: ['quality'],
    icon: 'pulse',
    homepage: 'https://www.datadoghq.com',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.{site}/v1/mcp' } }],
    inputs: [{ id: 'site', labelKey: 'integrationsCatalog.input.site', placeholder: 'datadoghq.com', defaultValue: 'datadoghq.com' }],
  },
  {
    id: 'posthog',
    name: 'PostHog',
    publisher: 'PostHog',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.posthog.description',
    detailsKey: 'integrationsCatalog.entry.posthog.details',
    categories: ['quality', 'data'],
    icon: 'bar-chart-box',
    homepage: 'https://posthog.com',
    status: 'stable',
    components: [
      { kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.posthog.com/mcp' } },
      { kind: 'skill', source: 'PostHog/skills', subpath: 'skills/posthog/all/skills/tools-and-features-hogql', skillDir: 'tools-and-features-hogql' },
    ],
  },
  {
    id: 'mixpanel',
    name: 'Mixpanel',
    publisher: 'Mixpanel',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.mixpanel.description',
    detailsKey: 'integrationsCatalog.entry.mixpanel.details',
    categories: ['quality', 'data'],
    icon: 'bar-chart-box',
    homepage: 'https://mixpanel.com',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.mixpanel.com/mcp' } }],
  },
  {
    id: 'incident-io',
    name: 'incident.io',
    publisher: 'incident.io',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.incident-io.description',
    detailsKey: 'integrationsCatalog.entry.incident-io.details',
    categories: ['quality'],
    icon: 'alarm-warning',
    homepage: 'https://incident.io',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'oauth', remote: { url: 'https://mcp.incident.io/mcp' } }],
  },

  // --- Remote with a token ---
  {
    id: 'github',
    name: 'GitHub',
    publisher: 'GitHub',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.github.description',
    detailsKey: 'integrationsCatalog.entry.github.details',
    categories: ['code'],
    icon: 'github',
    homepage: 'https://github.com',
    status: 'stable',
    components: [
      { kind: 'mcp', auth: 'token', remote: { url: 'https://api.githubcopilot.com/mcp/', tokenHeader: { name: 'Authorization', valuePrefix: 'Bearer ' } }, tokenHelpUrl: 'https://github.com/settings/tokens' },
      { kind: 'skill', source: 'openai/skills', subpath: 'skills/.curated/gh-fix-ci', skillDir: 'gh-fix-ci' },
    ],
  },
  {
    id: 'postman',
    name: 'Postman',
    publisher: 'Postman',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.postman.description',
    detailsKey: 'integrationsCatalog.entry.postman.details',
    categories: ['other'],
    icon: 'send-plane',
    homepage: 'https://www.postman.com',
    status: 'stable',
    components: [{
      kind: 'mcp',
      auth: 'token',
      remote: { url: 'https://mcp.postman.com/minimal', tokenHeader: { name: 'X-Api-Key' } },
      tokenHelpUrl: 'https://go.postman.co/settings/me/api-keys',
    }],
  },
  {
    id: 'render',
    name: 'Render',
    publisher: 'Render',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.render.description',
    detailsKey: 'integrationsCatalog.entry.render.details',
    categories: ['cloud'],
    icon: 'rocket',
    homepage: 'https://render.com',
    status: 'stable',
    components: [
      {
        kind: 'mcp',
        auth: 'token',
        remote: { url: 'https://mcp.render.com/mcp', tokenHeader: { name: 'Authorization', valuePrefix: 'Bearer ' } },
        tokenHelpUrl: 'https://dashboard.render.com/u/settings#api-keys',
      },
      { kind: 'skill', source: 'render-oss/skills', subpath: 'skills/render-deploy', skillDir: 'render-deploy' },
      { kind: 'skill', source: 'render-oss/skills', subpath: 'skills/render-debug', skillDir: 'render-debug' },
      { kind: 'skill', source: 'render-oss/skills', subpath: 'skills/render-monitor', skillDir: 'render-monitor' },
    ],
  },
  {
    id: 'context7',
    name: 'Context7',
    publisher: 'Upstash',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.context7.description',
    detailsKey: 'integrationsCatalog.entry.context7.details',
    categories: ['ai'],
    icon: 'book-open',
    homepage: 'https://context7.com',
    status: 'stable',
    components: [{
      kind: 'mcp',
      auth: 'token',
      remote: { url: 'https://mcp.context7.com/mcp', tokenHeader: { name: 'Authorization', valuePrefix: 'Bearer ' }, tokenOptional: true },
      tokenHelpUrl: 'https://context7.com/dashboard',
    }],
  },
  {
    id: 'exa',
    name: 'Exa',
    publisher: 'Exa',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.exa.description',
    detailsKey: 'integrationsCatalog.entry.exa.details',
    categories: ['ai'],
    icon: 'global',
    homepage: 'https://exa.ai',
    status: 'stable',
    components: [{
      kind: 'mcp',
      auth: 'token',
      remote: { url: 'https://mcp.exa.ai/mcp', tokenHeader: { name: 'x-api-key' }, tokenOptional: true },
      tokenHelpUrl: 'https://dashboard.exa.ai/api-keys',
    }, { kind: 'skill', source: 'exa-labs/exa-mcp-server', subpath: 'skills/search', skillDir: 'search' }],
  },

  // --- Remote, no auth ---
  {
    id: 'microsoft-learn',
    name: 'Microsoft Learn',
    publisher: 'Microsoft',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.microsoft-learn.description',
    detailsKey: 'integrationsCatalog.entry.microsoft-learn.details',
    categories: ['other'],
    icon: 'book-marked',
    homepage: 'https://learn.microsoft.com',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'none', remote: { url: 'https://learn.microsoft.com/api/mcp' } }],
  },

  // --- Local servers (run on the machine OpenCode runs on) ---
  {
    id: 'playwright',
    name: 'Playwright',
    publisher: 'Microsoft',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.playwright.description',
    detailsKey: 'integrationsCatalog.entry.playwright.details',
    categories: ['quality'],
    icon: 'play',
    homepage: 'https://github.com/microsoft/playwright-mcp',
    status: 'stable',
    components: [
      { kind: 'mcp', auth: 'none', local: { command: ['npx', '-y', '@playwright/mcp@latest'], timeoutMs: LOCAL_TIMEOUT_MS, requires: ['node'] } },
      { kind: 'skill', source: 'openai/skills', subpath: 'skills/.curated/playwright', skillDir: 'playwright' },
    ],
  },
  {
    id: 'azure-devops',
    name: 'Azure DevOps',
    publisher: 'Microsoft',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.azure-devops.description',
    detailsKey: 'integrationsCatalog.entry.azure-devops.details',
    categories: ['code'],
    icon: 'git-pull-request',
    homepage: 'https://learn.microsoft.com/en-us/azure/devops/mcp-server/',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'none', local: { command: ['npx', '-y', '@azure-devops/mcp', '{org}'], timeoutMs: LOCAL_TIMEOUT_MS, requires: ['node'] } }],
    inputs: [{ id: 'org', labelKey: 'integrationsCatalog.input.org', placeholder: 'contoso', required: true }],
  },
  {
    id: 'azure',
    name: 'Azure',
    publisher: 'Microsoft',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.azure.description',
    detailsKey: 'integrationsCatalog.entry.azure.details',
    categories: ['cloud'],
    icon: 'server',
    homepage: 'https://github.com/Azure/azure-mcp',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'none', local: { command: ['npx', '-y', '@azure/mcp@latest', 'server', 'start'], timeoutMs: LOCAL_TIMEOUT_MS, requires: ['node'] } }],
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    publisher: 'MongoDB',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.mongodb.description',
    detailsKey: 'integrationsCatalog.entry.mongodb.details',
    categories: ['data'],
    icon: 'leaf',
    homepage: 'https://www.mongodb.com',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'none', local: { command: ['npx', '-y', 'mongodb-mcp-server@latest', '--readOnly'], timeoutMs: LOCAL_TIMEOUT_MS, requires: ['node'] } }],
  },
  {
    id: 'mcp-toolbox',
    name: 'MCP Toolbox for Databases',
    publisher: 'Google',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.mcp-toolbox.description',
    detailsKey: 'integrationsCatalog.entry.mcp-toolbox.details',
    categories: ['data'],
    icon: 'tools',
    homepage: 'https://github.com/googleapis/genai-toolbox',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'none', local: { command: ['npx', '-y', '@toolbox-sdk/server', '--prebuilt={db}', '--stdio'], timeoutMs: LOCAL_TIMEOUT_MS, requires: ['node'] } }],
    inputs: [{ id: 'db', labelKey: 'integrationsCatalog.input.db', placeholder: 'postgres', defaultValue: 'postgres' }],
  },
  {
    id: 'grafana',
    name: 'Grafana',
    publisher: 'Grafana Labs',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.grafana.description',
    detailsKey: 'integrationsCatalog.entry.grafana.details',
    categories: ['quality'],
    icon: 'bar-chart-box',
    homepage: 'https://grafana.com',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'none', local: { command: ['uvx', 'mcp-grafana'], timeoutMs: LOCAL_TIMEOUT_MS, requires: ['python'] } }],
  },
  {
    id: 'terraform',
    name: 'Terraform',
    publisher: 'HashiCorp',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.terraform.description',
    detailsKey: 'integrationsCatalog.entry.terraform.details',
    categories: ['cloud'],
    icon: 'stack',
    homepage: 'https://www.terraform.io',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'none', local: { command: ['docker', 'run', '-i', '--rm', 'hashicorp/terraform-mcp-server'], timeoutMs: LOCAL_TIMEOUT_MS, requires: ['docker'] } }],
  },
  {
    id: 'snyk',
    name: 'Snyk',
    publisher: 'Snyk',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.snyk.description',
    detailsKey: 'integrationsCatalog.entry.snyk.details',
    categories: ['quality'],
    icon: 'shield-check',
    homepage: 'https://snyk.io',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'none', local: { command: ['npx', '-y', 'snyk@latest', 'mcp', '-t', 'stdio'], timeoutMs: LOCAL_TIMEOUT_MS, requires: ['node'] } }],
  },
  {
    id: 'markitdown',
    name: 'MarkItDown',
    publisher: 'Microsoft',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.markitdown.description',
    detailsKey: 'integrationsCatalog.entry.markitdown.details',
    categories: ['other'],
    icon: 'file-text',
    homepage: 'https://github.com/microsoft/markitdown',
    status: 'stable',
    components: [{ kind: 'mcp', auth: 'none', local: { command: ['uvx', 'markitdown-mcp'], timeoutMs: LOCAL_TIMEOUT_MS, requires: ['python'] } }],
  },

  // --- Skills (installed on the Skills catalog page) ---
  {
    id: 'openai-pdf',
    name: 'OpenAI PDF skill',
    publisher: 'OpenAI',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.openai-pdf.description',
    detailsKey: 'integrationsCatalog.entry.openai-pdf.details',
    categories: ['other'],
    icon: 'file-pdf',
    homepage: 'https://github.com/openai/skills',
    status: 'stable',
    components: [{ kind: 'skill', source: 'openai/skills', subpath: 'skills/.curated/pdf', skillDir: 'pdf' }],
  },

  // --- OpenCode plugins (npm, pinned to a major, explicit confirmation) ---
  {
    id: 'langfuse-plugin',
    name: 'Langfuse',
    publisher: 'Langfuse',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.langfuse-plugin.description',
    detailsKey: 'integrationsCatalog.entry.langfuse-plugin.details',
    categories: ['ai'],
    icon: 'pulse',
    homepage: 'https://langfuse.com',
    status: 'stable',
    components: [{ kind: 'plugin', spec: '@langfuse/opencode-observability-plugin@^1', license: 'MIT' }],
  },
  {
    id: 'langsmith-plugin',
    name: 'LangSmith',
    publisher: 'LangChain',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.langsmith-plugin.description',
    detailsKey: 'integrationsCatalog.entry.langsmith-plugin.details',
    categories: ['ai'],
    icon: 'pulse',
    homepage: 'https://smith.langchain.com',
    status: 'stable',
    components: [{ kind: 'plugin', spec: '@langchain/langsmith-opencode@^1', license: 'MIT' }],
  },

  // --- OpenChamber extensions (installed from Git like Settings → Integrations) ---
  {
    id: 'excalidraw',
    name: 'Excalidraw',
    publisher: 'OpenChamber',
    verified: true,
    descriptionKey: 'integrationsCatalog.entry.excalidraw.description',
    detailsKey: 'integrationsCatalog.entry.excalidraw.details',
    categories: ['other'],
    icon: 'pencil-ruler-2',
    homepage: 'https://github.com/openchamber/openchamber-excalidraw',
    status: 'stable',
    components: [{ kind: 'extension', guestId: 'excalidraw', gitUrl: 'https://github.com/openchamber/openchamber-excalidraw' }],
  },
];

/** The opening section of the catalog: widely used services that show what an integration does. */
export const CATALOG_FEATURED_IDS: readonly string[] = ['linear', 'github', 'atlassian', 'figma', 'supabase', 'cloudflare'];

export const CATALOG_CATEGORY_ORDER: readonly CatalogCategory[] = ['product', 'code', 'design', 'cloud', 'data', 'quality', 'ai', 'other'];

export const getCatalogEntry = (id: string): CatalogEntry | undefined =>
  CATALOG_ENTRIES.find((entry) => entry.id === id);

/** The entry's MCP component, when it ships one. */
export const catalogMcpComponent = (entry: CatalogEntry): CatalogMcpComponent | undefined =>
  entry.components.find((component): component is CatalogMcpComponent => component.kind === 'mcp');

/**
 * Fills a remote URL or local command with the card's picker values. A token
 * without a value leaves the field empty, so a partially filled entry can be
 * rejected at validation rather than installed with a broken URL.
 */
export const interpolateCatalogTokens = (template: string, values: Record<string, string>): string =>
  template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, id: string) => {
    const value = values[id];
    return value !== undefined && value.trim() !== '' ? value.trim() : match;
  });

export const catalogEntryHasAllInputs = (entry: CatalogEntry, values: Record<string, string>): boolean =>
  (entry.inputs ?? []).every((input) => {
    const value = values[input.id];
    return !input.required || (value !== undefined && value.trim() !== '');
  });

/** The npm package name of a spec like `@scope/pkg@^1` or `pkg@^1`. */
export const catalogPluginPackageName = (spec: string): string => {
  const at = spec.indexOf('@', 1);
  return at > 0 ? spec.slice(0, at) : spec;
};

/** The display name of one component in the Includes list. */
export const catalogComponentName = (entry: CatalogEntry, component: CatalogComponent): string => {
  if (component.kind === 'mcp') return entry.name;
  if (component.kind === 'plugin') return catalogPluginPackageName(component.spec);
  if (component.kind === 'extension') return component.guestId;
  return component.skillDir;
};