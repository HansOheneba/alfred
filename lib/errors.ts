export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type SheetsErrorCode =
  | "permission"
  | "credentials"
  | "not_found"
  | "headers"
  | "unavailable"
  | "verify"
  | "missing_row";

export class SheetsError extends Error {
  readonly code: SheetsErrorCode;

  constructor(code: SheetsErrorCode, message: string) {
    super(message);
    this.name = "SheetsError";
    this.code = code;
  }
}

export type AiErrorCode = "timeout" | "rate_limit" | "invalid" | "unavailable";

export class AiError extends Error {
  readonly code: AiErrorCode;

  constructor(code: AiErrorCode, message: string) {
    super(message);
    this.name = "AiError";
    this.code = code;
  }
}

export class AuthError extends Error {
  constructor(message = "That record isn't available in this chat.") {
    super(message);
    this.name = "AuthError";
  }
}

export class DatabaseError extends Error {
  constructor(message = "The ledger is temporarily unavailable.") {
    super(message);
    this.name = "DatabaseError";
  }
}
