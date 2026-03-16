import type { Octokit } from '@octokit/rest';
import type { Webhooks } from '@octokit/webhooks';
import { ReviewOrchestrator } from '../review/orchestrator.js';
import { loadConfig } from '../config/loader.js';
import { createLLMProvider } from '../providers/factory.js';
import { logger } from '../utils/logger.js';

interface AppContext {
  apiKey: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  getInstallationOctokit: (installationId: number) => Promise<Octokit>;
}

export function registerWebhooks(webhooks: Webhooks, appCtx: AppContext): void {
  // Auto-review on PR opened or new commits pushed
  webhooks.on(
    ['pull_request.opened', 'pull_request.synchronize'],
    async ({ payload }) => {
      const installationId = payload.installation?.id;
      if (!installationId) return;

      const octokit = await appCtx.getInstallationOctokit(installationId);
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const pullNumber = payload.pull_request.number;
      const headSha = payload.pull_request.head.sha;
      const isDraft = payload.pull_request.draft;

      logger.info({ owner, repo, pullNumber, action: payload.action }, 'PR event received');

      const config = await loadConfig(octokit, owner, repo);

      if (isDraft && !config.review.auto.drafts) {
        logger.info({ pullNumber }, 'Skipping draft PR');
        return;
      }

      if (!config.review.auto.enabled) return;
      if (payload.action === 'opened' && !config.review.auto.onOpen) return;
      if (payload.action === 'synchronize' && !config.review.auto.onPush) return;

      const llm = createLLMProvider({
        apiKey: appCtx.apiKey,
        provider: appCtx.provider ?? config.provider,
        model: appCtx.model ?? config.model,
        baseUrl: appCtx.baseUrl ?? config.baseUrl,
      });

      const orchestrator = new ReviewOrchestrator(octokit, llm, config);
      await orchestrator.reviewPullRequest({ owner, repo, pullNumber, headSha });
    },
  );

  // @fiscalcr mention in PR/issue comments
  webhooks.on(['issue_comment.created'], async ({ payload }) => {
    const body = payload.comment.body;
    if (!body.includes('@fiscalcr')) return;
    if (!payload.issue.pull_request) return;

    const installationId = payload.installation?.id;
    if (!installationId) return;

    const octokit = await appCtx.getInstallationOctokit(installationId);
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const pullNumber = payload.issue.number;

    logger.info({ owner, repo, pullNumber }, '@fiscalcr mention detected');

    const command = parseFiscalCRCommand(body);

    if (command === 'review') {
      const config = await loadConfig(octokit, owner, repo);
      const llm = createLLMProvider({
        apiKey: appCtx.apiKey,
        provider: appCtx.provider ?? config.provider,
        model: appCtx.model ?? config.model,
        baseUrl: appCtx.baseUrl ?? config.baseUrl,
      });

      const { data: pr } = await octokit.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      });

      const orchestrator = new ReviewOrchestrator(octokit, llm, config);
      await orchestrator.reviewPullRequest({
        owner,
        repo,
        pullNumber,
        headSha: pr.head.sha,
      });
    } else if (command === 'help') {
      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: [
          '## FiscalCR Commands\n',
          '| Command | Description |',
          '|---------|-------------|',
          '| `@fiscalcr review` | Run a full code review on this PR |',
          '| `@fiscalcr help` | Show this help message |',
          '\nPowered by FiscalCR — model-agnostic AI code review.',
        ].join('\n'),
      });
    }
  });

  // Review request
  webhooks.on('pull_request.review_requested', async ({ payload }) => {
    const installationId = payload.installation?.id;
    if (!installationId) return;

    const octokit = await appCtx.getInstallationOctokit(installationId);
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const pullNumber = payload.pull_request.number;
    const headSha = payload.pull_request.head.sha;

    const config = await loadConfig(octokit, owner, repo);
    if (!config.review.auto.onReviewRequest) return;

    logger.info({ owner, repo, pullNumber }, 'Review requested');

    const llm = createLLMProvider({
      apiKey: appCtx.apiKey,
      provider: appCtx.provider ?? config.provider,
      model: appCtx.model ?? config.model,
      baseUrl: appCtx.baseUrl ?? config.baseUrl,
    });

    const orchestrator = new ReviewOrchestrator(octokit, llm, config);
    await orchestrator.reviewPullRequest({ owner, repo, pullNumber, headSha });
  });
}

function parseFiscalCRCommand(body: string): 'review' | 'help' | 'unknown' {
  const match = body.match(/@fiscalcr\s+(\w+)/i);
  if (!match) return 'review';
  const cmd = match[1].toLowerCase();
  if (cmd === 'review') return 'review';
  if (cmd === 'help') return 'help';
  return 'unknown';
}
