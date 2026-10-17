import {
  generateTraceId,
  generateSpanId,
  parseTraceparent,
  serializeTraceparent,
} from './traceContext.js';
import { sanitizeToAttributeString } from './sanitizer.js';
import { BatchSpanQueue } from './batchSpanQueue.js';
import { OtlpSender, attributesToOtlp } from './otlpSender.js';

const SPAN_KIND_INTERNAL = 1;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

/**
 * @returns {string} unix nano as decimal string
 */
function nowUnixNano() {
  return String(BigInt(Date.now()) * 1000000n);
}

/**
 * Active span handle returned by start* methods.
 * @typedef {Object} ActiveSpan
 * @property {string} traceId
 * @property {string} spanId
 * @property {string|null} parentSpanId
 * @property {string} name
 * @property {string} startTimeUnixNano
 * @property {Record<string, string|number|boolean>} attributes
 * @property {string} [traceparent]
 */

/**
 * Orchestrates GenAI / OpenInference spans and batched OTLP export.
 */
export class TelemetryEngine {
  /**
   * @param {Object} options
   * @param {Object} options.config - normalized enabled telemetry config
   * @param {string} options.packageVersion
   * @param {{ debug?: Function, warn?: Function }|null} [options.logger]
   * @param {OtlpSender} [options.sender] - injectable for tests
   * @param {BatchSpanQueue} [options.queue] - injectable for tests
   */
  constructor(options) {
    if (!options || !options.config || options.config.enabled !== true) {
      throw new Error('TelemetryEngine requires an enabled telemetry config');
    }
    if (typeof options.packageVersion !== 'string' || !options.packageVersion) {
      throw new Error('packageVersion is required');
    }

    this.config = options.config;
    this.logger = options.logger ?? null;
    this.packageVersion = options.packageVersion;

    this.sender = options.sender ?? new OtlpSender({
      endpoint: this.config.endpoint,
      protocol: this.config.protocol,
      headers: this.config.headers,
      serviceName: this.config.serviceName,
      scopeName: 'express_mcp',
      scopeVersion: this.packageVersion,
      maxSockets: this.config.maxSockets,
      keepAliveTimeoutMs: this.config.keepAliveTimeoutMs,
      maxRetries: this.config.maxRetries,
      requestTimeoutMs: this.config.requestTimeoutMs,
      logger: this.logger,
    });

    this.queue = options.queue ?? new BatchSpanQueue({
      batchMaxSpans: this.config.batchMaxSpans,
      batchTimeoutMs: this.config.batchTimeoutMs,
      maxQueueSize: this.config.maxQueueSize,
      exportBatch: (spans) => this.sender.send(spans),
      logger: this.logger,
    });
  }

  /**
   * @param {string|null|undefined} traceparentHeader
   * @returns {{ traceId: string, parentSpanId: string|null }}
   * @private
   */
  _resolveParent(traceparentHeader) {
    const parsed = parseTraceparent(traceparentHeader);
    if (parsed) {
      return { traceId: parsed.traceId, parentSpanId: parsed.spanId };
    }
    return { traceId: generateTraceId(), parentSpanId: null };
  }

  /**
   * Start a TOOL span for an MCP tool call.
   * @param {Object} params
   * @param {string} params.toolName
   * @param {string|null} [params.sessionId]
   * @param {string|null} [params.traceparent]
   * @param {object|null} [params.user]
   * @param {unknown} [params.args]
   * @returns {ActiveSpan|null}
   */
  startToolSpan(params) {
    try {
      const { traceId, parentSpanId } = this._resolveParent(params.traceparent);
      const spanId = generateSpanId();
      /** @type {Record<string, string|number|boolean>} */
      const attributes = {
        'openinference.span.kind': 'TOOL',
        'gen_ai.system': 'express_mcp',
        'gen_ai.tool.name': params.toolName,
        'gen_ai.operation.name': 'execute_tool',
      };
      if (params.sessionId) {
        attributes['mcp.session_id'] = String(params.sessionId);
      }
      if (params.user?.sub) {
        attributes['user.id'] = String(params.user.sub);
      }
      if (this.config.captureParameters && params.args !== undefined) {
        attributes['input.value'] = sanitizeToAttributeString(
          params.args,
          this.config.sanitizeKeys,
          this.config.maxAttributeLength
        );
      }
      return {
        traceId,
        spanId,
        parentSpanId,
        name: `mcp.tool.${params.toolName}`,
        startTimeUnixNano: nowUnixNano(),
        attributes,
        traceparent: serializeTraceparent(traceId, spanId),
      };
    } catch (err) {
      this.logger?.debug?.({ error: err?.message }, 'Failed to start tool span');
      return null;
    }
  }

