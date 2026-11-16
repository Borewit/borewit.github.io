'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(process.env.STATS_SCRIPT ||
  path.join(__dirname, '../assets/js/stats.js'), 'utf8');
const fixedNow = Date.parse('2026-11-16T12:00:00Z');
const day = 24 * 60 * 60 * 1000;
const project = (npmPackage, included = true, feature = false) => ({
  npmPackage, includeInDownloadTotal: included, feature
});
const defaultProjects = [
  project('music-metadata', true, true), project('strtok3', true, true),
  project('@tokenizer/token'), project('file-type', false, true)
];
const counts = { 'music-metadata': 100, strtok3: 200, '@tokenizer/token': 0, 'file-type': 999 };
const dataFor = (name, downloads = counts[name] ?? 1, from = '2026-10-01', through = '2026-10-31') => ({
  package: name, downloads, start: from, end: through
});
const cacheKey = (name, period = '2026-10-01:2026-10-31') =>
  `borewit:npm-downloads:v1:${period}:${name}`;
const cacheEntry = (name, age = 0, data = dataFor(name)) =>
  JSON.stringify({ data, fetchedAt: fixedNow - age });

class Element {
  constructor(text = '') {
    this.textContent = text;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
  }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes.set(name, value); }
}

async function runStats(options = {}) {
  let clock = options.now ?? fixedNow;
  let timerId = 0;
  const timers = new Map();
  const setTimer = (callback, delay = 0) => {
    const id = ++timerId;
    timers.set(id, { callback, at: clock + Math.max(0, delay) });
    return id;
  };
  const clearTimer = id => timers.delete(id);
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const section = new Element();
  section.setAttribute('aria-busy', 'true');
  const projects = options.projects ?? defaultProjects;
  const cards = projects.filter(p => p.feature && p.npmPackage).map(p => {
    const card = new Element('—');
    card.dataset.package = p.npmPackage;
    return card;
  });
  section.querySelectorAll = () => cards;
  const elements = Object.fromEntries([
    'stats-period', 'stats-total', 'stats-coverage', 'stats-status', 'stats-packages'
  ].map(id => [id, new Element()]));
  elements['project-data'] = new Element(JSON.stringify(projects));
  const document = {
    querySelector: () => options.noSection ? null : section,
    getElementById: id => elements[id],
    createElement: () => new Element()
  };
  const storage = options.storage ?? new Map();
  const localStorage = {
    getItem(key) {
      if (options.storageDisabled) throw new Error('Storage denied');
      return storage.get(key) ?? null;
    },
    setItem(key, value) {
      if (options.storageDisabled || options.storageFull) throw new Error('Storage denied');
      storage.set(key, value);
    }
  };
  const requests = [];
  const attempts = new Map();
  let active = 0;
  let maxActive = 0;
  async function fetch(url, { signal }) {
    const name = decodeURIComponent(url.split('/').at(-1));
    const attempt = (attempts.get(name) ?? 0) + 1;
    attempts.set(name, attempt);
    const request = { url, name, attempt, at: clock, aborted: false };
    requests.push(request);
    active++;
    maxActive = Math.max(maxActive, active);
    const plan = options.respond?.(name, attempt, request) ?? {};
    try {
      if (plan.hang || plan.latency) {
        await new Promise((resolve, reject) => {
          const timer = plan.hang ? null : setTimer(done, plan.latency);
          function done() {
            signal.removeEventListener('abort', abort);
            resolve();
          }
          function abort() {
            request.aborted = true;
            clearTimer(timer);
            reject(new Error('Aborted'));
          }
          signal.addEventListener('abort', abort, { once: true });
        });
      }
      if (plan.error) throw new Error('Network failure');
      const status = plan.status ?? 200;
      return {
        ok: status >= 200 && status < 300, status,
        headers: { get: () => plan.retryAfter ?? null },
        async json() {
          if (plan.invalidJson) throw new SyntaxError('Invalid JSON');
          return Object.hasOwn(plan, 'data') ? plan.data : dataFor(name);
        }
      };
    } finally {
      request.finishedAt = clock;
      active--;
    }
  }
  const deterministicMath = Object.create(Math);
  deterministicMath.random = () => 0;
  vm.runInNewContext(source, {
    document, localStorage, fetch, AbortController, Date: FakeDate, Intl,
    Math: deterministicMath, setTimeout: setTimer, clearTimeout: clearTimer
  }, { filename: 'stats.js' });

  // Drain promises before advancing virtual time so fast responses cannot time out.
  for (let step = 0; step < 1000; step++) {
    await new Promise(resolve => setImmediate(resolve));
    if (options.noSection || section.attributes.get('aria-busy') === 'false') {
      assert.equal(timers.size, 0, 'no pending timers after completion');
      return {
        requests, attempts, maxActive, storage, elapsed: clock - (options.now ?? fixedNow),
        total: elements['stats-total'].textContent,
        coverage: elements['stats-coverage'].textContent,
        status: elements['stats-status'].textContent,
        period: elements['stats-period'].textContent,
        rows: new Map(elements['stats-packages'].children.map(row =>
          [row.children[0].textContent, row.children[1].textContent])),
        cards: new Map(cards.map(card => [card.dataset.package, card.textContent]))
      };
    }
    assert.ok(timers.size, 'loading must have a request or scheduled retry');
    const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    timers.delete(id);
    clock = timer.at;
    timer.callback();
  }
  assert.fail('statistics did not settle within the timer budget');
}

