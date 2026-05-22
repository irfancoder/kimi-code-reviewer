import type { Octokit } from '@octokit/rest';
import type { ReviewConfig } from '../config/schema.js';
import type { ReviewAnnotation, ReviewResult, Severity, WalkthroughResult } from '../types/review.js';
import type { LLMProvider } from '../providers/interface.js';
import { packContext } from '../kimi/context-packer.js';
import { detectLanguages, detectFrameworks, buildDeepReviewMessages } from '../kimi/prompt-builder.js';
import { parseAIResponse } from '../kimi/response-parser.js';
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

      // Step 4: Detect languages and frameworks locally (no LLM call)
      const detectedLanguages = detectLanguages(prContext.changedFiles);
      const detectedFrameworks = detectFrameworks(prContext.fileContents);
      logger.info({ detectedLanguages, detectedFrameworks }, 'Languages and frameworks detected locally');

      // Step 5: Pack context — determines which file contents to include within 256K budget
      const packed = packContext(prContext, this.config);
      logger.info(
        { strategy: packed.strategy, totalTokens: packed.totalTokens, includedFiles: packed.includedFiles.length },
        'Context packed for review',
      );

      // Build a filtered fileContents map containing only the files selected by packContext.
      const packedFileContents = new Map<string, string>();
      for (const path of packed.includedFiles) {
        const content = prContext.fileContents.get(path);
        if (content) packedFileContents.set(path, content);
      }

      // Step 6: Single-pass review — walkthrough + deep review in one LLM call
      logger.info({ pullNumber }, 'Running single-pass review');
      // In chunked mode, use the budget-truncated diff instead of the full one
      const reviewContext = packed.truncatedDiff
        ? { ...prContext, diff: packed.truncatedDiff }
        : prContext;
      const messages = buildDeepReviewMessages(
        reviewContext, this.config, detectedLanguages, detectedFrameworks, packedFileContents,
      );

      const reviewResponse = await this.llm.chatCompletion({
        messages,
        responseFormat: { type: 'json_object' },
      });

      // Step 7: Parse review response — retry once if JSON extraction failed entirely
      let result = parseAIResponse(reviewResponse.content, reviewResponse.usage);
      let reviewUsage = reviewResponse.usage;
      if (result.parseError && reviewResponse.finishReason === 'length') {
        logger.warn(
          { pullNumber, completionTokens: reviewUsage.output },
          'Response truncated — output hit max_tokens limit, skipping retry',
        );
      } else if (result.parseError) {
        logger.warn({ pullNumber }, 'AI response JSON extraction failed, retrying');
        const retryResponse = await this.llm.chatCompletion({
          messages,
          responseFormat: { type: 'json_object' },
        });
        reviewUsage = sumTokenUsage(reviewResponse.usage, retryResponse.usage);
        result = parseAIResponse(retryResponse.content, reviewUsage);
      }

      result.tokensUsed = reviewUsage;

      // Step 8: Post walkthrough comment from the review result (non-blocking)
      if (this.config.walkthrough.enabled && (result.prSummary || result.walkthrough?.length)) {
        try {
          const walkthrough: WalkthroughResult = {
            prSummary: result.prSummary ?? '',
            walkthrough: result.walkthrough ?? [],
            detectedLanguages,
            detectedFrameworks,
            tokensUsed: { input: 0, output: 0, cached: 0 },
          };
          await createWalkthroughComment(this.octokit, {
            owner,
            repo,
            pullNumber,
            headSha,
            walkthrough,
            changedFilePaths: prContext.changedFiles.map((f) => f.filename),
          });
        } catch (err) {
          logger.warn({ err }, 'Failed to post walkthrough comment, continuing');
        }
      }

      // Step 9: Filter by minimum severity
      const minSeverityOrder = ['critical', 'warning', 'suggestion', 'nitpick'];
      const minIdx = minSeverityOrder.indexOf(this.config.review.minSeverity);
      result.annotations = result.annotations.filter(
        (a: ReviewAnnotation) => minSeverityOrder.indexOf(a.severity) <= minIdx,
      );

      // Step 10: Apply config-based suppressions
      result.annotations = applySuppressions(result.annotations, this.config.suppressions);

      // Step 11: Smart sort + truncate to maxAnnotations
      result.annotations = sortAndTruncateAnnotations(
        result.annotations,
        this.config.review.maxAnnotations,
      );

      // Recompute stats after all filtering
      const stats: Record<Severity, number> = { critical: 0, warning: 0, suggestion: 0, nitpick: 0 };
      for (const a of result.annotations) stats[a.severity]++;
      result.stats = stats;

      // Step 12: Determine conclusion
      const conclusion =
        this.config.review.failOn === 'critical' && result.stats.critical > 0
          ? 'failure'
          : this.config.review.failOn === 'warning' &&
              (result.stats.critical > 0 || result.stats.warning > 0)
            ? 'failure'
            : 'success';

      // Step 13: Update Check Run
      const summaryMd = buildSummary(result);
      await completeCheckRun(this.octokit, {
        owner, repo, checkRunId, conclusion,
        summary: summaryMd, annotations: result.annotations,
      });

      // Step 14: Create PR Review (inline comments)
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
          detectedLanguages,
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
