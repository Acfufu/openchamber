/**
 * Repo Wiki panel: the AI-generated architecture guide for one project.
 * Generation, storage, and semantics live on the server
 * (`packages/web/server/lib/repo-wiki`); this panel reads the run state,
 * renders pages, and resolves `repo-wiki-src://` references to the file
 * preview at the cited line.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n, type I18nKey, type I18nParams } from '@/lib/i18n';
import { type Locale } from '@/lib/i18n/runtime';
import {
  resolveRepoWikiProjectId,
  type RepoWikiPageMeta,
} from '@/lib/repoWikiApi';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { projectPathFromProjectId } from '@/lib/projectId';
import { useConfigStore } from '@/stores/useConfigStore';
import { useRepoWikiStore, EMPTY_REPO_WIKI_ENTRY, type RepoWikiEntry, type RepoWikiListState } from '@/stores/useRepoWikiStore';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectorySync } from '@/sync/sync-context';
import { cn } from '@/lib/utils';

type TranslateFn = (key: I18nKey, params?: I18nParams) => string;

const REPO_WIKI_SRC_SCHEME = 'repo-wiki-src://';

const pageStatusLabel = (t: TranslateFn, status: RepoWikiPageMeta['status']): string => {
  if (status === 'done') return t('repoWiki.page.status.done');
  if (status === 'failed') return t('repoWiki.page.status.failed');
  if (status === 'writing') return t('repoWiki.page.status.writing');
  return t('repoWiki.page.status.pending');
};

const runStageLabel = (t: TranslateFn, stage: string | null | undefined): string | null => {
  if (stage === 'digesting') return t('repoWiki.progress.stage.digesting');
  if (stage === 'catalog') return t('repoWiki.progress.stage.catalog');
  if (stage === 'pages') return t('repoWiki.progress.stage.pages');
  return stage || null;
};

interface WikiSourceTarget {
  filePath: string;
  line: number;
}

const parseSourceRef = (href: string): WikiSourceTarget | null => {
  if (!href.startsWith(REPO_WIKI_SRC_SCHEME)) return null;
  const [rawPath = '', anchor = ''] = href.slice(REPO_WIKI_SRC_SCHEME.length).split('#');
  if (!rawPath) return null;
  let filePath = rawPath;
  try {
    filePath = decodeURIComponent(rawPath);
  } catch {
    // A path the model left unencoded is still a usable relative path.
  }
  const lineMatch = anchor.match(/^L(\d+)/);
  return { filePath, line: lineMatch ? Number(lineMatch[1]) : 1 };
};

/**
 * The files surface addresses files by absolute path (that is what the file
 * tree stores), while source references hold workspace-relative paths. A
 * relative path handed to the viewer unanchored reads as outside the
 * workspace, so resolve it against the wiki's directory. `..` segments that
 * escape the workspace stay subject to the server's outside-workspace grant.
 */
