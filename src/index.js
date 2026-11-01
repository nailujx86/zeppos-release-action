'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('@actions/core');
const exec = require('@actions/exec');
const glob = require('@actions/glob');

const pack = require('./pack');
const qr = require('./qr');
const publish = require('./publish');

const FALSEY = new Set(['', 'false', '0', 'no', 'off']);

function truthy(value) {
  return !FALSEY.has(String(value ?? '').trim().toLowerCase());
}

function checkRequireStrings(value, cwd) {
  const problems = [];
  const lines = String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const split = line.indexOf('::');
    if (split < 1) {
      problems.push(`require-strings: malformed entry (expected file::text): ${line}`);
      continue;
    }
    const file = path.resolve(cwd, line.slice(0, split).trim());
    const needle = line.slice(split + 2).trim();
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      problems.push(`require-strings: cannot read ${path.relative(cwd, file)}`);
      continue;
    }
    if (!content.includes(needle)) {
      problems.push(`require-strings: ${path.relative(cwd, file)} does not contain ${JSON.stringify(needle)}`);
    }
  }
  return problems;
}

async function findZab(cwd, pattern) {
  const globber = await glob.create(path.resolve(cwd, pattern), { followSymbolicLinks: false });
  const matches = (await globber.glob()).filter((file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) {
    const found = matches.length ? `: ${matches.join(', ')}` : '';
    throw new Error(`expected exactly one .zab matching ${pattern}, found ${matches.length}${found}`);
  }
  return matches[0];
}

async function run() {
  const cwd = path.resolve(core.getInput('working-directory') || '.');
  const repo = process.env.GITHUB_REPOSITORY || '';
  const token = core.getInput('github-token');
  const publishPages = truthy(core.getInput('publish-pages'));
  const publishRelease = truthy(core.getInput('publish-release'));

  const expiry = Number(core.getInput('expiry') || pack.DEFAULT_EXPIRY);
  if (!Number.isSafeInteger(expiry) || expiry <= 0) {
    throw new Error(`expiry must be a positive whole number of seconds, got ${core.getInput('expiry')}`);
  }
  if (expiry > 2147483647) {
    core.warning(
      `expiry ${expiry} exceeds INT32_MAX (2147483647): a consumer holding expiredTime in a signed 32-bit int would read it as already expired`
    );
  }
  if (publishPages && !token) throw new Error('publish-pages needs a token (input `github-token`)');
  if (publishRelease && !token) throw new Error('publish-release needs a token (input `github-token`)');
  if (token) core.setSecret(token); // registered with the log masker before anything runs

  const problems = checkRequireStrings(core.getInput('require-strings'), cwd);
  if (problems.length) throw new Error(problems.join('\n'));

  if (truthy(core.getInput('build'))) {
    await exec.exec('npm', ['install', '--include=dev'], { cwd });
    await exec.exec('npm', ['run', 'build'], { cwd }); // argv, not a shell - no `&&` here
  }

  const zabPath = await findZab(cwd, core.getInput('zab') || 'dist/*.zab');
  const parsed = await pack.readZab(fs.readFileSync(zabPath), path.basename(zabPath));
  const app = pack.appMetaFor(parsed);

  const expected = core.getInput('expect-version');
  if (expected && expected !== app.version) {
    throw new Error(`expected app version ${expected}, packaged ${app.version}`);
  }

  const tag = core.getInput('tag') || `v${app.version}`;
  const versionDir = publish.pagesDirFor(app.version);
  const base = publish.resolveBaseUrl({
    baseUrl: core.getInput('base-url'),
    publishPages,
    publishRelease,
    repo,
    tag,
    pagesDir: versionDir,
  });

  const outDir = path.resolve(cwd, core.getInput('out-dir') || 'zepp-site');
  const devices = pack.loadDevices(path.join(os.homedir(), '.zepp', '.zeus_devices'));
  const document = await pack.packZab(parsed, { outDir, base, expiry, devices });

  for (const entry of document.packages) {
    await qr.writeQr(pack.payloadFor(document.base, entry.file), path.join(outDir, entry.qr));
  }

  // Always: a QR that does not decode back to its payload is the one failure this
  // action exists to prevent, and ruling it out is cheap.
  const bad = [];
  for (const entry of document.packages) {
    const want = pack.payloadFor(document.base, entry.file);
    const got = qr.readQr(path.join(outDir, entry.qr));
    if (got !== want) bad.push(`${entry.qr}: decoded ${JSON.stringify(got)}`);
  }
  if (bad.length) throw new Error(`QR verification failed:\n${bad.join('\n')}`);

  const packages = document.packages;
  const zpks = packages.flatMap((entry) => [path.join(outDir, entry.file), path.join(outDir, entry.rawFile)]);
  const qrFiles = packages.map((entry) => path.join(outDir, entry.qr));

  if (publishPages) {
    await publish.publishPages({
      repoUrl: `https://x-access-token:${token}@github.com/${repo}.git`,
      branch: 'gh-pages',
      destDir: versionDir,
      files: zpks,
      message: `publish ${versionDir} (${app.appName} ${app.version})`,
    });
  }

  let releaseUrl = '';
  if (publishRelease) {
    // Pages hosts the packages when it is on, so the release only needs the QR images.
    const assets = publishPages ? [...qrFiles, zabPath] : [...zpks, ...qrFiles, zabPath];
    releaseUrl =
      (await publish.publishRelease({
        repo,
        tag,
        name: `${app.appName} ${app.version}`,
        body: fs.readFileSync(path.join(outDir, 'release-notes.md'), 'utf8'),
        assets,
        token,
      })) || '';
  }

  if (truthy(core.getInput('check-urls'))) {
    const missing = [];
    for (const entry of packages) {
      const url = pack.urlFor(document.base, entry.file);
      if (!(await qr.probe(url))) missing.push(url);
    }
    if (missing.length) throw new Error(`unreachable package URLs:\n${missing.join('\n')}`);
  }

  core.setOutput('version', app.version || '');
  core.setOutput('count', String(packages.length));
  core.setOutput('out-dir', outDir);
  core.setOutput('notes', path.join(outDir, 'release-notes.md'));
  core.setOutput('files', packages.map((entry) => path.join(outDir, entry.file)).join('\n'));
  core.setOutput('base-url', document.base);
  core.setOutput('release-url', releaseUrl);

  core.info(`packaged ${packages.length} device packages into ${outDir}`);
  // Only inside Actions; a local run has no summary file to append to.
  if (process.env.GITHUB_STEP_SUMMARY) {
    await core.summary.addRaw(fs.readFileSync(path.join(outDir, 'release-notes.md'), 'utf8')).write();
  }
  return document;
}

if (process.env.ZEPP_ACTION_NO_RUN !== 'true') {
  run().catch((error) => core.setFailed(error.message));
}

module.exports = { run, checkRequireStrings, truthy };
