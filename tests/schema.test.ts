import { describe, expect, it } from 'vitest';
import { parseAndValidateReviewJson } from '../src/schema.js';

describe('JSON validation with Zod (ReviewResponseSchema)', () => {
  it('validates a well-formed Gemini review JSON payload', () => {
    const validJson = JSON.stringify({
      summary: 'Found one SQL injection vulnerability in the user lookup query.',
      findings: [
        {
          file: 'src/db.ts',
          line: 24,
          severity: 'critical',
          title: 'SQL Injection via unsanitized user input',
          comment: 'Interpolating user input directly into SQL allows arbitrary query execution.',
          suggestion: 'const rows = await db.query("SELECT * FROM users WHERE id = $1", [userId]);',
          confidence: 0.96,
        },
      ],
    });

    const result = parseAndValidateReviewJson(validJson);
    expect(result.success).toBe(true);
    expect(result.data?.findings).toHaveLength(1);
    expect(result.data?.findings[0].severity).toBe('critical');
  });

  it('strips optional ```json markdown code fences before validating', () => {
    const fencedJson = '```json\n{"summary": "All good!", "findings": []}\n```';
    const result = parseAndValidateReviewJson(fencedJson);

    expect(result.success).toBe(true);
    expect(result.data?.summary).toBe('All good!');
    expect(result.data?.findings).toEqual([]);
  });

  it('rejects malformed JSON syntax or missing required fields with clear errors', () => {
    const brokenSyntax = parseAndValidateReviewJson('{ "summary": "missing bracket" ');
    expect(brokenSyntax.success).toBe(false);
    expect(brokenSyntax.error).toContain('Invalid JSON syntax');

    const invalidSchema = parseAndValidateReviewJson(
      JSON.stringify({
        summary: 'Bad finding schema',
        findings: [
          {
            file: 'src/app.ts',
            line: -10, // must be positive integer
            severity: 'blocker', // invalid enum value
            title: 'Bug',
            comment: 'Details',
            suggestion: null,
            confidence: 1.5, // must be <= 1
          },
        ],
      }),
    );

    expect(invalidSchema.success).toBe(false);
    expect(invalidSchema.error).toContain('JSON schema validation failed');
  });
});
