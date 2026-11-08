'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JSZip = require('jszip');

const pack = require('../src/pack');
const { makeZab, innerAppJson, PLATFORMS } = require('./helpers');

const BASE = 'example.github.io/uv-index/v1.0.0';
const DEVICES = { 8913152: 'Amazfit Active 2 (Round)', 7995648: 'Amazfit GTS 4' };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zepp-pack-'));
}

async function packed(options = {}) {
  const dir = tempDir();
  const zabPath = await makeZab(path.join(dir, 'build.zab'));
  const parsed = await pack.readZab(fs.readFileSync(zabPath), path.basename(zabPath));
  const outDir = path.join(dir, 'site');
  const document = await pack.packZab(parsed, { outDir, base: BASE, devices: DEVICES, ...options });
  return { dir, outDir, document };
}

test('slug and label describe a platform unambiguously', () => {
  assert.equal(pack.slugFor(PLATFORMS[0]), 'round-466-zps');
  assert.equal(pack.slugFor(PLATFORMS[1]), 'square-390x450-nxp');
  assert.equal(pack.labelFor(PLATFORMS[0]), 'Round 466\u00d7466 \u00b7 ZPS');
});

test('a crafted manifest cannot name a file outside outDir', () => {
  const evil = { screenType: 'x/../../pwned', screenResolution: '466x466', cpuPlatform: 'ZPS' };
  const slug = pack.slugFor(evil);
  assert.equal(slug, 'x-pwned-466x466-zps');
  assert.ok(!slug.includes('/') && !slug.includes('..'), slug);
  const stem = pack.stemFor({ appName: 'UV Index', version: '1.0.0/../../etc' });
  assert.ok(!stem.includes('/') && !stem.includes('..'), stem);
});

test('two packages that would collide are refused', async () => {
  const dir = tempDir();
  const zabPath = await makeZab(path.join(dir, 'build.zab'), {
    platforms: [
      { screenType: 'round', screenResolution: '466x466', cpuPlatform: 'ZPS', sources: [1] },
      { screenType: 'round', screenResolution: '466x466', cpuPlatform: 'ZPS', sources: [2] },
    ],
  });
  const parsed = await pack.readZab(fs.readFileSync(zabPath), 'build.zab');
  await assert.rejects(
    pack.packZab(parsed, { outDir: path.join(dir, 'site'), base: BASE, devices: {} }),
    /would both be called/
  );
});

test('stem is filename safe', () => {
  assert.equal(pack.stemFor({ appName: 'UV Index', version: '1.2.3' }), 'uv-index-1-2-3');
  assert.equal(pack.stemFor({ appName: 'My App!', version: '2.0.0' }), 'my-app-2-0-0');
});

test('appMetaFor reads identity from the first package', async () => {
  const zab = await makeZab(path.join(tempDir(), 'build.zab'), { version: '3.2.1' });
  const parsed = await pack.readZab(fs.readFileSync(zab), 'build.zab');
  assert.deepEqual(pack.appMetaFor(parsed), { appId: 1127270, appName: 'UV Index', version: '3.2.1' });
});

test('payload and url share one join', () => {
  assert.equal(pack.payloadFor(BASE, 'a.zpk'), 'zpkd1://example.github.io/uv-index/v1.0.0/a.zpk');
  assert.equal(pack.payloadFor('/' + BASE + '/', 'a.zpk'), 'zpkd1://example.github.io/uv-index/v1.0.0/a.zpk');
  assert.equal(pack.urlFor(BASE, 'a.zpk'), 'https://example.github.io/uv-index/v1.0.0/a.zpk');
});

test('a base with a scheme is refused, not baked into a QR', () => {
  // zpkd1://https://host/... is unscannable, and verify-qr cannot catch it because
  // it compares the QR against the same derived string.
  assert.throws(() => pack.payloadFor('https://cdn.example.com/x', 'a.zpk'), /no scheme/);
  assert.throws(() => pack.urlFor('http://cdn.example.com/x', 'a.zpk'), /no scheme/);
  assert.throws(() => pack.normaliseBase('zpkd1://cdn.example.com/x'), /no scheme/);
});

