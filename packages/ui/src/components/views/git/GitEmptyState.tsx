import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import { useEasterEggCopy } from '@/lib/easter-eggs/easterEggCopy';
import { gitCleanLine } from '@/lib/easter-eggs/lines';
import { useI18n } from '@/lib/i18n';

interface GitEmptyStateProps {
  onOpenStashes?: () => void;
}

export const GitEmptyState: React.FC<GitEmptyStateProps> = ({ onOpenStashes }) => {
  const { t } = useI18n();
  const copy = useEasterEggCopy();
  // Each time the clean state shows, it picks a new line and keeps it while it stays on screen.
  const [pick] = React.useState(() => ({ at: new Date(), seed: Math.floor(Math.random() * 1000) }));
  const description = (copy ? gitCleanLine(copy, pick.at, pick.seed) : null) ?? t('gitView.empty.cleanDescription');
  return (
    <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
      <Icon name="git-commit" className="size-10 text-muted-foreground/70 mb-4" />
      <p className="typography-ui-label font-semibold text-foreground mb-1">
        {t('gitView.empty.cleanTitle')}
      </p>
      <p className="typography-meta text-muted-foreground mb-4">
        {description}
      </p>

      {onOpenStashes ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpenStashes}
          className="gap-1.5"
        >
          <Icon name="archive-stack" className="size-4" />
          {t('gitView.stashes.title')}
        </Button>
      ) : null}
    </div>
  );
};
