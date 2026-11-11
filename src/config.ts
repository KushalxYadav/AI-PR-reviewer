import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { Severity, SEVERITY_LEVELS, SeveritySchema } from './schema.js';

/**
 * Default Gemini model ID used when neither .reviewbot.yml nor GEMINI_MODEL is set.
 * Update this single constant to change the default model ID across the entire Action.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-4-argon';

/**
 * Hard safety caps per PR run to control token usage and API cost.
 */
export const DEFAULT_MAX_FILES = 30;
export const DEFAULT_MAX_CHUNK_CHARS = 60_000;
export const DEFAULT_MAX_TOTAL_CHARS = 150_000;
export const DEFAULT_MAX_COMMENTS = 15;

/**
 * Schema for optional .reviewbot.yml configuration file at the repository root.
 */
export const RawConfigSchema = z
  .object({
    model: z.string().trim().min(1).optional(),
    min_severity: SeveritySchema.optional(),
    max_comments: z.number().int().positive().max(100).optional(),
    ignore: z.array(z.string().trim().min(1)).optional(),
    language: z.string().trim().min(1).optional(),
    focus: z.array(z.string().trim().min(1)).optional(),
    custom_instructions: z.string().optional(),
    review_drafts: z.boolean().optional(),
    max_files: z.number().int().positive().max(200).optional(),
    max_chunk_chars: z.number().int().positive().max(500_000).optional(),
    max_total_chars: z.number().int().positive().max(1_000_000).optional(),
  })
  .strict();

export interface ReviewConfig {
  model: string;
  min_severity: Severity;
  max_comments: number;
  ignore: string[];
  language: string;
  focus: string[];
  custom_instructions: string;
  review_drafts: boolean;
  max_files: number;
  max_chunk_chars: number;
  max_total_chars: number;
}

/**
 * Returns the default review configuration, taking optional environment/input
 * model override into account.
 */
export function getDefaultConfig(envModelOverride?: string): ReviewConfig {
  const trimmedModel = envModelOverride?.trim();
  return {
    model: trimmedModel && trimmedModel.length > 0 ? trimmedModel : DEFAULT_GEMINI_MODEL,
    min_severity: 'medium',
    max_comments: DEFAULT_MAX_COMMENTS,
    ignore: [],
    language: 'en',
    focus: [],
    custom_instructions: '',
    review_drafts: false,
    max_files: DEFAULT_MAX_FILES,
    max_chunk_chars: DEFAULT_MAX_CHUNK_CHARS,
    max_total_chars: DEFAULT_MAX_TOTAL_CHARS,
  };
}

/**
 * Parses a raw YAML string from .reviewbot.yml and merges it with sensible defaults.
 * If the file content is null, empty, or invalid, falls back to defaults and reports warnings.
 */
export function loadReviewConfig(
  yamlContent: string | null | undefined,
  envModelOverride?: string,
  onWarning?: (msg: string) => void,
): ReviewConfig {
  const defaults = getDefaultConfig(envModelOverride);
  if (!yamlContent || yamlContent.trim().length === 0) {
    return defaults;
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(yamlContent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onWarning?.(`Failed to parse .reviewbot.yml YAML syntax (${message}). Running with defaults.`);
    return defaults;
  }

  if (parsedYaml === null || parsedYaml === undefined) {
    return defaults;
  }

  if (typeof parsedYaml !== 'object' || Array.isArray(parsedYaml)) {
    onWarning?.('.reviewbot.yml root must be a YAML mapping/object. Running with defaults.');
    return defaults;
  }

  const result = RawConfigSchema.safeParse(parsedYaml);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    onWarning?.(`Invalid options in .reviewbot.yml (${issues}). Running with defaults.`);
    return defaults;
  }

  const data = result.data;
  return {
    model: data.model ?? defaults.model,
    min_severity: data.min_severity ?? defaults.min_severity,
    max_comments: data.max_comments ?? defaults.max_comments,
    ignore: data.ignore ?? defaults.ignore,
    language: data.language ?? defaults.language,
    focus: data.focus ?? defaults.focus,
    custom_instructions: data.custom_instructions?.trim() ?? defaults.custom_instructions,
    review_drafts: data.review_drafts ?? defaults.review_drafts,
    max_files: data.max_files ?? defaults.max_files,
    max_chunk_chars: data.max_chunk_chars ?? defaults.max_chunk_chars,
    max_total_chars: data.max_total_chars ?? defaults.max_total_chars,
  };
}

/**
 * Compares a finding's severity against the configured minimum severity threshold.
 */
export function meetsMinSeverity(findingSeverity: Severity, minSeverity: Severity): boolean {
  const findingRank = SEVERITY_LEVELS.indexOf(findingSeverity);
  const minRank = SEVERITY_LEVELS.indexOf(minSeverity);
  return findingRank >= minRank;
}
