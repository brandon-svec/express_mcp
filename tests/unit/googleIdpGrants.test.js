import { expect } from 'chai';
import {
  AuthManager,
  GOOGLE_CONTACTS_READONLY_SCOPE
} from '../../src/classes/authManager.js';
import { InMemoryStandaloneSessionStore } from '../../src/stores/inMemoryStandaloneSessionStore.js';
import { deriveSealKey, seal, unseal } from '../../src/crypto/seal.js';
import { GoogleGrantTool } from '../../src/tools/googleGrant.js';
import { createTestAuthManager, TEST_AUTH } from '../authTestUtils.js';

const IDP_KEY = 'test-idp-encryption-key-at-least-32!!';

describe('seal crypto', () => {
  it('round-trips plaintext', () => {
    const key = deriveSealKey(IDP_KEY);
    const sealed = seal('refresh-token-value', key);
    expect(unseal(sealed, key)).to.equal('refresh-token-value');
  });

  it('rejects short secrets', () => {
    expect(() => deriveSealKey('short')).to.throw(
      'idpTokenEncryptionKey must be a string of at least 32 characters'
    );
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
    expect(pending).to.deep.equal({
      context: { telegram_chat_id: '1' },
      provider: 'google',
      purpose: 'google_grant',
      scopes: [GOOGLE_CONTACTS_READONLY_SCOPE],
      sub: 'google:123'
    });
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
      expect(err.message).to.equal(
        'scope is not in googleExtraScopes allowlist: https://www.googleapis.com/auth/contacts'
      );
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
    expect({
      access_type: parsed.searchParams.get('access_type'),
      prompt: parsed.searchParams.get('prompt'),
      include_granted_scopes: parsed.searchParams.get('include_granted_scopes'),
      scope: parsed.searchParams.get('scope')
    }).to.deep.equal({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      scope: [
        'openid',
        'email',
        'profile',
        GOOGLE_CONTACTS_READONLY_SCOPE
      ].join(' ')
    });
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
      expect({
        name: err.name,
        reason: err.reason,
        message: err.message,
        missingScopes: err.missingScopes
      }).to.deep.equal({
        name: 'GoogleScopeGrantRequiredError',
        reason: 'no_grant',
        message: 'No Google extra-scope grant for this user',
        missingScopes: [GOOGLE_CONTACTS_READONLY_SCOPE]
      });
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
    expect({
      scopes: grant.scopes,
      plaintext: unseal(grant.sealedRefreshToken, deriveSealKey(IDP_KEY))
    }).to.deep.equal({
      scopes: [GOOGLE_CONTACTS_READONLY_SCOPE],
      plaintext: 'rt-secret'
    });

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
    expect(result).to.deep.equal({
      accessToken: 'fresh-access',
      scopes: [GOOGLE_CONTACTS_READONLY_SCOPE],
      expiresIn: 3600
    });
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
    ).to.throw(
      'idpTokenEncryptionKey (≥32 characters) is required when googleExtraScopes is set'
    );
  });

  it('revokeGoogleIdpGrant revokes at Google and deletes the grant', async () => {
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

    const originalFetch = globalThis.fetch;
    /** @type {{ url: string, method: string, body: string }|null} */
    let revokeRequest = null;
    globalThis.fetch = async (url, options) => {
      revokeRequest = {
        url: String(url),
        method: options.method,
        body: options.body
      };
      return { ok: true, status: 200, text: async () => '' };
    };
    try {
      const revoked = await authManager.revokeGoogleIdpGrant('google:99');
      expect({
        revoked,
        revokeRequest,
        grantAfter: await store.findIdpGrant('google:99')
      }).to.deep.equal({
        revoked: true,
        revokeRequest: {
          url: 'https://oauth2.googleapis.com/revoke',
          method: 'POST',
          body: new URLSearchParams({ token: 'rt-secret' }).toString()
        },
        grantAfter: null
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('revokeGoogleIdpGrant returns false when no grant exists', async () => {
    const authManager = createTestAuthManager({
      providers: { google: TEST_AUTH.google },
      googleExtraScopes: [GOOGLE_CONTACTS_READONLY_SCOPE],
      idpTokenEncryptionKey: IDP_KEY
    });
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, status: 200, text: async () => '' };
    };
    try {
      const revoked = await authManager.revokeGoogleIdpGrant('google:missing');
      expect({ revoked, fetchCalled }).to.deep.equal({
        revoked: false,
        fetchCalled: false
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('revokeGoogleIdpGrant treats Google 400 as already-revoked success', async () => {
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
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => 'invalid_token'
    });
    try {
      const revoked = await authManager.revokeGoogleIdpGrant('google:99');
      expect({
        revoked,
        grantAfter: await store.findIdpGrant('google:99')
      }).to.deep.equal({
        revoked: true,
        grantAfter: null
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('GoogleGrantTool', () => {
  it('describes extra scopes generally (not Contacts-only)', () => {
    const authManager = createTestAuthManager({
      providers: { google: TEST_AUTH.google },
      googleExtraScopes: [GOOGLE_CONTACTS_READONLY_SCOPE],
      idpTokenEncryptionKey: IDP_KEY
    });
    const tool = new GoogleGrantTool(authManager);
    expect(tool.description).to.include('Contacts, Calendar');
    expect(tool.description).to.not.match(/e\.g\. Contacts/);
  });

  it('status with grant returns granted true and scopes', async () => {
    const store = new InMemoryStandaloneSessionStore();
    const authManager = createTestAuthManager({
      providers: { google: TEST_AUTH.google },
      googleExtraScopes: [GOOGLE_CONTACTS_READONLY_SCOPE],
      idpTokenEncryptionKey: IDP_KEY,
      sessionStore: store
    });
    await authManager.persistGoogleIdpGrant(
      'google:1',
      {
        refresh_token: 'rt-1',
        scope: GOOGLE_CONTACTS_READONLY_SCOPE
      },
      [GOOGLE_CONTACTS_READONLY_SCOPE]
    );
    const tool = new GoogleGrantTool(authManager);
    const result = await tool.execute(
      { action: 'status' },
      { user: { sub: 'google:1' } }
    );
    expect(result).to.deep.equal({
      granted: true,
      scopes: [GOOGLE_CONTACTS_READONLY_SCOPE]
    });
  });

  it('status without grant returns granted false', async () => {
    const authManager = createTestAuthManager({
      providers: { google: TEST_AUTH.google },
      googleExtraScopes: [GOOGLE_CONTACTS_READONLY_SCOPE],
      idpTokenEncryptionKey: IDP_KEY
    });
    const tool = new GoogleGrantTool(authManager);
    const result = await tool.execute(
      { action: 'status' },
      { user: { sub: 'google:missing' } }
    );
    expect(result).to.deep.equal({ granted: false, scopes: [] });
  });

  it('revoke with grant returns revoked true and clears store', async () => {
    const store = new InMemoryStandaloneSessionStore();
    const authManager = createTestAuthManager({
      providers: { google: TEST_AUTH.google },
      googleExtraScopes: [GOOGLE_CONTACTS_READONLY_SCOPE],
      idpTokenEncryptionKey: IDP_KEY,
      sessionStore: store
    });
    await authManager.persistGoogleIdpGrant(
      'google:1',
      {
        refresh_token: 'rt-1',
        scope: GOOGLE_CONTACTS_READONLY_SCOPE
      },
      [GOOGLE_CONTACTS_READONLY_SCOPE]
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '' });
    try {
      const tool = new GoogleGrantTool(authManager);
      const result = await tool.execute(
        { action: 'revoke' },
        { user: { sub: 'google:1' } }
      );
      expect({
        result,
        grantAfter: await store.findIdpGrant('google:1')
      }).to.deep.equal({
        result: { revoked: true },
        grantAfter: null
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('revoke without grant returns no_grant', async () => {
    const authManager = createTestAuthManager({
      providers: { google: TEST_AUTH.google },
      googleExtraScopes: [GOOGLE_CONTACTS_READONLY_SCOPE],
      idpTokenEncryptionKey: IDP_KEY
    });
    const tool = new GoogleGrantTool(authManager);
    const result = await tool.execute(
      { action: 'revoke' },
      { user: { sub: 'google:missing' } }
    );
    expect(result).to.deep.equal({ revoked: false, reason: 'no_grant' });
  });

  it('throws when context.user.sub is missing', async () => {
    const authManager = createTestAuthManager({
      providers: { google: TEST_AUTH.google },
      googleExtraScopes: [GOOGLE_CONTACTS_READONLY_SCOPE],
      idpTokenEncryptionKey: IDP_KEY
    });
    const tool = new GoogleGrantTool(authManager);
    try {
      await tool.execute({ action: 'status' }, {});
      expect.fail('expected error');
    } catch (err) {
      expect(err.message).to.equal('Authenticated user.sub is required');
    }
  });
});
