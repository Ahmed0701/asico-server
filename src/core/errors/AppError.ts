export type ErrorDetail = {
  path: string;
  message: string;
  // A machine-readable value for the client, when the message alone is not enough (the current version of a
  // record that someone else changed).
  value?: unknown;
};

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details: readonly ErrorDetail[] | undefined;

  constructor(statusCode: number, message: string, code = "APP_ERROR", details?: readonly ErrorDetail[]) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