function assertPaced(requests) {
  for (let i = 1; i < requests.length; i++) {
    assert.ok(requests[i].at - requests[i - 1].at >= 500, 'starts spaced by at least 500ms');
  }
}

test('complete counts include zero and scoped packages, deduplicate and exclude shared maintenance', async () => {
  const result = await runStats({ projects: [
    ...defaultProjects, project('music-metadata'), { includeInDownloadTotal: true }
  ] });
  assert.equal(result.total, '300');
  assert.equal(result.rows.size, 3);
  assert.equal(result.rows.get('@tokenizer/token'), '0');
  assert.equal(result.cards.get('file-type'), '999');
  assert.equal(result.requests.length, 4);
  assert.match(result.requests.find(r => r.name === '@tokenizer/token').url, /%40tokenizer%2Ftoken$/);
  assert.match(result.coverage, /Across 3/);
  assert.match(result.status, /Live data from npm/);
  assertPaced(result.requests);
});

test('slow requests never exceed two concurrent requests and starts remain paced', async () => {
  const result = await runStats({ respond: () => ({ latency: 1500 }) });
  assert.equal(result.maxActive, 2);
  assert.equal(result.total, '300');
  assertPaced(result.requests);
});

test('network failures retry with a shared cooldown before succeeding', async () => {
  const result = await runStats({ respond: (name, attempt) =>
    name === 'music-metadata' && attempt === 1 ? { error: true } : {} });
  assert.equal(result.attempts.get('music-metadata'), 2);
  assert.equal(result.total, '300');
  assert.ok(result.requests[1].at - result.requests[0].at >= 2000);
  assertPaced(result.requests);
});

test('429 Retry-After seconds pauses all queued requests, including another worker', async () => {
  const result = await runStats({ respond: (name, attempt) =>
    name === 'music-metadata' && attempt === 1 ? { status: 429, retryAfter: '5' } : {} });
  assert.equal(result.total, '300');
  assert.equal(result.attempts.get('music-metadata'), 2);
  assert.ok(result.requests.slice(1).every(request => request.at >= fixedNow + 5000));
  assertPaced(result.requests);
});

test('HTTP-date Retry-After is respected', async () => {
  const result = await runStats({ respond: (name, attempt) =>
    name === 'music-metadata' && attempt === 1
      ? { status: 503, retryAfter: new Date(fixedNow + 7000).toUTCString() } : {} });
  assert.equal(result.total, '300');
  assert.ok(result.requests[1].at >= fixedNow + 7000);
});

test('long Retry-After ends this load without retrying early or waiting indefinitely', async () => {
  const result = await runStats({ respond: () => ({ status: 429, retryAfter: '120' }) });
  assert.equal(result.requests.length, 1);
  assert.equal(result.total, 'Unavailable');
  assert.match(result.coverage, /0 of 3/);
  assert.doesNotMatch(result.status, /Live data/);
  assert.ok(result.elapsed < 120000);
});

