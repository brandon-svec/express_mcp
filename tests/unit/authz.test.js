import { assert } from 'chai';
import {
  isUserAllowed,
  normalizeAllowlist,
  parseAllowedUsersFromEnv,
  userLogFields
} from '../../src/authz.js';

describe('authz', () => {
  const user = {
    sub: 'google:1',
    login: 'octocat',
    email: 'Octo@Example.com',
    provider: 'google'
  };

  it('parseAllowedUsersFromEnv splits and trims', () => {
    assert.deepEqual(
      parseAllowedUsersFromEnv(' a@x.com , bob '),
      ['a@x.com', 'bob']
    );
    assert.deepEqual(parseAllowedUsersFromEnv(''), []);
    assert.deepEqual(parseAllowedUsersFromEnv(undefined), []);
  });

  it('normalizeAllowlist lowercases entries', () => {
    const set = normalizeAllowlist(['A@X.com', 'Bob']);
    assert.isTrue(set.has('a@x.com'));
    assert.isTrue(set.has('bob'));
  });

  it('isUserAllowed returns true when allowlist empty', () => {
    assert.isTrue(isUserAllowed(user, []));
    assert.isTrue(isUserAllowed(user, undefined));
  });

  it('isUserAllowed matches email case-insensitively', () => {
    assert.isTrue(isUserAllowed(user, ['octo@example.com']));
    assert.isFalse(isUserAllowed(user, ['other@example.com']));
  });

  it('isUserAllowed matches login case-insensitively', () => {
    assert.isTrue(isUserAllowed(user, ['Octocat']));
    assert.isFalse(isUserAllowed(user, ['otheruser']));
  });

  it('isUserAllowed returns false without user when allowlist set', () => {
    assert.isFalse(isUserAllowed(null, ['a@x.com']));
  });

  it('userLogFields omits token and includes identity fields', () => {
    assert.deepEqual(userLogFields(user), {
      sub: user.sub,
      login: user.login,
      email: user.email,
      provider: user.provider
    });
    assert.deepEqual(userLogFields(null), {});
  });
});
