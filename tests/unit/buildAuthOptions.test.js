import { assert } from 'chai';
import { buildAuthOptions } from '../../src/buildAuthOptions.js';
import { TEST_AUTH } from '../authTestUtils.js';

function validInput(overrides = {}) {
  return {
    enabled: true,
    baseUrl: 'https://example.com',
    callbackUrl: TEST_AUTH.callbackUrl,
    jwtSecret: TEST_AUTH.jwtSecret,
    sessionSecret: TEST_AUTH.sessionSecret,
    jwtExpiresIn: TEST_AUTH.jwtExpiresIn,
    allowedUsers: ['user@example.com'],
    providers: {
      google: TEST_AUTH.google
    },
    ...overrides
  };
}

describe('buildAuthOptions', () => {
  it('returns disabled auth when enabled is false', () => {
    assert.deepStrictEqual(buildAuthOptions({ enabled: false }), { enabled: false });
  });

  it('derives issuer and resourcePath from baseUrl', () => {
    const auth = buildAuthOptions(validInput());

    assert.strictEqual(auth.issuer, 'https://example.com/mcp');
    assert.strictEqual(auth.resourcePath, '/mcp');
    assert.strictEqual(auth.enabled, true);
  });

  it('strips trailing slash from baseUrl before deriving issuer', () => {
    const auth = buildAuthOptions(validInput({ baseUrl: 'https://example.com/' }));

    assert.strictEqual(auth.issuer, 'https://example.com/mcp');
  });

  it('accepts providers.google configuration', () => {
    const auth = buildAuthOptions(validInput());

    assert.deepStrictEqual(auth.providers, {
      google: TEST_AUTH.google
    });
  });

  it('throws when google clientId is empty', () => {
    assert.throws(
      () =>
        buildAuthOptions(
          validInput({
            providers: {
              google: {
                clientId: '',
                clientSecret: TEST_AUTH.google.clientSecret
              }
            }
          })
        ),
      /google clientId is missing or empty/
    );
  });

  it('supports single-provider shorthand', () => {
    const auth = buildAuthOptions({
      enabled: true,
      baseUrl: 'https://example.com',
      callbackUrl: TEST_AUTH.callbackUrl,
      jwtSecret: TEST_AUTH.jwtSecret,
      sessionSecret: TEST_AUTH.sessionSecret,
      jwtExpiresIn: TEST_AUTH.jwtExpiresIn,
      provider: 'github',
      clientId: TEST_AUTH.github.clientId,
      clientSecret: TEST_AUTH.github.clientSecret
    });

    assert.strictEqual(auth.provider, 'github');
    assert.strictEqual(auth.clientId, TEST_AUTH.github.clientId);
    assert.strictEqual(auth.clientSecret, TEST_AUTH.github.clientSecret);
  });

  it('uses explicit issuer when provided', () => {
    const auth = buildAuthOptions(
      validInput({
        issuer: 'https://custom.example.com/mcp',
        baseUrl: 'https://ignored.example.com'
      })
    );

    assert.strictEqual(auth.issuer, 'https://custom.example.com/mcp');
  });
});
