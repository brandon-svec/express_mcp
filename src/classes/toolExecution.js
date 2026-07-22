/**
 * ToolExecution class for managing tool execution context and logging
 */
export class ToolExecution {
  constructor(toolName, requestId, args) {
    this.toolName = toolName;
    this.requestId = requestId;
    this.args = args;
    this.startTime = process.hrtime.bigint();
    this.logData = {};
    this.status = null;
    this.result = null;
    this.errorData = {};
  }

  /**
   * Add structured data to the execution log
   * @param {Object} data - Structured data to add to logs
   */
  addLogData(data) {
    Object.assign(this.logData, data);
  }

  /**
   * Set the execution result
   * @param {*} result - The result of the tool execution
   */
  setResult(result) {
    this.result = result;
    // Auto-set status to success if not already set (unless it's an error)
    if (!this.status) {
      this.status = 'success';
    }
  }

  /**
   * Set the execution status
   * @param {string} status - Tool status: 'success' or 'error'
   */
  setStatus(status) {
    if (!['success', 'error'].includes(status)) {
      throw new Error(`Invalid status: ${status}. Must be 'success' or 'error'`);
    }
    this.status = status;
  }

  /**
   * Add error-specific data to the execution
   * @param {Object} errorData - Error-specific data to add
   */
  addErrorData(errorData) {
    this.status = 'error';
    Object.assign(this.errorData, errorData);
  }

  /**
   * Set error details for failed executions
   * @param {string} message - Error message
   * @param {number} [code] - Error code (defaults to -32603 for internal error)
   * @param {Object} [data] - Additional error data
   */
  setError(message, code = -32603, data = null) {
    this.status = 'error';
    this.errorData = {
      error: message,
      errorCode: code
    };
    if (data) {
      this.errorData.errorData = data;
    }
  }



  /**
   * Get error data for failed executions
   * @returns {Object} Error data object
   */
  getErrorData() {
    return this.errorData;
  }

  /**
   * Get the execution duration in milliseconds
   * @returns {number} Duration in milliseconds
   */
  getDuration() {
    const endTime = process.hrtime.bigint();
    return Math.ceil(Number(endTime - this.startTime) / 1000000);
  }

  /**
   * Get all log data including execution metadata
   * @returns {Object} Complete log data object with nested toolExecution
   */
  getLogData() {
    const result = {
      toolName: this.toolName,
      durationMs: this.getDuration(),
      toolExecution: {
        logData: this.logData
      }
    };

    if (this.status) {
      result.status = this.status;
    }

    return result;
  }

  /**
   * Reset the execution context for a new execution
   */
  reset() {
    this.startTime = process.hrtime.bigint();
    this.logData = {};
    this.status = null;
    this.result = null;
    this.errorData = {};
  }
}
