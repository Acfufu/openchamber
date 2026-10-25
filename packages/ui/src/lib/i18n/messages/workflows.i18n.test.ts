import { describe, expect, test } from 'bun:test';

import { workflowsI18n } from './workflows.i18n';

const locales = ['de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;
// "Workflows" is the word several languages use themselves.
const sameAsEnglish = (key: string) => key === 'chat.workStatus.section.workflows';

describe('workflow translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = workflowsI18n.en;
    const keys = Object.keys(english);
    for (const locale of locales) {
      const translated: Record<string, string> = workflowsI18n[locale];
      expect(Object.keys(translated).sort()).toEqual(keys.slice().sort());
      for (const key of keys) {
        expect(translated[key]?.trim()).toBeTruthy();
        if (!sameAsEnglish(key)) expect(translated[key]).not.toBe(english[key]);
        for (const placeholder of english[key].match(/\{\w+\}/g) ?? []) expect(translated[key]).toContain(placeholder);
      }
    }
  });
});