test('readZab refuses a package that claims several platforms', async () => {
  const dir = tempDir();
  const zabPath = path.join(dir, 'build.zab');
  await makeZab(zabPath);
  // Rewrite the manifest so the first zpk claims two platforms.
  const { buildZip } = require('./helpers');
  const raw = await JSZip.loadAsync(fs.readFileSync(zabPath));
  const manifest = JSON.parse(await raw.file('manifest.json').async('string'));
  manifest.zpks[0].platforms.push({ screenType: 'round', screenResolution: '480x480', cpuPlatform: 'ZPS' });
  const files = {};
  for (const name of Object.keys(raw.files)) {
    if (raw.files[name].dir) continue;
    files[name] = await raw.files[name].async('nodebuffer');
  }
  files['manifest.json'] = JSON.stringify(manifest);
  fs.writeFileSync(zabPath, await buildZip(files));
  await assert.rejects(pack.readZab(fs.readFileSync(zabPath), 'build.zab'), /several platforms/);
});

test('one patched and one raw zpk per platform', async () => {
  const { outDir } = await packed();
  assert.deepEqual(fs.readdirSync(outDir).sort(), [
    'release-notes.md',
    'uv-index-1-0-0-round-466-zps-raw.zpk',
    'uv-index-1-0-0-round-466-zps.zpk',
    'uv-index-1-0-0-square-390x450-nxp-raw.zpk',
    'uv-index-1-0-0-square-390x450-nxp.zpk',
  ]);
});

test('zpk root holds device.zip then app-side.zip', async () => {
  const { outDir } = await packed();
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(outDir, 'uv-index-1-0-0-round-466-zps.zpk')));
  assert.deepEqual(Object.keys(zip.files), ['device.zip', 'app-side.zip']);
  const inner = await JSZip.loadAsync(await zip.file('device.zip').async('nodebuffer'));
  const files = Object.keys(inner.files).filter((name) => !inner.files[name].dir);
  assert.deepEqual(files, ['app.json', 'app.bin', 'assets/raw/locale/en-US.btxt']);
});

test('patched package is preview with a long expiry', async () => {
  const { outDir } = await packed();
  const config = await innerAppJson(path.join(outDir, 'uv-index-1-0-0-round-466-zps.zpk'));
  assert.equal(config.packageInfo.mode, 'preview');
  assert.equal(config.packageInfo.expiredTime, pack.DEFAULT_EXPIRY);
  assert.equal(config.packageInfo.timeStamp, 1793213888);
  assert.equal(config.packageInfo.zpm, '3.4.2');
});

test('default expiry is the int32 ceiling', () => {
  assert.equal(pack.DEFAULT_EXPIRY, 2147483647);
  assert.equal(pack.DEFAULT_EXPIRY, 2 ** 31 - 1);
  assert.ok(Number.isSafeInteger(pack.DEFAULT_EXPIRY));
});

test('a custom expiry is written through unchanged', async () => {
  const { outDir } = await packed({ expiry: 31536000 });
  const config = await innerAppJson(path.join(outDir, 'uv-index-1-0-0-round-466-zps.zpk'));
  assert.equal(config.packageInfo.expiredTime, 31536000);
  assert.equal(config.packageInfo.mode, 'preview');
});

test('raw package is untouched', async () => {
  const { outDir } = await packed();
  const config = await innerAppJson(path.join(outDir, 'uv-index-1-0-0-round-466-zps-raw.zpk'));
  assert.equal(config.packageInfo.mode, 'production');
  assert.equal(config.packageInfo.expiredTime, 172800);
});

