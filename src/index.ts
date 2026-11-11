import * as core from '@actions/core';
import * as github from '@actions/github';
import { loadReviewConfig } from './config.js';
import { createGeminiGenerator, Logger } from './gemini.js';
import {
  evaluateEventTrigger,
  fetchExistingReviewComments,
  fetchPullRequestDetails,
  fetchPullRequestFiles,
  fetchRepoConfigFile,
  postBatchInlineReview,
  upsertSummaryComment,
} from './github.js';
import { executePullRequestReview } from './review.js';

const actionLogger: Logger = {
  info: (msg: string) => core.info(msg),
  warn: (msg: string) => core.warning(msg),
  error: (msg: string) => core.error(msg),
};

/**
 * Writes a clear, friendly note to the GitHub Actions Job Summary when a fork PR is skipped.
 */
async function writeForkSkippedJobSummary(prNumber: number): Promise<void> {
  try {
    await core.summary
      .addHeading('AI PR Review Skipped (Fork Pull Request)', 2)
      .addRaw(
        `Pull Request #${prNumber} originates from a forked repository. ` +
          `For security reasons, GitHub Actions does not expose repository secrets (\`GEMINI_API_KEY\`) ` +
          `and provides a read-only \`GITHUB_TOKEN\` on fork workflows, so the automated review was safely skipped.`,
        true,
      )
      .write();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.warning(`Could not write to GitHub Actions job summary: ${msg}`);
  }
}

/**
 * Main GitHub Action entrypoint.
 */
export async function run(): Promise<void> {
  try {
    const context = github.context;
    const trigger = evaluateEventTrigger(
      context.eventName,
      context.payload as unknown as Record<string, unknown>,
    );

    if (!trigger.shouldRun || !trigger.pullNumber) {
      core.info(trigger.reason ?? 'Event does not require PR review. Exiting.');
      return;
    }

    const githubToken = core.getInput('github_token') || process.env.GITHUB_TOKEN || '';
    if (!githubToken) {
      core.setFailed('Missing github_token input or GITHUB_TOKEN environment variable.');
      return;
    }
    core.setSecret(githubToken);

    const geminiApiKey = core.getInput('GEMINI_API_KEY') || process.env.GEMINI_API_KEY || '';
    if (geminiApiKey) {
      core.setSecret(geminiApiKey);
    }

    const envModelOverride = core.getInput('GEMINI_MODEL') || process.env.GEMINI_MODEL || undefined;
    const configPath = core.getInput('config_path') || '.reviewbot.yml';

    const octokit = github.getOctokit(githubToken);
    const { owner, repo } = context.repo;
    const pullNumber = trigger.pullNumber;

    const prDetails = await fetchPullRequestDetails(octokit, owner, repo, pullNumber);

    // Fork PR handling: GITHUB_TOKEN is read-only and secrets are unavailable on fork PRs.
    // Never attempt to post a PR comment; log a clear warning and write to the job summary.
    if (prDetails.isFork && !geminiApiKey) {
      core.warning(
        `PR #${pullNumber} is from a fork and GEMINI_API_KEY is unavailable (GITHUB_TOKEN is also read-only on fork PRs). Skipping AI review.`,
      );
      await writeForkSkippedJobSummary(pullNumber);
      return;
    }

    if (prDetails.isFork && context.eventName === 'pull_request') {
      core.warning(
        `PR #${pullNumber} is from a fork where GITHUB_TOKEN is read-only. Skipping AI review to avoid permission errors.`,
      );
      await writeForkSkippedJobSummary(pullNumber);
      return;
    }

    if (!geminiApiKey) {
      core.setFailed(
        'GEMINI_API_KEY is required. Add GEMINI_API_KEY to your repository secrets and pass it in your workflow file.',
      );
      return;
    }

    // Load optional .reviewbot.yml from the repository
    const rawConfigYaml = await fetchRepoConfigFile(
      octokit,
      owner,
      repo,
      configPath,
      prDetails.headSha,
    );
    const config = loadReviewConfig(rawConfigYaml, envModelOverride, (msg) => core.warning(msg));

    // Skip draft PRs unless explicitly enabled in .reviewbot.yml
    if (prDetails.draft && !config.review_drafts) {
      core.info(`PR #${pullNumber} is a draft and review_drafts is false. Skipping review.`);
      return;
    }

    core.info(
      `Starting AI review for PR #${pullNumber} using model "${config.model}" (min_severity: ${config.min_severity}, max_comments: ${config.max_comments})...`,
    );

    const rawFiles = await fetchPullRequestFiles(octokit, owner, repo, pullNumber);

    // Handle empty PRs with zero changed files
    if (rawFiles.length === 0) {
      core.info(`PR #${pullNumber} has no changed files. Skipping review.`);
      return;
    }

    const existingComments = await fetchExistingReviewComments(octokit, owner, repo, pullNumber);

    const generateText = createGeminiGenerator(geminiApiKey);

    const result = await executePullRequestReview({
      rawFiles,
      prMetadata: {
        number: prDetails.number,
        title: prDetails.title,
        body: prDetails.body,
      },
      config,
      existingComments,
      generateText,
      logger: actionLogger,
    });

    // Post ONE pull request review containing all new inline comments
    if (result.inlineComments.length > 0) {
      core.info(
        `Posting ${result.inlineComments.length} inline review comment(s) in a single batch review...`,
      );
      await postBatchInlineReview(
        octokit,
        owner,
        repo,
        pullNumber,
        prDetails.headSha,
        result.inlineComments.map((c) => ({
          path: c.path,
          line: c.line,
          body: c.body,
        })),
      );
    } else {
      core.info('No new inline comments to post.');
    }

    // Post or update the single summary comment
    core.info('Updating PR summary comment...');
    await upsertSummaryComment(octokit, owner, repo, pullNumber, result.summaryMarkdown);

    core.info(`AI review for PR #${pullNumber} completed successfully.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`AI PR Reviewer failed: ${message}`);
  }
}

// Execute when run as the entrypoint in GitHub Actions
if (process.env.VITEST !== 'true') {
  void run();
}
