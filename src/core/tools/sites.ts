import { z } from 'zod';
import { listProperties, type Property } from '../gsc/sites.js';
import { mdTable, sections } from '../format.js';
import { defineTool, READ_ONLY } from './types.js';

export const listSites = defineTool({
  name: 'list_sites',
  title: 'List Search Console properties',
  description:
    "Lists every Search Console property this server can access, with its type (domain 'sc-domain:' vs URL-prefix) and permission level. Call this first to find the exact property to pass as site_url.",
  input: z.object({}),
  annotations: READ_ONLY,
  async run(ctx): Promise<{ identity: string; properties: Property[] }> {
    return { identity: ctx.gsc.identity.email, properties: await listProperties(ctx.gsc) };
  },
  format(result) {
    if (result.properties.length === 0) {
      return `No Search Console properties are visible to ${result.identity}. Add it as a user on your properties: Search Console → Settings → Users and permissions → Add user.`;
    }
    const table = mdTable(
      ['Property', 'Type', 'Permission'],
      result.properties.map((p) => [
        p.site_url,
        p.type === 'domain' ? 'domain' : 'URL prefix',
        p.has_access ? p.permission_level : 'unverified (no data)',
      ]),
    );
    return sections(
      `**${result.properties.length} properties** visible to ${result.identity}:`,
      table,
    );
  },
});
