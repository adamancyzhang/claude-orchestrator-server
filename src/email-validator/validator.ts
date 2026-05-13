import type { EmailValidatorOptions, ValidationResult, ValidationError } from "./types.js";
import { parseEmail } from "./parser.js";
import { validateLocalPart } from "./local-part.js";
import { validateDomain } from "./domain.js";

const DEFAULTS: Required<EmailValidatorOptions> = {
  allowComments: false,
  allowDisplayName: true,
  maxLocalPartLength: 64,
  maxDomainLength: 255,
  maxTotalLength: 254,
};

export class EmailValidator {
  private options: Required<EmailValidatorOptions>;

  constructor(options?: EmailValidatorOptions) {
    this.options = { ...DEFAULTS, ...options };
  }

  validate(email: string): ValidationResult {
    const errors: ValidationError[] = [];

    if (typeof email !== "string" || email.trim().length === 0) {
      errors.push({
        code: "ERR_EMPTY_INPUT",
        message: "Input is empty or whitespace-only",
        position: 0,
      });
      return { valid: false, errors, normalized: null };
    }

    const parseResult = parseEmail(email.trim(), this.options);
    if (!parseResult.ok) {
      return { valid: false, errors: [parseResult.error], normalized: null };
    }

    const { localPart, domain, isIpLiteral, isIPv6 } = parseResult.value;

    const localErrors = validateLocalPart(localPart, this.options.maxLocalPartLength);
    errors.push(...localErrors);

    const domainErrors = validateDomain(domain, isIpLiteral, isIPv6, this.options.maxDomainLength);
    errors.push(...domainErrors);

    if (errors.length > 0) {
      return { valid: false, errors, normalized: null };
    }

    const normalized = `${localPart}@${domain.toLowerCase()}`;

    return { valid: true, errors: [], normalized };
  }

  isValid(email: string): boolean {
    return this.validate(email).valid;
  }

  normalize(email: string): string | null {
    return this.validate(email).normalized;
  }

  getOptions(): Readonly<Required<EmailValidatorOptions>> {
    return { ...this.options };
  }
}
