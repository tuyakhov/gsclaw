import { z } from 'zod';
import { publicErrorMessage, UserFacingError } from '../errors.js';
import { compactUrl, mdTable, sections } from '../format.js';
import type { GscClient } from '../gsc/client.js';
import { listProperties, propertyCoversUrl, resolveProperty, type Property } from '../gsc/sites.js';
import type { UrlInspectionResult } from '../gsc/types.js';
import { displayHost } from './common.js';
import { defineTool, READ_ONLY, type ToolContext } from './types.js';

export interface InspectionSummary {
  url: string;
  site_url: string;
  verdict: string;
  coverage_state: string | null;
  indexing_state: string | null;
  robots_txt_state: string | null;
  page_fetch_state: string | null;
  last_crawl_time: string | null;
  crawled_as: string | null;
  google_canonical: string | null;
  user_canonical: string | null;
  /** True when Google chose a different canonical than the page declares. */
  canonical_mismatch: boolean;
  sitemaps: string[];
  referring_urls: string[];
  /** Deprecated by Google; reported only when present. */
  /** Only present when Google still returns a verdict: the Mobile Usability report is retired. */
  mobile_usability?: { verdict: string; issues: string[] };
  rich_results: {
    verdict: string;
    items: { type: string; name: string | null; issues: string[] }[];
  } | null;
  inspection_link: string | null;
}

const urlField = z
  .string()
  .url()
  .describe('Full URL of the page to inspect (must belong to the property).');
const optionalSiteField = z
  .string()
  .optional()
  .describe(
    'Property that contains the URL. Optional: inferred from your properties when omitted.',
  );

/** Finds the most specific readable property that contains `url`. */
export async function propertyForUrl(
  gsc: GscClient,
  url: string,
  siteUrl?: string,
): Promise<Property> {
  if (siteUrl) {
    const property = await resolveProperty(gsc, siteUrl);
    if (!propertyCoversUrl(property, url)) {
      throw new UserFacingError(`${url} is not inside the property '${property.site_url}'.`);
    }
    return property;
  }
  const properties = (await listProperties(gsc)).filter(
    (p) => p.has_access && propertyCoversUrl(p, url),
  );
  // URL-prefix properties are more specific than domain properties; longer prefixes win.
  properties.sort(
    (a, b) =>
      Number(b.type === 'url_prefix') - Number(a.type === 'url_prefix') ||
      b.site_url.length - a.site_url.length,
  );
  const best = properties[0];
  if (!best)
    throw new UserFacingError(
      `None of your Search Console properties contains ${url}. Run list_sites to check.`,
      'not_found',
    );
  return best;
}

/**
 * Google retired the Mobile Usability report, and the API now answers VERDICT_UNSPECIFIED with no
 * issues for every URL. Keep the field only when it still says something.
 */
function mobileUsability(
  mobile: UrlInspectionResult['mobileUsabilityResult'],
  issues: (list?: { issueMessage?: string; message?: string; severity?: string }[]) => string[],
): Pick<InspectionSummary, 'mobile_usability'> {
  const verdict = mobile?.verdict ?? 'VERDICT_UNSPECIFIED';
  const found = issues(mobile?.issues);
  if (!mobile || (verdict === 'VERDICT_UNSPECIFIED' && found.length === 0)) return {};
  return { mobile_usability: { verdict, issues: found } };
}

