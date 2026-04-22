export function getHttpStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'status' in err && typeof (err as { status?: unknown }).status === 'number') {
    return (err as { status: number }).status;
  }
  return undefined;
}

export class LLMApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public responseBody?: unknown,
  ) {
    super(message);
    this.name = 'LLMApiError';
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class ReviewError extends Error {
  constructor(
    message: string,
    public phase: string,
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}
