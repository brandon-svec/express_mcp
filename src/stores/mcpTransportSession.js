/**
 * Redis / in-memory key prefix for Streamable HTTP MCP transport metadata.
 * Distinct from OAuth active sessions (`mcp:session:{jti}`).
 * @param {string} sessionId
 * @returns {string}
 */
export function mcpTransportKey(sessionId) {
  return `mcp:transport:${sessionId}`;
}

/**
 * @param {unknown} record
 * @returns {{
 *   user: Object|null,
 *   userId: string|null,
 *   extraInstructions: string|null,
 *   permissionMode: string,
 *   sessionMeta: Object,
 *   protocolVersion: string,
 *   capabilities: Object,
 *   clientInfo: Object,
 *   resourcePath: string,
 *   createdAt: number
 * }}
 */
export function normalizeMcpTransportRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('MCP transport session record is required');
  }
  if (record.user !== null && (typeof record.user !== 'object' || Array.isArray(record.user))) {
    throw new Error('MCP transport session record.user must be an object or null');
  }
  if (record.userId !== null && (typeof record.userId !== 'string' || !record.userId)) {
    throw new Error('MCP transport session record.userId must be a non-empty string or null');
  }
  if (
    record.extraInstructions !== null
    && (typeof record.extraInstructions !== 'string' || !record.extraInstructions)
  ) {
    throw new Error('MCP transport session record.extraInstructions must be a non-empty string or null');
  }
  if (typeof record.permissionMode !== 'string' || !record.permissionMode) {
    throw new Error('MCP transport session record.permissionMode is required');
  }
  if (!record.sessionMeta || typeof record.sessionMeta !== 'object' || Array.isArray(record.sessionMeta)) {
    throw new Error('MCP transport session record.sessionMeta must be an object');
  }
  if (typeof record.protocolVersion !== 'string' || !record.protocolVersion) {
    throw new Error('MCP transport session record.protocolVersion is required');
  }
  if (!record.capabilities || typeof record.capabilities !== 'object' || Array.isArray(record.capabilities)) {
    throw new Error('MCP transport session record.capabilities must be an object');
  }
  if (!record.clientInfo || typeof record.clientInfo !== 'object' || Array.isArray(record.clientInfo)) {
    throw new Error('MCP transport session record.clientInfo must be an object');
  }
  if (typeof record.resourcePath !== 'string' || !record.resourcePath) {
    throw new Error('MCP transport session record.resourcePath is required');
  }
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt) || record.createdAt <= 0) {
    throw new Error('MCP transport session record.createdAt must be a positive number');
  }
  return {
    user: record.user,
    userId: record.userId,
    extraInstructions: record.extraInstructions,
    permissionMode: record.permissionMode,
    sessionMeta: record.sessionMeta,
    protocolVersion: record.protocolVersion,
    capabilities: record.capabilities,
    clientInfo: record.clientInfo,
    resourcePath: record.resourcePath,
    createdAt: record.createdAt
  };
}