const resolveSourcePath = (directory: string, filePath: string): string => {
  if (filePath.startsWith('/') || /^[A-Za-z]:[/\\]/.test(filePath)) {
    return filePath;
  }
  const segments: string[] = [];
  for (const part of `${directory}/${filePath}`.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return `/${segments.join('/')}`;
};

/**
 * Providers the server can actually call, filtered to models the catalog does
 * not flag as schema-incapable — the same rule the walkthrough picker applies
 * (a missing capability field is treated as capable).
 */
const useModelOptions = (): Array<{ value: string; label: string }> => {
  const providers = useConfigStore((state) => state.providers);
  const modelsMetadata = useConfigStore((state) => state.modelsMetadata);
  const [authenticated, setAuthenticated] = React.useState<Set<string>>(() => new Set());

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await runtimeFetch('/api/small-model', { headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        const payload = await response.json();
        const ids: unknown[] = payload != null && payload.constructor === Object && Array.isArray(payload.authenticatedProviders)
          ? payload.authenticatedProviders
          : [];
        if (!cancelled) {
          setAuthenticated(new Set(ids.filter((id): id is string => id != null && id.constructor === String)));
        }
      } catch {
        // Fail closed: never offer a provider whose login was not verified.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return React.useMemo(() => {
    const options: Array<{ value: string; label: string }> = [];
    for (const provider of providers) {
      if (authenticated.size > 0 && !authenticated.has(provider.id)) continue;
      const models = Array.isArray(provider.models) ? provider.models : [];
      for (const model of models) {
        if (model == null || model.id == null) continue;
        if (modelsMetadata.get(`${provider.id}/${model.id}`)?.structured_output === false) continue;
        options.push({ value: `${provider.id}/${model.id}`, label: `${provider.id}/${model.id}` });
      }
    }
    return options;
  }, [providers, modelsMetadata, authenticated]);
};

// Active work first, failures next, waiting last, finished pages at the end.
const PAGE_STATUS_RANK = {
  writing: 0,
  pending: 1,
  failed: 2,
  done: 3,
} satisfies Record<RepoWikiPageMeta['status'], number>;

interface PageStateCounts {
  done: number;
  failed: number;
  total: number;
}

/**
 * Live page counts mirrored straight off the manifest statuses: done and
 * failed are disjoint, and a page that flips back to `writing` shrinks both.
 */
const countPageStates = (pages: RepoWikiPageMeta[]): PageStateCounts => ({
  done: pages.filter((page) => page.status === 'done').length,
  failed: pages.filter((page) => page.status === 'failed').length,
  total: pages.length,
});

/**
 * Stable failure codes → localized sentences. A failure whose code has no
 * entry here (server freeform text, provider errors) renders its raw message.
 * Page-level failures resolve through the same table.
 */
const ERROR_MESSAGE_KEYS = [
  ['run-in-progress', 'repoWiki.error.runInProgress'],
  ['no-model', 'repoWiki.error.noModel'],
  ['no-provider-login', 'repoWiki.error.noProviderLogin'],
  ['context-too-small', 'repoWiki.error.contextTooSmall'],
  ['no-wiki', 'repoWiki.error.noWiki'],
  ['unknown-page', 'repoWiki.error.unknownPage'],
  ['page-not-failed', 'repoWiki.error.pageNotFailed'],
  ['malformed-response', 'repoWiki.error.malformedResponse'],
  ['interrupted', 'repoWiki.error.interrupted'],
  ['invalid-retries', 'repoWiki.error.invalidRetries'],
  ['read-status', 'repoWiki.error.readStatus'],
  ['read-page', 'repoWiki.error.readPage'],
  ['start-generation', 'repoWiki.error.startGeneration'],
  ['stop-generation', 'repoWiki.error.stopGeneration'],
  ['retry-page', 'repoWiki.error.retryPage'],
  ['delete-wiki', 'repoWiki.error.deleteWiki'],
] as const satisfies ReadonlyArray<readonly [string, I18nKey]>;

const localizedError = (t: TranslateFn, message: string | null, errorCode: string | null): string | null => {
  if (!message && errorCode == null) return null;
  const key = errorCode == null ? undefined : ERROR_MESSAGE_KEYS.find(([code]) => code === errorCode)?.[1];
  if (key == null) return message ?? null;
  if (key === 'repoWiki.error.contextTooSmall') return t(key);
  return t(key);
};

/** Locale-formatted wall clock for display metadata; unparseable input passes through. */
const formatTimestamp = (iso: string, locale: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
};

const wikiErrorLine = (t: TranslateFn, entry: RepoWikiEntry): string | null => {
  if (!entry.error) return null;
  if (entry.errorCode != null && entry.errorCode === 'context-too-small' && entry.errorDetail?.requiredChars != null) {
    return t('repoWiki.error.contextTooSmall', {
      required: entry.errorDetail.requiredChars,
      available: entry.errorDetail.availableChars ?? 0,
    });
  }
  return localizedError(t, entry.error, entry.errorCode);
};

const PageRow: React.FC<{
  page: RepoWikiPageMeta;
  selected: boolean;
  active: boolean;
  canRetry: boolean;
  onSelect: () => void;
  onRetry: () => void;
}> = ({ page, selected, active, canRetry, onSelect, onRetry }) => {
  const { t } = useI18n();
  const statusLabel = pageStatusLabel(t, page.status);

  return (
    <div className="group/page relative min-w-0">
      <button
        type="button"
        onClick={onSelect}
        disabled={!active}
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left',
          selected ? 'bg-interactive-selection text-foreground' : 'hover:bg-interactive-hover',
          !active && 'opacity-60',
        )}
      >
        <span className="min-w-0 flex-1 truncate typography-body">{page.title}</span>
        {page.status === 'failed'
          ? <Icon name="error-warning" className="size-3.5 flex-shrink-0 text-destructive" />
          : page.status === 'done'
            ? <Icon name="check" className="size-3.5 flex-shrink-0 text-muted-foreground" />
            : page.status === 'writing'
              ? <Icon name="loader-4" className="size-3.5 flex-shrink-0 animate-spin text-muted-foreground" />
              : <Icon name="time" className="size-3.5 flex-shrink-0 text-muted-foreground" />}
        <span className="flex-shrink-0 typography-micro text-muted-foreground">{statusLabel}</span>
      </button>
      {page.status === 'failed' && !active && canRetry
        ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="absolute right-8 top-1/2 hidden -translate-y-1/2 group-hover/page:inline-flex"
              onClick={onRetry}
            >
              {t('repoWiki.page.retry')}
            </Button>
          )
        : null}
    </div>
  );
};

