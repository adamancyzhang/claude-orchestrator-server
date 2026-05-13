export function isValidEmail(email: string): boolean {
  if (email.length > 254) return false;

  const atIndex = email.indexOf('@');
  if (atIndex === -1) return false;

  // Exactly one @
  if (email.indexOf('@', atIndex + 1) !== -1) return false;

  const localPart = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);

  // Non-empty local part
  if (localPart.length === 0) return false;

  // Domain must have at least one dot
  if (!domain.includes('.')) return false;

  // No whitespace — character-class-only regex, no quantifiers, zero backtracking risk
  if (/\s/.test(email)) return false;

  return true;
}
