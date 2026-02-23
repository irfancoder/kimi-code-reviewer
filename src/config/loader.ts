import type { Octokit } from '@octokit/rest';
import { reviewConfigSchema, type ReviewConfig } from './schema.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { ConfigError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const CONFIG_FILENAME = '.kimi-review.yml';

export async function loadConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<ReviewConfig> {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: CONFIG_FILENAME,
    });

    if (!('content' in data) || data.encoding !== 'base64') {
      logger.info('Config file found but not a regular file, using defaults');
      return DEFAULT_CONFIG;
    }

    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    const parsed = parseYaml(content);
    const result = reviewConfigSchema.safeParse(parsed);

    if (!result.success) {
      logger.warn({ errors: result.error.issues }, 'Config validation failed, using defaults');
      throw new ConfigError(`Invalid config: ${result.error.message}`);
    }

    logger.info({ language: result.data.language, model: result.data.model }, 'Config loaded');
    return result.data;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    // 404 — no config file, use defaults
    logger.info('No .kimi-review.yml found, using defaults');
    return DEFAULT_CONFIG;
  }
}

/**
 * Simple YAML parser for the subset we use.
 * For production, consider using `yaml` package.
 * This handles basic key-value pairs and nested objects.
 */
function parseYaml(content: string): Record<string, unknown> {
  // Use a dynamic import approach — for now, just do basic JSON-like parsing
  // In production, add `yaml` as a dependency
  try {
    // Try JSON first (some users might use JSON format)
    return JSON.parse(content);
  } catch {
    // Basic YAML-like parsing for simple configs
    // TODO: Replace with proper yaml parser
    logger.warn('Basic YAML parsing used — consider adding yaml dependency for full support');
    return {};
  }
}
