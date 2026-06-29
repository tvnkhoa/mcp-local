/**
 * Policy / guardrail violation. Carries a stable machine-readable `code` so tool
 * responses can surface a consistent error taxonomy (ported from codebase-index-mcp).
 */
export class PolicyViolationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "PolicyViolationError";
  }
}
