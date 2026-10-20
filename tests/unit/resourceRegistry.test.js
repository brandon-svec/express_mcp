import { assert } from 'chai';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { BaseResource } from '../../src/classes/baseResource.js';
import { ResourceRegistry } from '../../src/classes/resourceRegistry.js';
import { KnowledgeBase } from '../../src/classes/knowledgeBase.js';

class DynamicResource extends BaseResource {
  constructor (uri, body) {
    super({ uri, name: 'dynamic', title: 'Dynamic' });
    this.body = body;
  }

  async read () {
    return { text: this.body };
  }
}

describe('BaseResource', () => {
  it('requires uri and name', () => {
    assert.throws(() => new BaseResource({ name: 'x' }), /uri is required/);
    assert.throws(() => new BaseResource({ uri: 'playbook://x' }), /name is required/);
    assert.throws(() => new BaseResource({ uri: '  ', name: 'x' }), /uri is required/);
  });

  it('defaults mimeType to text/markdown and omits optional fields', () => {
    const resource = new BaseResource({
      uri: 'playbook://sop',
      name: 'sop',
      text: '# SOP',
    });
    assert.deepStrictEqual(resource.getDefinition(), {
      uri: 'playbook://sop',
      name: 'sop',
      mimeType: 'text/markdown',
    });
  });

  it('includes optional title, description, annotations, and custom mimeType', () => {
    const resource = new BaseResource({
      uri: 'playbook://sop',
      name: 'sop',
      title: 'Incident SOP',
      description: 'How to respond',
      mimeType: 'text/plain',
      annotations: { audience: ['user'] },
      text: 'body',
    });
    assert.deepStrictEqual(resource.getDefinition(), {
      uri: 'playbook://sop',
      name: 'sop',
      title: 'Incident SOP',
      description: 'How to respond',
      mimeType: 'text/plain',
      annotations: { audience: ['user'] },
    });
  });

  it('rejects both text and blob, and non-string payloads', () => {
    assert.throws(
      () => new BaseResource({ uri: 'a://b', name: 'n', text: 't', blob: 'b' }),
      /cannot have both text and blob/,
    );
    assert.throws(
      () => new BaseResource({ uri: 'a://b', name: 'n', text: 1 }),
      /text must be a string/,
    );
    assert.throws(
      () => new BaseResource({ uri: 'a://b', name: 'n', blob: 1 }),
      /blob must be a string/,
    );
  });

  it('returns static text or blob from read', async () => {
    const textResource = new BaseResource({
      uri: 'playbook://t',
      name: 't',
      text: 'hello',
    });
    assert.deepStrictEqual(await textResource.read(), { text: 'hello' });

    const blobResource = new BaseResource({
      uri: 'playbook://b',
      name: 'b',
      blob: 'YmxvYg==',
    });
    assert.deepStrictEqual(await blobResource.read(), { blob: 'YmxvYg==' });
  });

  it('throws when subclass must implement read', async () => {
    const resource = new BaseResource({ uri: 'playbook://x', name: 'x' });
    try {
      await resource.read();
      assert.fail('expected read to throw');
    } catch (err) {
      assert.strictEqual(err.message, 'read method must be implemented by subclass');
    }
  });

  it('supports subclass read overrides', async () => {
    const resource = new DynamicResource('playbook://dyn', 'from-subclass');
    assert.deepStrictEqual(await resource.read(), { text: 'from-subclass' });
  });
});