test('transient HTTP failures and invalid JSON use bounded exponential retries', async t => {
  for (const plan of [{ status: 408 }, { status: 429 }, { status: 500 }, { status: 503 }, { invalidJson: true }]) {
    await t.test(JSON.stringify(plan), async () => {
      const result = await runStats({ projects: [project('music-metadata')], respond: () => plan });
      assert.equal(result.requests.length, 3);
      assert.equal(result.total, 'Unavailable');
      assert.ok(result.requests[1].at - result.requests[0].at >= 2000);
      assert.ok(result.requests[2].at - result.requests[1].at >= 4000);
      assert.match(result.status, /after retries/);
    });
  }
});

test('timeouts abort requests, retry and settle after three attempts', async () => {
  const result = await runStats({ projects: [project('music-metadata')], respond: () => ({ hang: true }) });
  assert.equal(result.requests.length, 3);
  assert.ok(result.requests.every(r => r.aborted && r.finishedAt - r.at === 10000));
  assert.equal(result.total, 'Unavailable');
});

test('permanent HTTP failures are not retried and withhold the total', async t => {
  for (const status of [400, 401, 403, 404]) {
    await t.test(String(status), async () => {
      const result = await runStats({ respond: name => name === 'strtok3' ? { status } : {} });
      assert.equal(result.attempts.get('strtok3'), 1);
      assert.equal(result.total, 'Unavailable');
      assert.match(result.coverage, /2 of 3/);
      assert.equal(result.rows.get('strtok3'), 'Unavailable');
    });
  }
});

test('invalid package, month and download values cannot enter the total or cache', async t => {
  const invalid = [null, dataFor('wrong-package'), { ...dataFor('music-metadata'), start: '2026-09-01' },
    { ...dataFor('music-metadata'), end: '2026-10-30' }, dataFor('music-metadata', -1),
    dataFor('music-metadata', 1.5), dataFor('music-metadata', '100'),
    dataFor('music-metadata', Number.MAX_SAFE_INTEGER + 1)];
  for (const data of invalid) {
    await t.test(JSON.stringify(data), async () => {
      const result = await runStats({ projects: [project('music-metadata')], respond: () => ({ data }) });
      assert.equal(result.total, 'Unavailable');
      assert.equal(result.requests.length, 1);
      assert.equal(result.storage.size, 0);
    });
  }
});

test('fresh same-month cache avoids requests on reload and preserves zero counts', async () => {
  const first = await runStats();
  const result = await runStats({ now: fixedNow + 60000, storage: first.storage });
  assert.equal(result.total, '300');
  assert.equal(result.requests.length, 0);
  assert.equal(result.rows.get('@tokenizer/token'), '0');
  assert.match(result.status, /cached npm data/);
});

test('only a newly added package is fetched when the other results are cached', async () => {
  const first = await runStats();
  const result = await runStats({ now: fixedNow + 60000, storage: first.storage,
    projects: [...defaultProjects, project('token-types')] });
  assert.equal(result.total, '301');
  assert.deepEqual(result.requests.map(r => r.name), ['token-types']);
});

test('expired exact-month cache is refreshed and used as a fallback after retry failure', async () => {
  const storage = new Map([[cacheKey('music-metadata'), cacheEntry('music-metadata', day)]]);
  const result = await runStats({ projects: [project('music-metadata')], storage,
    respond: () => ({ status: 503 }) });
  assert.equal(result.requests.length, 3);
  assert.equal(result.total, '100');
  assert.match(result.status, /cached npm data/);
  assert.ok(!result.status.includes('Live data'));
  assert.equal(JSON.parse(storage.get(cacheKey('music-metadata'))).fetchedAt, fixedNow - day);
});

test('successful refresh replaces expired cache and is described as live data', async () => {
  const storage = new Map([[cacheKey('music-metadata'), cacheEntry('music-metadata', day)]]);
  const result = await runStats({ projects: [project('music-metadata')], storage,
    respond: () => ({ data: dataFor('music-metadata', 150) }) });
  assert.equal(result.total, '150');
  assert.equal(JSON.parse(storage.get(cacheKey('music-metadata'))).data.downloads, 150);
  assert.match(result.status, /Live data from npm/);
});

