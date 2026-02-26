export interface AppErrorShape {
  statusCode: number;
  message: string;
  code: string | undefined;
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export class AppError extends Error implements AppErrorShape {
  statusCode: number;
  code: string | undefined;

  constructor(statusCode: number, message: string, code?: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function createAppError(statusCode: number, message: string, code?: string): AppError {
  return new AppError(statusCode, message, code);
}