test('patch changes nothing outside packageInfo', async () => {
  const { outDir } = await packed();
  const patched = await innerAppJson(path.join(outDir, 'uv-index-1-0-0-round-466-zps.zpk'));
  const raw = await innerAppJson(path.join(outDir, 'uv-index-1-0-0-round-466-zps-raw.zpk'));
  const withoutInfo = (config) => {
    const copy = JSON.parse(JSON.stringify(config));
    delete copy.packageInfo;
    return copy;
  };
  assert.deepEqual(withoutInfo(patched), withoutInfo(raw));
  assert.equal(patched.app.appId, 1127270);
});

test('bytecode inside app.bin is unchanged', async () => {
  const { outDir } = await packed();
  const read = async (file) => {
    const zpk = await JSZip.loadAsync(fs.readFileSync(path.join(outDir, file)));
    const inner = await JSZip.loadAsync(await zpk.file('device.zip').async('nodebuffer'));
    return inner.file('app.bin').async('nodebuffer');
  };
  assert.deepEqual(await read('uv-index-1-0-0-round-466-zps.zpk'), await read('uv-index-1-0-0-round-466-zps-raw.zpk'));
});

test('two runs over the same input are byte identical', async () => {
  const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
  const first = await packed();
  const second = await packed();
  for (const entry of first.document.packages) {
    assert.equal(
      hash(fs.readFileSync(path.join(first.outDir, entry.file))),
      hash(fs.readFileSync(path.join(second.outDir, entry.file))),
      entry.file
    );
  }
});

test('the document carries models, sizes and file names', async () => {
  const { outDir, document } = await packed();
  assert.ok(!fs.existsSync(path.join(outDir, 'packages.json')), 'no index file is written');
  assert.equal(document.base, BASE);
  assert.equal(document.app.version, '1.0.0');
  assert.equal(document.packages.length, 2);
  const [round] = document.packages;
  assert.equal(round.slug, 'round-466-zps');
  assert.equal(round.file, 'uv-index-1-0-0-round-466-zps.zpk');
  assert.equal(round.qr, 'qr-round-466-zps.png');
  assert.deepEqual(round.models, ['Amazfit Active 2 (Round)']);
  assert.ok(round.size > 100);
});

test('release notes link every package and every QR', async () => {
  const { outDir } = await packed();
  const notes = fs.readFileSync(path.join(outDir, 'release-notes.md'), 'utf8');
  for (const slug of ['round-466-zps', 'square-390x450-nxp']) {
    assert.ok(notes.includes(`https://${BASE}/qr-${slug}.png`), `missing QR for ${slug}`);
    assert.ok(notes.includes(`https://${BASE}/uv-index-1-0-0-${slug}.zpk`), `missing file for ${slug}`);
  }
  assert.ok(notes.includes('Amazfit GTS 4'));
  assert.ok(notes.includes('| Watch | QR | Package |'));
  assert.ok(notes.includes('The non-`-raw` packages are patched'), 'the footer stays one sentence');
});

test('models fall back to the label when the device cache is empty', async () => {
  const empty = await packed({ devices: {} });
  assert.deepEqual(empty.document.packages[0].models, []);
  const notes = fs.readFileSync(path.join(empty.outDir, 'release-notes.md'), 'utf8');
  assert.ok(notes.includes('Round 466\u00d7466 \u00b7 ZPS'));
});

test('loadDevices accepts both cache shapes', () => {
  const dir = tempDir();
  const bare = path.join(dir, 'devices.json');
  fs.writeFileSync(bare, JSON.stringify([{ deviceSource: 7, productName: 'Bare Watch' }]));
  assert.deepEqual(pack.loadDevices(bare), { 7: 'Bare Watch' });

  const cache = path.join(dir, '.zeus_devices');
  fs.writeFileSync(cache, JSON.stringify({ devices: [{ deviceSource: 8, code: 'Rome' }], devices_beta: [] }));
  assert.deepEqual(pack.loadDevices(cache), { 8: 'Rome' });

  assert.deepEqual(pack.loadDevices(path.join(dir, 'nope.json')), {});
});
