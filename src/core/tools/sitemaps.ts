import { z } from 'zod';
import { UserFacingError } from '../errors.js';
import { fmtInt, mdTable, sections } from '../format.js';
import type { Sitemap } from '../gsc/types.js';
import { propertyFor, siteUrlField } from './common.js';
import { defineTool, READ_ONLY } from './types.js';

export interface SitemapSummary {
  path: string;
  type: string | null;
  is_index: boolean;
  is_pending: boolean;
  last_submitted: string | null;
  last_downloaded: string | null;
  errors: number;
  warnings: number;
  /** URLs submitted per content type. Google no longer reports indexed counts for sitemaps. */
  submitted: number;
  contents: { type: string; submitted: number }[];
}

const num = (v: string | number | undefined) => (v === undefined ? 0 : Number(v) || 0);

export function summarizeSitemap(s: Sitemap): SitemapSummary {
  const contents = (s.contents ?? []).map((c) => ({
    type: c.type ?? 'web',
    submitted: num(c.submitted),
  }));
  return {
    path: s.path,
    type: s.type ?? null,
    is_index: Boolean(s.isSitemapsIndex),
    is_pending: Boolean(s.isPending),
    last_submitted: s.lastSubmitted ?? null,
    last_downloaded: s.lastDownloaded ?? null,
    errors: num(s.errors),
    warnings: num(s.warnings),
    submitted: contents.reduce((sum, c) => sum + c.submitted, 0),
    contents,
  };
}

const INDEXED_NOTE =
  '_Google no longer reports per-sitemap indexed counts (the API field is deprecated). Use inspect_url / batch_inspect_urls to check index status of specific URLs._';

function sitemapTable(sitemaps: SitemapSummary[]): string {
  return mdTable(
    ['Sitemap', 'Type', 'Submitted URLs', 'Errors', 'Warnings', 'Last read', 'Status'],
    sitemaps.map((s) => [
      s.path,
      s.is_index ? 'index' : (s.type ?? '—'),
      fmtInt(s.submitted),
      s.errors,
      s.warnings,
      s.last_downloaded?.slice(0, 10) ?? 'never',
      s.is_pending ? 'pending' : s.errors > 0 ? 'has errors' : 'ok',
    ]),
  );
}

export const listSitemaps = defineTool({
  name: 'list_sitemaps',
  title: 'List sitemaps',
  description:
    'Lists sitemaps submitted for a property with status, errors, warnings, submitted URL counts and when Google last read them. Pass sitemap_index to list the children of a sitemap index.',
  input: z.object({
    site_url: siteUrlField,
    sitemap_index: z
      .string()
      .url()
      .optional()
      .describe('Full URL of a sitemap index to list its child sitemaps.'),
  }),
  annotations: READ_ONLY,
  async run(ctx, input) {
    const property = await propertyFor(ctx, input.site_url);
    const sitemaps = await ctx.gsc.listSitemaps(property.site_url, input.sitemap_index);
    return { site_url: property.site_url, sitemaps: sitemaps.map(summarizeSitemap) };
  },
  format(r) {
    if (r.sitemaps.length === 0) {
      return `No sitemaps are submitted for ${r.site_url}. Submit one in Search Console → Sitemaps (or with submit_sitemap if writes are enabled).`;
    }
    const withErrors = r.sitemaps.filter((s) => s.errors > 0).length;
    return sections(
      `**${r.sitemaps.length} sitemap(s)** for ${r.site_url}${withErrors ? ` — ${withErrors} with errors` : ''}:`,
      sitemapTable(r.sitemaps),
      INDEXED_NOTE,
    );
  },
});

export const getSitemap = defineTool({
  name: 'get_sitemap',
  title: 'Get sitemap details',
  description:
    'Shows one sitemap: status, errors, warnings, submitted URL counts per content type and last download time.',
  input: z.object({
    site_url: siteUrlField,
    sitemap_url: z
      .string()
      .url()
      .describe('Full sitemap URL exactly as submitted (see list_sitemaps).'),
  }),
  annotations: READ_ONLY,
  async run(ctx, input) {
    const property = await propertyFor(ctx, input.site_url);
    return {
      site_url: property.site_url,
      sitemap: summarizeSitemap(await ctx.gsc.getSitemap(property.site_url, input.sitemap_url)),
    };
  },
  format(r) {
    const s = r.sitemap;
    const contents = s.contents.map((c) => `${c.type}: ${fmtInt(c.submitted)}`).join(' · ');
    return sections(
      `**Sitemap** ${s.path}`,
      [
        `- Type: ${s.is_index ? 'sitemap index' : (s.type ?? 'unknown')}${s.is_pending ? ' (processing pending)' : ''}`,
        `- Submitted URLs: ${fmtInt(s.submitted)}${contents ? ` (${contents})` : ''}`,
        `- Errors: ${s.errors} · Warnings: ${s.warnings}`,
        `- Last submitted: ${s.last_submitted ?? 'unknown'} · Last read by Google: ${s.last_downloaded ?? 'never'}`,
      ].join('\n'),
      INDEXED_NOTE,
    );
  },
});

const WRITE_NOTE =
  'Requires GSCLAW_ALLOW_WRITES=true and Full (not Restricted) permission on the property.';

export const submitSitemap = defineTool({
  name: 'submit_sitemap',
  title: 'Submit sitemap (writes to Search Console)',
  description: `MUTATES STATE: submits (or resubmits) a sitemap URL to Search Console for the property, asking Google to crawl it. ${WRITE_NOTE}`,
  input: z.object({
    site_url: siteUrlField,
    sitemap_url: z.string().url().describe('Full sitemap URL to submit. Must be on the property.'),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  write: true,
  async run(ctx, input) {
    const property = await propertyFor(ctx, input.site_url);
    if (property.permission_level === 'restricted') {
      throw new UserFacingError(
        `Restricted users cannot submit sitemaps. Give ${ctx.gsc.identity.email} Full permission on '${property.site_url}' in Search Console → Settings → Users and permissions.`,
        'permission',
      );
    }
    await ctx.gsc.submitSitemap(property.site_url, input.sitemap_url);
    return { site_url: property.site_url, sitemap_url: input.sitemap_url, submitted: true };
  },
  format(r) {
    return `Submitted ${r.sitemap_url} for ${r.site_url}. Google will fetch it shortly; check status later with get_sitemap.`;
  },
});

export const deleteSitemap = defineTool({
  name: 'delete_sitemap',
  title: 'Delete sitemap (writes to Search Console)',
  description: `MUTATES STATE (destructive): removes a submitted sitemap from Search Console for the property. This does not delete the file from your site. ${WRITE_NOTE}`,
  input: z.object({
    site_url: siteUrlField,
    sitemap_url: z
      .string()
      .url()
      .describe('Full sitemap URL to remove, exactly as listed by list_sitemaps.'),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  write: true,
  async run(ctx, input) {
    const property = await propertyFor(ctx, input.site_url);
    await ctx.gsc.deleteSitemap(property.site_url, input.sitemap_url);
    return { site_url: property.site_url, sitemap_url: input.sitemap_url, deleted: true };
  },
  format(r) {
    return `Removed ${r.sitemap_url} from Search Console for ${r.site_url}. The file on your site is unchanged.`;
  },
});
