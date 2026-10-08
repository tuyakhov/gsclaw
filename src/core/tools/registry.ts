import { comparePeriods } from './compare.js';
import { contentDecay } from './content-decay.js';
import { batchInspectUrls, inspectUrl } from './inspection.js';
import {
  ctrOpportunities,
  keywordCannibalization,
  strikingDistanceKeywords,
} from './opportunities.js';
import { pageReport } from './page-report.js';
import { searchAnalytics } from './search-analytics.js';
import { listSites } from './sites.js';
import { deleteSitemap, getSitemap, listSitemaps, submitSitemap } from './sitemaps.js';
import type { AnyTool } from './types.js';

/** Every tool, in the order clients list them. */
export const ALL_TOOLS: AnyTool[] = [
  listSites,
  searchAnalytics,
  comparePeriods,
  strikingDistanceKeywords,
  ctrOpportunities,
  keywordCannibalization,
  contentDecay,
  pageReport,
  inspectUrl,
  batchInspectUrls,
  listSitemaps,
  getSitemap,
  submitSitemap,
  deleteSitemap,
] as AnyTool[];

/** Tools available for a request: write tools only when enabled and the credentials can write. */
export function availableTools(opts: { allowWrites: boolean; canWrite: boolean }): AnyTool[] {
  return ALL_TOOLS.filter((tool) => !tool.write || (opts.allowWrites && opts.canWrite));
}

export function findTool(name: string): AnyTool | undefined {
  return ALL_TOOLS.find((tool) => tool.name === name);
}
