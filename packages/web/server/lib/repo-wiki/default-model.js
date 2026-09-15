import fs from 'fs';
import path from 'path';

import { readMergedSettingsSync } from '../opencode/settings-files.js';

/**
 * The model settings the Repo Wiki chain falls back to, read at generation
 * time — never cached across a settings change: the user's default model and
 * the Repo Wiki model override (Settings → Sessions). This is the tail of the
 * Repo Wiki model chain: request choice → the manifest's model → the override
 * → this default. Absent, unreadable, and malformed settings all mean "no
 * value", which the orchestrator reports as `no-model` rather than guessing.
 */
export const createDefaultModelReader = ({ dataDir }) => {
  if (dataDir == null || dataDir === '') {
    throw new Error('dataDir is required');
  }
  const settingsFilePath = path.join(path.resolve(dataDir), 'settings.json');

  return () => {
    try {
      const settings = readMergedSettingsSync({ fs, path, settingsFilePath });
      const readTrimmed = (value) => {
        if (value == null || value.constructor !== String) return undefined;
        const trimmed = value.trim();
        return trimmed || undefined;
      };
      return {
        defaultModel: readTrimmed(settings?.defaultModel),
        repoWikiModelOverride: readTrimmed(settings?.repoWikiModelOverride),
      };
    } catch {
      return {};
    }
  };
};
