import { minimatch } from 'minimatch';
import type { ChangedFile } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import { logger } from '../utils/logger.js';

/**
 * Filter changed files based on include/exclude glob patterns from config.
 */
export function filterFiles(
  files: ChangedFile[],
  config: ReviewConfig,
): ChangedFile[] {
  const { include, exclude } = config.files;

  const filtered = files.filter((file) => {
    // Must match at least one include pattern
    const included = include.some((pattern) =>
      minimatch(file.filename, pattern, { dot: true }),
    );
    if (!included) return false;

    // Must not match any exclude pattern
    const excluded = exclude.some((pattern) =>
      minimatch(file.filename, pattern, { dot: true }),
    );
    if (excluded) return false;

    // Skip removed files (nothing to review)
    if (file.status === 'removed') return false;

    // Skip files without patches (binary files)
    if (!file.patch) return false;

    return true;
  });

  const skipped = files.length - filtered.length;
  if (skipped > 0) {
    logger.info({ total: files.length, filtered: filtered.length, skipped }, 'Files filtered');
  }

  return filtered;
}
