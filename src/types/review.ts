export type Severity = 'critical' | 'warning' | 'suggestion' | 'nitpick';

export interface WalkthroughFile {
  path: string;
  summary: string;
  changeType: 'added' | 'modified' | 'removed' | 'renamed';
}

export interface WalkthroughResult {
  prSummary: string;
  walkthrough: WalkthroughFile[];
  detectedLanguages: string[];
  detectedFrameworks: string[];
  tokensUsed: { input: number; output: number; cached: number };
}

export type AnnotationCategory =
  | 'bug'
  | 'security'
  | 'performance'
  | 'style'
  | 'best-practice'
  | 'documentation'
  | 'testing'
  | 'other';

export interface ReviewAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  severity: Severity;
  category: AnnotationCategory;
  title: string;
  body: string;
  suggestedFix?: string;
}

export interface ReviewResult {
  summary: string;
  score: number; // 0-100
  annotations: ReviewAnnotation[];
  stats: Record<Severity, number>;
  tokensUsed: {
    input: number;
    output: number;
    cached: number;
  };
  /** True when JSON could not be extracted from the LLM response at all — caller may retry. */
  parseError?: boolean;
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  patch?: string;
}

export interface PullRequestContext {
  owner: string;
  repo: string;
  pullNumber: number;
  baseSha: string;
  headSha: string;
  title: string;
  body: string;
  diff: string;
  changedFiles: ChangedFile[];
  fileContents: Map<string, string>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PackResult {
  messages: ChatMessage[];
  totalTokens: number;
  includedFiles: string[];
  truncatedFiles: string[];
  strategy: 'full' | 'mixed' | 'chunked';
}
