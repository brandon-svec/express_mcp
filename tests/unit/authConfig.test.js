import { assert } from 'chai';
import { validateAuthOptions } from '../../src/authConfig.js';
import { TEST_AUTH } from '../authTestUtils.js';

function validAuth(overrides = {}) {
  return {
    enabled: true,
    callbackUrl: TEST_AUTH.callbackUrl,
    jwtSecret: TEST_AUTH.jwtSecret,
    sessionSecret: TEST_AUTH.sessionSecret,
    issuer: TEST_AUTH.issuer,
    resourcePath: TEST_AUTH.resourcePath,
    jwtExpiresIn: TEST_AUTH.jwtExpiresIn,
    allowedUsers: [],
    providers: {
      google: TEST_AUTH.google
    },
    sessionStore: { createPending: async () => {} },
    ...overrides
  };
}

describe('validateAuthOptions', () => {
  it('does nothing when auth is disabled', () => {
    assert.doesNotThrow(() => validateAuthOptions({ enabled: false }));
  });

  it('accepts a complete auth configuration', () => {
    assert.doesNotThrow(() => validateAuthOptions(validAuth()));
  });

  it('throws when callbackUrl is empty', () => {
    assert.throws(
      () => validateAuthOptions(validAuth({ callbackUrl: '  ' })),
      /callbackUrl is missing or empty/
    );
  });

  it('throws when jwtExpiresIn is missing', () => {
    assert.throws(
      () => validateAuthOptions(validAuth({ jwtExpiresIn: '' })),
      /jwtExpiresIn is missing or empty/
    );
  });

  it('throws when allowedUsers is not an array', () => {
    assert.throws(
      () => validateAuthOptions(validAuth({ allowedUsers: 'user@example.com' })),
      /allowedUsers must be an array/
    );
  });

  it('throws when google clientId is empty', () => {
    assert.throws(
      () =>
        validateAuthOptions(
          validAuth({
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

  it('throws when sessionStore is missing', () => {
    const withoutStore = { ...validAuth() };
    delete withoutStore.sessionStore;
    assert.throws(
      () => validateAuthOptions(withoutStore),
      /sessionStore is required/
    );
  });

  it('throws when google clientSecret is missing but clientId is set', () => {
    assert.throws(
      () =>
        validateAuthOptions(
          validAuth({
            providers: {
              google: {
                clientId: TEST_AUTH.google.clientId,
                clientSecret: ''
              }
            }
          })
        ),
      /google clientSecret is missing or empty/
    );
  });
});
