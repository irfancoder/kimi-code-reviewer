# Kimi Code Reviewer

AI-powered code review for GitHub using **Moonshot Kimi** with **256K context window**.

> Fill the gap in Kimi's developer ecosystem — native GitHub integration for intelligent code review.

## Features

- **256K Context Window** — Review entire PRs with full file context, not just diffs
- **GitHub App + Action** — Use as a GitHub App (@kimi mentions) or GitHub Action (CI/CD)
- **Cache-Optimized** — Prefix caching at $0.10/M tokens (75% cheaper than standard)
- **Inline Annotations** — Issues appear directly in PR diff via GitHub Checks API
- **Configurable** — Per-repo `.kimi-review.yml` for custom rules, severity thresholds, file filters
- **Multi-language** — Review comments in English, 繁體中文, 简体中文, 日本語, 한국어

## Quick Start — GitHub Action

```yaml
# .github/workflows/kimi-review.yml
name: Kimi Code Review
on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write
  checks: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: kimi-code-reviewer/kimi-code-reviewer@v1
        with:
          kimi_api_key: ${{ secrets.KIMI_API_KEY }}
          language: en
          fail_on: critical
```

### Action Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `kimi_api_key` | Yes | — | Moonshot AI API key |
| `github_token` | No | `github.token` | GitHub token |
| `model` | No | `kimi-k2-0905` | Kimi model (256K context) |
| `language` | No | `en` | Review language |
| `fail_on` | No | `critical` | Fail check on: critical, warning, never |

### Action Outputs

| Output | Description |
|--------|-------------|
| `review_summary` | Review summary text |
| `annotations_count` | Number of annotations |
| `critical_count` | Critical issues found |
| `tokens_used` | Total tokens consumed |
| `cost_estimate` | Estimated cost in USD |

## Quick Start — GitHub App

### @kimi Commands

| Command | Description |
|---------|-------------|
| `@kimi review` | Full code review |
| `@kimi help` | Show commands |

### Self-Hosting

```bash
git clone https://github.com/kimi-code-reviewer/kimi-code-reviewer.git
cd kimi-code-reviewer
npm install
cp .env.example .env  # Fill in your credentials
npm run dev
```

Required environment variables:
- `KIMI_API_KEY` — Get from [platform.moonshot.ai](https://platform.moonshot.ai)
- `GITHUB_APP_ID` — Your GitHub App ID
- `GITHUB_PRIVATE_KEY` — GitHub App private key
- `GITHUB_WEBHOOK_SECRET` — Webhook secret

## Configuration

Create `.kimi-review.yml` in your repo root:

```yaml
language: en
model: kimi-k2-0905

review:
  auto:
    enabled: true
    drafts: false
  aspects:
    bugs: true
    security: true
    performance: true
  minSeverity: suggestion
  failOn: critical

files:
  exclude:
    - "**/generated/**"
    - "**/*.test.ts"

rules:
  - name: no-console-log
    description: "No console.log in production code"
    severity: warning

prompt:
  reviewFocus: "Focus on API input validation and SQL injection prevention"
```

## How It Works

```
PR Event → Extract Diff → Pack Context (256K) → Kimi API → Parse Response → GitHub Annotations
```

### Context Packing Strategy

| PR Size | Strategy | Description |
|---------|----------|-------------|
| Small (<50K tokens) | **Full** | All file contents + diff + dependencies |
| Medium (50-150K) | **Mixed** | Key files full, rest diff-only |
| Large (>150K) | **Chunked** | Split by module, merge results |

### Cost Optimization

Kimi's prefix caching reduces costs by 75%:
- First review of a PR: ~$0.05-0.10
- Subsequent pushes to same PR: ~$0.02-0.04 (prefix cache hit)
- Cache rate: $0.10/M tokens vs $0.39/M standard

## Architecture

```
src/
├── kimi/           # Kimi API client, prompt engineering, context packing
├── github/         # Webhooks, PR extraction, Checks API, comments
├── review/         # Orchestrator, diff analysis, file filtering
├── config/         # .kimi-review.yml schema and loader
└── utils/          # Logger, token estimation, errors
```

## Development

```bash
npm run dev          # Start dev server with hot reload
npm test             # Run tests
npm run build        # Build TypeScript
npm run build:action # Bundle GitHub Action
```

## License

MIT