  /**
   * End a TOOL span and enqueue for export.
   * @param {ActiveSpan|null} span
   * @param {Object} execution
   * @param {string} [execution.status]
   * @param {unknown} [execution.result]
   * @param {Object} [execution.errorData]
   * @param {number} [execution.durationMs]
   */
  endToolSpan(span, execution) {
    if (!span) {
      return;
    }
    try {
      const status = execution?.status === 'error' ? 'error' : 'success';
      span.attributes['mcp.tool.status'] = status;
      if (typeof execution?.durationMs === 'number') {
        span.attributes['mcp.tool.duration_ms'] = execution.durationMs;
      }
      if (status === 'success' && this.config.captureResults && execution?.result !== undefined) {
        span.attributes['output.value'] = sanitizeToAttributeString(
          execution.result,
          this.config.sanitizeKeys,
          this.config.maxAttributeLength
        );
      }
      if (status === 'error' && execution?.errorData) {
        if (execution.errorData.error) {
          span.attributes['error.message'] = sanitizeToAttributeString(
            execution.errorData.error,
            this.config.sanitizeKeys,
            this.config.maxAttributeLength
          );
        }
        if (typeof execution.errorData.errorCode === 'number') {
          span.attributes['error.code'] = execution.errorData.errorCode;
        }
      }
      this._enqueueCompleted(span, status === 'error' ? STATUS_ERROR : STATUS_OK);
    } catch (err) {
      this.logger?.debug?.({ error: err?.message }, 'Failed to end tool span');
    }
  }

  /**
   * Start an agent CHAIN span.
   * @param {Object} params
   * @param {string} params.prompt
   * @param {string} [params.genAiSystem='custom']
   * @param {string|null} [params.traceparent]
   * @param {string|null} [params.sessionId]
   * @param {object|null} [params.user]
   * @returns {ActiveSpan|null}
   */
  startAgentSpan(params) {
    try {
      const { traceId, parentSpanId } = this._resolveParent(params.traceparent);
      const spanId = generateSpanId();
      /** @type {Record<string, string|number|boolean>} */
      const attributes = {
        'openinference.span.kind': 'CHAIN',
        'gen_ai.system': params.genAiSystem || 'custom',
        'gen_ai.operation.name': 'process_message',
      };
      if (params.sessionId) {
        attributes['mcp.session_id'] = String(params.sessionId);
      }
      if (params.user?.sub) {
        attributes['user.id'] = String(params.user.sub);
      }
      if (this.config.captureParameters) {
        attributes['input.value'] = sanitizeToAttributeString(
          params.prompt,
          this.config.sanitizeKeys,
          this.config.maxAttributeLength
        );
      }
      return {
        traceId,
        spanId,
        parentSpanId,
        name: 'agent.process_message',
        startTimeUnixNano: nowUnixNano(),
        attributes,
        traceparent: serializeTraceparent(traceId, spanId),
      };
    } catch (err) {
      this.logger?.debug?.({ error: err?.message }, 'Failed to start agent span');
      return null;
    }
  }

  /**
   * Overwrite a span's `input.value` after the model request is assembled.
   * Fail-open: never throws into agent execution.
   * @param {ActiveSpan|null} span
   * @param {unknown} value
   */
  setSpanInput(span, value) {
    if (!span || !span.attributes || !this.config.captureParameters || value === undefined) {
      return;
    }
    try {
      span.attributes['input.value'] = sanitizeToAttributeString(
        value,
        this.config.sanitizeKeys,
        this.config.maxAttributeLength
      );
    } catch (err) {
      this.logger?.debug?.({ error: err?.message }, 'Failed to set span input');
    }
  }

