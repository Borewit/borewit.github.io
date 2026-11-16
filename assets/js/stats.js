(() => {
  'use strict';

  const section = document.querySelector('.oss-stats');
  if (!section) return;

  // The same JSON source renders the project directory at build time.
  const projects = JSON.parse(document.getElementById('project-data').textContent);
  const packages = [...new Set(projects
    .filter(project => project.includeInDownloadTotal && project.npmPackage)
    .map(project => project.npmPackage))];
  const trackedPackages = [...new Set([
    ...packages,
    ...projects.filter(project => project.feature && project.npmPackage)
      .map(project => project.npmPackage)
  ])];

  const requestTimeout = 10000;
  const requestInterval = 500;
  const maxAttempts = 3;
  const maxCooldownWait = 60000;
  const cacheMaxAge = 24 * 60 * 60 * 1000;
  const sleep = delay => new Promise(resolve => setTimeout(resolve, delay));
  let nextRequestAt = 0;
  let cooldownUntil = 0;
  let cachedCount = 0;

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
  document.getElementById('stats-period').textContent = `${month} · npm downloads per month`;

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

  function validDownloads(data, name) {
    return data && data.package === name && data.start === from && data.end === through &&
      Number.isSafeInteger(data.downloads) && data.downloads >= 0;
  }

  const cacheKey = name => `borewit:npm-downloads:v1:${period}:${name}`;
  function readCache(name) {
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey(name)));
      if (cached && validDownloads(cached.data, name) &&
          Number.isSafeInteger(cached.fetchedAt) && cached.fetchedAt >= 0 &&
          cached.fetchedAt <= Date.now()) return cached;
    } catch {
      // Storage can be disabled or contain invalid JSON; fetching still works.
    }
    return null;
  }

  function writeCache(name, data) {
    try {
      localStorage.setItem(cacheKey(name), JSON.stringify({ data, fetchedAt: Date.now() }));
    } catch {
      // Storage failures must not turn a successful API response into a failure.
    }
  }

  function showCount(name, count) {
    if (rows.has(name)) rows.get(name).textContent = count;
    for (const card of section.querySelectorAll('[data-package]')) {
      if (card.dataset.package === name) card.textContent = count;
    }
  }

  function recordDownloads(name, data, cached = false) {
    results.set(name, data.downloads);
    if (cached) cachedCount++;
    showCount(name, format.format(data.downloads));
  }

  function retryAfter(response) {
    const value = response.headers.get('Retry-After');
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
      return Number.isInteger(seconds) && seconds >= 0 ? seconds * 1000 : 0;
    }
    const delay = Date.parse(value) - Date.now();
    return Number.isFinite(delay) ? Math.max(0, delay) : 0;
  }

  async function waitForRequestSlot() {
    while (true) {
      // Do not wait indefinitely, or retry early when npm asks for a long pause.
      if (cooldownUntil - Date.now() > maxCooldownWait) return false;
      const delay = Math.max(nextRequestAt, cooldownUntil) - Date.now();
      if (delay <= 0) {
        nextRequestAt = Date.now() + requestInterval;
        return true;
      }
      await sleep(delay);
    }
  }

  async function fetchDownloads(name, cached) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (!await waitForRequestSlot()) break;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeout);
      let retryable = true;
      let serverDelay = 0;
      try {
        const response = await fetch(
          `https://api.npmjs.org/downloads/point/${period}/${encodeURIComponent(name)}`,
          { signal: controller.signal }
        );
        if (!response.ok) {
          retryable = response.status === 408 || response.status === 429 ||
            (response.status >= 500 && response.status <= 599);
          if (retryable) serverDelay = retryAfter(response);
          throw new Error('npm request failed');
        }
        const data = await response.json();
        if (!validDownloads(data, name)) {
          retryable = false;
          throw new Error('Invalid download statistics');
        }
        recordDownloads(name, data);
        writeCache(name, data);
        return;
      } catch {
        if (!retryable) break;
        // All workers share the cooldown, not just the package that failed.
        const delay = Math.max(serverDelay, 2000 * 2 ** attempt + Math.random() * 250);
        cooldownUntil = Math.max(cooldownUntil, Date.now() + delay);
        document.getElementById('stats-status').textContent =
          'npm statistics are temporarily unavailable. Cooling down before retrying…';
      } finally {
        clearTimeout(timeout);
      }
    }

    // A previous successful response for this exact month is better than no data.
    if (cached) recordDownloads(name, cached.data, true);
    else showCount(name, 'Unavailable');
  }

  async function loadStats() {
    const queue = [];
    for (const name of trackedPackages) {
      const cached = readCache(name);
      if (cached && Date.now() - cached.fetchedAt < cacheMaxAge) {
        recordDownloads(name, cached.data, true);
      } else {
        queue.push({ name, cached });
      }
    }
    // Two workers and globally spaced starts avoid a burst of npm requests.
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (queue.length) {
        const { name, cached } = queue.shift();
        await fetchDownloads(name, cached);
      }
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
    const source = cachedCount ? 'Includes cached npm data.'
      : results.size ? 'Live data from npm.' : 'npm data is currently unavailable.';
    let status = `Full calendar month: ${from} to ${through}. ${source}`;
    if (!complete) {
      status += ' Some npm statistics could not be loaded after retries. ' +
        'Available figures are shown below; reload later to try again.';
    } else if (trackedPackages.some(name => !results.has(name))) {
      status += ' Some shared-maintenance statistics are unavailable; the package total is complete.';
    }
    document.getElementById('stats-status').textContent = status;
    section.setAttribute('aria-busy', 'false');
  }

  loadStats();
})();
