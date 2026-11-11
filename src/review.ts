import { meetsMinSeverity, ReviewConfig } from './config.js';
import {
  chunkParsedDiffs,
  filterFindingsByDiffLines,
  ParsedFileDiff,
  parseFilePatch,
  RawPullRequestFile,
  shouldIgnoreFile,
} from './diff.js';
import { GenerateTextFn, Logger, reviewDiffChunk } from './gemini.js';
import { ExistingReviewComment, SUMMARY_COMMENT_MARKER } from './github.js';
import { PullRequestMetadata } from './prompt.js';
import { Finding, SEVERITY_LEVELS } from './schema.js';

export interface InlineReviewCommentPayload {
  path: string;
  line: number;
  body: string;
  finding: Finding;
}

export interface ReviewExecutionResult {
  summaryMarkdown: string;
  inlineComments: InlineReviewCommentPayload[];
  allValidFindings: Finding[];
  ignoredFilesCount: number;
  skippedForCostCap: string[];
  reviewedFilesCount: number;
}

/**
 * Formats a single finding into a GitHub inline review comment body,
 * including a ```suggestion block when a concrete code suggestion is present.
 */
export function formatInlineCommentBody(finding: Finding): string {
  const severityBadge: Record<Finding['severity'], string> = {
    critical: '🔴 **CRITICAL**',
    high: '🟠 **HIGH**',
    medium: '🟡 **MEDIUM**',
    low: '🔵 **LOW**',
  };

  const parts: string[] = [
    `${severityBadge[finding.severity]} — **${finding.title.trim()}**`,
    '',
    finding.comment.trim(),
  ];

  if (finding.suggestion && finding.suggestion.trim().length > 0) {
    const cleanSuggestion = finding.suggestion
      .replace(/^```[a-zA-Z0-9_-]*\n?/, '')
      .replace(/\n?```$/, '');
    parts.push('', '```suggestion', cleanSuggestion, '```');
  }

  if (finding.confidence < 0.75) {
    parts.push(
      '',
      `_Confidence: ${Math.round(finding.confidence * 100)}% (please verify with surrounding context)_`,
    );
  }

  return parts.join('\n');
}

/**
 * Normalizes text for deduplication comparisons.
 */
function normalizeForDedup(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Filters out duplicate findings:
 * 1. Deduplicates within the current run (same file + line + title/comment).
 * 2. Deduplicates against comments already posted on earlier runs on the same file, line,
 *    and title or comment body.
 */
export function deduplicateFindings(
  findings: Finding[],
  existingComments: ExistingReviewComment[],
): Finding[] {
  const seenInCurrentRun = new Set<string>();
  const result: Finding[] = [];

  for (const finding of findings) {
    const normalizedPath = finding.file.replace(/\\/g, '/').replace(/^\/+/, '');
    const normalizedTitle = normalizeForDedup(finding.title);
    const normalizedComment = normalizeForDedup(finding.comment);
    const runKey = `${normalizedPath}:${finding.line}:${normalizedTitle}:${normalizedComment}`;

    if (seenInCurrentRun.has(runKey)) {
      continue;
    }

    // Check if an existing PR comment on the same file and line already contains this finding
    const alreadyPosted = existingComments.some((existing) => {
      const existingPath = existing.path.replace(/\\/g, '/').replace(/^\/+/, '');
      if (existingPath !== normalizedPath || existing.line !== finding.line) {
        return false;
      }
      const existingBodyNorm = normalizeForDedup(existing.body);
      return (
        (normalizedTitle.length > 0 && existingBodyNorm.includes(normalizedTitle)) ||
        (normalizedComment.length > 0 && existingBodyNorm.includes(normalizedComment))
      );
    });

    if (alreadyPosted) {
      continue;
    }

    seenInCurrentRun.add(runKey);
    result.push(finding);
  }

  return result;
}

/**
 * Sorts findings from highest severity to lowest severity, breaking ties by confidence.
 */
export function sortFindingsByPriority(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const severityDiff = SEVERITY_LEVELS.indexOf(b.severity) - SEVERITY_LEVELS.indexOf(a.severity);
    if (severityDiff !== 0) {
      return severityDiff;
    }
    return b.confidence - a.confidence;
  });
}

