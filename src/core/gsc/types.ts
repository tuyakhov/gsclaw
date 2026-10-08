// Raw Google Search Console API shapes (webmasters/v3 + searchconsole/v1).

export const SEARCH_TYPES = ['web', 'image', 'video', 'news', 'discover', 'googleNews'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export const DIMENSIONS = [
  'query',
  'page',
  'country',
  'device',
  'date',
  'searchAppearance',
  'hour',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const FILTER_DIMENSIONS = [
  'query',
  'page',
  'country',
  'device',
  'searchAppearance',
] as const;
export type FilterDimension = (typeof FILTER_DIMENSIONS)[number];

export const FILTER_OPERATORS = [
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'includingRegex',
  'excludingRegex',
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export const AGGREGATION_TYPES = ['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel'] as const;
export type AggregationType = (typeof AGGREGATION_TYPES)[number];

export const DATA_STATES = ['final', 'all', 'hourly_all'] as const;
export type DataState = (typeof DATA_STATES)[number];

export interface SiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

export interface DimensionFilter {
  dimension: FilterDimension;
  operator?: FilterOperator;
  expression: string;
}

export interface SearchAnalyticsRequest {
  startDate: string;
  endDate: string;
  dimensions?: Dimension[];
  type?: SearchType;
  dimensionFilterGroups?: { groupType?: 'and'; filters: DimensionFilter[] }[];
  aggregationType?: AggregationType;
  rowLimit?: number;
  startRow?: number;
  dataState?: DataState;
}

export interface SearchAnalyticsRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchAnalyticsResponse {
  rows?: SearchAnalyticsRow[];
  responseAggregationType?: string;
  metadata?: {
    first_incomplete_date?: string;
    first_incomplete_hour?: string;
    firstIncompleteDate?: string;
    firstIncompleteHour?: string;
  };
}

export interface InspectionIssue {
  issueMessage?: string;
  message?: string;
  issueType?: string;
  severity?: string;
}

export interface UrlInspectionResult {
  inspectionResultLink?: string;
  indexStatusResult?: {
    verdict?: string;
    coverageState?: string;
    robotsTxtState?: string;
    indexingState?: string;
    lastCrawlTime?: string;
    pageFetchState?: string;
    googleCanonical?: string;
    userCanonical?: string;
    sitemap?: string[];
    referringUrls?: string[];
    crawledAs?: string;
  };
  mobileUsabilityResult?: { verdict?: string; issues?: InspectionIssue[] };
  richResultsResult?: {
    verdict?: string;
    detectedItems?: {
      richResultType?: string;
      items?: { name?: string; issues?: InspectionIssue[] }[];
    }[];
  };
  ampResult?: {
    verdict?: string;
    ampUrl?: string;
    indexingState?: string;
    ampIndexStatusVerdict?: string;
    issues?: InspectionIssue[];
  };
}

export interface UrlInspectionResponse {
  inspectionResult?: UrlInspectionResult;
}

export interface Sitemap {
  path: string;
  lastSubmitted?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  lastDownloaded?: string;
  /** int64 fields arrive as strings. */
  warnings?: string | number;
  errors?: string | number;
  contents?: { type?: string; submitted?: string | number; indexed?: string | number }[];
}

export interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: { reason?: string; message?: string; domain?: string }[];
    details?: { '@type'?: string; reason?: string; metadata?: Record<string, string> }[];
  };
}
