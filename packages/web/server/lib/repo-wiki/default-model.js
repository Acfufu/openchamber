import fs from 'fs';
import path from 'path';

import { readMergedSettingsSync } from '../opencode/settings-files.js';

/**
 * The user's default model (Settings → Defaults → default model), read at
 * generation time — never cached across a settings change. This is the last
 * step of the Repo Wiki model chain: request choice → the manifest's model →
 * this. Absent, unreadable, and malformed settings all mean "no default",
 * which the orchestrator reports as `no-model` rather than guessing.
 */
export const createDefaultModelReader = ({ dataDir }) => {
  if (dataDir == null || dataDir === '') {
    throw new Error('dataDir is required');
  }
  const settingsFilePath = path.join(path.resolve(dataDir), 'settings.json');

  return () => {
    try {
      const settings = readMergedSettingsSync({ fs, path, settingsFilePath });
      const value = settings?.defaultModel;
      if (value == null || value.constructor !== String) return undefined;
      const trimmed = value.trim();
      return trimmed || undefined;
    } catch {
      return undefined;
    }
  };
};
