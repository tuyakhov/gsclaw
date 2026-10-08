# Test fixtures

These JSON files mirror the response shapes documented for the Google Search Console API
(`webmasters/v3` sites, sitemaps and searchAnalytics, and `v1/urlInspection/index:inspect`),
including quirks such as int64 counters arriving as strings and the deprecated `indexed` field.

`test/helpers/fake-gsc.ts` serves them (plus a synthetic Search Analytics dataset) through a fake
`fetch`, so no test ever talks to Google.