interface RepoWikiPanelProps {
  /** The active workspace directory; empty when no workspace is open. */
  directory: string;
  /** Read-only host (the mobile drawer tab): suppresses the generation
      form/options, retry, stop, delete, and stale-regenerate actions. NOT
      crossView — the active project's source references stay live. */
  readOnly?: boolean;
}

/** Human-readable switcher label: decode the stored id back to a basename. */
const projectName = (projectId: string): string => {
  const path = projectPathFromProjectId(projectId);
  const name = path ? path.split('/').filter(Boolean).pop() : null;
  return name || projectId;
};

/**
 * The header's in-content project switcher. The active project is always the
 * first item — selecting it returns to the generatable panel — and every
 * other item is a stored wiki rendered read-only. A failed listing shows an
 * error row, never a look-alike empty menu.
 */
const ProjectSwitcher: React.FC<{
  activeProjectId: string;
  activeLabel: string;
  viewingProjectId: string | null;
  list: RepoWikiListState;
  canLeaveActive: boolean;
  onSelect: (projectId: string | null) => void;
  onOpen: () => void;
  t: TranslateFn;
}> = ({ activeProjectId, activeLabel, viewingProjectId, list, canLeaveActive, onSelect, onOpen, t }) => {
  const others = (list.wikis ?? []).filter((item) => item.projectId !== activeProjectId);

  return (
    <Select
      value={viewingProjectId ?? activeProjectId}
      onValueChange={(value) => onSelect(value === activeProjectId ? null : value)}
      onOpenChange={(open) => {
        if (open) onOpen();
      }}
    >
      <SelectTrigger
        className="h-7 min-w-0 max-w-full flex-1 gap-1 border-none bg-transparent px-1.5 shadow-none hover:bg-interactive-hover"
        aria-label={t('repoWiki.switcher.label')}
      >
        {/* The wrapper's SelectValue prints the raw value when given no
            children; resolve the human-readable project name instead. */}
        <SelectValue>
          {(value: string | undefined) => (value && value !== activeProjectId
            ? projectName(value)
            : activeLabel)}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={activeProjectId}>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate">{activeLabel}</span>
          </span>
        </SelectItem>
        {canLeaveActive && others.length > 0
          ? others.map((item) => (
              <SelectItem key={item.projectId} value={item.projectId}>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate">{projectName(item.projectId)}</span>
                  {item.run?.status === 'running'
                    ? (
                        <span className="flex flex-shrink-0 items-center gap-1 typography-micro text-muted-foreground">
                          <Icon name="loader-4" className="size-3 animate-spin" />
                          {runStageLabel(t, item.run.stage)}
                        </span>
                      )
                    : item.pagesFailed > 0
                      ? (
                          <span className="flex-shrink-0 typography-micro text-destructive">
                            {t('repoWiki.pages.failedCount', { count: item.pagesFailed })}
                          </span>
                        )
                      : (
                          <span className="flex-shrink-0 typography-micro text-muted-foreground">
                            {item.pagesDone}
                          </span>
                        )}
                </span>
              </SelectItem>
            ))
          : null}
        {canLeaveActive && list.error
          ? (
              <div className="px-2 py-1.5 typography-micro text-destructive">
                {t('repoWiki.switcher.error')}
              </div>
            )
          : null}
        {canLeaveActive && !list.error && !list.loading && list.wikis != null && others.length === 0
          ? (
              <div className="px-2 py-1.5 typography-micro text-muted-foreground">
                {t('repoWiki.switcher.empty')}
              </div>
            )
          : null}
      </SelectContent>
    </Select>
  );
};

