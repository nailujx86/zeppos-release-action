'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ZEPP_ACTION_NO_RUN = 'true';
const { run, checkRequireStrings, truthy } = require('../src/index');
const { makeZab } = require('./helpers');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zepp-index-'));
}

function setInputs(values) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_') || key === 'GITHUB_REPOSITORY' || key === 'GITHUB_OUTPUT') delete process.env[key];
  }
  for (const [name, value] of Object.entries(values)) {
    process.env[`INPUT_${name.toUpperCase()}`] = String(value);
  }
}

beforeEach(() => setInputs({}));

test('truthy understands the usual spellings', () => {
  assert.equal(truthy('true'), true);
  assert.equal(truthy('yes'), true);
  assert.equal(truthy(''), false);
  assert.equal(truthy('false'), false);
  assert.equal(truthy(undefined), false);
});

test('require-strings accepts a satisfied guard', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'constants.js'), 'export const DEMO_MODE = false;\n');
  assert.deepEqual(checkRequireStrings('constants.js::DEMO_MODE = false', dir), []);
});

test('require-strings reports every problem, with file names', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'constants.js'), 'export const DEMO_MODE = true;\n');
  const problems = checkRequireStrings(
    ['constants.js::DEMO_MODE = false', 'missing.js::whatever', 'no-separator'].join('\n'),
    dir
  );
  assert.equal(problems.length, 3);
  assert.match(problems[0], /constants\.js does not contain "DEMO_MODE = false"/);
  assert.match(problems[1], /cannot read missing\.js/);
  assert.match(problems[2], /malformed/);
});

test('run fails when the zab glob matches nothing', async () => {
  const dir = tempDir();
  setInputs({
    zab: path.join(dir, 'dist', '*.zab'),
    'base-url': 'example.github.io/app/v1.0.0',
    build: 'false',
    'working-directory': dir,
  });
  await assert.rejects(run(), /expected exactly one \.zab/);
});

test('run fails when there is nowhere to point the QRs', async () => {
  const dir = tempDir();
  await makeZab(path.join(dir, 'dist', 'build.zab'));
  setInputs({
    zab: path.join(dir, 'dist', '*.zab'),
    build: 'false',
    'working-directory': dir,
    'out-dir': 'site',
  });
  await assert.rejects(run(), /nothing to point the QR codes at/);
});

test('run refuses a mismatched expect-version', async () => {
  const dir = tempDir();
  await makeZab(path.join(dir, 'dist', 'build.zab'), { version: '1.0.0' });
  setInputs({
    zab: path.join(dir, 'dist', '*.zab'),
    'base-url': 'example.github.io/app/v1.0.0',
    build: 'false',
    'working-directory': dir,
    'out-dir': 'site',
    'expect-version': '1.1.0',
  });
  await assert.rejects(run(), /expected app version 1\.1\.0, packaged 1\.0\.0/);
});

test('bad expiry is rejected before anything is read', async () => {
  setInputs({ 'base-url': 'example.github.io/app/v1', expiry: 'soon', build: 'false' });
  await assert.rejects(run(), /expiry must be a positive whole number/);
});

test('an expiry beyond safe-integer range is rejected', async () => {
  setInputs({ 'base-url': 'example.github.io/app/v1', expiry: '99999999999999999999', build: 'false' });
  await assert.rejects(run(), /expiry must be a positive whole number/);
});

test('publishing without a token fails fast', async () => {
  const dir = tempDir();
  await makeZab(path.join(dir, 'dist', 'build.zab'));
  setInputs({
    zab: path.join(dir, 'dist', '*.zab'),
    'publish-release': 'true',
    'github-token': '',
    build: 'false',
    'working-directory': dir,
    'out-dir': 'site',
  });
  await assert.rejects(run(), /publish-release needs a token/);
});

test('run packages a zab and reports outputs', async () => {
  const dir = tempDir();
  await makeZab(path.join(dir, 'dist', 'build.zab'));
  setInputs({
    zab: path.join(dir, 'dist', '*.zab'),
    'base-url': 'example.github.io/app/v1.0.0',
    build: 'false',
    'working-directory': dir,
    'out-dir': 'site',
    'expect-version': '1.0.0',
  });
  const outputFile = path.join(dir, 'outputs.txt');
  fs.writeFileSync(outputFile, '');
  process.env.GITHUB_OUTPUT = outputFile; // after setInputs, which clears it

  const document = await run();

  assert.equal(document.packages.length, 2);
  assert.equal(document.base, 'example.github.io/app/v1.0.0');
  assert.ok(fs.existsSync(path.join(dir, 'site', 'qr-round-466-zps.png')));
  const outputs = fs.readFileSync(outputFile, 'utf8');
  assert.match(outputs, /version<<ghadelimiter_[^\n]+\n1\.0\.0/);
  assert.match(outputs, /count<<ghadelimiter_[^\n]+\n2/);
  assert.match(outputs, /base-url<<ghadelimiter_[^\n]+\nexample\.github\.io\/app\/v1\.0\.0/);
});
