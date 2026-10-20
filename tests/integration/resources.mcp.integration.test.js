import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import express from 'express';
import request from 'supertest';
import { ExpressMcp } from '../../src/classes/expressMcp.js';
import { BaseResource } from '../../src/classes/baseResource.js';
import {
  getTestExpressMcpOptions,
  createMcpSession,
  mcpPostWithSession,
  MCP_STREAMABLE_HTTP_ACCEPT,
  MCP_SESSION_ID_HEADER,
  createInitializeRequest,
} from '../config.js';

const packageVersion = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;

async function createResourcesApp (options = {}) {
  const expressMcp = new ExpressMcp(getTestExpressMcpOptions(options));
  const app = express();
  app.use(express.json());
  app.use('/mcp', expressMcp.router());
  const baseAgent = request(app);

  // Retry once: Streamable HTTP session init can flake under rapid app churn.
  let sessionId;
  try {
    sessionId = await createMcpSession(baseAgent);
  } catch {
    sessionId = await createMcpSession(baseAgent);
  }

  await mcpPostWithSession(baseAgent, sessionId, '/mcp').send({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });

  return {
    expressMcp,
    post: async (body) => {
      let response = await mcpPostWithSession(baseAgent, sessionId, '/mcp').send(body);
      if (response.status === 400 && (!response.body || Object.keys(response.body).length === 0)) {
        response = await mcpPostWithSession(baseAgent, sessionId, '/mcp').send(body);
      }
      return response;
    },
    app,
    baseAgent,
  };
}

