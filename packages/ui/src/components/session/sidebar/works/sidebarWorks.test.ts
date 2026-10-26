import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import type { SessionGroup, SessionNode } from '../types';
import type { ProjectSection } from '../projects/sessionProjectRender';
import { buildSidebarWorkIndex, buildWorktreeArchiveAnchors, orderSidebarWorks } from './sidebarWorks';
import { pickWorkSessionToOpen } from './workActions';

// SAFETY: works read only ids, forks and metadata.
const session = (id: string, extra: Partial<Session> = {}): Session => ({ id, title: id, directory: '/repo', time: { created: 1, updated: 1 }, ...extra } as Session);
const node = (id: string, children: SessionNode[] = [], extra: Partial<Session> = {}): SessionNode => ({ session: session(id, extra), children, worktree: null });
const group = (id: string, sessions: SessionNode[], worktree: boolean): SessionGroup => ({
  id, label: id, branch: worktree ? id : null, description: null, isMain: !worktree, directory: `/${id}`,
  worktree: worktree ? { path: `/${id}`, projectDirectory: '/repo', branch: id, label: id } : null,
  sessions,
});

const section: ProjectSection = {
  project: { id: 'p', normalizedPath: '/repo' },
  groups: [
    group('main', [node('root', [node('review')]), node('lonely')], false),
    group('wt', [node('w1'), node('w2')], true),
    group('empty-wt', [], true),
  ],
};

describe('sidebar works', () => {
  test('a root session with what nests under it is one work, a worktree with all its sessions another', () => {
    const index = buildSidebarWorkIndex([section]);
    expect(index.bySessionId.get('review')?.key).toBe('session:root');
    expect(index.bySessionId.get('w2')?.key).toBe('p:wt');
    expect(index.worktreeWorks.map((ref) => ref.key)).toEqual(['p:wt', 'p:empty-wt']);
  });

  test('works come once each, in the order of their first matching session', () => {
    const index = buildSidebarWorkIndex([section]);
    const order = ['w2', 'review', 'w1', 'lonely', 'root'].map((id) => session(id));
    expect(orderSidebarWorks(order, index, (entry) => entry.id !== 'lonely').map((ref) => ref.key))
      .toEqual(['p:wt', 'session:root']);
  });

  test('a worktree keeps the place its archived newest session gave it', () => {
    const index = buildSidebarWorkIndex([section]);
    // Listed newest first: lonely (30), w1 (20), root (10). The worktree's
    // newest session (25, archived) sat between lonely and w1.
    const values = new Map([['lonely', 30], ['archived', 25], ['w1', 20], ['root', 10], ['old', 5]]);
    const order = ['lonely', 'w1', 'root'].map((id) => session(id));
    const anchors = buildWorktreeArchiveAnchors({
      worktreeWorks: index.worktreeWorks,
      archivedSessions: [
        session('archived', { directory: '/wt' }),
        session('old', { directory: '/empty-wt' }),
        session('elsewhere', { directory: '/other' }),
      ],
      orderedSessions: order,
      orderValueOf: (entry) => values.get(entry.id) ?? 0,
      isPinned: () => false,
    });
    expect([...anchors]).toEqual([['p:wt', 0.5], ['p:empty-wt', 2.5]]);
    expect(orderSidebarWorks(order, index, () => true, anchors).map((ref) => ref.key))
      .toEqual(['session:lonely', 'p:wt', 'session:root', 'p:empty-wt']);
  });

  test('a click opens the latest session that is not a review or fork, else the latest, else nothing', () => {
    const review = node('review', [], { metadata: { openchamber: { kind: 'review', originalSessionID: 'x' } } });
    // SAFETY: only the fork's source id is read.
    const fork = node('fork', [], { fork: { sessionID: 'x' } as Session['fork'] });
    expect(pickWorkSessionToOpen([review, fork, node('work')])?.id).toBe('work');
    expect(pickWorkSessionToOpen([review, fork])?.id).toBe('review');
    expect(pickWorkSessionToOpen([])).toBeNull();
  });
});
