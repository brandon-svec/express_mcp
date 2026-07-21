import { assert } from 'chai';
import {
  isRedirectUriAllowedByPolicy,
  OAuthClientRegistry
} from '../../src/mcpOAuth.js';

describe('DCR redirect URI policy', () => {
  it('allows loopback http(s) and custom schemes by default', () => {
    assert.isTrue(isRedirectUriAllowedByPolicy('http://127.0.0.1:8787/callback'));
    assert.isTrue(isRedirectUriAllowedByPolicy('http://localhost/cb'));
    assert.isTrue(isRedirectUriAllowedByPolicy('cursor://anysphere.cursor-mcp/oauth/callback'));
  });

  it('rejects non-loopback http(s) unless allowlisted', () => {
    assert.isFalse(isRedirectUriAllowedByPolicy('https://evil.example/cb'));
    assert.isTrue(
      isRedirectUriAllowedByPolicy('https://app.example/cb', ['https://app.example/cb'])
    );
  });

  it('OAuthClientRegistry enforces maxEntries', () => {
    const registry = new OAuthClientRegistry({ maxEntries: 2 });
    registry.register({
      client_name: 'a',
      redirect_uris: ['cursor://a'],
      grant_types: ['authorization_code'],
      response_types: ['code']
    });
    registry.register({
      client_name: 'b',
      redirect_uris: ['cursor://b'],
      grant_types: ['authorization_code'],
      response_types: ['code']
    });
    registry.register({
      client_name: 'c',
      redirect_uris: ['cursor://c'],
      grant_types: ['authorization_code'],
      response_types: ['code']
    });
    assert.strictEqual(registry.clients.size, 2);
  });
});
