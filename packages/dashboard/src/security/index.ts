export {
  createApiKeyAuth,
  sendApiKeyUnauthorized,
  type ApiKeyConfig,
  type ApiKeyResult,
} from "./api-key-auth.js";

export {
  escapeHtml,
  sanitizeString,
  matchesPattern,
  isValidLength,
  isSafeIdentifier,
  isValidPath,
  isValidVersion,
  truncateString,
  isPayloadSizeValid,
  validateJsonStructure,
  type BodyValidationConfig,
} from "./input-validation.js";

export {
  createAuditLogger,
  type AuditEventType,
  type AuditEntry,
  type AuditLogFn,
  type AuditLoggerConfig,
  type AuditLogger,
} from "./audit-log.js";
