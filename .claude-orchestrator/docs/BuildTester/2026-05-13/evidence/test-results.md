# Evidence: Test Results

**Date**: 2026-05-13
**Command**: `npx tsx` via ESM import

## Acceptance Criteria Tests

| Test Case | Expected | Actual | Pass |
|-----------|----------|--------|------|
| `test@example.com` | true | true | ✓ |
| `not-an-email` | false | false | ✓ |

## Edge Case Tests

| Test Case | Expected | Actual | Pass |
|-----------|----------|--------|------|
| empty string `''` | false | false | ✓ |
| double @ `a@b@c.com` | false | false | ✓ |
| no dot in domain `a@bcd` | false | false | ✓ |
| whitespace `test @example.com` | false | false | ✓ |
| 254-char email | true | true | ✓ |
| 255-char email | false | false | ✓ |
| `user@domain.com` | true | true | ✓ |
| `a@b.c` | true | true | ✓ |
| `user+tag@sub.domain.co` | true | true | ✓ |
| special chars local `special!#$%local@domain.com` | true | true | ✓ |

## Summary

- **Passed**: 12/12
- **Failed**: 0