/**
 * Builds the markdown body for the single idempotent PR summary comment.
 * Includes the hidden `<!-- ai-pr-reviewer -->` marker.
 */
export function buildSummaryCommentMarkdown(params: {
  chunkSummaries: string[];
  findings: Finding[];
  postedInlineCount: number;
  duplicateSkippedCount: number;
  reviewedFilesCount: number;
  ignoredFilesCount: number;
  skippedForCostCap: string[];
  model: string;
}): string {
  const {
    chunkSummaries,
    findings,
    postedInlineCount,
    duplicateSkippedCount,
    reviewedFilesCount,
    ignoredFilesCount,
    skippedForCostCap,
    model,
  } = params;

  const lines: string[] = [SUMMARY_COMMENT_MARKER, '## 🤖 AI Pull Request Review', ''];

  if (chunkSummaries.length > 0) {
    lines.push(chunkSummaries.join('\n\n'), '');
  } else {
    lines.push('No reviewable code changes were found in this Pull Request.', '');
  }

  const counts = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    high: findings.filter((f) => f.severity === 'high').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
    low: findings.filter((f) => f.severity === 'low').length,
  };

  lines.push(
    `**Files reviewed:** ${reviewedFilesCount}` +
      (ignoredFilesCount > 0 ? ` · **Noise/ignored files skipped:** ${ignoredFilesCount}` : '') +
      ` · **Inline comments posted:** ${postedInlineCount}` +
      (duplicateSkippedCount > 0
        ? ` · **Already reported on earlier runs:** ${duplicateSkippedCount}`
        : ''),
    '',
  );

  if (findings.length === 0) {
    lines.push('✅ **No actionable issues found** above the configured severity threshold.', '');
  } else {
    lines.push(
      '| Severity | Count |',
      '| :--- | :---: |',
      `| 🔴 Critical | ${counts.critical} |`,
      `| 🟠 High | ${counts.high} |`,
      `| 🟡 Medium | ${counts.medium} |`,
      `| 🔵 Low | ${counts.low} |`,
      '',
      '### Key Findings',
      '',
    );

    for (const f of findings.slice(0, 20)) {
      lines.push(`- **[${f.severity.toUpperCase()}]** \`${f.file}:${f.line}\` — ${f.title}`);
    }
    lines.push('');
  }

  if (skippedForCostCap.length > 0) {
    lines.push(
      '> ⚠️ **Note on File / Token Caps:** To control API cost, the following files were skipped because the PR exceeded the per-run limit:',
      ...skippedForCostCap.slice(0, 25).map((file) => `> - \`${file}\``),
      ...(skippedForCostCap.length > 25
        ? [`> - _...and ${skippedForCostCap.length - 25} more file(s)_`]
        : []),
      '',
    );
  }

  lines.push(`---`, `_Reviewed by Gemini (\`${model}\`)_`);
  return lines.join('\n');
}

/**
 * Executes the complete PR review pipeline across all changed files:
 * 1. Filters noise and user ignore globs.
 * 2. Parses unified diffs and records valid RIGHT-side line numbers.
 * 3. Chunks diffs safely along file/hunk boundaries with hard cost caps.
 * 4. Calls Gemini per chunk and merges results.
 * 5. Filters by min_severity and valid RIGHT diff lines, deduplicates against existing comments,
 *    and prepares the summary markdown and inline comment batch.
 */
