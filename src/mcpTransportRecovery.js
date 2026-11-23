import http from 'http';

export const MCP_STREAMABLE_HTTP_ACCEPT = 'application/json, text/event-stream';

/**
 * Ownership + mount isolation check for a stored MCP transport session.
 * @param {{ user: { sub?: string }|null, resourcePath: string }} record
 * @param {{ sub?: string }|null|undefined} mcpUser
 * @param {string} resourcePath
 * @returns {boolean}
 */
export function ownsMcpTransportSession(record, mcpUser, resourcePath) {
  if (!record || typeof record !== 'object') {
    return false;
  }
  if (record.resourcePath !== resourcePath) {
    return false;
  }
  const savedSub =
    record.user && typeof record.user.sub === 'string' && record.user.sub
      ? record.user.sub
      : null;
  const callerSub =
    mcpUser && typeof mcpUser.sub === 'string' && mcpUser.sub
      ? mcpUser.sub
      : null;
  if (savedSub !== null || callerSub !== null) {
    return savedSub === callerSub;
  }
  return true;
}

/**
 * Drive StreamableHTTPServerTransport through initialize + notifications/initialized
 * without writing to the live client response.
 * @param {import('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport} transport
 * @param {{
 *   protocolVersion: string,
 *   capabilities: Object,
 *   clientInfo: Object
 * }} record
 * @returns {Promise<void>}
 */
export async function replayMcpTransportInitialize(transport, record) {
  if (typeof record.protocolVersion !== 'string' || !record.protocolVersion) {
    throw new Error('protocolVersion is required for MCP transport recovery');
  }
  if (!record.capabilities || typeof record.capabilities !== 'object' || Array.isArray(record.capabilities)) {
    throw new Error('capabilities is required for MCP transport recovery');
  }
  if (!record.clientInfo || typeof record.clientInfo !== 'object' || Array.isArray(record.clientInfo)) {
    throw new Error('clientInfo is required for MCP transport recovery');
  }

  const initializeBody = {
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      protocolVersion: record.protocolVersion,
      capabilities: record.capabilities,
      clientInfo: record.clientInfo
    },
    id: 'mcp-transport-recover-init'
  };
  const initializedBody = {
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  };

  await postToTransport(transport, initializeBody, {});
  await postToTransport(transport, initializedBody, {
    'mcp-session-id': transport.sessionId
  });
}

/**
 * @param {import('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport} transport
 * @param {Object} body
 * @param {Record<string, string>} extraHeaders
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
function postToTransport(transport, body, extraHeaders) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        await transport.handleRequest(req, res, body);
      } catch (error) {
        reject(error);
        server.close();
      }
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to bind synthetic MCP recovery server'));
        return;
      }

      const req = http.request(
        {
          host: '127.0.0.1',
          port: address.port,
          path: '/',
          method: 'POST',
          headers: {
            accept: MCP_STREAMABLE_HTTP_ACCEPT,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            ...extraHeaders
          }
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            server.close();
            const responseBody = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode && res.statusCode >= 400) {
              reject(
                new Error(
                  `Synthetic MCP recovery request failed with status ${res.statusCode}: ${responseBody}`
                )
              );
              return;
            }
            resolve({ statusCode: res.statusCode || 0, body: responseBody });
          });
        }
      );
      req.on('error', (error) => {
        server.close();
        reject(error);
      });
      req.end(payload);
    });
  });
}
