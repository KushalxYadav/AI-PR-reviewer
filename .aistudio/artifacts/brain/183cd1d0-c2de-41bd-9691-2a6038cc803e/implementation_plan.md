# Argon Review — AI-Powered GitHub Pull Request Reviewer Action

Argon Review is a standalone, zero-infrastructure open-source GitHub Action powered by Google's Gemini API (`DEFAULT_GEMINI_MODEL`) that automatically reviews pull request diffs for real bugs, security vulnerabilities, race conditions, and breaking changes, posting a single idempotent summary comment and batched inline review comments.

## User Review & Critical Decisions

> [!IMPORTANT]
> The plan has been updated with all five requested revisions.

- **Confirmed Decision 1 — Pure GitHub Action Package Only**: No Express or React web UI will be built. The project is strictly the GitHub Action package (`src/`, `tests/`, `action.yml`, bundled `dist/index.js`, `.github/workflows/example.yml`, `README.md`, and `LICENSE`).
- **Confirmed Decision 2 — Fork PR Read-Only Token Handling**: On fork PRs where `GEMINI_API_KEY` is unavailable (and `GITHUB_TOKEN` is read-only), the Action will NOT attempt to post a PR comment. Instead, it logs a clear `core.warning` and writes an explanation to the GitHub Actions Job Summary (`core.summary`).
- **Confirmed Decision 3 — `/review` Command Authorization**: When triggered via `issue_comment` (`Let's review` / `/review` on a PR), the Action verifies that `comment.author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR` before executing. Unauthorized comment triggers are ignored with a warning.
- **Confirmed Decision 4 — Tag Escaping for Prompt Injection Defence**: Before wrapping diff chunks in `<UNTRUSTED_PR_DIFF>...</UNTRUSTED_PR_DIFF>`, any literal or case-variant closing `</UNTRUSTED_PR_DIFF>` tag inside the diff content is escaped so untrusted patches cannot break out of the delimiter block.
- **Confirmed Decision 5 — Single Model Constant (`DEFAULT_GEMINI_MODEL`)**: The default model ID is defined in one clearly named constant (`DEFAULT_GEMINI_MODEL = "gemini-4-argon"`) in `src/config.ts` so it can be changed in a single place, while still supporting overrides via the `GEMINI_MODEL` input/environment variable or `.reviewbot.yml`.
- **Confirmed Decision 6 — Non-Blocking `COMMENT` Review Events & Token Guardrails**: Inline reviews are submitted as a single `COMMENT` event so builds are never blocked, with default caps of 30 files, 60,000 characters per file-aligned chunk, and 150,000 total diff characters per run.

---

## 1. Overview & Core Concept

- **What It Does**:
  1. **Event & Permission Triage**: Runs on `pull_request` (`opened`, `synchronize`, `reopened`) and authorized `/review` `issue_comment` triggers on pull requests (`OWNER`, `MEMBER`, or `COLLABORATOR`).
  2. **Safe Fork & Draft Handling**: Skips draft PRs by default (unless enabled in `.reviewbot.yml`). Detects fork PRs missing secrets and exits cleanly with `core.warning` + a Job Summary note (`core.summary`) without calling write APIs with a read-only `GITHUB_TOKEN`.
  3. **Diff Fetching, Filtering & Hunk-Safe Chunking**: Paginates changed PR files via Octokit, filters out lockfiles, minified assets, build/dist directories, binaries/images, generated code, and custom `.reviewbot.yml` ignore globs, and groups files into chunks without ever splitting a unified diff hunk.
  4. **Hardened Gemini Review Pipeline**: Escapes any `</UNTRUSTED_PR_DIFF>` sequences inside diffs, wraps patches in untrusted data delimiters, requests strict JSON from Gemini (`responseMimeType: "application/json"` + `responseSchema`), validates responses with Zod, retries once with a JSON-fix prompt if validation fails, and uses exponential backoff (up to 3 retries) on 429/5xx errors.
  5. **RIGHT-Side Line Mapping & Deduplication**: Maps each finding to a valid `RIGHT`-side line in the diff patch (dropping out-of-range lines), deduplicates against earlier inline review comments on the same `(file, line, message)`, posts all new inline comments in a single `pulls.createReview` (`COMMENT`) call, and creates or updates a single summary comment identified by `<!-- ai-pr-reviewer -->`.
- **Target Audience / Persona**: Developers and open-source maintainers who want to add automated AI code review to any repository using one workflow file and one secret (`GEMINI_API_KEY`).
- **Key Value**: High-signal code review focused on real defects rather than style noise, packaged with `@vercel/ncc` into `dist/index.js` for zero-install execution on Node.js 20 runners.

---

## 2. User Experience & Developer Workflow

- **Key User Flows**:
  1. **2-Minute Repository Setup**: User adds `GEMINI_API_KEY` to GitHub repository secrets and copies `.github/workflows/example.yml` into their repo.
  2. **Automated PR Review**: Opening or updating a PR triggers the Action. Within seconds, the bot posts/updates a single summary comment (`<!-- ai-pr-reviewer -->`) and attaches inline review comments with concrete `suggestion` blocks on specific diff lines.
  3. **Manual `/review` Re-Run**: A repo `OWNER`, `MEMBER`, or `COLLABORATOR` comments `/review` on a PR to trigger an on-demand review.
  4. **Optional `.reviewbot.yml` Customization**: Maintainers optionally add `.reviewbot.yml` in the repository root to configure `model`, `min_severity`, `max_comments`, `ignore` globs, `language` (`en` or `hi`), `focus` areas, and `custom_instructions`.

---

## 3. Key Technical Decisions & Trade-Offs

