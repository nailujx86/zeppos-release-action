'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const publish = require('../src/publish');

function tempDir(prefix = 'zepp-pub-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function gitShow(bare, ref) {
  return execFileSync('git', [`--git-dir=${bare}`, 'show', ref], { encoding: 'utf8' });
}

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    calls.push({ url, method, body: options.body });
    const result = handler({ url, method, options }) || {};
    return {
      ok: result.status ? result.status >= 200 && result.status < 300 : true,
      status: result.status || 200,
      json: async () => result.json,
      text: async () => JSON.stringify(result.json === undefined ? '' : result.json),
    };
  };
  return { fetchImpl, calls };
}

const SHORT = (url) => url.replace('https://api.github.com', '').replace('https://uploads.github.com', '');

test('resolveBaseUrl prefers an explicit base, then pages, then release', () => {
  const common = { repo: 'nailujx86/uv-index', tag: 'v1.0.0', pagesDir: 'v1.0.0' };
  assert.equal(
    publish.resolveBaseUrl({ ...common, baseUrl: '/example.github.io/app/v2.0.0/', publishPages: true, publishRelease: true }),
    'example.github.io/app/v2.0.0'
  );
  assert.equal(
    publish.resolveBaseUrl({ ...common, publishPages: true, publishRelease: true }),
    'nailujx86.github.io/uv-index/v1.0.0'
  );
  assert.equal(
    publish.resolveBaseUrl({ ...common, publishRelease: true }),
    'github.com/nailujx86/uv-index/releases/download/v1.0.0'
  );
  assert.equal(
    publish.resolveBaseUrl({ repo: 'nailujx86/nailujx86.github.io', tag: 'v1', pagesDir: 'v1', publishPages: true }),
    'nailujx86.github.io/v1',
    'user-site repos have no project path segment'
  );
  assert.throws(() => publish.resolveBaseUrl({ ...common }), /set `base-url`/);
});

test('publishPages refuses a destination that escapes the worktree', async () => {
  await assert.rejects(
    publish.publishPages({ repoUrl: '/tmp/nowhere.git', branch: 'gh-pages', destDir: 'v1.0.0/../../evil', files: [] }),
    /plain directory name/
  );
  await assert.rejects(
    publish.publishPages({ repoUrl: '/tmp/nowhere.git', branch: 'gh-pages', destDir: '../evil', files: [] }),
    /plain directory name/
  );
  await assert.rejects(
    publish.publishPages({ repoUrl: '/tmp/nowhere.git', branch: 'gh-pages', destDir: '', files: [] }),
    /plain directory name/
  );
});

test('publishPages creates the branch, then keeps other versions', async () => {
  const bare = path.join(tempDir(), 'site.git');
  execFileSync('git', ['init', '--bare', '-q', bare]);
  const src = tempDir();
  const one = path.join(src, 'a.zpk');
  const two = path.join(src, 'b.zpk');
  fs.writeFileSync(one, 'AAA');
  fs.writeFileSync(two, 'BBB');

  await publish.publishPages({ repoUrl: bare, branch: 'gh-pages', destDir: 'v1.0.0', files: [one] });
  assert.equal(gitShow(bare, 'gh-pages:v1.0.0/a.zpk'), 'AAA');

  await publish.publishPages({ repoUrl: bare, branch: 'gh-pages', destDir: 'v1.1.0', files: [two] });
  assert.equal(gitShow(bare, 'gh-pages:v1.0.0/a.zpk'), 'AAA', 'an older version was wiped');
  assert.equal(gitShow(bare, 'gh-pages:v1.1.0/b.zpk'), 'BBB');

  await publish.publishPages({ repoUrl: bare, branch: 'gh-pages', destDir: 'v1.0.0', files: [two] });
  assert.equal(gitShow(bare, 'gh-pages:v1.0.0/b.zpk'), 'BBB');
  assert.throws(() => gitShow(bare, 'gh-pages:v1.0.0/a.zpk'), 'stale file survived a republish');
});

test('publishRelease creates the release, then uploads every asset', async () => {
  const dir = tempDir();
  const asset = path.join(dir, 'uv-index-1-0-0-round-466-zps.zpk');
  fs.writeFileSync(asset, 'AAA');

  const { fetchImpl, calls } = fakeFetch(({ url, method }) => {
    if (method === 'GET' && url.endsWith('/releases/tags/v1.0.0')) return { status: 404 };
    if (method === 'POST' && url.endsWith('/releases')) return { json: { id: 11, html_url: 'https://example/rel/11' } };
    if (method === 'POST' && url.includes('/assets?name=')) return { json: { id: 1 } };
    return { status: 500 };
  });

  const url = await publish.publishRelease({
    repo: 'o/r',
    tag: 'v1.0.0',
    name: 'UV Index 1.0.0',
    body: 'body',
    assets: [asset],
    token: 't',
    fetchImpl,
  });

  assert.equal(url, 'https://example/rel/11');
  assert.deepEqual(
    calls.map((call) => `${call.method} ${SHORT(call.url)}`),
    [
      'GET /repos/o/r/releases/tags/v1.0.0',
      'POST /repos/o/r/releases',
      'POST /repos/o/r/releases/11/assets?name=uv-index-1-0-0-round-466-zps.zpk',
    ]
  );
  assert.equal(JSON.parse(calls[1].body).tag_name, 'v1.0.0');
});

test('publishRelease updates an existing release and replaces same-named assets', async () => {
  const dir = tempDir();
  const asset = path.join(dir, 'qr-round-466-zps.png');
  fs.writeFileSync(asset, 'PNG');

  const { fetchImpl, calls } = fakeFetch(({ url, method }) => {
    if (method === 'GET' && url.endsWith('/releases/tags/v1.0.0')) return { json: { id: 7, html_url: 'https://example/rel/7' } };
    if (method === 'PATCH') return { json: { id: 7, html_url: 'https://example/rel/7' } };
    if (method === 'GET' && url.includes('/assets?per_page=100')) return { json: [{ id: 5, name: 'qr-round-466-zps.png' }] };
    if (method === 'DELETE') return {};
    if (method === 'POST' && url.includes('/assets?name=')) return { json: { id: 6 } };
    return { status: 500 };
  });

  await publish.publishRelease({
    repo: 'o/r',
    tag: 'v1.0.0',
    name: 'UV Index 1.0.0',
    body: 'body',
    assets: [asset],
    token: 't',
    fetchImpl,
  });

  assert.deepEqual(
    calls.map((call) => `${call.method} ${SHORT(call.url)}`),
    [
      'GET /repos/o/r/releases/tags/v1.0.0',
      'PATCH /repos/o/r/releases/7',
      'GET /repos/o/r/releases/7/assets?per_page=100',
      'DELETE /repos/o/r/releases/assets/5',
      'POST /repos/o/r/releases/7/assets?name=qr-round-466-zps.png',
    ]
  );
});

test('publishRelease fails loudly when the api refuses', async () => {
  const dir = tempDir();
  const asset = path.join(dir, 'a.zpk');
  fs.writeFileSync(asset, 'AAA');
  const { fetchImpl } = fakeFetch(({ method }) => {
    if (method === 'GET') return { status: 404 };
    return { status: 403, json: { message: 'Resource not accessible by integration' } };
  });
  await assert.rejects(
    publish.publishRelease({ repo: 'o/r', tag: 'v1', name: 'n', body: 'b', assets: [asset], token: 't', fetchImpl }),
    /403/
  );
});
