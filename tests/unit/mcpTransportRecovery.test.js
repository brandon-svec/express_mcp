import { expect } from 'chai';
import { ownsMcpTransportSession } from '../../src/mcpTransportRecovery.js';

describe('ownsMcpTransportSession', () => {
  const base = {
    user: { sub: 'gh:1' },
    resourcePath: '/mcp'
  };

  it('allows the owning user on the same resourcePath', () => {
    expect(ownsMcpTransportSession(base, { sub: 'gh:1' }, '/mcp')).to.equal(true);
  });

  it('rejects a different user', () => {
    expect(ownsMcpTransportSession(base, { sub: 'gh:2' }, '/mcp')).to.equal(false);
  });

  it('rejects a mismatched resourcePath', () => {
    expect(ownsMcpTransportSession(base, { sub: 'gh:1' }, '/mcp/admin')).to.equal(false);
  });

  it('allows unauthenticated recovery when both sides have no sub', () => {
    expect(
      ownsMcpTransportSession({ user: null, resourcePath: '/mcp' }, null, '/mcp')
    ).to.equal(true);
  });

  it('rejects when only one side has a sub', () => {
    expect(
      ownsMcpTransportSession({ user: { sub: 'gh:1' }, resourcePath: '/mcp' }, null, '/mcp')
    ).to.equal(false);
    expect(
      ownsMcpTransportSession({ user: null, resourcePath: '/mcp' }, { sub: 'gh:1' }, '/mcp')
    ).to.equal(false);
  });
});
