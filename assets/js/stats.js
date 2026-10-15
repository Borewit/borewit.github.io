(() => {
  'use strict';

  // The same JSON source renders the project directory at build time.
  const projects = JSON.parse(document.getElementById('project-data').textContent);
  const packages = projects.filter(project => project.includeInDownloadTotal)
    .map(project => project.npmPackage);
  const trackedPackages = [...new Set([
    ...packages,
    ...projects.filter(project => project.feature && project.npmPackage)
      .map(project => project.npmPackage)
  ])];
  const section = document.querySelector('.oss-stats');
  if (!section) return;

  // Explicit UTC dates give every package the same complete calendar month.
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const dateKey = date => date.toISOString().slice(0, 10);
  const from = dateKey(start);
  const through = dateKey(end);
  const period = `${from}:${through}`;
  const format = new Intl.NumberFormat('en-US');
  const month = new Intl.DateTimeFormat('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC'
  }).format(start);
  document.getElementById('stats-period').textContent = `${month} · monthly npm downloads`;

  const results = new Map();
  const rows = new Map();
  const list = document.getElementById('stats-packages');
  for (const name of packages) {
    const row = document.createElement('li');
    const link = document.createElement('a');
    link.href = `https://www.npmjs.com/package/${name}`;
    link.textContent = name;
    const count = document.createElement('span');
    count.textContent = 'Loading…';
    row.append(link, count);
    list.append(row);
    rows.set(name, count);
  }

  async function fetchDownloads(name) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(
        `https://api.npmjs.org/downloads/point/${period}/${encodeURIComponent(name)}`,
        { signal: controller.signal }
      );
      if (!response.ok) throw new Error('npm request failed');
      const data = await response.json();
      if (data.package !== name || data.start !== from || data.end !== through ||
          !Number.isSafeInteger(data.downloads) || data.downloads < 0) {
        throw new Error('Invalid download statistics');
      }
      results.set(name, data.downloads);
      const count = format.format(data.downloads);
      if (rows.has(name)) rows.get(name).textContent = count;
      for (const card of section.querySelectorAll('[data-package]')) {
        if (card.dataset.package === name) card.textContent = count;
      }
    } catch {
      if (rows.has(name)) rows.get(name).textContent = 'Unavailable';
      for (const card of section.querySelectorAll('[data-package]')) {
        if (card.dataset.package === name) card.textContent = 'Unavailable';
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async function loadStats() {
    const queue = [...trackedPackages];
    // Bound concurrency, including individual requests for scoped packages.
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (queue.length) await fetchDownloads(queue.shift());
    }));

    const available = packages.filter(name => results.has(name));
    const complete = available.length === packages.length;
    const total = document.getElementById('stats-total');
    total.textContent = complete
      ? format.format(packages.reduce((sum, name) => sum + results.get(name), 0))
      : 'Unavailable';
    document.getElementById('stats-coverage').textContent = complete
      ? `Across ${packages.length} featured npm packages · ${month}`
      : `Data available for ${available.length} of ${packages.length} packages; total withheld`;
    document.getElementById('stats-status').textContent = complete && results.has('file-type')
      ? `Full calendar month: ${from} to ${through}. Live data from npm.`
      : 'Some npm statistics could not be loaded. Available figures are shown below; reload to try again.';
    section.setAttribute('aria-busy', 'false');
  }

  loadStats();
})();
