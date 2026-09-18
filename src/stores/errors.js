/**
 * Thrown when no stored JWT exists for the given login context.
 */
export class ContextAuthRequiredError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'ContextAuthRequiredError';
  }
}

/**
 * Thrown when a Google IdP grant (refresh token + scopes) is missing or incomplete.
 * Hosts should surface an incremental-consent URL rather than inventing data.
 */
export class GoogleScopeGrantRequiredError extends Error {
  /**
   * @param {string} message
   * @param {{ sub?: string, missingScopes?: string[], reason?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'GoogleScopeGrantRequiredError';
    this.sub = details.sub;
    this.missingScopes = Array.isArray(details.missingScopes) ? details.missingScopes : [];
    this.reason = details.reason || 'no_grant';
  }
}
