import { describe, expect, it, vi } from 'vitest';
import { getDefaultConfig } from '../src/config.js';
import { reviewDiffChunk } from '../src/gemini.js';
import { evaluateEventTrigger } from '../src/github.js';
import { deduplicateFindings, executePullRequestReview } from '../src/review.js';

describe('end-to-end review pipeline, retry logic, deduplication, and trigger guards', () => {
  const noopLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  it('retries once with a fix-JSON prompt when Gemini returns invalid JSON on the first attempt', async () => {
    const generateText = vi
      .fn()
      .mockResolvedValueOnce('NOT VALID JSON {{{')
      .mockResolvedValueOnce(
        JSON.stringify({
          summary: 'Repaired JSON summary.',
          findings: [
            {
              file: 'src/index.ts',
              line: 2,
              severity: 'high',
              title: 'Unhandled Promise Rejection',
              comment: 'Await the async call or attach a catch handler.',
              suggestion: 'await startServer();',
              confidence: 0.9,
            },
          ],
        }),
      );

    const chunk = {
      index: 1,
      files: [
        {
          filename: 'src/index.ts',
          status: 'modified',
          formattedPatch:
            '=== FILE: src/index.ts ===\n@@ -1,2 +1,2 @@\nL1:  const a = 1;\nL2: +startServer();',
        },
      ],
      totalChars: 80,
    };

    const result = await reviewDiffChunk(
      chunk,
      1,
      { number: 12, title: 'Test PR', body: 'Test description' },
      getDefaultConfig(),
      generateText,
      noopLogger,
      async () => {},
    );

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText.mock.calls[1][0].userPrompt).toContain('Fix your JSON');
    expect(result).not.toBeNull();
    expect(result?.findings).toHaveLength(1);
  });

  it('skips the chunk and logs a warning without crashing if JSON is still invalid after retry', async () => {
    const generateText = vi.fn().mockResolvedValue('STILL INVALID JSON');
    const warnSpy = vi.fn();

    const chunk = {
      index: 1,
      files: [
        {
          filename: 'src/index.ts',
          status: 'modified',
          formattedPatch: '=== FILE: src/index.ts ===\n@@ -1,1 +1,1 @@\nL1: +bad();',
        },
      ],
      totalChars: 50,
    };

    const result = await reviewDiffChunk(
      chunk,
      1,
      { number: 12, title: 'Test PR' },
      getDefaultConfig(),
      generateText,
      { info: vi.fn(), warn: warnSpy, error: vi.fn() },
      async () => {},
    );

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('deduplicates findings already posted on earlier runs for the same file, line, and message', () => {
    const findings = [
      {
        file: 'src/api.ts',
        line: 15,
        severity: 'high' as const,
        title: 'Missing authorization check',
        comment: 'Verify user permissions before deleting the record.',
        suggestion: null,
        confidence: 0.95,
      },
      {
        file: 'src/api.ts',
        line: 20,
        severity: 'medium' as const,
        title: 'Potential null dereference',
        comment: 'Check if user.profile is defined.',
        suggestion: null,
        confidence: 0.85,
      },
    ];

    const existingComments = [
      {
        id: 101,
        path: 'src/api.ts',
        line: 15,
        body: '🟠 **HIGH** — **Missing authorization check**\n\nVerify user permissions before deleting the record.',
      },
    ];

    const deduplicated = deduplicateFindings(findings, existingComments);
    expect(deduplicated).toHaveLength(1);
    expect(deduplicated[0].line).toBe(20);
  });

  it('enforces OWNER, MEMBER, or COLLABORATOR author_association for /review issue_comment triggers', () => {
    const makeCommentPayload = (authorAssociation: string, body = '/review') => ({
      action: 'created',
      issue: { number: 42, pull_request: { url: 'https://api.github.com/repos/o/r/pulls/42' } },
      comment: {
        body,
        author_association: authorAssociation,
        user: { login: 'octocat' },
      },
    });

    expect(evaluateEventTrigger('issue_comment', makeCommentPayload('OWNER')).shouldRun).toBe(true);
    expect(evaluateEventTrigger('issue_comment', makeCommentPayload('MEMBER')).shouldRun).toBe(
      true,
    );
    expect(
      evaluateEventTrigger('issue_comment', makeCommentPayload('COLLABORATOR')).shouldRun,
    ).toBe(true);

    // Unauthorized associations must be rejected
    expect(evaluateEventTrigger('issue_comment', makeCommentPayload('CONTRIBUTOR')).shouldRun).toBe(
      false,
    );
    expect(
      evaluateEventTrigger('issue_comment', makeCommentPayload('FIRST_TIME_CONTRIBUTOR')).shouldRun,
    ).toBe(false);
    expect(evaluateEventTrigger('issue_comment', makeCommentPayload('NONE')).shouldRun).toBe(false);
  });

  it('executes full review pipeline and includes hidden marker in summary comment', async () => {
    const generateText = vi.fn().mockResolvedValue(
      JSON.stringify({
        summary: 'Reviewed authentication changes.',
        findings: [
          {
            file: 'src/auth.ts',
            line: 2,
            severity: 'critical',
            title: 'Hardcoded secret token',
            comment: 'Move the JWT secret to an environment variable.',
            suggestion: 'const secret = process.env.JWT_SECRET;',
            confidence: 0.99,
          },
        ],
      }),
    );

    const result = await executePullRequestReview({
      rawFiles: [
        {
          filename: 'src/auth.ts',
          status: 'modified',
          additions: 2,
          deletions: 0,
          changes: 2,
          patch: '@@ -1,1 +1,2 @@\n const user = {};\n+const secret = "super-secret-123";',
        },
      ],
      prMetadata: { number: 7, title: 'Add JWT auth' },
      config: getDefaultConfig(),
      existingComments: [],
      generateText,
      logger: noopLogger,
    });

    expect(result.inlineComments).toHaveLength(1);
    expect(result.inlineComments[0].line).toBe(2);
    expect(result.inlineComments[0].body).toContain('```suggestion');
    expect(result.summaryMarkdown).toContain('<!-- ai-pr-reviewer -->');
  });
});
