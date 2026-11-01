'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const exec = require('@actions/exec');
const core = require('@actions/core');

const { normaliseBase } = require('./pack');

const API = 'https://api.github.com';
const UPLOAD = 'https://uploads.github.com';

/** The one place a version becomes a directory name, so the push and the QR URL cannot drift. */
function pagesDirFor(version) {
  return `v${version}`;
}

function pagesBaseUrl(repo, pagesDir) {
  const [owner, name] = String(repo).split('/');
  const isUserSite = Boolean(name) && name.toLowerCase() === `${owner.toLowerCase()}.github.io`;
  return normaliseBase(`${owner}.github.io${isUserSite ? '' : `/${name}`}/${pagesDir}`);
}

function releaseBaseUrl(repo, tag) {
  return normaliseBase(`github.com/${repo}/releases/download/${tag}`);
}

/** Where the QR codes point. Explicit base wins, then Pages (direct 200), then release assets. */
function resolveBaseUrl({ baseUrl = '', publishPages = false, publishRelease = false, repo = '', tag = '', pagesDir = '' }) {
  if (baseUrl) return normaliseBase(baseUrl);
  if (publishPages) {
    if (!repo) throw new Error('publish-pages needs GITHUB_REPOSITORY to be set');
    return pagesBaseUrl(repo, pagesDir);
  }
  if (publishRelease) {
    if (!repo) throw new Error('publish-release needs GITHUB_REPOSITORY to be set');
    return releaseBaseUrl(repo, tag);
  }
  throw new Error('nothing to point the QR codes at: set `base-url`, `publish-pages: true`, or `publish-release: true`');
}

/**
 * Push files into <branch>/<destDir>/ of repoUrl, leaving every other directory alone.
 * A printed QR code bakes the URL in, so an older version must never be deleted.
 */
async function publishPages({ repoUrl, branch = 'gh-pages', destDir, files, message }) {
  // destDir becomes a path that is rm -rf'd and committed: keep it a single plain
  // name so it can never reach outside the worktree.
  if (!/^[A-Za-z0-9._-]+$/.test(String(destDir || ''))) {
    throw new Error(`destination must be a plain directory name, got ${JSON.stringify(destDir)}`);
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zepp-pages-'));
  const run = (args, options = {}) => exec.exec('git', args, { cwd: work, silent: true, ...options });

  try {
    await run(['init', '-q']);
    await run(['remote', 'add', 'origin', repoUrl]);

    let exists = true;
    try {
      await run(['fetch', '-q', '--depth=1', 'origin', branch]);
    } catch {
      exists = false;
    }
    if (exists) {
      await run(['checkout', '-q', '-B', branch, 'FETCH_HEAD']);
    } else {
      core.info(`branch ${branch} does not exist yet, creating it`);
      await run(['checkout', '-q', '--orphan', branch]);
    }

    const target = path.join(work, destDir);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    for (const file of files) {
      fs.copyFileSync(file, path.join(target, path.basename(file)));
    }

    await run(['add', '-A']);
    await run(
      [
        '-c', 'user.name=github-actions[bot]',
        '-c', 'user.email=github-actions[bot]@users.noreply.github.com',
        'commit', '-q', '-m', message || `publish ${destDir}`,
      ],
      { ignoreReturnCode: true }
    );
    await run(['push', '-q', 'origin', `HEAD:${branch}`]);
    core.info(`published ${files.length} files to ${branch}/${destDir}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function readJson(response) {
  if (typeof response.json !== 'function') return {};
  return response.json().catch(() => ({}));
}

/** Create or update the release for `tag`, then upload every asset (replacing same names). */
async function publishRelease({
  repo,
  tag,
  name,
  body,
  assets,
  token,
  apiBase = API,
  uploadBase = UPLOAD,
  fetchImpl = fetch,
}) {
  if (!token) throw new Error('publish-release needs a token (input `github-token`)');
  const headers = {
    authorization: `token ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  const jsonHeaders = { ...headers, 'content-type': 'application/json' };
  const names = assets.map((file) => path.basename(file));

  const existing = await fetchImpl(`${apiBase}/repos/${repo}/releases/tags/${tag}`, { headers });
  let release;

  if (existing.status === 404) {
    const created = await fetchImpl(`${apiBase}/repos/${repo}/releases`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ tag_name: tag, name, body, draft: false, prerelease: false }),
    });
    if (!created.ok) {
      throw new Error(`creating release ${tag} failed: ${created.status} ${JSON.stringify(await readJson(created))}`);
    }
    release = await created.json();
  } else {
    if (!existing.ok) {
      throw new Error(`reading release ${tag} failed: ${existing.status} ${JSON.stringify(await readJson(existing))}`);
    }
    release = await existing.json();
    const updated = await fetchImpl(`${apiBase}/repos/${repo}/releases/${release.id}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ name, body }),
    });
    if (!updated.ok) {
      throw new Error(`updating release ${tag} failed: ${updated.status} ${JSON.stringify(await readJson(updated))}`);
    }
    release = await updated.json();

    const listed = await fetchImpl(`${apiBase}/repos/${repo}/releases/${release.id}/assets?per_page=100`, { headers });
    if (listed.ok) {
      for (const asset of await listed.json()) {
        if (names.includes(asset.name)) {
          await fetchImpl(`${apiBase}/repos/${repo}/releases/assets/${asset.id}`, { method: 'DELETE', headers });
          core.info(`replaced existing asset ${asset.name}`);
        }
      }
    }
  }

  for (const file of assets) {
    const filename = path.basename(file);
    const uploaded = await fetchImpl(
      `${uploadBase}/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(filename)}`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        body: fs.readFileSync(file),
      }
    );
    if (!uploaded.ok) {
      throw new Error(`uploading ${filename} failed: ${uploaded.status} ${JSON.stringify(await readJson(uploaded))}`);
    }
  }

  core.info(`release ${tag} now carries ${assets.length} assets`);
  return release.html_url;
}

module.exports = { resolveBaseUrl, pagesBaseUrl, releaseBaseUrl, pagesDirFor, publishPages, publishRelease };
