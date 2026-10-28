import React from 'react';

import { useI18n } from '@/lib/i18n';
import { getClientPlatform } from '@/lib/platform';
import { BinaryArtifact } from './BinaryArtifact';

/**
 * A PDF in the browser's own viewer. Android WebView has none and paints an
 * empty frame, so the Android app shows the file with its download instead.
 */
export const PdfArtifact: React.FC<{
  src: string;
  name: string;
  path: string;
  sizeBytes: number | null;
  download?: React.ReactNode;
}> = ({ src, name, path, sizeBytes, download }) => {
  const { t } = useI18n();
  if (getClientPlatform() === 'android') {
    return (
      <BinaryArtifact
        name={name}
        path={path}
        sizeBytes={sizeBytes}
        description={t('filesView.artifact.pdf.androidUnavailable')}
        download={download}
      />
    );
  }
  return (
    <div className="h-full overflow-hidden bg-[var(--surface-background)]">
      <iframe src={src} className="h-full w-full border-0" title={name} />
    </div>
  );
};