export async function executePullRequestReview(params: {
  rawFiles: RawPullRequestFile[];
  prMetadata: PullRequestMetadata;
  config: ReviewConfig;
  existingComments: ExistingReviewComment[];
  generateText: GenerateTextFn;
  logger: Logger;
  sleepFn?: (ms: number) => Promise<void>;
}): Promise<ReviewExecutionResult> {
  const { rawFiles, prMetadata, config, existingComments, generateText, logger, sleepFn } = params;

  const parsedFiles: ParsedFileDiff[] = [];
  const parsedFilesByPath = new Map<string, ParsedFileDiff>();
  let ignoredFilesCount = 0;

  for (const rawFile of rawFiles) {
    const ignoreCheck = shouldIgnoreFile(
      rawFile.filename,
      rawFile.patch,
      config.ignore,
      rawFile.status,
    );
    if (ignoreCheck.ignored || !rawFile.patch) {
      ignoredFilesCount += 1;
      continue;
    }

    const parsed = parseFilePatch(
      rawFile.filename,
      rawFile.patch,
      rawFile.status,
      rawFile.additions,
      rawFile.deletions,
    );
    if (parsed.hunks.length === 0 || parsed.validRightLines.size === 0) {
      ignoredFilesCount += 1;
      continue;
    }

    parsedFiles.push(parsed);
    parsedFilesByPath.set(parsed.filename.replace(/\\/g, '/').replace(/^\/+/, ''), parsed);
  }

  if (parsedFiles.length === 0) {
    const summaryMarkdown = buildSummaryCommentMarkdown({
      chunkSummaries: [
        'All changed files in this Pull Request were filtered out (e.g., lockfiles, generated artifacts, binaries, deleted files, or paths matching ignore patterns).',
      ],
      findings: [],
      postedInlineCount: 0,
      duplicateSkippedCount: 0,
      reviewedFilesCount: 0,
      ignoredFilesCount,
      skippedForCostCap: [],
      model: config.model,
    });

    return {
      summaryMarkdown,
      inlineComments: [],
      allValidFindings: [],
      ignoredFilesCount,
      skippedForCostCap: [],
      reviewedFilesCount: 0,
    };
  }

  const { chunks, skippedForCostCap } = chunkParsedDiffs(
    parsedFiles,
    config.max_chunk_chars,
    config.max_total_chars,
    config.max_files,
  );

  const reviewedFilesSet = new Set<string>();
  for (const chunk of chunks) {
    for (const f of chunk.files) {
      reviewedFilesSet.add(f.filename);
    }
  }

  const chunkSummaries: string[] = [];
  const rawFindings: Finding[] = [];

  for (const chunk of chunks) {
    logger.info(
      `Reviewing chunk ${chunk.index}/${chunks.length} (${chunk.files.length} file(s), ${chunk.totalChars} chars)...`,
    );
    const chunkResult = await reviewDiffChunk(
      chunk,
      chunks.length,
      prMetadata,
      config,
      generateText,
      logger,
      sleepFn,
    );

    if (chunkResult) {
      if (chunkResult.summary.trim().length > 0) {
        chunkSummaries.push(chunkResult.summary.trim());
      }
      rawFindings.push(...chunkResult.findings);
    }
  }

  // Filter by configured minimum severity
  const severityFiltered = rawFindings.filter((f) =>
    meetsMinSeverity(f.severity, config.min_severity),
  );

  // Map each finding to a valid RIGHT-side diff line; drop findings outside the diff
  const { validFindings, droppedFindings } = filterFindingsByDiffLines(
    severityFiltered,
    parsedFilesByPath,
  );
  if (droppedFindings.length > 0) {
    logger.info(
      `Dropped ${droppedFindings.length} finding(s) whose line numbers were not part of the RIGHT-side diff.`,
    );
  }

  const sortedValidFindings = sortFindingsByPriority(validFindings);

  // Deduplicate against current run and earlier runs
  const deduplicatedFindings = deduplicateFindings(sortedValidFindings, existingComments);
  const duplicateSkippedCount = sortedValidFindings.length - deduplicatedFindings.length;

  // Enforce max_comments cap
  const cappedFindings = deduplicatedFindings.slice(0, config.max_comments);

  const inlineComments: InlineReviewCommentPayload[] = cappedFindings.map((finding) => ({
    path: finding.file,
    line: finding.line,
    body: formatInlineCommentBody(finding),
    finding,
  }));

  const summaryMarkdown = buildSummaryCommentMarkdown({
    chunkSummaries,
    findings: sortedValidFindings,
    postedInlineCount: inlineComments.length,
    duplicateSkippedCount,
    reviewedFilesCount: reviewedFilesSet.size,
    ignoredFilesCount,
    skippedForCostCap,
    model: config.model,
  });

  return {
    summaryMarkdown,
    inlineComments,
    allValidFindings: sortedValidFindings,
    ignoredFilesCount,
    skippedForCostCap,
    reviewedFilesCount: reviewedFilesSet.size,
  };
}
