import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_GEMINI_MODEL, loadReviewConfig, meetsMinSeverity } from '../src/config.js';

describe('config loading (.reviewbot.yml)', () => {
  it('returns sensible defaults when .reviewbot.yml is missing or empty', () => {
    const config = loadReviewConfig(null);
    expect(config.model).toBe(DEFAULT_GEMINI_MODEL);
    expect(config.min_severity).toBe('medium');
    expect(config.max_comments).toBe(15);
    expect(config.ignore).toEqual([]);
    expect(config.language).toBe('en');
    expect(config.focus).toEqual([]);
    expect(config.custom_instructions).toBe('');
    expect(config.review_drafts).toBe(false);
  });

  it('respects GEMINI_MODEL environment/input override when .reviewbot.yml does not specify model', () => {
    const config = loadReviewConfig('', 'gemini-custom-override');
    expect(config.model).toBe('gemini-custom-override');
  });

  it('parses all supported options from .reviewbot.yml including Hindi language ("hi")', () => {
    const yaml = `
model: gemini-4-argon
min_severity: high
max_comments: 8
ignore:
  - "**/*.generated.ts"
  - "docs/**"
language: hi
focus:
  - security
  - performance
custom_instructions: "Ensure all database calls pass a transaction context."
review_drafts: true
`;
    const config = loadReviewConfig(yaml);
    expect(config.model).toBe('gemini-4-argon');
    expect(config.min_severity).toBe('high');
    expect(config.max_comments).toBe(8);
    expect(config.ignore).toEqual(['**/*.generated.ts', 'docs/**']);
    expect(config.language).toBe('hi');
    expect(config.focus).toEqual(['security', 'performance']);
    expect(config.custom_instructions).toBe(
      'Ensure all database calls pass a transaction context.',
    );
    expect(config.review_drafts).toBe(true);
  });

  it('falls back to defaults and logs a warning on malformed YAML or invalid schema fields', () => {
    const onWarning = vi.fn();
    const badYaml = 'min_severity: invalid_level_name\nmax_comments: -5';

    const config = loadReviewConfig(badYaml, undefined, onWarning);
    expect(config.min_severity).toBe('medium');
    expect(config.max_comments).toBe(15);
    expect(onWarning).toHaveBeenCalledOnce();
  });

  it('correctly compares finding severities against min_severity threshold', () => {
    expect(meetsMinSeverity('critical', 'medium')).toBe(true);
    expect(meetsMinSeverity('high', 'medium')).toBe(true);
    expect(meetsMinSeverity('medium', 'medium')).toBe(true);
    expect(meetsMinSeverity('low', 'medium')).toBe(false);
    expect(meetsMinSeverity('low', 'low')).toBe(true);
  });
});
