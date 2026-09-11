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
  RepoWikiRequestError,
  type RepoWikiPageMeta,
} from '@/lib/repoWikiApi';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useRepoWikiStore, EMPTY_REPO_WIKI_ENTRY } from '@/stores/useRepoWikiStore';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';

type TranslateFn = (key: I18nKey, params?: I18nParams) => string;

const REPO_WIKI_SRC_SCHEME = 'repo-wiki-src://';

const pageStatusLabel = (t: TranslateFn, status: RepoWikiPageMeta['status']): string => {
  if (status === 'done') return t('repoWiki.page.status.done');
  if (status === 'failed') return t('repoWiki.page.status.failed');
  if (status === 'writing') return t('repoWiki.page.status.writing');
  return t('repoWiki.page.status.pending');
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
        const ids = payload != null && payload.constructor === Object && Array.isArray(payload.authenticatedProviders)
          ? payload.authenticatedProviders
          : [];
        if (!cancelled) {
          setAuthenticated(new Set(ids.filter((id: any) => id != null && id.constructor === String)));
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

const PageRow: React.FC<{
  page: RepoWikiPageMeta;
  selected: boolean;
  active: boolean;
  onSelect: () => void;
  onRetry: () => void;
}> = ({ page, selected, active, onSelect, onRetry }) => {
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
      {page.status === 'failed' && !active
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
}

export const RepoWikiPanel: React.FC<RepoWikiPanelProps> = ({ directory }) => {
  const { t, locale, locales, label } = useI18n();
  const modelOptions = useModelOptions();

  const projectId = directory ? resolveRepoWikiProjectId(directory) : '';
  const entry = useRepoWikiStore((state) => (projectId ? state.entries[projectId] : undefined)) ?? EMPTY_REPO_WIKI_ENTRY;
  const load = useRepoWikiStore((state) => state.load);
  const loadPage = useRepoWikiStore((state) => state.loadPage);
  const generate = useRepoWikiStore((state) => state.generate);
  const stopGeneration = useRepoWikiStore((state) => state.stop);
  const retryPage = useRepoWikiStore((state) => state.retryPage);
  const removeWiki = useRepoWikiStore((state) => state.remove);
  const setPanelVisible = useRepoWikiStore((state) => state.setPanelVisible);
  const openContextFileAtLine = useUIStore((state) => state.openContextFileAtLine);

  const [language, setLanguage] = React.useState<Locale>(locale);
  const [diagrams, setDiagrams] = React.useState(true);
  const [model, setModel] = React.useState('');
  const [selectedPageId, setSelectedPageId] = React.useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [pageMarkdown, setPageMarkdown] = React.useState<string | null>(null);
  const [working, setWorking] = React.useState(false);

  React.useEffect(() => {
    if (!directory) return;
    void load(directory, { force: true, silent: true });
    setPanelVisible(directory, true);
    return () => setPanelVisible(directory, false);
  }, [directory, load, setPanelVisible]);

  const wiki = entry.status?.wiki ?? null;
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
    if (!directory || !selectedPage) {
      setPageMarkdown(null);
      return;
    }
    void loadPage(directory, selectedPage.id).then((markdown) => {
      if (!cancelled) setPageMarkdown(markdown);
    });
    return () => {
      cancelled = true;
    };
  }, [directory, selectedPage, loadPage]);

  if (!directory) {
    return null;
  }

  // Source references are intercepted in the CAPTURE phase on this container:
  // the markdown renderer's own app-link guard sits on an inner node in the
  // bubble phase and would otherwise claim the custom scheme (confirm dialog)
  // before the panel ever sees the click. The node arrives with the wiki
  // view (the empty state renders none), so the listener tracks the node
  // itself instead of firing once while the ref is still null.
  const [contentNode, setContentNode] = React.useState<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!contentNode) return;
    const handleCapture = (event: MouseEvent) => {
      const targetNode = event.target instanceof Element ? event.target : null;
      const anchor = targetNode?.closest('a');
      if (!anchor) return;
      const target = parseSourceRef(anchor.getAttribute('href') ?? '');
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      openContextFileAtLine(directory, target.filePath, target.line);
    };
    contentNode.addEventListener('click', handleCapture, true);
    return () => contentNode.removeEventListener('click', handleCapture, true);
  }, [contentNode, directory, openContextFileAtLine]);

  const startGeneration = async () => {
    setWorking(true);
    try {
      await generate(directory, {
        language,
        diagrams,
        model: model || undefined,
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
      await retryPage(directory, pageId);
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

  const stageLabel = runActive
    ? run?.stage === 'digesting'
      ? t('repoWiki.progress.stage.digesting')
      : run?.stage === 'catalog'
        ? t('repoWiki.progress.stage.catalog')
        : t('repoWiki.progress.stage.pages')
    : null;

  const sortedPages = [...pages].sort((a, b) => PAGE_STATUS_RANK[a.status] - PAGE_STATUS_RANK[b.status]);

  const errorMessage = entry.error;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {wiki
        ? (
            <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-2">
              <Icon name="book-open" className="size-4 flex-shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate typography-ui-label font-semibold">
                {t('contextPanel.mode.repoWiki')}
              </span>
              {entry.status?.stale && !runActive
                ? (
                    <Button type="button" variant="outline" size="xs" disabled={working} onClick={() => void startGeneration()}>
                      {t('repoWiki.stale.regenerate')}
                    </Button>
                  )
                : null}
              {confirmingDelete
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
                  )}
            </div>
          )
        : null}

      {entry.status?.stale && !runActive
        ? (
            <div className="flex-shrink-0 bg-surface-raised px-3 py-1.5 typography-meta text-muted-foreground">
              {t('repoWiki.stale.banner')}
            </div>
          )
        : null}

      {errorMessage
        ? (
            <div className="flex-shrink-0 px-3 py-2">
              <p className="typography-meta text-destructive">{errorMessage}</p>
            </div>
          )
        : null}

      {!wiki && !runActive
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
              <Button type="button" variant="outline" size="xs" disabled={working} onClick={() => void requestStop()}>
                {t('repoWiki.generate.stop')}
              </Button>
            </div>
          )
        : null}

      {pages.length > 0
        ? (
            <div className="flex min-h-0 flex-1">
              <div className="min-h-0 w-44 flex-shrink-0 overflow-y-auto border-r border-border px-1.5 py-2">
                {sortedPages.map((page) => (
                  <PageRow
                    key={page.id}
                    page={page}
                    selected={page.id === selectedPageId}
                    active={page.status === 'done'}
                    onSelect={() => setSelectedPageId(page.id)}
                    onRetry={() => void requestRetry(page.id)}
                  />
                ))}
              </div>
              <div ref={setContentNode} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {selectedPage?.status === 'failed'
                  ? (
                      <div className="space-y-2">
                        <p className="typography-body text-destructive">{selectedPage.error ?? t('repoWiki.page.status.failed')}</p>
                        <Button type="button" variant="outline" size="sm" disabled={working} onClick={() => void requestRetry(selectedPage.id)}>
                          {t('repoWiki.page.retry')}
                        </Button>
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
