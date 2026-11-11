# 🤖 AI PR Reviewer (Gemini 4 Argon)

**High-signal, zero-infrastructure AI code reviews for your GitHub Pull Requests—powered by Google Gemini (`gemini-4-argon`) with one workflow file and one secret.**

---

## 📸 Demo

> _Placeholder: Insert demo GIF or screenshot here (`docs/demo-review.gif`)_
>
> ```
> +-----------------------------------------------------------------------------------+
> | 🤖 github-actions bot commented                                                   |
> |                                                                                   |
> | ## 🤖 AI Pull Request Review                                                      |
> | Reviewed authentication middleware and SQL query builder changes.                 |
> |                                                                                   |
> | Files reviewed: 3 · Inline comments posted: 2                                     |
> |                                                                                   |
> | | Severity    | Count |                                                           |
> | | 🔴 Critical |   1   |                                                           |
> | | 🟠 High     |   1   |                                                           |
> +-----------------------------------------------------------------------------------+
> ```

---

## ⚡ Quick Start in 2 Minutes

You do **not** need a server, database, or external dashboard.

### 1. Get a Gemini API Key
Create a Google Gemini API key in [Google AI Studio](https://aistudio.google.com/).

### 2. Add `GEMINI_API_KEY` as a Repository Secret
In your GitHub repository, go to:
**Settings → Secrets and variables → Actions → New repository secret**
- **Name:** `GEMINI_API_KEY`
- **Secret:** Paste your Gemini API key.

### 3. Add the Workflow File
Create `.github/workflows/ai-pr-review.yml` in your repository and paste the following YAML:

```yaml
name: AI PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: ai-pr-review-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true

jobs:
  review:
    name: Gemini PR Review
    if: >
      github.event_name == 'pull_request' ||
      (github.event_name == 'issue_comment' &&
       github.event.issue.pull_request &&
       startsWith(trim(github.event.comment.body), '/review'))
    runs-on: ubuntu-latest
    steps:
      - name: Run AI PR Reviewer
        uses: your-org/ai-pr-reviewer@v1
        with:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

That's it! Open a Pull Request (or comment `/review` on an existing PR as a repo owner, member, or collaborator) and the bot will review your changes automatically.

---

## ⚙️ Configuration Reference (`.reviewbot.yml`)

Adding a `.reviewbot.yml` file to the root of your repository is **completely optional**. If the file is missing, the bot runs with sensible defaults.

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `model` | `string` | `gemini-4-argon` (or `GEMINI_MODEL` input) | Gemini model ID used for code review. |
| `min_severity` | `'low' \| 'medium' \| 'high' \| 'critical'` | `'medium'` | Minimum severity required to post an inline finding. |
| `max_comments` | `number` | `15` | Maximum number of inline review comments posted per run. |
| `ignore` | `string[]` | `[]` | Additional glob patterns to ignore (built-in noise like lockfiles, `dist/`, binaries, and minified files are always ignored). |
| `language` | `string` | `'en'` | Language for review comments (`'en'` for English, `'hi'` for Hindi / हिन्दी, or any ISO code). |
| `focus` | `string[]` | `[]` | Extra areas to emphasize (e.g., `["security", "performance", "tests"]`). |
| `custom_instructions` | `string` | `""` | Free-text instructions appended to the reviewer system prompt. |
| `review_drafts` | `boolean` | `false` | Whether to review Draft Pull Requests automatically. |
| `max_files` | `number` | `30` | Maximum number of files to review in a single PR run. |
| `max_chunk_chars` | `number` | `60000` | Maximum characters per diff chunk sent in a single Gemini call. |
| `max_total_chars` | `number` | `150000` | Maximum total diff characters reviewed across the entire PR run. |

### Example `.reviewbot.yml`

```yaml
model: gemini-4-argon
min_severity: medium
max_comments: 15
language: en # Use "hi" for Hindi (हिन्दी)
ignore:
  - "**/*.generated.ts"
  - "migrations/**"
  - "docs/**"
focus:
  - security
  - performance
  - tests
custom_instructions: |
  Ensure all public API endpoints validate request payloads with Zod and enforce tenant isolation.
```

---

## 💬 Example Bot Comments

### 1. Summary Comment (Updated in-place on every push)

> ## 🤖 AI Pull Request Review
>
> This PR introduces a new password reset endpoint and updates the session token validator. While the token expiry logic is sound, there is a critical SQL injection vulnerability in the user lookup query and an unhandled null dereference when a user has no active session.
>
> **Files reviewed:** 4 · **Noise/ignored files skipped:** 2 · **Inline comments posted:** 2
>
> | Severity | Count |
> | :--- | :---: |
> | 🔴 Critical | 1 |
> | 🟠 High | 1 |
> | 🟡 Medium | 0 |
> | 🔵 Low | 0 |
>
> ### Key Findings
> - **[CRITICAL]** `src/db/users.ts:42` — Unsanitized SQL string interpolation in `findUserByEmail`
> - **[HIGH]** `src/auth/session.ts:88` — Unchecked null access on `session.user.id`

### 2. Inline Review Comment (with one-click GitHub Suggestion)

> 🔴 **CRITICAL** — **Unsanitized SQL string interpolation in `findUserByEmail`**
>
> Interpolating `email` directly into the SQL query string enables SQL injection attacks. Use parameterized placeholders instead.
>
> ```suggestion
>   const result = await db.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email]);
> ```

---

## ❓ Frequently Asked Questions (FAQ)

### 💰 How much does it cost?
The GitHub Action itself is 100% free and open-source. You only pay for your Google Gemini API usage under your `GEMINI_API_KEY`. To keep costs low and predictable:
- Lockfiles, `dist/` folders, images, binaries, and generated files are filtered out before calling Gemini.
- Each run enforces a hard cap on total files (`max_files: 30`) and diff characters (`max_total_chars: 150000`). If any files are skipped due to the cap, the bot lists them in the summary comment.

### 🔒 Privacy: What data is sent to Google?
Only the PR title, PR description, and the unified diff patches of the non-ignored changed files in the PR are sent to the Google Gemini API. Your full repository source code is **never** uploaded, and neither your `GEMINI_API_KEY` nor full diff contents are ever printed to GitHub Actions logs.

### 🍴 Why are Fork Pull Requests skipped?
When an external contributor opens a Pull Request from a forked repository, GitHub Actions intentionally withholds repository secrets (`GEMINI_API_KEY`) and provides a **read-only** `GITHUB_TOKEN` for security reasons. Because the token is read-only and cannot post PR comments, the Action detects fork PRs, logs a clear `core.warning`, writes an explanation to the GitHub Actions Job Summary, and exits cleanly so the contributor's CI check never fails.

### 🙈 How do I ignore specific files or folders?
Add an `ignore` list of glob patterns to `.reviewbot.yml` in your repository root:
```yaml
ignore:
  - "src/legacy/**"
  - "**/*.snap"
  - "fixtures/**"
```
Note that common lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `go.sum`, `Cargo.lock`, etc.), `dist/` and `build/` directories, minified files (`*.min.js`), and binary assets are automatically ignored by default.

### 🧠 How do I change the Gemini model?
You can change the model in three ways (in order of precedence):
1. Set `model: your-model-id` in `.reviewbot.yml`.
2. Pass `GEMINI_MODEL: 'your-model-id'` in the `with:` section of your `.github/workflows/ai-pr-review.yml`.
3. If you are maintaining your own fork of this Action, edit the `DEFAULT_GEMINI_MODEL` constant in `src/config.ts` and run `npm run build`.

---

## 🛠️ Contributing & Local Development

Contributions, bug reports, and feature requests are welcome!

### Prerequisites
- Node.js 20+
- npm

### Commands
```bash
# Install dependencies
npm install

# Run unit tests (Vitest)
npm test

# Run linter and TypeScript strict typecheck
npm run lint

# Bundle the Action into dist/index.js with @vercel/ncc
npm run build
```

> **Important:** Because GitHub Actions runs `dist/index.js` directly without running `npm install`, always run `npm run build` and commit the updated `dist/` folder before opening a PR.

---

## 📄 License

Released under the [MIT License](./LICENSE).
