import type { Octokit } from '@octokit/rest';
import type { ReviewConfig } from '../config/schema.js';
import type { ReviewAnnotation, ReviewResult, Severity, WalkthroughResult } from '../types/review.js';
import type { LLMProvider } from '../providers/interface.js';
import { packContext } from '../kimi/context-packer.js';
import { detectLanguages, buildWalkthroughMessages, buildDeepReviewMessages } from '../kimi/prompt-builder.js';
import { parseAIResponse, parseWalkthroughResponse } from '../kimi/response-parser.js';
import { extractPullRequestContext } from '../github/pulls.js';
import { createCheckRun, completeCheckRun } from '../github/checks.js';
import { createPRReview, createWalkthroughComment } from '../github/comments.js';
import { filterFiles } from './file-filter.js';
import { buildSummary } from './summary-builder.js';
import { applySuppressions, sortAndTruncateAnnotations } from './annotation-utils.js';
import { sumTokenUsage } from '../utils/tokens.js';
import { ReviewError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

interface ReviewParams {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
}

export class ReviewOrchestrator {
  constructor(
    private octokit: Octokit,
    private llm: LLMProvider,
    private config: ReviewConfig,
  ) {}

  async reviewPullRequest(params: ReviewParams): Promise<ReviewResult> {
    const { owner, repo, pullNumber, headSha } = params;

    // Step 1: Create Check Run
    const checkRunId = await createCheckRun(this.octokit, { owner, repo, headSha });

    try {
      // Step 2: Extract PR context
      logger.info({ pullNumber }, 'Extracting PR context');
      const prContext = await extractPullRequestContext(
        this.octokit,
        owner,
        repo,
        pullNumber,
        this.config,
      );

      // Step 3: Filter files
      const filteredFiles = filterFiles(prContext.changedFiles, this.config);
      prContext.changedFiles = filteredFiles;

      if (filteredFiles.length === 0) {
        const result: ReviewResult = {
          summary: 'No reviewable files in this PR (all files matched exclude patterns).',
          score: 100,
          annotations: [],
          stats: { critical: 0, warning: 0, suggestion: 0, nitpick: 0 },
          tokensUsed: { input: 0, output: 0, cached: 0 },
        };
        await completeCheckRun(this.octokit, {
          owner, repo, checkRunId, conclusion: 'success',
          summary: result.summary, annotations: [],
        });
        return result;
      }

      // Step 4: Detect languages from file extensions (pure, no API call)
      const extensionLanguages = detectLanguages(prContext.changedFiles);
      logger.info({ extensionLanguages }, 'Languages detected from extensions');

      // Step 5: Pass 1 — Walkthrough (understand PR intent, detect frameworks)
      // Can be disabled via config.walkthrough.enabled = false to save cost/latency.
      let walkthrough: WalkthroughResult;

      if (this.config.walkthrough.enabled) {
        logger.info({ pullNumber }, 'Running walkthrough pass (Pass 1)');
        try {
          const walkthroughMessages = buildWalkthroughMessages(prContext);
          const walkthroughResponse = await this.llm.chatCompletion({
            messages: walkthroughMessages,
            responseFormat: { type: 'json_object' },
          });
          walkthrough = parseWalkthroughResponse(
            walkthroughResponse.content,
            walkthroughResponse.usage,
          );
          // Supplement with extension-based detection for any language the model missed
          for (const lang of extensionLanguages) {
            if (!walkthrough.detectedLanguages.includes(lang)) {
              walkthrough.detectedLanguages.push(lang);
            }
          }
          logger.info(
            { detectedLanguages: walkthrough.detectedLanguages, detectedFrameworks: walkthrough.detectedFrameworks },
            'Walkthrough pass complete',
          );
        } catch (err) {
          logger.warn({ err }, 'Walkthrough pass failed, falling back to extension-based detection');
          walkthrough = {
            prSummary: '',
            walkthrough: [],
            detectedLanguages: extensionLanguages,
            detectedFrameworks: [],
            tokensUsed: { input: 0, output: 0, cached: 0 },
          };
        }

        // Step 6: Post/update walkthrough comment (non-blocking)
        await createWalkthroughComment(this.octokit, {
          owner,
          repo,
          pullNumber,
          headSha,
          walkthrough,
          changedFilePaths: prContext.changedFiles.map((f) => f.filename),
        });
      } else {
        logger.info({ pullNumber }, 'Walkthrough pass disabled, using extension-based detection');
        walkthrough = {
          prSummary: '',
          walkthrough: [],
          detectedLanguages: extensionLanguages,
          detectedFrameworks: [],
          tokensUsed: { input: 0, output: 0, cached: 0 },
        };
      }

      // Step 7: Pack context — determines which file contents to include within 256K budget
      const packed = packContext(prContext, this.config);
      logger.info(
        { strategy: packed.strategy, totalTokens: packed.totalTokens, includedFiles: packed.includedFiles.length },
        'Context packed for Pass 2',
      );

      // Build a filtered fileContents map containing only the files selected by packContext.
      // For large PRs (mixed/chunked strategy) this prevents blowing the token budget.
      const packedFileContents = new Map<string, string>();
      for (const path of packed.includedFiles) {
        const content = prContext.fileContents.get(path);
        if (content) packedFileContents.set(path, content);
      }

      // Step 8: Pass 2 — Deep review using walkthrough context + budget-respecting file contents
      logger.info({ pullNumber }, 'Running deep review pass (Pass 2)');
      const messages = buildDeepReviewMessages(prContext, this.config, walkthrough, packedFileContents);

      const reviewResponse = await this.llm.chatCompletion({
        messages,
        responseFormat: { type: 'json_object' },
      });

      // Step 9: Parse review response — retry once if JSON extraction failed entirely
      let result = parseAIResponse(reviewResponse.content, reviewResponse.usage);
      let reviewUsage = reviewResponse.usage;
      if (result.parseError) {
        logger.warn({ pullNumber }, 'AI response JSON extraction failed, retrying deep review pass');
        const retryResponse = await this.llm.chatCompletion({
          messages,
          responseFormat: { type: 'json_object' },
        });
        reviewUsage = sumTokenUsage(reviewResponse.usage, retryResponse.usage);
        result = parseAIResponse(retryResponse.content, reviewUsage);
      }

      // Merge token usage from both passes into the result
      result.tokensUsed = sumTokenUsage(walkthrough.tokensUsed, reviewUsage);

      // Step 10: Filter by minimum severity
      const minSeverityOrder = ['critical', 'warning', 'suggestion', 'nitpick'];
      const minIdx = minSeverityOrder.indexOf(this.config.review.minSeverity);
      result.annotations = result.annotations.filter(
        (a: ReviewAnnotation) => minSeverityOrder.indexOf(a.severity) <= minIdx,
      );

      // Step 11: Apply config-based suppressions
      result.annotations = applySuppressions(result.annotations, this.config.suppressions);

      // Step 12: Smart sort + truncate to maxAnnotations
      result.annotations = sortAndTruncateAnnotations(
        result.annotations,
        this.config.review.maxAnnotations,
      );

      // Recompute stats after all filtering
      const stats: Record<Severity, number> = { critical: 0, warning: 0, suggestion: 0, nitpick: 0 };
      for (const a of result.annotations) stats[a.severity]++;
      result.stats = stats;

      // Step 13: Determine conclusion
      const conclusion =
        this.config.review.failOn === 'critical' && result.stats.critical > 0
          ? 'failure'
          : this.config.review.failOn === 'warning' &&
              (result.stats.critical > 0 || result.stats.warning > 0)
            ? 'failure'
            : 'success';

      // Step 14: Update Check Run
      const summaryMd = buildSummary(result);
      await completeCheckRun(this.octokit, {
        owner, repo, checkRunId, conclusion,
        summary: summaryMd, annotations: result.annotations,
      });

      // Step 15: Create PR Review (inline comments)
      await createPRReview(this.octokit, {
        owner,
        repo,
        pullNumber,
        commitSha: headSha,
        result,
        failOn: this.config.review.failOn,
        provider: this.config.provider,
        model: this.config.model,
        baseUrl: this.config.baseUrl,
      });

      logger.info(
        {
          pullNumber,
          score: result.score,
          annotations: result.annotations.length,
          conclusion,
          contextStrategy: packed.strategy,
          detectedLanguages: walkthrough.detectedLanguages,
        },
        'Review completed',
      );

      return result;
    } catch (err) {
      logger.error({ err, pullNumber }, 'Review failed');
      await completeCheckRun(this.octokit, {
        owner, repo, checkRunId, conclusion: 'failure',
        summary: `Review failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        annotations: [],
      });
      throw new ReviewError(
        err instanceof Error ? err.message : 'Unknown error',
        'orchestration',
      );
    }
  }
}
