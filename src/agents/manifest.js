/**
 * Build Turn-0 domain expert system-instruction text:
 * service identity plus a compact operational playbooks directory.
 *
 * Does not reprint tool catalogs (those live in Gemini toolDeclarations and
 * the escalation MCP CAPABILITIES block).
 *
 * @param {{
 *   serverName?: string,
 *   serviceDescription?: string,
 *   agentDescription?: string,
 *   playbooks?: Array<{
 *     title?: string,
 *     uri?: string,
 *     summary?: string,
 *     tools?: string[],
 *   }>,
 * }} options
 * @returns {string} Markdown fragment, or '' when there is nothing to inject
 */
export function buildDomainExpertManifest (options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('buildDomainExpertManifest requires a plain options object');
  }

  if (options.playbooks !== undefined && !Array.isArray(options.playbooks)) {
    throw new Error('playbooks must be an array when provided');
  }

  const serverName = typeof options.serverName === 'string' ? options.serverName.trim() : '';
  const serviceDescription = typeof options.serviceDescription === 'string'
    ? options.serviceDescription.trim()
    : '';
  const agentDescription = typeof options.agentDescription === 'string'
    ? options.agentDescription.trim()
    : '';
  const role = serviceDescription || agentDescription;
  const playbooks = options.playbooks ?? [];

  if (!serverName && !role && playbooks.length === 0) {
    return '';
  }

  const lines = [];

  if (serverName || role) {
    lines.push('SERVICE DOMAIN & IDENTITY:');
    if (serverName) {
      lines.push(`Service: ${serverName}`);
    }
    if (role) {
      lines.push(`Role: ${role}`);
    }
  }

  if (playbooks.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('OPERATIONAL PLAYBOOKS & PROCEDURES:');
    lines.push('The following official playbooks define business rules and procedures for this service:');
    for (const playbook of playbooks) {
      if (!playbook || typeof playbook !== 'object' || Array.isArray(playbook)) {
        throw new Error('playbooks entries must be plain objects');
      }
      const title = typeof playbook.title === 'string' && playbook.title.trim()
        ? playbook.title.trim()
        : '(untitled)';
      const uri = typeof playbook.uri === 'string' ? playbook.uri.trim() : '';
      const summary = typeof playbook.summary === 'string' ? playbook.summary.trim() : '';
      const tools = Array.isArray(playbook.tools)
        ? playbook.tools.filter((name) => typeof name === 'string' && name.trim())
        : [];

      let bullet = uri
        ? `- "${title}" (${uri})`
        : `- "${title}"`;
      if (summary) {
        bullet += `: ${summary}`;
      }
      lines.push(bullet);
      if (tools.length > 0) {
        lines.push(`  Governs tools: ${tools.join(', ')}`);
      }
    }
    lines.push('When fulfilling requests governed by a playbook, follow its prescribed steps.');
  }

  return lines.join('\n');
}