- **Decision 1 — Fork PR Detection with Job Summary Output (`core.summary`)**
  - *Chosen Approach*: Detect fork PRs (`head.repo.full_name !== base.repo.full_name`) or missing `GEMINI_API_KEY` on fork events, emit `core.warning(...)`, write a friendly markdown notice to `core.summary`, and exit `0` without calling `issues.createComment`.
  - *Why*: GitHub Actions passes a read-only `GITHUB_TOKEN` on `pull_request` events from forks and withholds secrets; attempting to post a PR comment would fail with `403 Resource not accessible by integration`.
- **Decision 2 — Strict Author Association Check on `/review` Comments**
  - *Chosen Approach*: When `github.context.eventName === 'issue_comment'`, verify `payload.issue?.pull_request` exists, the comment body matches `/review`, and `payload.comment?.author_association` is in `['OWNER', 'MEMBER', 'COLLABORATOR']`.
  - *Why*: Prevents untrusted external users from triggering paid Gemini API calls or exhausting rate limits on public repositories.
- **Decision 3 — Delimiter Escaping + System Prompt Hardening**
  - *Chosen Approach*: Sanitize raw patches by replacing any case-insensitive occurrence of `</UNTRUSTED_PR_DIFF>` with `&lt;/UNTRUSTED_PR_DIFF&gt;` before enclosing the diff in `<UNTRUSTED_PR_DIFF>...</UNTRUSTED_PR_DIFF>`, paired with explicit system prompt rules treating all diff contents as passive data.
  - *Why*: Stops adversarial PR diffs from closing the XML block early and injecting rogue instructions into the prompt context.
- **Decision 4 — Two-Layer JSON Validation (Gemini Schema + Zod + 1x Self-Correction Retry)**
  - *Chosen Approach*: Enforce JSON structure via `@google/genai` `responseSchema` and verify with Zod (`ReviewResponseSchema`). If parsing or validation fails, send one follow-up repair request with the Zod error message; if still invalid, log a warning and skip only that chunk.
  - *Why*: Guarantees resilience so a single malformed response never crashes the entire PR review run.

---

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

- **Architecture & Pipeline Diagram**:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     GITHUB ACTION ENTRYPOINT (Node 20)                       │
│  [Event: pull_request (opened/synchronize/reopened) | issue_comment /review] │
│         │                                                                    │
│         ▼                                                                    │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ 1. Guardrails & Context Resolution                                     │  │
│  │  • Fork PR without secret? ──▶ core.warning + core.summary & exit(0)   │  │
│  │  • issue_comment "/review"? ──▶ Verify OWNER | MEMBER | COLLABORATOR   │  │
│  │  • Draft PR? ──▶ Skip unless review_drafts enabled                     │  │
│  └──────────────────────────────────┬─────────────────────────────────────┘  │
│                                     ▼                                        │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ 2. Config & Diff Ingestion                                             │  │
│  │  • Load .reviewbot.yml from PR head/base ref (fallback to defaults)    │  │
│  │  • Paginate PR files via Octokit & filter noise / ignore globs         │  │
│  │  • Enforce file/token caps & track skipped files for summary notice    │  │
│  └──────────────────────────────────┬─────────────────────────────────────┘  │
│                                     ▼                                        │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ 3. Diff Parsing, Hunk-Safe Chunking & RIGHT-Side Line Mapping          │  │
│  │  • Parse @@ -a,b +c,d @@ headers; record valid RIGHT line numbers      │  │
│  │  • Group files into chunks (never split a hunk in the middle)          │  │
│  │  • Escape any </UNTRUSTED_PR_DIFF> tags inside patch content           │  │
│  └──────────────────────────────────┬─────────────────────────────────────┘  │
│                                     ▼                                        │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ 4. Gemini Review Client (DEFAULT_GEMINI_MODEL)                         │  │
│  │  • Exponential backoff (max 3 retries) on 429 / 5xx errors             │  │
│  │  • Strict JSON output + Zod validation (1x fix-JSON retry on failure)  │  │
│  └──────────────────────────────────┬─────────────────────────────────────┘  │
│                                     ▼                                        │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ 5. Deduplication & GitHub Review Publishing                            │  │
│  │  • Filter by min_severity, valid RIGHT diff lines & max_comments       │  │
│  │  • Deduplicate against existing inline comments (file + line + body)   │  │
│  │  • Post 1 batched pulls.createReview (event: COMMENT)                  │  │
│  │  • Upsert 1 summary comment via hidden <!-- ai-pr-reviewer --> marker  │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Data Model & Schemas**:
  - `DEFAULT_GEMINI_MODEL`: Single constant exported from `src/config.ts` (default set to `"gemini-4-argon"` for easy one-line editing).
  - `ReviewConfig`: `{ model: string, min_severity: 'low' | 'medium' | 'high' | 'critical', max_comments: number, ignore: string[], language: string, focus: string[], custom_instructions: string }`
  - `Finding`: `{ file: string, line: number, severity: 'critical' | 'high' | 'medium' | 'low', title: string, comment: string, suggestion: string | null, confidence: number }`
  - `ReviewOutput`: `{ summary: string, findings: Finding[] }`
- **Verification & Bundling Strategy**:
  - **Unit Tests (Vitest)**: Comprehensive test suite covering unified diff parsing, `RIGHT`-side line mapping, file-aligned chunking, noise/glob filtering, `</UNTRUSTED_PR_DIFF>` tag escaping, `.reviewbot.yml` config parsing and defaults, author association checks, deduplication, and Zod JSON validation/retry behavior.
  - **Linting & Typecheck**: ESLint + Prettier + `tsc --noEmit` in strict mode.
  - **Bundling**: `@vercel/ncc build src/index.ts -o dist` producing a self-contained `dist/index.js` referenced by `action.yml` (`runs.using: 'node20'`, `runs.main: 'dist/index.js'`).