  /**
   * Start an LLM span for one model generate round.
   * @param {Object} params
   * @param {string|null} [params.traceparent] - parent CHAIN traceparent
   * @param {string} [params.genAiSystem='custom']
   * @param {string} [params.model]
   * @param {number} [params.round]
   * @param {string|null} [params.sessionId]
   * @param {unknown} [params.contents] - generate contents (history + this turn)
   * @param {string} [params.systemInstruction]
   * @returns {ActiveSpan|null}
   */
  startLlmSpan(params) {
    try {
      const { traceId, parentSpanId } = this._resolveParent(params.traceparent);
      const spanId = generateSpanId();
      /** @type {Record<string, string|number|boolean>} */
      const attributes = {
        'openinference.span.kind': 'LLM',
        'gen_ai.system': params.genAiSystem || 'custom',
        'gen_ai.operation.name': 'generateContent',
      };
      if (typeof params.model === 'string' && params.model) {
        attributes['gen_ai.request.model'] = params.model;
      }
      if (typeof params.round === 'number') {
        attributes['agent.round'] = params.round;
      }
      if (params.sessionId) {
        attributes['mcp.session_id'] = String(params.sessionId);
      }
      if (this.config.captureParameters) {
        if (params.contents !== undefined) {
          attributes['input.value'] = sanitizeToAttributeString(
            params.contents,
            this.config.sanitizeKeys,
            this.config.maxAttributeLength
          );
        }
        if (
          typeof params.systemInstruction === 'string'
          && params.systemInstruction.trim().length > 0
        ) {
          attributes['gen_ai.system_instruction'] = sanitizeToAttributeString(
            params.systemInstruction,
            this.config.sanitizeKeys,
            this.config.maxAttributeLength
          );
        }
      }
      return {
        traceId,
        spanId,
        parentSpanId,
        name: 'gen_ai.generateContent',
        startTimeUnixNano: nowUnixNano(),
        attributes,
        traceparent: serializeTraceparent(traceId, spanId),
      };
    } catch (err) {
      this.logger?.debug?.({ error: err?.message }, 'Failed to start LLM span');
      return null;
    }
  }

  /**
   * End an LLM span and enqueue for export.
   * @param {ActiveSpan|null} span
   * @param {Object} [result]
   * @param {{ promptTokens?: number, completionTokens?: number, totalTokens?: number }} [result.usage]
   * @param {string} [result.thought]
   * @param {unknown} [result.output]
   * @param {Error|null} [result.error]
   */
  endLlmSpan(span, result = {}) {
    if (!span) {
      return;
    }
    try {
      const usage = result.usage;
      if (usage && typeof usage === 'object') {
        if (typeof usage.promptTokens === 'number') {
          span.attributes['gen_ai.usage.input_tokens'] = usage.promptTokens;
        }
        if (typeof usage.completionTokens === 'number') {
          span.attributes['gen_ai.usage.output_tokens'] = usage.completionTokens;
        }
        if (typeof usage.totalTokens === 'number') {
          span.attributes['gen_ai.usage.total_tokens'] = usage.totalTokens;
        }
      }
      if (this.config.captureResults) {
        if (typeof result.thought === 'string' && result.thought) {
          span.attributes['gen_ai.thought'] = sanitizeToAttributeString(
            result.thought,
            this.config.sanitizeKeys,
            this.config.maxAttributeLength
          );
        }
        if (result.output !== undefined) {
          span.attributes['output.value'] = sanitizeToAttributeString(
            result.output,
            this.config.sanitizeKeys,
            this.config.maxAttributeLength
          );
        }
      }
      if (result.error) {
        span.attributes['error.message'] = sanitizeToAttributeString(
          result.error.message || String(result.error),
          this.config.sanitizeKeys,
          this.config.maxAttributeLength
        );
        this._enqueueCompleted(span, STATUS_ERROR);
        return;
      }
      this._enqueueCompleted(span, STATUS_OK);
    } catch (err) {
      this.logger?.debug?.({ error: err?.message }, 'Failed to end LLM span');
    }
  }

