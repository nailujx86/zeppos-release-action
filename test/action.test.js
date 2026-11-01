'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const YAML = require('yaml');

const ROOT = path.resolve(__dirname, '..');
const ACTION = YAML.parse(fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8'));
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');

test('marketplace metadata is present and within limits', () => {
  assert.ok(ACTION.name, 'name is required');
  assert.ok(ACTION.name.length <= 60, `name is ${ACTION.name.length} chars`);
  assert.ok(ACTION.description, 'description is required');
  assert.ok(ACTION.description.length <= 125, `description is ${ACTION.description.length} chars, max 125`);
  assert.ok(ACTION.author, 'author is required');
  assert.ok(ACTION.branding, 'branding is required to publish');
  assert.match(ACTION.branding.icon, /^[a-z-]+$/);
  assert.match(ACTION.branding.color, /^(white|yellow|blue|green|orange|red|purple|gray-dark)$/);
});

test('runs on the current actions runtime', () => {
  assert.equal(ACTION.runs.using, 'node24');
  assert.equal(ACTION.runs.main, 'dist/index.js');
  // The bundle being present and current is enforced by CI (`git diff --exit-code dist`)
  // and by the self-test workflow, which cannot run without it.
});

test('every input read by the code is declared', () => {
  const used = [...INDEX.matchAll(/core\.getInput\('([^']+)'/g)].map((match) => match[1]);
  assert.ok(used.length >= 12, `only found ${used.length} inputs in src/index.js`);
  for (const name of used) {
    assert.ok(ACTION.inputs[name], `src/index.js reads input "${name}" but action.yml does not declare it`);
  }
});

test('every declared input is read', () => {
  const used = new Set([...INDEX.matchAll(/core\.getInput\('([^']+)'/g)].map((match) => match[1]));
  for (const name of Object.keys(ACTION.inputs)) {
    assert.ok(used.has(name), `action.yml declares input "${name}" that src/index.js never reads`);
  }
});

test('every input and output is documented in the README', () => {
  for (const name of Object.keys(ACTION.inputs)) {
    assert.ok(README.includes(`\`${name}\``), `input "${name}" is not mentioned in README.md`);
  }
  for (const name of Object.keys(ACTION.outputs)) {
    assert.ok(README.includes(`\`${name}\``), `output "${name}" is not mentioned in README.md`);
  }
});

test('every output is declared and set', () => {
  const set = [...INDEX.matchAll(/core\.setOutput\('([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(set.sort(), Object.keys(ACTION.outputs).sort());
});

test('publishing is opt-in', () => {
  assert.equal(ACTION.inputs['publish-pages'].default, 'false');
  assert.equal(ACTION.inputs['publish-release'].default, 'false');
  assert.equal(ACTION.inputs['base-url'].required, false);
  assert.equal(ACTION.inputs['github-token'].default, '${{ github.token }}');
});
