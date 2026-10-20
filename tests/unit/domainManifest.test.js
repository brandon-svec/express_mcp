import { assert } from 'chai';
import { buildDomainExpertManifest } from '../../src/agents/manifest.js';
import { buildDomainExpertManifest as exportedBuildDomainExpertManifest } from '../../src/index.js';

describe('buildDomainExpertManifest', () => {
  it('throws when options are not a plain object', () => {
    assert.throws(() => buildDomainExpertManifest(null), /plain options object/);
    assert.throws(() => buildDomainExpertManifest([]), /plain options object/);
    assert.throws(() => buildDomainExpertManifest('x'), /plain options object/);
  });

  it('throws when playbooks is provided but not an array', () => {
    assert.throws(
      () => buildDomainExpertManifest({ playbooks: {} }),
      /playbooks must be an array/,
    );
  });

  it('returns empty string when all inputs are empty', () => {
    assert.strictEqual(buildDomainExpertManifest({}), '');
    assert.strictEqual(buildDomainExpertManifest({
      serverName: '  ',
      serviceDescription: '',
      agentDescription: undefined,
      playbooks: [],
    }), '');
  });

  it('builds identity-only manifest', () => {
    const text = buildDomainExpertManifest({
      serverName: 'widget',
      serviceDescription: 'Widget domain service',
    });
    assert.strictEqual(text, [
      'SERVICE DOMAIN & IDENTITY:',
      'Service: widget',
      'Role: Widget domain service',
    ].join('\n'));
  });

  it('prefers serviceDescription over agentDescription for Role', () => {
    const text = buildDomainExpertManifest({
      agentDescription: 'Ask the agent',
      serviceDescription: 'Domain role',
    });
    assert.include(text, 'Role: Domain role');
    assert.notInclude(text, 'Ask the agent');
  });

  it('uses agentDescription when serviceDescription is absent', () => {
    const text = buildDomainExpertManifest({
      agentDescription: 'Ask the specialist',
    });
    assert.strictEqual(text, [
      'SERVICE DOMAIN & IDENTITY:',
      'Role: Ask the specialist',
    ].join('\n'));
  });

  it('formats playbooks with governance mappings', () => {
    const text = buildDomainExpertManifest({
      serverName: 'orders',
      playbooks: [{
        title: 'Returns SOP',
        uri: 'kb://orders/returns',
        summary: 'How to process returns',
        tools: ['returns_create', 'returns_cancel'],
      }],
    });
    assert.strictEqual(text, [
      'SERVICE DOMAIN & IDENTITY:',
      'Service: orders',
      '',
      'OPERATIONAL PLAYBOOKS & PROCEDURES:',
      'The following official playbooks define business rules and procedures for this service:',
      '- "Returns SOP" (kb://orders/returns): How to process returns',
      '  Governs tools: returns_create, returns_cancel',
      'When fulfilling requests governed by a playbook, follow its prescribed steps.',
    ].join('\n'));
  });

  it('omits summary suffix and Governs tools line when empty', () => {
    const text = buildDomainExpertManifest({
      playbooks: [{
        title: 'Sparse',
        uri: 'playbook://sparse',
        summary: '',
        tools: [],
      }],
    });
    assert.strictEqual(text, [
      'OPERATIONAL PLAYBOOKS & PROCEDURES:',
      'The following official playbooks define business rules and procedures for this service:',
      '- "Sparse" (playbook://sparse)',
      'When fulfilling requests governed by a playbook, follow its prescribed steps.',
    ].join('\n'));
  });

  it('exports buildDomainExpertManifest from package root', () => {
    assert.strictEqual(exportedBuildDomainExpertManifest, buildDomainExpertManifest);
  });
});
