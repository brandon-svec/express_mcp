/**
 * Authorization allowlist helpers for MCP authenticated users.
 */

/**
 * Parse comma-separated allowlist from env string.
 * @param {string} [value]
 * @returns {string[]}
 */
export function parseAllowedUsersFromEnv(value) {
  if (!value || typeof value !== 'string' || !value.trim()) {
    return [];
  }
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

/**
 * @param {string[]} [users]
 * @returns {Set<string>}
 */
export function normalizeAllowlist(users) {
  if (!users || users.length === 0) {
    return new Set();
  }
  return new Set(users.map((entry) => entry.toLowerCase()));
}

/**
 * True if allowlist is empty (allow all authenticated) or user matches email/login.
 * @param {Object|null} mcpUser - JWT payload (sub, login, email, ...)
 * @param {string[]} [allowedUsers]
 * @returns {boolean}
 */
export function isUserAllowed(mcpUser, allowedUsers) {
  if (!allowedUsers || allowedUsers.length === 0) {
    return true;
  }
  if (!mcpUser) {
    return false;
  }

  const allowlist = normalizeAllowlist(allowedUsers);
  const candidates = [mcpUser.email, mcpUser.login]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  return candidates.some((value) => allowlist.has(value));
}

/**
 * Safe user fields for structured logs (never includes tokens).
 * @param {Object|null} mcpUser
 * @returns {Object}
 */
export function userLogFields(mcpUser) {
  if (!mcpUser) {
    return {};
  }
  return {
    sub: mcpUser.sub,
    login: mcpUser.login,
    email: mcpUser.email,
    provider: mcpUser.provider
  };
}
