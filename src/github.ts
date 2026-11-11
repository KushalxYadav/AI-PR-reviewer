import * as github from '@actions/github';
import { RawPullRequestFile } from './diff.js';

export type OctokitClient = ReturnType<typeof github.getOctokit>;

/**
 * Allowed GitHub author_association values permitted to trigger a manual `/review` comment.
 */
export const ALLOWED_REVIEW_COMMENT_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * Hidden HTML marker used to locate and update the single PR summary comment.
 */
export const SUMMARY_COMMENT_MARKER = '<!-- ai-pr-reviewer -->';

export interface ExistingReviewComment {
  id: number;
  path: string;
  line: number | null;
  body: string;
}

export interface PullRequestDetails {
  number: number;
  title: string;
  body: string | null;
  draft: boolean;
  headSha: string;
  baseSha: string;
  isFork: boolean;
  owner: string;
  repo: string;
}

export interface TriggerEvaluation {
  shouldRun: boolean;
  reason?: string;
  pullNumber?: number;
}

/**
 * Evaluates whether the current GitHub webhook event should trigger a PR review.
 * Supports:
 * 1. `pull_request` with actions `opened`, `synchronize`, or `reopened`.
 * 2. `issue_comment` (`created`) on a Pull Request when the comment starts with `/review`
 *    AND the commenter's `author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR`.
 */
export function evaluateEventTrigger(
  eventName: string,
  payload: Record<string, unknown>,
): TriggerEvaluation {
  if (eventName === 'pull_request') {
    const action = payload.action as string | undefined;
    const pr = payload.pull_request as { number?: number } | undefined;
    if (!pr?.number) {
      return { shouldRun: false, reason: 'Missing pull_request.number in webhook payload.' };
    }
    if (action !== 'opened' && action !== 'synchronize' && action !== 'reopened') {
      return {
        shouldRun: false,
        reason: `Ignoring pull_request action "${action ?? 'unknown'}".`,
      };
    }
    return { shouldRun: true, pullNumber: pr.number };
  }

  if (eventName === 'issue_comment') {
    const action = payload.action as string | undefined;
    if (action && action !== 'created') {
      return {
        shouldRun: false,
        reason: `Ignoring issue_comment action "${action}".`,
      };
    }

    const issue = payload.issue as
      { number?: number; pull_request?: Record<string, unknown> } | undefined;
    if (!issue?.pull_request || !issue.number) {
      return {
        shouldRun: false,
        reason: 'Comment is not on a Pull Request.',
      };
    }

    const comment = payload.comment as
      { body?: string; author_association?: string; user?: { login?: string } } | undefined;
    const body = (comment?.body ?? '').trim();
    if (!/^\/review(?:\s|$)/i.test(body)) {
      return {
        shouldRun: false,
        reason: 'Comment does not start with "/review".',
      };
    }

    const association = (comment?.author_association ?? '').toUpperCase();
    if (!ALLOWED_REVIEW_COMMENT_ASSOCIATIONS.has(association)) {
      const author = comment?.user?.login ?? 'unknown';
      return {
        shouldRun: false,
        reason: `Ignoring /review command from @${author} with author_association="${association || 'NONE'}" (must be OWNER, MEMBER, or COLLABORATOR).`,
      };
    }

    return { shouldRun: true, pullNumber: issue.number };
  }

  return {
    shouldRun: false,
    reason: `Unsupported event "${eventName}".`,
  };
}

/**
 * Fetches Pull Request metadata from the GitHub API, including fork detection.
 */
export async function fetchPullRequestDetails(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PullRequestDetails> {
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });

  const headFullName = pr.head.repo?.full_name ?? '';
  const baseFullName = pr.base.repo.full_name;
  const isFork =
    Boolean(pr.head.repo?.fork) ||
    !headFullName ||
    headFullName.toLowerCase() !== baseFullName.toLowerCase();

  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    draft: Boolean(pr.draft),
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    isFork,
    owner,
    repo,
  };
}

/**
 * Fetches `.reviewbot.yml` from the repository at the given ref (or default branch if not found).
 * Returns null if the file does not exist.
 */
export async function fetchRepoConfigFile(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  configPath: string,
  ref: string,
): Promise<string | null> {
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: configPath,
      ref,
    });

    if (!Array.isArray(response.data) && response.data.type === 'file' && response.data.content) {
      return Buffer.from(response.data.content, 'base64').toString('utf-8');
    }
    return null;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Fetches all changed files and unified diff patches for a Pull Request using Octokit pagination.
 */
export async function fetchPullRequestFiles(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<RawPullRequestFile[]> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  return files.map((file) => ({
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: file.patch,
  }));
}

/**
 * Fetches all existing inline review comments on the Pull Request for deduplication.
 */
export async function fetchExistingReviewComments(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<ExistingReviewComment[]> {
  const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  return comments.map((c) => ({
    id: c.id,
    path: c.path,
    line: c.line ?? c.original_line ?? null,
    body: c.body,
  }));
}

/**
 * Posts ONE Pull Request review containing all inline comments in a single API call.
 * Always uses `event: 'COMMENT'` so builds are never blocked.
 */
export async function postBatchInlineReview(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  pullNumber: number,
  commitId: string,
  comments: Array<{ path: string; line: number; body: string }>,
): Promise<void> {
  if (comments.length === 0) {
    return;
  }

  await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    commit_id: commitId,
    event: 'COMMENT',
    comments: comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: 'RIGHT',
      body: comment.body,
    })),
  });
}

/**
 * Creates or updates a single summary comment on the PR identified by `<!-- ai-pr-reviewer -->`.
 */
export async function upsertSummaryComment(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  pullNumber: number,
  body: string,
): Promise<void> {
  const bodyWithMarker = body.includes(SUMMARY_COMMENT_MARKER)
    ? body
    : `${SUMMARY_COMMENT_MARKER}\n${body}`;

  const issueComments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100,
  });

  const existing = issueComments.find((comment) =>
    (comment.body ?? '').includes(SUMMARY_COMMENT_MARKER),
  );

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body: bodyWithMarker,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: bodyWithMarker,
    });
  }
}
