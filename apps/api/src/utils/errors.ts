export class AppError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly code = 'REQUEST_FAILED') {
    super(message);
    this.name = 'AppError';
  }
}
export const badRequest = (message: string, code?: string) => new AppError(400, message, code);
export const unauthorized = (message = 'Authentication required') => new AppError(401, message, 'UNAUTHENTICATED');
export const forbidden = (message = 'You do not have permission to perform this action') => new AppError(403, message, 'FORBIDDEN');
export const notFound = (message = 'Resource not found') => new AppError(404, message, 'NOT_FOUND');
export const conflict = (message: string) => new AppError(409, message, 'CONFLICT');
export const tooMany = (message: string) => new AppError(429, message, 'RATE_LIMITED');
export const unavailable = (message: string) => new AppError(503, message, 'SERVICE_UNAVAILABLE');