test('corrupt, future, wrong-month and invalid cached counts are rejected', async t => {
  const invalid = ['not JSON', 'null', '{}', cacheEntry('music-metadata', -day),
    cacheEntry('music-metadata', 0, dataFor('other-package')),
    cacheEntry('music-metadata', 0, dataFor('music-metadata', -1)),
    cacheEntry('music-metadata', 0, dataFor('music-metadata', 100, '2026-09-01', '2026-09-30')),
    JSON.stringify({ data: dataFor('music-metadata'), fetchedAt: '2026-11-16' })];
  for (const entry of invalid) {
    await t.test(entry, async () => {
      const storage = new Map([[cacheKey('music-metadata'), entry]]);
      const result = await runStats({ projects: [project('music-metadata')], storage,
        respond: () => ({ status: 404 }) });
      assert.equal(result.requests.length, 1);
      assert.equal(result.total, 'Unavailable');
    });
  }
});

test('blocked or full localStorage does not break successful live requests', async t => {
  for (const options of [{ storageDisabled: true }, { storageFull: true }]) {
    await t.test(JSON.stringify(options), async () => {
      const result = await runStats(options);
      assert.equal(result.total, '300');
      assert.equal(result.requests.length, 4);
    });
  }
});

test('shared-only failure does not withhold the owned total or claim it is incomplete', async () => {
  const result = await runStats({ respond: name => name === 'file-type' ? { status: 404 } : {} });
  assert.equal(result.total, '300');
  assert.equal(result.cards.get('file-type'), 'Unavailable');
  assert.match(result.status, /shared-maintenance statistics are unavailable/);
  assert.match(result.status, /package total is complete/);
});

test('malformed and negative Retry-After values fall back to exponential cooldown', async t => {
  for (const retryAfter of ['not a date', '-1', '-9999', '0.5']) {
    await t.test(retryAfter, async () => {
      const result = await runStats({ projects: [project('music-metadata')], respond: (name, attempt) =>
        attempt === 1 ? { status: 429, retryAfter } : {} });
      assert.equal(result.total, '100');
      assert.equal(result.requests[1].at - fixedNow, 2000);
    });
  }
});

test('month calculation handles January rollover and leap-year February in UTC', async t => {
  for (const [now, from, through, month] of [
    ['2027-01-01T00:30:00Z', '2026-12-01', '2026-12-31', 'December 2026'],
    ['2024-03-01T00:30:00Z', '2024-02-01', '2024-02-29', 'February 2024']
  ]) {
    await t.test(month, async () => {
      const result = await runStats({ now: Date.parse(now), projects: [project('music-metadata')],
        respond: name => ({ data: dataFor(name, 100, from, through) }) });
      assert.equal(result.total, '100');
      assert.ok(result.period.startsWith(month));
      assert.ok(result.requests[0].url.includes(`${from}:${through}`));
    });
  }
});

test('a page without the statistics section makes no requests', async () => {
  const result = await runStats({ noSection: true });
  assert.equal(result.requests.length, 0);
});

test('a late rate-limit response also pauses workers that were already waiting', async () => {
  const result = await runStats({ projects: [...defaultProjects, project('token-types'), project('win-guid')],
    respond: (name, attempt) => name === 'music-metadata' && attempt === 1
      ? { latency: 1500, status: 429, retryAfter: '3' } : {} });
  assert.equal(result.total, '302');
  const failure = result.requests[0].finishedAt;
  assert.ok(result.requests.filter(r => r.at >= failure).every(r => r.at >= failure + 3000));
  assertPaced(result.requests);
});

test('previous-month cache is never used for the next calendar month', async () => {
  const first = await runStats();
  const result = await runStats({ storage: first.storage, now: Date.parse('2026-12-01T12:00:00Z'),
    projects: [project('music-metadata')], respond: () => ({ status: 404 }) });
  assert.equal(result.total, 'Unavailable');
  assert.equal(result.requests.length, 1);
  assert.ok(result.requests[0].url.includes('2026-11-01:2026-11-30'));
});

test('the period label explicitly describes downloads per month', async () => {
  const result = await runStats();
  assert.equal(result.period, 'October 2026 · npm downloads per month');
});
