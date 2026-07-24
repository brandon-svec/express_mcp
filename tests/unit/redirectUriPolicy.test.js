import { assert } from 'chai';
import {
  DEFAULT_TRUSTED_REDIRECT_HOSTS,
  isRedirectUriAllowedByPolicy,
  OAuthClientRegistry
} from '../../src/mcpOAuth.js';

describe('DCR redirect URI policy', () => {
  it('allows loopback http(s) and custom schemes by default', () => {
    assert.isTrue(isRedirectUriAllowedByPolicy('http://127.0.0.1:8787/callback'));
    assert.isTrue(isRedirectUriAllowedByPolicy('http://localhost/cb'));
    assert.isTrue(isRedirectUriAllowedByPolicy('https://127.0.0.1/cb'));
    assert.isTrue(isRedirectUriAllowedByPolicy('cursor://anysphere.cursor-mcp/oauth/callback'));
  });

  it('allows https on default trusted agent hosts', () => {
    assert.isTrue(
      isRedirectUriAllowedByPolicy('https://www.cursor.com/agents/mcp/oauth/callback')
    );
    assert.isTrue(isRedirectUriAllowedByPolicy('https://cursor.com/oauth/callback'));
    assert.isTrue(isRedirectUriAllowedByPolicy('https://vscode.dev/redirect'));
    assert.isTrue(isRedirectUriAllowedByPolicy('https://insiders.vscode.dev/redirect'));
    assert.isTrue(DEFAULT_TRUSTED_REDIRECT_HOSTS.has('www.cursor.com'));
  });

  it('rejects unknown remote https and public cleartext http by default', () => {
    assert.isFalse(isRedirectUriAllowedByPolicy('https://evil.example/cb'));
    assert.isFalse(isRedirectUriAllowedByPolicy('http://evil.example/cb'));
  });

  it('rejects trusted-host suffix bypasses (exact hostname only)', () => {
    assert.isFalse(isRedirectUriAllowedByPolicy('https://cursor.com.attacker.example/cb'));
    assert.isFalse(isRedirectUriAllowedByPolicy('https://www.cursor.com.evil.example/cb'));
    assert.isFalse(isRedirectUriAllowedByPolicy('https://notvscode.dev/redirect'));
  });

  it('extends trusted hosts via options.trustedHosts', () => {
    assert.isTrue(
      isRedirectUriAllowedByPolicy('https://newagent.example/cb', {
        trustedHosts: ['newagent.example']
      })
    );
    assert.isFalse(
      isRedirectUriAllowedByPolicy('https://other.example/cb', {
        trustedHosts: ['newagent.example']
      })
    );
  });

  it('allowAnyHttps accepts any https but still rejects public http', () => {
    assert.isTrue(
      isRedirectUriAllowedByPolicy('https://evil.example/cb', { allowAnyHttps: true })
    );
    assert.isFalse(
      isRedirectUriAllowedByPolicy('http://evil.example/cb', { allowAnyHttps: true })
    );
  });

  it('allows exact matches in allowedRedirectUris', () => {
    assert.isTrue(
      isRedirectUriAllowedByPolicy('https://app.example/cb', {
        allowedRedirectUris: ['https://app.example/cb']
      })
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
