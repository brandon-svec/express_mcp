import { assert } from 'chai';
import { ToolExecution } from '../../src/classes/toolExecution.js';

describe('ToolExecution', () => {
  let execution;
  const toolName = 'test-tool';
  const requestId = 'req-123';
  const args = { param: 'value' };

  beforeEach(() => {
    execution = new ToolExecution(toolName, requestId, args);
  });

  describe('constructor', () => {
    it('should initialize with required properties', () => {
      assert.strictEqual(execution.toolName, toolName);
      assert.strictEqual(execution.requestId, requestId);
      assert.deepStrictEqual(execution.args, args);
      assert.isObject(execution.logData);
      assert.isEmpty(execution.logData);
      assert.isNull(execution.status);
      assert.isNull(execution.result);
    });

    it('should set start time', () => {
      assert.strictEqual(typeof execution.startTime, 'bigint');
      assert.isTrue(execution.startTime > 0n);
    });
  });

  describe('addLogData', () => {
    it('should add log data to the execution', () => {
      const data = { key: 'value', count: 42 };
      execution.addLogData(data);
      
      assert.deepStrictEqual(execution.logData, data);
    });

    it('should merge multiple log data calls', () => {
      execution.addLogData({ key1: 'value1' });
      execution.addLogData({ key2: 'value2' });
      execution.addLogData({ key1: 'updated' }); // Should overwrite
      
      assert.deepStrictEqual(execution.logData, {
        key1: 'updated',
        key2: 'value2'
      });
    });

    it('should handle nested objects', () => {
      execution.addLogData({
        metrics: {
          cpu: 80,
          memory: 1024
        }
      });
      
      execution.addLogData({
        metrics: {
          disk: 512
        },
        status: 'processing'
      });
      
      assert.deepStrictEqual(execution.logData, {
        metrics: {
          disk: 512 // Object replacement, not merge
        },
        status: 'processing'
      });
    });
  });

  describe('setResult', () => {
    it('should set string result', () => {
      const result = 'test result';
      execution.setResult(result);
      
      assert.strictEqual(execution.result, result);
    });

    it('should set object result', () => {
      const result = { data: [1, 2, 3], status: 'success' };
      execution.setResult(result);
      
      assert.deepStrictEqual(execution.result, result);
    });

    it('should set null result', () => {
      execution.setResult(null);
      
      assert.isNull(execution.result);
    });

    it('should overwrite previous result', () => {
      execution.setResult('first');
      execution.setResult('second');
      
      assert.strictEqual(execution.result, 'second');
    });
  });

  describe('setStatus', () => {
    it('should set valid status values', () => {
      const validStatuses = ['success', 'error'];
      
      validStatuses.forEach(status => {
        execution.setStatus(status);
        assert.strictEqual(execution.status, status);
      });
    });

    it('should throw error for invalid status', () => {
      const invalidStatuses = ['pending', 'running', 'completed', 'failed', 'failure'];
      
      invalidStatuses.forEach(status => {
        assert.throws(
          () => execution.setStatus(status),
          Error,
          `Invalid status: ${status}. Must be 'success' or 'error'`
        );
      });
    });

    it('should throw error for null status', () => {
      assert.throws(
        () => execution.setStatus(null),
        Error,
        'Invalid status: null'
      );
    });

    it('should throw error for undefined status', () => {
      assert.throws(
        () => execution.setStatus(undefined),
        Error,
        'Invalid status: undefined'
      );
    });
  });

  describe('addErrorData', () => {
    it('should add error data to the execution', () => {
      execution.addErrorData({ errorType: 'validation', details: 'Invalid input' });
      
      const errorData = execution.getErrorData();
      assert.strictEqual(errorData.errorType, 'validation');
      assert.strictEqual(errorData.details, 'Invalid input');
    });

    it('should merge multiple error data calls', () => {
      execution.addErrorData({ errorType: 'validation' });
      execution.addErrorData({ details: 'Invalid input', code: 123 });
      
      const errorData = execution.getErrorData();
      assert.strictEqual(errorData.errorType, 'validation');
      assert.strictEqual(errorData.details, 'Invalid input');
      assert.strictEqual(errorData.code, 123);
    });
  });

  describe('setError', () => {
    it('should set error details and status', () => {
      execution.setError('Something went wrong', -32603);
      
      assert.strictEqual(execution.status, 'error');
      const errorData = execution.getErrorData();
      assert.strictEqual(errorData.error, 'Something went wrong');
      assert.strictEqual(errorData.errorCode, -32603);
    });

    it('should set error with additional data', () => {
      const additionalData = { stack: 'Error stack trace', context: 'operation' };
      execution.setError('Execution failed', -32603, additionalData);
      
      assert.strictEqual(execution.status, 'error');
      const errorData = execution.getErrorData();
      assert.strictEqual(errorData.error, 'Execution failed');
      assert.strictEqual(errorData.errorCode, -32603);
      assert.deepStrictEqual(errorData.errorData, additionalData);
    });

    it('should use default error code when not provided', () => {
      execution.setError('Default error');
      
      assert.strictEqual(execution.status, 'error');
      const errorData = execution.getErrorData();
      assert.strictEqual(errorData.error, 'Default error');
      assert.strictEqual(errorData.errorCode, -32603);
    });
  });



  describe('getErrorData', () => {
    it('should return empty object when no error data set', () => {
      const errorData = execution.getErrorData();
      assert.deepStrictEqual(errorData, {});
    });

    it('should return error data when set via addErrorData', () => {
      execution.addErrorData({ type: 'test', message: 'error' });
      
      const errorData = execution.getErrorData();
      assert.strictEqual(errorData.type, 'test');
      assert.strictEqual(errorData.message, 'error');
    });

    it('should return error data when set via setError', () => {
      execution.setError('Test error', -32500);
      
      const errorData = execution.getErrorData();
      assert.strictEqual(errorData.error, 'Test error');
      assert.strictEqual(errorData.errorCode, -32500);
    });
  });

  describe('getDuration', () => {
    it('should return duration in milliseconds', () => {
      const duration = execution.getDuration();
      
      assert.isNumber(duration);
      assert.isTrue(duration >= 0);
    });

    it('should increase over time', async () => {
      const duration1 = execution.getDuration();
      
      // Wait a small amount of time
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const duration2 = execution.getDuration();
      
      assert.isTrue(duration2 > duration1);
    });

    it('should return whole numbers (ceiled)', () => {
      const duration = execution.getDuration();
      
      assert.strictEqual(duration, Math.ceil(duration));
    });
  });

  describe('getLogData', () => {
    it('should return basic log data with metadata at parent level', () => {
      const logData = execution.getLogData();
      
      assert.property(logData, 'toolName');
      assert.property(logData, 'durationMs');
      assert.property(logData, 'toolExecution');
      assert.property(logData.toolExecution, 'logData');
      assert.strictEqual(logData.toolName, toolName);
      assert.isNumber(logData.durationMs);
    });

    it('should include custom log data in nested structure', () => {
      execution.addLogData({ custom: 'value', count: 123 });
      
      const logData = execution.getLogData();
      
      assert.strictEqual(logData.toolExecution.logData.custom, 'value');
      assert.strictEqual(logData.toolExecution.logData.count, 123);
    });

    it('should include status when set', () => {
      execution.setStatus('success');
      
      const logData = execution.getLogData();
      
      assert.property(logData, 'status');
      assert.strictEqual(logData.status, 'success');
    });

    it('should not include status when not set', () => {
      const logData = execution.getLogData();
      
      assert.notProperty(logData, 'status');
    });

    it('should merge all data properly', () => {
      execution.addLogData({ 
        operation: 'test',
        metrics: { cpu: 80 }
      });
      execution.setStatus('success');
      
      const logData = execution.getLogData();
      
      assert.deepStrictEqual(logData, {
        toolName: toolName,
        durationMs: logData.durationMs, // Dynamic value
        status: 'success',
        toolExecution: {
          logData: {
            operation: 'test',
            metrics: { cpu: 80 }
          }
        }
      });
    });
  });

  describe('reset', () => {
    beforeEach(() => {
      // Setup execution with data
      execution.addLogData({ key: 'value' });
      execution.setStatus('success');
      execution.setResult('test result');
    });

    it('should reset all data', () => {
      execution.reset();
      
      assert.isEmpty(execution.logData);
      assert.isEmpty(execution.errorData);
      assert.isNull(execution.status);
      assert.isNull(execution.result);
    });

    it('should reset start time', async () => {
      const originalStartTime = execution.startTime;
      
      // Wait a bit to ensure time difference
      await new Promise(resolve => setTimeout(resolve, 1));
      
      execution.reset();
      
      assert.notStrictEqual(execution.startTime, originalStartTime);
      assert.isTrue(execution.startTime > originalStartTime);
    });

    it('should preserve tool name, request ID, and args', () => {
      execution.reset();
      
      assert.strictEqual(execution.toolName, toolName);
      assert.strictEqual(execution.requestId, requestId);
      assert.deepStrictEqual(execution.args, args);
    });

    it('should reset duration calculation', async () => {
      // Wait to accumulate some duration
      await new Promise(resolve => setTimeout(resolve, 5));
      const durationBefore = execution.getDuration();
      
      execution.reset();
      
      const durationAfter = execution.getDuration();
      
      // Duration after reset should be much smaller (close to 0)
      assert.isTrue(durationAfter <= durationBefore);
      assert.isTrue(durationAfter < 5); // Should be much less than 5ms
    });
  });

  describe('integration scenarios', () => {
    it('should handle successful tool execution flow', () => {
      // Simulate successful execution
      execution.addLogData({ operation: 'data_processing' });
      execution.addLogData({ itemsProcessed: 100 });
      execution.setStatus('success');
      execution.setResult({ processed: 100, status: 'complete' });
      
      const logData = execution.getLogData();
      
      assert.strictEqual(logData.toolExecution.logData.operation, 'data_processing');
      assert.strictEqual(logData.toolExecution.logData.itemsProcessed, 100);
      assert.strictEqual(logData.status, 'success');
      assert.deepStrictEqual(execution.result, { processed: 100, status: 'complete' });
    });

    it('should handle failed tool execution flow', () => {
      // Simulate failed execution
      execution.addLogData({ operation: 'data_processing' });
      execution.setError('Processing failed', -32603, {
        stack: 'Error stack trace'
      });
      
      const logData = execution.getLogData();
      const errorData = execution.getErrorData();
      
      assert.strictEqual(logData.toolExecution.logData.operation, 'data_processing');
      assert.strictEqual(errorData.error, 'Processing failed');
      assert.strictEqual(errorData.errorCode, -32603);
      assert.strictEqual(errorData.errorData.stack, 'Error stack trace');
      assert.strictEqual(logData.status, 'error');
      assert.isNull(execution.result); // No result set on error
    });

    it('should handle validation error flow', () => {
      // Simulate validation error
      execution.setError('Validation failed: Property "email" must be string', -32602, {
        validationErrors: [
          { property: 'email', message: 'must be string' }
        ]
      });
      
      const logData = execution.getLogData();
      const errorData = execution.getErrorData();
      
      assert.strictEqual(errorData.errorCode, -32602);
      assert.strictEqual(errorData.error, 'Validation failed: Property "email" must be string');
      assert.strictEqual(logData.status, 'error');
      assert.property(errorData.errorData, 'validationErrors');
      assert.isArray(errorData.errorData.validationErrors);
    });
  });
});