export const RepoWikiPanel: React.FC<RepoWikiPanelProps> = ({ directory, readOnly = false }) => {
  const { t, locale, locales, label } = useI18n();
  const modelOptions = useModelOptions();

  const projectId = directory ? resolveRepoWikiProjectId(directory) : '';
  const entry = useRepoWikiStore((state) => (projectId ? state.entries[projectId] : undefined)) ?? EMPTY_REPO_WIKI_ENTRY;
  const load = useRepoWikiStore((state) => state.load);
  const loadById = useRepoWikiStore((state) => state.loadById);
  const loadPage = useRepoWikiStore((state) => state.loadPage);
  const loadPageById = useRepoWikiStore((state) => state.loadPageById);
  const generate = useRepoWikiStore((state) => state.generate);
  const stopGeneration = useRepoWikiStore((state) => state.stop);
  const retryPage = useRepoWikiStore((state) => state.retryPage);
  const removeWiki = useRepoWikiStore((state) => state.remove);
  const setPanelVisible = useRepoWikiStore((state) => state.setPanelVisible);
  const setProjectVisible = useRepoWikiStore((state) => state.setProjectVisible);
  const wikiList = useRepoWikiStore((state) => state.list);
  const loadList = useRepoWikiStore((state) => state.loadList);
  const openContextFileAtLine = useUIStore((state) => state.openContextFileAtLine);

  // A non-null viewingProjectId renders another stored project's wiki
  // read-only; null is the active workspace's own (generatable) panel.
  const [viewingProjectId, setViewingProjectId] = React.useState<string | null>(null);
  const viewedEntry = useRepoWikiStore(
    React.useCallback((state) => (viewingProjectId ? state.entries[viewingProjectId] : undefined), [viewingProjectId]),
  ) ?? EMPTY_REPO_WIKI_ENTRY;

  const [language, setLanguage] = React.useState<Locale>(locale);
  const [diagrams, setDiagrams] = React.useState(true);
  const [model, setModel] = React.useState('');
  const [retries, setRetries] = React.useState(0);
  const [selectedPageId, setSelectedPageId] = React.useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [pageMarkdown, setPageMarkdown] = React.useState<string | null>(null);
  const [working, setWorking] = React.useState(false);

  React.useEffect(() => {
    if (!directory) return;
    void load(directory, { force: true, silent: true });
    setPanelVisible(directory, true);
    return () => setPanelVisible(directory, false);
  }, [directory, load, setPanelVisible]);

  // The cross-project view loads its own full manifest by id (no directory,
  // so staleness is omitted) and registers visibility so the two-condition
  // poller keeps an active run live while the user reads it.
  React.useEffect(() => {
    if (!viewingProjectId) return;
    void loadById(viewingProjectId, { force: true, silent: true });
    setProjectVisible(viewingProjectId, true);
    return () => setProjectVisible(viewingProjectId, false);
  }, [viewingProjectId, loadById, setProjectVisible]);

  // Conversation-turn revalidation: the sync reducer rewrites a session's
  // status to `idle` when its turn completes. A visible panel whose project
  // has no active run silently revalidates when a session in this directory
  // just turned idle — never on first sight of the directory, and never for
  // a project whose freshness already belongs to the poller.
  const sessionStatuses = useDirectorySync(
    React.useCallback((state) => state.session_status, []),
    directory,
  );
  const revalidateOnTurnComplete = useRepoWikiStore((state) => state.revalidateOnTurnComplete);
  const turnTypesRef = React.useRef<{ directory: string; types: Map<string, string> }>({ directory: '', types: new Map() });
  React.useEffect(() => {
    const tracked = turnTypesRef.current;
    const firstSight = tracked.directory !== directory;
    const next = new Map<string, string>();
    let turnCompleted = false;
    for (const [sessionId, status] of Object.entries(sessionStatuses ?? {})) {
      const type = status?.type ?? '';
      next.set(sessionId, type);
      if (!firstSight && type === 'idle' && tracked.types.get(sessionId) !== undefined && tracked.types.get(sessionId) !== 'idle') {
        turnCompleted = true;
      }
    }
    turnTypesRef.current = { directory, types: next };
    if (turnCompleted) revalidateOnTurnComplete(directory);
  }, [sessionStatuses, directory, revalidateOnTurnComplete]);

  const crossView = viewingProjectId != null;
  const shownEntry = crossView ? viewedEntry : entry;
  const wiki = shownEntry.status?.wiki ?? null;
  const run = wiki?.run ?? null;
  const runActive = run?.status === 'running';
  const pages = wiki?.catalog?.pages ?? [];

  React.useEffect(() => {
    if (pages.length === 0) {
      setSelectedPageId(null);
      return;
    }
    const stillThere = selectedPageId != null && pages.some((page) => page.id === selectedPageId);
    if (stillThere) return;
    const firstReadable = pages.find((page) => page.status === 'done') ?? pages[0];
    setSelectedPageId(firstReadable.id);
  }, [pages, selectedPageId]);

  const selectedPage = pages.find((page) => page.id === selectedPageId) ?? null;

  React.useEffect(() => {
    let cancelled = false;
    if ((!directory && !viewingProjectId) || !selectedPage) {
      setPageMarkdown(null);
      return;
    }
    const request = viewingProjectId
      ? loadPageById(viewingProjectId, selectedPage.id)
      : loadPage(directory, selectedPage.id);
    void request.then((markdown) => {
      if (!cancelled) setPageMarkdown(markdown);
    });
    return () => {
      cancelled = true;
    };
  }, [viewingProjectId, directory, selectedPage, loadPage, loadPageById]);

  // Source references are intercepted in the CAPTURE phase on this container:
  // the markdown renderer's own app-link guard sits on an inner node in the
  // bubble phase and would otherwise claim the custom scheme (confirm dialog)
  // before the panel ever sees the click. The node arrives with the wiki
  // view (the empty state renders none), so the listener tracks the node
  // itself instead of firing once while the ref is still null.
  // These hooks sit above the `!directory` early return: hook count must not
  // depend on props, or a directory arriving while mounted crashes React.
  const [contentNode, setContentNode] = React.useState<HTMLDivElement | null>(null);
  React.useEffect(() => {
    // Cross-project pages cite files in a repo this panel has no directory
    // for, so their source references stay inert there.
    if (!contentNode || !directory || viewingProjectId != null) return;
    const handleCapture = (event: MouseEvent) => {
      const targetNode = event.target instanceof Element ? event.target : null;
      const anchor = targetNode?.closest('a');
      if (!anchor) return;
      const target = parseSourceRef(anchor.getAttribute('href') ?? '');
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      openContextFileAtLine(directory, resolveSourcePath(directory, target.filePath), target.line);
    };
    contentNode.addEventListener('click', handleCapture, true);
    return () => contentNode.removeEventListener('click', handleCapture, true);
  }, [contentNode, directory, viewingProjectId, openContextFileAtLine]);

  if (!directory) {
    return null;
  }

  const startGeneration = async () => {
    setWorking(true);
    try {
      await generate(directory, {
        language,
        diagrams,
        model: model || undefined,
        retries: retries > 0 ? retries : undefined,
      });
    } finally {
      setWorking(false);
    }
  };

  const requestStop = async () => {
    setWorking(true);
    try {
      await stopGeneration(directory);
    } finally {
      setWorking(false);
    }
  };

  const requestRetry = async (pageId: string) => {
    setWorking(true);
    try {
      // One Retry press consents to the same per-page budget the panel is
      // configured with: up to (retries + 1) page calls.
      await retryPage(directory, pageId, { retries: retries > 0 ? retries : undefined });
    } finally {
      setWorking(false);
    }
  };

  const requestDelete = async () => {
    setWorking(true);
    setConfirmingDelete(false);
    try {
      await removeWiki(directory);
      setSelectedPageId(null);
    } finally {
      setWorking(false);
    }
  };

  const stageLabel = runActive ? runStageLabel(t, run?.stage) : null;

  const sortedPages = [...pages].sort((a, b) => PAGE_STATUS_RANK[a.status] - PAGE_STATUS_RANK[b.status]);
  const pageCounts = countPageStates(pages);

  const errorLine = wikiErrorLine(t, shownEntry);

  const selectProject = (selected: string | null) => {
    setViewingProjectId(selected);
    setSelectedPageId(null);
    setPageMarkdown(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="book-open" className="size-4 flex-shrink-0 text-muted-foreground" />
        <ProjectSwitcher
          activeProjectId={projectId}
          activeLabel={projectName(projectId)}
          viewingProjectId={viewingProjectId}
          list={wikiList}
          canLeaveActive={Boolean(directory)}
          onSelect={selectProject}
          onOpen={() => void loadList()}
          t={t}
        />
        {!crossView && !readOnly && entry.status?.stale && !runActive
          ? (
              <Button type="button" variant="outline" size="xs" disabled={working} onClick={() => void startGeneration()}>
                {t('repoWiki.stale.regenerate')}
              </Button>
            )
          : null}
        {!crossView && !readOnly && wiki
          ? (
              confirmingDelete
                ? (
                    <>
                      <Button type="button" variant="destructive" size="xs" disabled={working} onClick={() => void requestDelete()}>
                        {t('repoWiki.delete.confirm')}
                      </Button>
                      <Button type="button" variant="ghost" size="xs" onClick={() => setConfirmingDelete(false)}>
                        {t('repoWiki.delete.cancel')}
                      </Button>
                    </>
                  )
                : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={working || runActive}
                      aria-label={t('repoWiki.delete.action')}
                      title={t('repoWiki.delete.action')}
                      onClick={() => setConfirmingDelete(true)}
                    >
                      <Icon name="delete-bin" className="size-4" />
                    </Button>
                  )
            )
          : null}
      </div>

      {wiki
        ? (
            <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 typography-micro text-muted-foreground">
              <button
                type="button"
                className="flex flex-shrink-0 items-center rounded-sm hover:text-foreground"
                aria-expanded={detailsOpen}
                aria-label={t('repoWiki.meta.details')}
                title={t('repoWiki.meta.details')}
                onClick={() => setDetailsOpen((open) => !open)}
              >
                <Icon name={detailsOpen ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5" />
              </button>
              <span className="min-w-0 flex-1 truncate">
                {wiki.branch ? `${wiki.branch} @ ` : ''}
                {wiki.commit ? wiki.commit.slice(0, 7) : '—'}
                {' · '}
                {wiki.language}
                {run && run.status !== 'running' && run.finishedAt
                  ? ` · ${formatTimestamp(run.finishedAt, locale)}`
                  : ''}
              </span>
            </div>
          )
        : null}

      {wiki && detailsOpen
        ? (
            <div className="flex-shrink-0 space-y-1 border-b border-border bg-surface-muted px-3 py-2 typography-micro text-muted-foreground">
              <div className="flex items-center justify-between gap-3">
                <span>{t('repoWiki.meta.pages')}</span>
                <span className="min-w-0 truncate">
                  {pageCounts.done}/{pageCounts.total}
                  {pageCounts.failed > 0
                    ? ` · ${t('repoWiki.pages.failedCount', { count: pageCounts.failed })}`
                    : ''}
                </span>
              </div>
              {wiki.model
                ? (
                    <div className="flex items-center justify-between gap-3">
                      <span>{t('repoWiki.meta.model')}</span>
                      <span className="min-w-0 truncate">{wiki.model.providerID}/{wiki.model.modelID}</span>
                    </div>
                  )
                : null}
              {runActive && stageLabel
                ? (
                    <div className="flex items-center justify-between gap-3">
                      <span>{t('repoWiki.meta.stage')}</span>
                      <span className="min-w-0 truncate">{stageLabel}</span>
                    </div>
                  )
                : null}
            </div>
          )
        : null}

      {!crossView && entry.status?.stale && !runActive
        ? (
            <div className="flex-shrink-0 bg-surface-muted px-3 py-1.5 typography-meta text-muted-foreground">
              {t('repoWiki.stale.banner')}
            </div>
          )
        : null}

      {errorLine
        ? (
            <div className="flex-shrink-0 px-3 py-2">
              <p className="typography-meta text-destructive">{errorLine}</p>
            </div>
          )
        : null}

      {!crossView && readOnly && !wiki && !runActive
        ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <div className="mx-auto max-w-sm space-y-4">
                <div className="space-y-1">
                  <h2 className="typography-ui-label font-semibold">{t('repoWiki.empty.title')}</h2>
                  <p className="typography-meta text-muted-foreground">{t('repoWiki.empty.readOnlyDescription')}</p>
                </div>
              </div>
            </div>
          )
        : null}

      {!crossView && !readOnly && !wiki && !runActive
        ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <div className="mx-auto max-w-sm space-y-4">
                <div className="space-y-1">
                  <h2 className="typography-ui-label font-semibold">{t('repoWiki.empty.title')}</h2>
                  <p className="typography-meta text-muted-foreground">{t('repoWiki.empty.description')}</p>
                </div>
                <div className="space-y-1">
                  <span className="typography-ui-label">{t('repoWiki.options.language')}</span>
                  <Select
                    value={language}
                    onValueChange={(value) => {
                      // SAFETY: every option value is a Locale taken from the
                      // i18n context, so the string is always a valid locale.
                      setLanguage(value as Locale);
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {locales.map((item) => (
                        <SelectItem key={item} value={item}>{label(item)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="typography-ui-label">{t('repoWiki.options.diagrams')}</span>
                    <p className="typography-micro text-muted-foreground">{t('repoWiki.options.diagrams.hint')}</p>
                  </div>
                  <Button
                    type="button"
                    variant="chip"
                    size="sm"
                    aria-pressed={diagrams}
                    onClick={() => setDiagrams((value) => !value)}
                  >
                    {diagrams ? <Icon name="check" className="size-3.5" /> : null}
                  </Button>
                </div>
                <div className="space-y-1">
                  <span className="typography-ui-label">{t('repoWiki.options.model')}</span>
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">{t('repoWiki.options.model.default')}</SelectItem>
                      {modelOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <span className="typography-ui-label">{t('repoWiki.options.retries')}</span>
                  <Select
                    value={String(retries)}
                    onValueChange={(value) => setRetries(Number(value))}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">{t('repoWiki.options.retries.none')}</SelectItem>
                      {[1, 2, 3].map((value) => (
                        <SelectItem key={value} value={String(value)}>{String(value)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="typography-micro text-muted-foreground">{t('repoWiki.options.retries.hint')}</p>
                </div>
                <Button type="button" variant="default" size="default" className="w-full" disabled={working} onClick={() => void startGeneration()}>
                  {working ? t('repoWiki.generate.running') : t('repoWiki.generate.action')}
                </Button>
              </div>
            </div>
          )
        : null}

      {runActive
        ? (
            <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-2">
              <Icon name="loader-4" className="size-4 animate-spin text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate typography-meta text-muted-foreground">{stageLabel}</span>
              {crossView || readOnly
                ? null
                : (
                    <Button type="button" variant="outline" size="xs" disabled={working} onClick={() => void requestStop()}>
                      {t('repoWiki.generate.stop')}
                    </Button>
                  )}
            </div>
          )
        : null}

      {pages.length > 0
        ? (
            <div className="flex min-h-0 flex-1">
              <div className="flex min-h-0 w-44 flex-shrink-0 flex-col border-r border-border">
                <div className="flex-shrink-0 px-2.5 pb-1 pt-2 typography-micro text-muted-foreground">
                  {pageCounts.done}/{pageCounts.total}
                  {pageCounts.failed > 0
                    ? (
                        <>
                          {' · '}
                          <span className="text-destructive">
                            {t('repoWiki.pages.failedCount', { count: pageCounts.failed })}
                          </span>
                        </>
                      )
                    : null}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
                  {sortedPages.map((page) => (
                    <PageRow
                      key={page.id}
                      page={page}
                      selected={page.id === selectedPageId}
                      active={page.status === 'done'}
                      canRetry={!crossView && !readOnly}
                      onSelect={() => setSelectedPageId(page.id)}
                      onRetry={() => void requestRetry(page.id)}
                    />
                  ))}
                </div>
              </div>
              <div ref={setContentNode} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {selectedPage?.status === 'failed'
                  ? (
                      <div className="space-y-2">
                        <p className="typography-body text-destructive">
                          {localizedError(t, selectedPage.error, selectedPage.errorCode)
                            ?? t('repoWiki.page.status.failed')}
                        </p>
                        {!crossView && !readOnly
                          ? (
                              <Button type="button" variant="outline" size="sm" disabled={working} onClick={() => void requestRetry(selectedPage.id)}>
                                {t('repoWiki.page.retry')}
                              </Button>
                            )
                          : null}
                      </div>
                    )
                  : pageMarkdown
                    ? <SimpleMarkdownRenderer content={pageMarkdown} className="typography-markdown-body" enableFileReferences={false} />
                    : (
                        <p className="typography-meta text-muted-foreground">
                          {selectedPage ? pageStatusLabel(t, selectedPage.status) : null}
                        </p>
                      )}
              </div>
            </div>
          )
        : null}
    </div>
  );
};