  /**
   * Record a request_tools escalation as a TOOL child and annotate the CHAIN parent.
   * @param {ActiveSpan|null} parentSpan - agent CHAIN span
   * @param {Object} params
   * @param {string} params.reason
   * @param {string[]} params.grantedTools
   * @param {number} [params.round]
   * @param {string|null} [params.sessionId]
   */
  recordEscalation(parentSpan, params) {
    if (!parentSpan) {
      return;
    }
    try {
      parentSpan.attributes['agent.escalated'] = true;
      parentSpan.attributes['agent.escalation_reason'] = sanitizeToAttributeString(
        params.reason,
        this.config.sanitizeKeys,
        this.config.maxAttributeLength
      );

      const spanId = generateSpanId();
      /** @type {Record<string, string|number|boolean>} */
      const attributes = {
        'openinference.span.kind': 'TOOL',
        'gen_ai.system': 'express_mcp',
        'gen_ai.tool.name': 'request_tools',
        'gen_ai.operation.name': 'execute_tool',
        'mcp.tool.status': 'success',
      };
      if (typeof params.round === 'number') {
        attributes['agent.round'] = params.round;
      }
      if (params.sessionId) {
        attributes['mcp.session_id'] = String(params.sessionId);
      }
      if (this.config.captureParameters) {
        attributes['input.value'] = sanitizeToAttributeString(
          { reason: params.reason },
          this.config.sanitizeKeys,
          this.config.maxAttributeLength
        );
      }
      if (this.config.captureResults) {
        attributes['output.value'] = sanitizeToAttributeString(
          { ok: true, tools: params.grantedTools },
          this.config.sanitizeKeys,
          this.config.maxAttributeLength
        );
      }
      const now = nowUnixNano();
      this.queue.enqueue({
        traceId: parentSpan.traceId,
        spanId,
        parentSpanId: parentSpan.spanId,
        name: 'mcp.tool.request_tools',
        kind: SPAN_KIND_INTERNAL,
        startTimeUnixNano: now,
        endTimeUnixNano: now,
        status: { code: STATUS_OK },
        attributes: attributesToOtlp(attributes),
      });
    } catch (err) {
      this.logger?.debug?.({ error: err?.message }, 'Failed to record escalation span');
    }
  }

  /**
   * End an agent CHAIN span.
   * @param {ActiveSpan|null} span
   * @param {Object} result
   * @param {string} [result.output]
   * @param {number} [result.rounds]
   * @param {number} [result.promptTokens]
   * @param {number} [result.completionTokens]
   * @param {number} [result.totalTokens]
   * @param {number} [result.selfCorrections]
   * @param {Error|null} [result.error]
   */
  endAgentSpan(span, result = {}) {
    if (!span) {
      return;
    }
    try {
      if (typeof result.rounds === 'number') {
        span.attributes['agent.rounds'] = result.rounds;
      }
      if (typeof result.promptTokens === 'number') {
        span.attributes['gen_ai.usage.input_tokens'] = result.promptTokens;
      }
      if (typeof result.completionTokens === 'number') {
        span.attributes['gen_ai.usage.output_tokens'] = result.completionTokens;
      }
      if (typeof result.totalTokens === 'number') {
        span.attributes['gen_ai.usage.total_tokens'] = result.totalTokens;
      }
      if (typeof result.selfCorrections === 'number' && result.selfCorrections > 0) {
        span.attributes['agent.self_corrections'] = result.selfCorrections;
      }
      if (result.error) {
        span.attributes['error.message'] = sanitizeToAttributeString(
          result.error.message || String(result.error),
          this.config.sanitizeKeys,
          this.config.maxAttributeLength
        );
        this._enqueueCompleted(span, STATUS_ERROR);
        return;
      }
      if (this.config.captureResults && result.output !== undefined) {
        span.attributes['output.value'] = sanitizeToAttributeString(
          result.output,
          this.config.sanitizeKeys,
          this.config.maxAttributeLength
        );
      }
      this._enqueueCompleted(span, STATUS_OK);
    } catch (err) {
      this.logger?.debug?.({ error: err?.message }, 'Failed to end agent span');
    }
  }

  /**
   * @param {ActiveSpan} span
   * @param {number} statusCode
   * @private
   */
  _enqueueCompleted(span, statusCode) {
    /** @type {Record<string, unknown>} */
    const otlpSpan = {
      traceId: span.traceId,
      spanId: span.spanId,
      name: span.name,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: span.startTimeUnixNano,
      endTimeUnixNano: nowUnixNano(),
      status: { code: statusCode },
      attributes: attributesToOtlp(span.attributes),
    };
    if (span.parentSpanId) {
      otlpSpan.parentSpanId = span.parentSpanId;
    }
    this.queue.enqueue(otlpSpan);
  }

  /**
   * Drain queue and destroy HTTP agents.
   * @returns {Promise<void>}
   */
  async shutdown() {
    try {
      await this.queue.shutdown();
    } catch (err) {
      this.logger?.debug?.({ error: err?.message }, 'Telemetry queue shutdown failed');
    }
    try {
      this.sender.destroy?.();
    } catch (err) {
      this.logger?.debug?.({ error: err?.message }, 'Telemetry sender destroy failed');
    }
  }
}
