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
