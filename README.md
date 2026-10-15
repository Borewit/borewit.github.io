[![pages-build-deployment](https://github.com/Borewit/borewit.github.io/actions/workflows/pages/pages-build-deployment/badge.svg)](https://github.com/Borewit/borewit.github.io/actions/workflows/pages/pages-build-deployment)

# Repository for [borewit.github.io](https://borewit.github.io)

The homepage is `index.html`, rendered by Jekyll. Edit `_data/projects.json` to
update project names, descriptions, links, and categories. Projects with a
`feature` appear in the results section and download cards. `npmPackage` names
the npm package; `includeInDownloadTotal` controls whether its downloads count
toward the combined monthly total. Shared upstream work is shown separately.

Jekyll renders project content into HTML at build time and embeds the same data
for `assets/js/stats.js`. JavaScript only fetches live npm download statistics.
Page styles live in `assets/css/site.css` and `assets/css/stats.css`.