export function summarizeInspection(
  url: string,
  siteUrl: string,
  result: UrlInspectionResult | undefined,
): InspectionSummary {
  const idx = result?.indexStatusResult ?? {};
  const google = idx.googleCanonical ?? null;
  const user = idx.userCanonical ?? null;
  const issues = (list?: { issueMessage?: string; message?: string; severity?: string }[]) =>
    (list ?? []).map(
      (i) => `${i.severity ? `${i.severity}: ` : ''}${i.issueMessage ?? i.message ?? 'issue'}`,
    );
  return {
    url,
    site_url: siteUrl,
    verdict: idx.verdict ?? 'VERDICT_UNSPECIFIED',
    coverage_state: idx.coverageState ?? null,
    indexing_state: idx.indexingState ?? null,
    robots_txt_state: idx.robotsTxtState ?? null,
    page_fetch_state: idx.pageFetchState ?? null,
    last_crawl_time: idx.lastCrawlTime ?? null,
    crawled_as: idx.crawledAs ?? null,
    google_canonical: google,
    user_canonical: user,
    canonical_mismatch: Boolean(google && user && google !== user),
    sitemaps: idx.sitemap ?? [],
    referring_urls: (idx.referringUrls ?? []).slice(0, 10),
    ...mobileUsability(result?.mobileUsabilityResult, issues),
    rich_results: result?.richResultsResult
      ? {
          verdict: result.richResultsResult.verdict ?? 'VERDICT_UNSPECIFIED',
          items: (result.richResultsResult.detectedItems ?? []).flatMap((d) =>
            (d.items ?? [{}]).map((item) => ({
              type: d.richResultType ?? 'unknown',
              name: item.name ?? null,
              issues: issues(item.issues),
            })),
          ),
        }
      : null,
    inspection_link: result?.inspectionResultLink ?? null,
  };
}

export async function inspectOne(
  ctx: ToolContext,
  url: string,
  siteUrl?: string,
  languageCode?: string,
): Promise<InspectionSummary> {
  const property = await propertyForUrl(ctx.gsc, url, siteUrl);
  const res = await ctx.gsc.inspectUrl(property.site_url, url, languageCode);
  return summarizeInspection(url, property.site_url, res.inspectionResult);
}

export function formatInspection(s: InspectionSummary): string {
  const lines = [
    `**URL Inspection** for ${s.url}`,
    `- Verdict: **${s.verdict}**${s.coverage_state ? ` — ${s.coverage_state}` : ''}`,
    `- Indexing: ${s.indexing_state ?? 'unknown'} · robots.txt: ${s.robots_txt_state ?? 'unknown'} · fetch: ${s.page_fetch_state ?? 'unknown'}`,
    `- Last crawl: ${s.last_crawl_time ?? 'never / unknown'}${s.crawled_as ? ` (${s.crawled_as.toLowerCase()} crawler)` : ''}`,
    `- Canonical — Google: ${s.google_canonical ?? 'n/a'} · declared: ${s.user_canonical ?? 'n/a'}${s.canonical_mismatch ? ' ⚠️ **mismatch**' : ''}`,
  ];
  if (s.sitemaps.length) lines.push(`- In sitemaps: ${s.sitemaps.join(', ')}`);
  if (s.rich_results) {
    const items = s.rich_results.items
      .map(
        (i) =>
          `${i.type}${i.name ? ` (${i.name})` : ''}${i.issues.length ? `: ${i.issues.join('; ')}` : ''}`,
      )
      .join(' · ');
    lines.push(`- Rich results: ${s.rich_results.verdict}${items ? ` — ${items}` : ''}`);
  }
  if (s.mobile_usability) {
    lines.push(
      `- Mobile usability (deprecated report): ${s.mobile_usability.verdict}${s.mobile_usability.issues.length ? ` — ${s.mobile_usability.issues.join('; ')}` : ''}`,
    );
  }
  if (s.inspection_link) lines.push(`- Open in Search Console: ${s.inspection_link}`);
  lines.push('_URL Inspection reports the indexed version; it is not a live test._');
  return lines.join('\n');
}

export const inspectUrl = defineTool({
  name: 'inspect_url',
  title: 'Inspect URL (index status)',
  description:
    "Shows Google's index status for one URL: verdict, coverage state, robots.txt and fetch status, last crawl, Google-selected vs declared canonical, sitemaps and rich results. Uses the URL Inspection API (quota: 2,000/day and 600/min per property).",
  input: z.object({
    url: urlField,
    site_url: optionalSiteField,
    language_code: z.string().default('en-US').describe('Language for issue messages (BCP-47).'),
  }),
  annotations: READ_ONLY,
  async run(ctx, input) {
    return inspectOne(ctx, input.url, input.site_url, input.language_code);
  },
  format: formatInspection,
});