describe('MCP resources integration', () => {
  it('initialize advertises resources capability', async () => {
    const expressMcp = new ExpressMcp(getTestExpressMcpOptions({ enableKnowledgeBase: false }));
    const app = express();
    app.use(express.json());
    app.use('/mcp', expressMcp.router());

    const response = await request(app)
      .post('/mcp')
      .set('Accept', MCP_STREAMABLE_HTTP_ACCEPT)
      .send(createInitializeRequest(1));

    assert.strictEqual(response.status, 200);
    assert.ok(response.headers[MCP_SESSION_ID_HEADER]);
    assert.deepStrictEqual(response.body, {
      jsonrpc: '2.0',
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
          resources: {},
        },
        serverInfo: {
          name: '@express-mcp/express-mcp',
          version: packageVersion,
        },
      },
      id: 1,
    });
  });

  it('lists and reads KnowledgeBase documents as kb://documents/{id}', async () => {
    const { expressMcp, post } = await createResourcesApp({ enableKnowledgeBase: true });
    await expressMcp.addDocument('getting-started', {
      title: 'Getting Started',
      content: '# Welcome\nStart here.',
      tags: ['guide', 'intro'],
    });
    const doc = expressMcp.getKnowledgeBase().getDocument('getting-started');

    const listResponse = await post({
      jsonrpc: '2.0',
      method: 'resources/list',
      id: 2,
    });
    assert.strictEqual(listResponse.status, 200);
    assert.deepStrictEqual(listResponse.body, {
      jsonrpc: '2.0',
      result: {
        resources: [{
          uri: 'kb://documents/getting-started',
          name: 'getting-started',
          title: 'Getting Started',
          mimeType: 'text/markdown',
          description: 'Start here.',
          annotations: {
            audience: ['assistant'],
            lastModified: doc.updatedAt,
          },
        }],
      },
      id: 2,
    });

    const readResponse = await post({
      jsonrpc: '2.0',
      method: 'resources/read',
      params: { uri: 'kb://documents/getting-started' },
      id: 3,
    });
    assert.strictEqual(readResponse.status, 200);
    assert.deepStrictEqual(readResponse.body, {
      jsonrpc: '2.0',
      result: {
        contents: [{
          uri: 'kb://documents/getting-started',
          mimeType: 'text/markdown',
          text: '# Welcome\nStart here.',
        }],
      },
      id: 3,
    });
  });

  it('uses kb://{name}/{id} when ExpressMcp name is set', async () => {
    const { expressMcp, post } = await createResourcesApp({
      name: 'widget',
      enableKnowledgeBase: true,
    });
    await expressMcp.addDocument('sop-1', {
      title: 'SOP',
      content: 'Do the thing',
    });

    const listResponse = await post({
      jsonrpc: '2.0',
      method: 'resources/list',
      id: 4,
    });
    assert.strictEqual(listResponse.status, 200);
    const uris = listResponse.body.result.resources.map((r) => r.uri);
    assert.deepStrictEqual(uris.includes('kb://widget/sop-1'), true);

    const readResponse = await post({
      jsonrpc: '2.0',
      method: 'resources/read',
      params: { uri: 'kb://widget/sop-1' },
      id: 5,
    });
    assert.strictEqual(readResponse.status, 200);
    assert.deepStrictEqual(readResponse.body.result.contents[0].text, 'Do the thing');
  });

  it('lists and reads custom BaseResource playbooks', async () => {
    const { expressMcp, post } = await createResourcesApp({ enableKnowledgeBase: false });
    expressMcp.registerResource(new BaseResource({
      uri: 'playbook://incident-response',
      name: 'incident-response',
      title: 'Incident Response',
      description: 'Pager playbook',
      text: '# Incident Response\n1. Page on-call',
    }));

    const listResponse = await post({
      jsonrpc: '2.0',
      method: 'resources/list',
      id: 6,
    });
    assert.strictEqual(listResponse.status, 200);
    assert.deepStrictEqual(listResponse.body.result.resources, [{
      uri: 'playbook://incident-response',
      name: 'incident-response',
      title: 'Incident Response',
      description: 'Pager playbook',
      mimeType: 'text/markdown',
    }]);

    const readResponse = await post({
      jsonrpc: '2.0',
      method: 'resources/read',
      params: { uri: 'playbook://incident-response' },
      id: 7,
    });
    assert.strictEqual(readResponse.status, 200);
    assert.deepStrictEqual(readResponse.body.result.contents, [{
      uri: 'playbook://incident-response',
      mimeType: 'text/markdown',
      text: '# Incident Response\n1. Page on-call',
    }]);
  });

  it('returns JSON-RPC error -32002 for unknown URIs', async () => {
    const { post } = await createResourcesApp({ enableKnowledgeBase: false });
    const response = await post({
      jsonrpc: '2.0',
      method: 'resources/read',
      params: { uri: 'kb://documents/missing' },
      id: 8,
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.jsonrpc, '2.0');
    assert.strictEqual(response.body.id, 8);
    assert.strictEqual(response.body.error.code, -32002);
    assert.strictEqual(
      response.body.error.message,
      'MCP error -32002: Resource not found: kb://documents/missing',
    );
  });

  it('serves custom resources when knowledge base is disabled and rejects kb URIs', async () => {
    const { expressMcp, post } = await createResourcesApp({ enableKnowledgeBase: false });
    expressMcp.registerResource(new BaseResource({
      uri: 'playbook://only',
      name: 'only',
      text: 'custom only',
    }));
    // Document exists on the KB instance but is not bridged into resources.
    await expressMcp.addDocument('hidden', {
      title: 'Hidden',
      content: 'not exposed',
    });

    const listResponse = await post({
      jsonrpc: '2.0',
      method: 'resources/list',
      id: 9,
    });
    assert.strictEqual(listResponse.status, 200);
    assert.deepStrictEqual(
      listResponse.body.result.resources.map((r) => r.uri),
      ['playbook://only'],
    );

    const kbRead = await post({
      jsonrpc: '2.0',
      method: 'resources/read',
      params: { uri: 'kb://documents/hidden' },
      id: 10,
    });
    assert.strictEqual(kbRead.body.error.code, -32002);
  });
});
