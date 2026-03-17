export declare class LLMApiError extends Error {
    statusCode: number;
    responseBody?: unknown | undefined;
    constructor(message: string, statusCode: number, responseBody?: unknown | undefined);
}
export declare class ConfigError extends Error {
    constructor(message: string);
}
export declare class ReviewError extends Error {
    phase: string;
    constructor(message: string, phase: string);
}
//# sourceMappingURL=errors.d.ts.map