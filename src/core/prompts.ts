import { z } from 'zod';

export const seoHealthCheckArgs = z.object({
  site_url: z
    .string()
    .describe("Property to review, e.g. 'sc-domain:example.com' or 'example.com'."),
  date_range: z
    .enum(['last_28_days', 'last_3_months', 'last_6_months'])
    .optional()
    .describe('Analysis period (default last_28_days).'),
  brand_terms: z
    .string()
    .optional()
    .describe(
      "Optional RE2 regex of brand queries to exclude from opportunity analysis, e.g. 'acme|acme corp'.",
    ),
});

export function seoHealthCheckPrompt(args: z.output<typeof seoHealthCheckArgs>): string {
  const range = args.date_range ?? 'last_28_days';
  const brand = args.brand_terms
    ? `Pass exclude_queries: "${args.brand_terms}" to the opportunity tools so brand searches don't skew results.`
    : 'If the site has obvious brand queries, mention that a brand-excluded view (exclude_queries) may change the picture.';
  return `Run a complete SEO health check of the Search Console property "${args.site_url}" using the GSClaw tools. Period: ${range}.

Work through these steps, calling the tools yourself:
1. list_sites: confirm the exact property and that we have access.
2. compare_periods (dimension "none", then "query" and "page", compare_to "previous_period"): overall trend and the biggest movers. If the period allows, also check compare_to "year_over_year" to separate seasonality from real change.
3. striking_distance_keywords: the best quick-win queries ranking ~8–20.
4. ctr_opportunities: high-impression queries whose CTR is below expectation for their position (title/description fixes).
5. keyword_cannibalization: queries split across several pages.
6. content_decay: pages in steady decline.
7. list_sitemaps: sitemap errors/warnings and whether Google reads them.
8. page_report or inspect_url for the 2–3 most important pages you found (top losers or top striking-distance pages), to check index status and canonicals.
${brand}

Then write a concise report:
- **Summary**: 3–5 bullets on overall health and trend (with numbers).
- **Prioritized actions**: a numbered list ordered by expected impact vs effort. For each: the page/query, the evidence (numbers from the tools), and the concrete fix.
- **Technical issues**: indexing, canonical or sitemap problems, if any.
- **Watch list**: things to re-check in 2–4 weeks.

Remember: Search Console data lags ~2–3 days, positions are averages, and rare queries are anonymized. Don't invent numbers; cite only what the tools returned.`;
}
