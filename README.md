[![pages-build-deployment](https://github.com/Borewit/borewit.github.io/actions/workflows/pages/pages-build-deployment/badge.svg)](https://github.com/Borewit/borewit.github.io/actions/workflows/pages/pages-build-deployment)

# Repository for [borewit.github.io](https://borewit.github.io)

The homepage is `index.html`, rendered by Jekyll. Edit `_data/projects.json` to
update project names, descriptions, links, and categories. Projects with a
`feature` appear in the results section and download cards. `npmPackage` names
the npm package; `includeInDownloadTotal` controls whether its downloads per
month count toward the combined total. Shared upstream work is shown separately.

Jekyll renders project content into HTML at build time and embeds the same data
for `assets/js/stats.js`. JavaScript fetches npm downloads per month for the last
complete UTC calendar month.
Page styles live in `assets/css/site.css` and `assets/css/stats.css`.

## Download statistics

The browser starts npm requests at least 500 ms apart, with at most two requests
in flight. Network errors, timeouts, HTTP 408/429, and server errors get up to
three attempts with exponential backoff and jitter. All requests share the
cooldown, including any readable `Retry-After` header. A requested cooldown over
60 seconds stops further requests for that page load rather than retrying early.
Each request has a 10-second timeout.

Validated results are cached in local storage per package and calendar month for
24 hours. If a refresh fails, a previously successful result for that exact month
can still be shown; the status explicitly identifies cached data. Disabled or
full storage does not prevent live fetching. The combined total remains withheld
unless every included package has valid data. Shared-maintenance package failures
do not withhold the owned-package total.

Run the network-free regression tests (no Jekyll build or dependencies required):

```sh
node --test test/stats.test.cjs
```

## Sponsor credit

The homepage acknowledges CodeRabbit with a small “Code reviews powered by”
credit in the support section. The official logo for
light backgrounds is stored locally, unchanged, at
`assets/images/sponsors/coderabbit.svg`, so visitors do not need to fetch it from
an external site.

Logo source: [CodeRabbit brand guidelines](https://www.coderabbit.ai/brand),
[orange logotype SVG](https://www.coderabbit.ai/content/assets/orange-typemark.svg).
Keep the supplied artwork, proportions, and clear space intact.