export interface BatchInspectionResult {
  inspected: number;
  failed: number;
  verdicts: Record<string, number>;
  coverage: Record<string, number>;
  canonical_mismatches: number;
  results: InspectionSummary[];
  errors: { url: string; error: string }[];
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export const batchInspectUrls = defineTool({
  name: 'batch_inspect_urls',
  title: 'Inspect many URLs',
  description:
    'Runs URL Inspection on a list of URLs with limited concurrency and summarizes index status (verdicts, coverage states, canonical mismatches). Each URL costs one URL Inspection call (2,000/day and 600/min per property), so keep batches focused.',
  input: z.object({
    urls: z
      .array(z.string().url())
      .min(1)
      .max(500)
      .describe('URLs to inspect (the server caps the batch size; default cap 50).'),
    site_url: optionalSiteField,
    concurrency: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe('Parallel requests (max 10 ≈ the 600/min quota).'),
  }),
  annotations: READ_ONLY,
  async run(ctx, input): Promise<BatchInspectionResult> {
    const urls = [...new Set(input.urls)];
    if (urls.length > ctx.config.batchInspectMax) {
      throw new UserFacingError(
        `Too many URLs (${urls.length}). This server allows up to ${ctx.config.batchInspectMax} per batch (GSCLAW_BATCH_INSPECT_MAX) to protect the 2,000/day URL Inspection quota. Split the list.`,
      );
    }
    const outcomes = await mapWithConcurrency(urls, input.concurrency, async (url) => {
      try {
        return { ok: true as const, value: await inspectOne(ctx, url, input.site_url) };
      } catch (error) {
        return {
          ok: false as const,
          url,
          error: publicErrorMessage(error).message.split('\n')[0]!,
        };
      }
    });
    const results = outcomes.flatMap((o) => (o.ok ? [o.value] : []));
    const errors = outcomes.flatMap((o) => (o.ok ? [] : [{ url: o.url, error: o.error }]));
    const count = (values: (string | null)[]) =>
      values.reduce<Record<string, number>>((acc, v) => {
        const k = v ?? 'unknown';
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {});
    return {
      inspected: results.length,
      failed: errors.length,
      verdicts: count(results.map((r) => r.verdict)),
      coverage: count(results.map((r) => r.coverage_state)),
      canonical_mismatches: results.filter((r) => r.canonical_mismatch).length,
      results,
      errors,
    };
  },
  format(r) {
    const host = r.results[0] ? displayHost(r.results[0].site_url) : undefined;
    const summary = Object.entries(r.coverage)
      .sort((a, b) => b[1] - a[1])
      .map(([state, n]) => `${n} × ${state}`)
      .join(' · ');
    const table = mdTable(
      ['URL', 'Verdict', 'Coverage', 'Last crawl', 'Canonical'],
      r.results.map((s) => [
        compactUrl(s.url, host),
        s.verdict,
        s.coverage_state,
        s.last_crawl_time?.slice(0, 10) ?? '—',
        s.canonical_mismatch
          ? `⚠️ Google chose ${compactUrl(s.google_canonical ?? '', host)}`
          : 'ok',
      ]),
    );
    return sections(
      `**Inspected ${r.inspected} URL(s)**${r.failed ? `, ${r.failed} failed` : ''}. ${summary}`,
      r.canonical_mismatches
        ? `⚠️ ${r.canonical_mismatches} URL(s) where Google picked a different canonical.`
        : null,
      table,
      r.errors.length
        ? `**Errors:**\n${r.errors.map((e) => `- ${e.url}: ${e.error}`).join('\n')}`
        : null,
    );
  },
});
