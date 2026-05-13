export interface EmailParseResult {
  localPart: string;
  domain: string;
  displayName: string | null;
  isIpLiteral: boolean;
  isIPv6: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  normalized: string | null;
}

export interface ValidationError {
  code: string;
  message: string;
  position: number;
}

export interface EmailValidatorOptions {
  allowComments?: boolean;
  allowDisplayName?: boolean;
  maxLocalPartLength?: number;
  maxDomainLength?: number;
  maxTotalLength?: number;
}