describe('ResourceRegistry', () => {
  it('requires a non-empty namespace', () => {
    assert.throws(() => new ResourceRegistry({}), /namespace is required/);
    assert.throws(() => new ResourceRegistry({ namespace: '  ' }), /namespace is required/);
  });

  it('registers, lists, and unregisters explicit resources', () => {
    const registry = new ResourceRegistry({ namespace: 'documents' });
    const resource = new BaseResource({
      uri: 'playbook://sop',
      name: 'sop',
      text: '# SOP',
    });
    registry.register(resource);
    assert.isTrue(registry.has('playbook://sop'));
    assert.deepStrictEqual(registry.getRegistered(), [resource]);
    assert.deepStrictEqual(registry.listResources(), [{
      uri: 'playbook://sop',
      name: 'sop',
      mimeType: 'text/markdown',
    }]);

    assert.throws(
      () => registry.register(new BaseResource({ uri: 'playbook://sop', name: 'dup', text: 'x' })),
      /already registered/,
    );

    assert.isTrue(registry.unregister('playbook://sop'));
    assert.isFalse(registry.has('playbook://sop'));
    assert.deepStrictEqual(registry.listResources(), []);
  });

  it('clear removes only explicit resources', () => {
    const kb = new KnowledgeBase();
    kb.addDocument('doc-1', { title: 'Doc', content: 'Body', tags: ['ops'] });
    const registry = new ResourceRegistry({ namespace: 'documents', knowledgeBase: kb });
    registry.register(new BaseResource({ uri: 'playbook://x', name: 'x', text: 'x' }));
    registry.clear();
    assert.deepStrictEqual(registry.getRegistered(), []);
    assert.strictEqual(registry.listResources().length, 1);
    assert.strictEqual(registry.listResources()[0].uri, 'kb://documents/doc-1');
  });

  it('maps KB documents to kb://documents/{id} when namespace is documents', () => {
    const kb = new KnowledgeBase();
    kb.addDocument('getting-started', {
      title: 'Getting Started',
      content: 'Welcome',
      tags: ['guide'],
      metadata: { mimeType: 'text/plain' },
    });
    const registry = new ResourceRegistry({ namespace: 'documents', knowledgeBase: kb });
    const listed = registry.listResources();
    assert.strictEqual(listed.length, 1);
    assert.deepStrictEqual(listed[0], {
      uri: 'kb://documents/getting-started',
      name: 'getting-started',
      title: 'Getting Started',
      mimeType: 'text/plain',
      description: 'Welcome',
      annotations: {
        audience: ['assistant'],
        lastModified: kb.getDocument('getting-started').updatedAt,
      },
    });
  });

  it('maps KB documents to kb://{name}/{id} for a named namespace', () => {
    const kb = new KnowledgeBase();
    kb.addDocument('sop-1', { title: 'SOP', content: 'Do it' });
    const registry = new ResourceRegistry({ namespace: 'widget', knowledgeBase: kb });
    assert.deepStrictEqual(registry.listResources()[0].uri, 'kb://widget/sop-1');
    assert.strictEqual(registry.listResources()[0].description, 'Do it');
  });

  it('includes summary and tools on BaseResource getDefinition', () => {
    const resource = new BaseResource({
      uri: 'playbook://returns',
      name: 'returns',
      title: 'Returns SOP',
      summary: 'How to process returns',
      tools: ['returns_create', 'returns_cancel'],
      text: '# Returns',
    });
    assert.deepStrictEqual(resource.getDefinition(), {
      uri: 'playbook://returns',
      name: 'returns',
      title: 'Returns SOP',
      mimeType: 'text/markdown',
      summary: 'How to process returns',
      tools: ['returns_create', 'returns_cancel'],
    });
  });

  it('getPlaybooksManifest merges explicit playbooks with KB docs and skips blob-only', () => {
    const kb = new KnowledgeBase();
    kb.addDocument('kb-sop', {
      title: 'KB SOP',
      content: 'Body',
      summary: 'From KB',
      tools: ['kb_search'],
      tags: ['ops'],
    });
    const registry = new ResourceRegistry({ namespace: 'widget', knowledgeBase: kb });
    registry.register(new BaseResource({
      uri: 'playbook://returns',
      name: 'returns',
      title: 'Returns',
      summary: 'Process returns',
      tools: ['returns_create'],
      text: '# Returns',
    }));
    registry.register(new BaseResource({
      uri: 'binary://logo',
      name: 'logo',
      mimeType: 'image/png',
      blob: 'abc',
    }));

    const manifest = registry.getPlaybooksManifest();
    assert.deepStrictEqual(manifest.map((p) => p.uri), [
      'playbook://returns',
      'kb://widget/kb-sop',
    ]);
    assert.deepStrictEqual(manifest[0], {
      id: 'returns',
      title: 'Returns',
      uri: 'playbook://returns',
      summary: 'Process returns',
      tools: ['returns_create'],
      tags: [],
    });
    assert.deepStrictEqual(manifest[1], {
      id: 'kb-sop',
      title: 'KB SOP',
      uri: 'kb://widget/kb-sop',
      summary: 'From KB',
      tools: ['kb_search'],
      tags: ['ops'],
    });
  });

  it('getPlaybooksManifest shadows KB docs when explicit URI collides', () => {
    const kb = new KnowledgeBase();
    kb.addDocument('shadowed', { title: 'KB', content: 'kb', summary: 'KB summary' });
    const registry = new ResourceRegistry({ namespace: 'documents', knowledgeBase: kb });
    registry.register(new BaseResource({
      uri: 'kb://documents/shadowed',
      name: 'custom',
      title: 'Custom',
      summary: 'Custom summary',
      tools: ['ping'],
      text: 'custom',
    }));
    const manifest = registry.getPlaybooksManifest();
    assert.strictEqual(manifest.length, 1);
    assert.strictEqual(manifest[0].id, 'custom');
    assert.strictEqual(manifest[0].summary, 'Custom summary');
  });

  it('lists explicit resources before KB docs and shadows colliding KB URIs', async () => {
    const kb = new KnowledgeBase();
    kb.addDocument('shadowed', { title: 'KB Title', content: 'kb-body', tags: ['kb'] });
    const registry = new ResourceRegistry({ namespace: 'documents', knowledgeBase: kb });
    const custom = new BaseResource({
      uri: 'kb://documents/shadowed',
      name: 'custom-shadow',
      title: 'Custom Title',
      text: 'custom-body',
    });
    registry.register(new BaseResource({
      uri: 'playbook://first',
      name: 'first',
      text: 'one',
    }));
    registry.register(custom);

    const listed = registry.listResources();
    assert.deepStrictEqual(listed.map((r) => r.uri), [
      'playbook://first',
      'kb://documents/shadowed',
    ]);
    assert.strictEqual(listed[1].name, 'custom-shadow');
    assert.strictEqual(listed[1].title, 'Custom Title');

    const read = await registry.readResource('kb://documents/shadowed');
    assert.deepStrictEqual(read, {
      contents: [{
        uri: 'kb://documents/shadowed',
        mimeType: 'text/markdown',
        text: 'custom-body',
      }],
    });
  });

  it('reads KB document content by uri', async () => {
    const kb = new KnowledgeBase();
    kb.addDocument('doc-1', { title: 'Doc', content: '# Hello' });
    const registry = new ResourceRegistry({ namespace: 'documents', knowledgeBase: kb });
    assert.deepStrictEqual(await registry.readResource('kb://documents/doc-1'), {
      contents: [{
        uri: 'kb://documents/doc-1',
        mimeType: 'text/markdown',
        text: '# Hello',
      }],
    });
  });

  it('throws McpError -32002 for missing resources', async () => {
    const registry = new ResourceRegistry({ namespace: 'documents' });
    try {
      await registry.readResource('kb://documents/missing');
      assert.fail('expected readResource to throw');
    } catch (err) {
      assert.instanceOf(err, McpError);
      assert.strictEqual(err.code, -32002);
      assert.strictEqual(err.message, 'MCP error -32002: Resource not found: kb://documents/missing');
    }
  });

  it('lists only custom resources when knowledgeBase is null', () => {
    const registry = new ResourceRegistry({ namespace: 'documents', knowledgeBase: null });
    registry.register(new BaseResource({
      uri: 'playbook://only',
      name: 'only',
      text: 'x',
    }));
    assert.deepStrictEqual(registry.listResources().map((r) => r.uri), ['playbook://only']);
  });

  it('rejects non-BaseResource registration', () => {
    const registry = new ResourceRegistry({ namespace: 'documents' });
    assert.throws(
      () => registry.register({ uri: 'playbook://x', name: 'x' }),
      /instance of BaseResource/,
    );
  });
});
