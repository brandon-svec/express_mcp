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
