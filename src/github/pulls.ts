import type { Octokit } from '@octokit/rest';
import type { PullRequestContext, ChangedFile } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import { logger } from '../utils/logger.js';

export async function extractPullRequestContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  config: ReviewConfig,
): Promise<PullRequestContext> {
  // Fetch PR metadata
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });

  // Fetch changed files list
  const files: ChangedFile[] = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });
    if (data.length === 0) break;
    for (const f of data) {
      files.push({
        filename: f.filename,
        status: f.status as ChangedFile['status'],
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      });
    }
    if (data.length < 100) break;
    page++;
  }

  // Fetch the unified diff
  const { data: diff } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
    mediaType: { format: 'diff' },
  }) as unknown as { data: string };

  // Fetch full file contents for context (head version)
  const fileContents = new Map<string, string>();
  const maxFileSize = config.files.maxFileSize;

  for (const file of files) {
    if (file.status === 'removed') continue;

    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path: file.filename,
        ref: pr.head.sha,
      });

      if ('content' in data && data.encoding === 'base64') {
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        if (content.length <= maxFileSize) {
          fileContents.set(file.filename, content);
        }
      }
    } catch (err) {
      logger.debug({ file: file.filename, err }, 'Could not fetch file content');
    }
  }

  logger.info(
    { filesCount: files.length, fileContentsCount: fileContents.size, diffLength: (diff as string).length },
    'PR context extracted',
  );

  return {
    owner,
    repo,
    pullNumber,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    title: pr.title,
    body: pr.body ?? '',
    diff: diff as string,
    changedFiles: files,
    fileContents,
  };
}
