import { expect } from 'chai';
import {
  AuthManager,
  GOOGLE_CONTACTS_READONLY_SCOPE
} from '../../src/classes/authManager.js';
import { GoogleScopeGrantRequiredError } from '../../src/stores/errors.js';
import { InMemoryStandaloneSessionStore } from '../../src/stores/inMemoryStandaloneSessionStore.js';
import { deriveSealKey, seal, unseal } from '../../src/crypto/seal.js';
import { createTestAuthManager, TEST_AUTH } from '../authTestUtils.js';

const IDP_KEY = 'test-idp-encryption-key-at-least-32!!';

describe('seal crypto', () => {
  it('round-trips plaintext', () => {
    const key = deriveSealKey(IDP_KEY);
    const sealed = seal('refresh-token-value', key);
    expect(unseal(sealed, key)).to.equal('refresh-token-value');
  });

  it('rejects short secrets', () => {
    expect(() => deriveSealKey('short')).to.throw(/at least 32/);
  });
});

describe('Google IdP grants', () => {
  it('stores google_grant pending details', async () => {
    const store = new InMemoryStandaloneSessionStore();
    const sessionId = '550e8400-e29b-41d4-a716-446655440099';
    await store.createPending(
      sessionId,
      { telegram_chat_id: '1' },
      'google',
      600,
      {
        purpose: 'google_grant',
        scopes: [GOOGLE_CONTACTS_READONLY_SCOPE],
        sub: 'google:123'
      }
    );
    const pending = await store.peekPending(sessionId);
    expect(pending.purpose).to.equal('google_grant');
    expect(pending.scopes).to.deep.equal([GOOGLE_CONTACTS_READONLY_SCOPE]);
    expect(pending.sub).to.equal('google:123');
  });

  it('createGoogleGrantUrl rejects scopes outside the allowlist', async () => {
    const authManager = createTestAuthManager({
      providers: { google: TEST_AUTH.google },
      googleExtraScopes: [GOOGLE_CONTACTS_READONLY_SCOPE],
      idpTokenEncryptionKey: IDP_KEY
    });
    try {
      await authManager.createGoogleGrantUrl({
        scopes: ['https://www.googleapis.com/auth/contacts']
      });
      expect.fail('expected error');
    } catch (err) {
      expect(err.message).to.include('not in googleExtraScopes');
    }
  });

  it('getAuthorizationUrl for offline consent includes contacts scope', () => {
    const authManager = createTestAuthManager({
      providers: { google: TEST_AUTH.google },
      googleExtraScopes: [GOOGLE_CONTACTS_READONLY_SCOPE],
      idpTokenEncryptionKey: IDP_KEY
    });
    const url = authManager.getAuthorizationUrl('google', 'state-1', {
      extraScopes: [GOOGLE_CONTACTS_READONLY_SCOPE],
      accessType: 'offline',
      prompt: 'consent',
      includeGrantedScopes: true
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('access_type')).to.equal('offline');
    expect(parsed.searchParams.get('prompt')).to.equal('consent');
    expect(parsed.searchParams.get('include_granted_scopes')).to.equal('true');
    expect(parsed.searchParams.get('scope')).to.include(GOOGLE_CONTACTS_READONLY_SCOPE);
    expect(parsed.searchParams.get('scope')).to.include('openid');
  });

  it('getGoogleAccessToken throws typed no_grant when missing', async () => {
    const authManager = createTestAuthManager({
      providers: { google: TEST_AUTH.google },
      googleExtraScopes: [GOOGLE_CONTACTS_READONLY_SCOPE],
      idpTokenEncryptionKey: IDP_KEY
    });
    try {
      await authManager.getGoogleAccessToken('google:missing', {
        requiredScopes: [GOOGLE_CONTACTS_READONLY_SCOPE]
      });
      expect.fail('expected GoogleScopeGrantRequiredError');
    } catch (err) {
      expect(err).to.be.instanceOf(GoogleScopeGrantRequiredError);
      expect(err.reason).to.equal('no_grant');
      expect(err.missingScopes).to.deep.equal([GOOGLE_CONTACTS_READONLY_SCOPE]);
    }
  });

  it('persistGoogleIdpGrant + getGoogleAccessToken refreshes access token', async () => {
    const store = new InMemoryStandaloneSessionStore();
    const authManager = createTestAuthManager({
      providers: { google: TEST_AUTH.google },
      googleExtraScopes: [GOOGLE_CONTACTS_READONLY_SCOPE],
      idpTokenEncryptionKey: IDP_KEY,
      sessionStore: store
    });

    await authManager.persistGoogleIdpGrant(
      'google:99',
      {
        refresh_token: 'rt-secret',
        scope: GOOGLE_CONTACTS_READONLY_SCOPE
      },
      [GOOGLE_CONTACTS_READONLY_SCOPE]
    );

    const grant = await store.findIdpGrant('google:99');
    expect(grant.scopes).to.include(GOOGLE_CONTACTS_READONLY_SCOPE);
    expect(grant.sealedRefreshToken).to.be.a('string');
    expect(grant.sealedRefreshToken).to.not.include('rt-secret');

    authManager._refreshGoogleAccessToken = async (refreshToken) => {
      expect(refreshToken).to.equal('rt-secret');
      return {
        access_token: 'fresh-access',
        expires_in: 3600,
        scope: GOOGLE_CONTACTS_READONLY_SCOPE
      };
    };

    const result = await authManager.getGoogleAccessToken('google:99', {
      requiredScopes: [GOOGLE_CONTACTS_READONLY_SCOPE]
    });
    expect(result.accessToken).to.equal('fresh-access');
    expect(result.expiresIn).to.equal(3600);
  });

  it('requires idpTokenEncryptionKey when googleExtraScopes is set', () => {
    expect(
      () =>
        new AuthManager({
          providers: { google: TEST_AUTH.google },
          callbackUrl: TEST_AUTH.callbackUrl,
          issuer: TEST_AUTH.issuer,
          resourcePath: TEST_AUTH.resourcePath,
          jwtSecret: TEST_AUTH.jwtSecret,
          sessionSecret: TEST_AUTH.sessionSecret,
          jwtExpiresIn: TEST_AUTH.jwtExpiresIn,
          sessionStore: new InMemoryStandaloneSessionStore(),
          googleExtraScopes: [GOOGLE_CONTACTS_READONLY_SCOPE]
        })
    ).to.throw(/idpTokenEncryptionKey/);
  });
});
