import { z } from 'zod';

/**
 * Supported finding severities ordered from lowest to highest impact.
 */
export const SEVERITY_LEVELS = ['low', 'medium', 'high', 'critical'] as const;

export type Severity = (typeof SEVERITY_LEVELS)[number];

export const SeveritySchema = z.enum(SEVERITY_LEVELS);

/**
 * Schema for a single inline review finding returned by Gemini.
 */
export const FindingSchema = z.object({
  file: z.string().min(1, 'File path must be a non-empty string'),
  line: z.number().int().positive('Line number must be a positive integer'),
  severity: SeveritySchema,
  title: z.string().min(1, 'Title must be a non-empty string'),
  comment: z.string().min(1, 'Comment explanation must be a non-empty string'),
  suggestion: z
    .string()
    .nullable()
    .optional()
    .transform((val) => (val && val.trim().length > 0 ? val : null)),
  confidence: z.number().min(0).max(1),
});

export type Finding = z.infer<typeof FindingSchema>;

/**
 * Schema for the full structured JSON review response returned by Gemini.
 */
export const ReviewResponseSchema = z.object({
  summary: z.string().min(1, 'Summary must be a non-empty string'),
  findings: z.array(FindingSchema),
});

export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

export interface ValidationResult {
  success: boolean;
  data?: ReviewResponse;
  error?: string;
}

/**
 * Strips optional markdown code fences (e.g. ```json ... ```) if the model
 * wrapped its JSON output, then parses and validates against ReviewResponseSchema.
 */
export function parseAndValidateReviewJson(rawText: string): ValidationResult {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return {
      success: false,
      error: 'Model returned an empty response instead of JSON.',
    };
  }

  // Strip surrounding ```json ... ``` fences if present
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidateJson = fenceMatch ? fenceMatch[1].trim() : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidateJson);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Invalid JSON syntax: ${message}`,
    };
  }

  const validation = ReviewResponseSchema.safeParse(parsed);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    return {
      success: false,
      error: `JSON schema validation failed: ${issues}`,
    };
  }

  return {
    success: true,
    data: validation.data,
  };
}
