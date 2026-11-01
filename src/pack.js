'use strict';

const fs = require('node:fs');
const path = require('node:path');

const JSZip = require('jszip');

// Seconds. zeus stamps 172800 (48h), which is what makes a direct-link package stop
// installing a couple of days after it was built. 2147483647 (INT32_MAX, ~68 years) is
// deliberate: anything larger wraps negative if a consumer holds expiredTime in a signed
// 32-bit int, which would read as already expired. Callers can override via `expiry`.
const DEFAULT_EXPIRY = 2147483647;
const FIXED_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0)); // deterministic zips
const ZIP_OPTIONS = { date: FIXED_DATE, compression: 'DEFLATE', unixPermissions: 0o600 };
const GENERATE_OPTIONS = { type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } };

function loadDevices(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  const list = Array.isArray(data) ? data : data.devices || [];
  const names = {};
  for (const device of list) {
    if (device && device.deviceSource != null) {
      names[device.deviceSource] = device.productName || device.code || String(device.deviceSource);
    }
  }
  return names;
}

function slugFor(platform) {
  const shape = String(platform.screenType || 'dev').toLowerCase();
  const [width, height] = String(platform.screenResolution || '?').split('x');
  const cpu = String(platform.cpuPlatform || 'cpu').toLowerCase();
  if (shape === 'round') return `${shape}-${width}-${cpu}`;
  return `${shape}-${width}x${height || width}-${cpu}`;
}

function labelFor(platform) {
  const shape = String(platform.screenType || 'device');
  const capitalised = shape.charAt(0).toUpperCase() + shape.slice(1).toLowerCase();
  const [width, height] = String(platform.screenResolution || '?').split('x');
  const cpu = String(platform.cpuPlatform || 'CPU').toUpperCase();
  return `${capitalised} ${width}\u00d7${height || width} \u00b7 ${cpu}`;
}

function stemFor(app) {
  const name = String(app.appName || 'app')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const version = String(app.version || '').replace(/\./g, '-');
  return version ? `${name}-${version}` : name;
}

function normaliseBase(baseUrl) {
  return String(baseUrl).replace(/^\/+|\/+$/g, '');
}

function joinUrl(baseUrl, filename) {
  return `${normaliseBase(baseUrl)}/${filename}`;
}

function payloadFor(baseUrl, filename, scheme = 'zpkd1') {
  return `${scheme}://${joinUrl(baseUrl, filename)}`;
}

function urlFor(baseUrl, filename, scheme = 'https') {
  return `${scheme}://${joinUrl(baseUrl, filename)}`;
}

async function readAppJson(deviceZipBuffer) {
  const zip = await JSZip.loadAsync(deviceZipBuffer);
  const entry = zip.file('app.json');
  if (!entry) throw new Error('device.zip has no app.json');
  return JSON.parse(await entry.async('string'));
}

/** Parse a .zab into {sourceName, entries:[{platform, deviceZip, appSide, config}]}. */
async function readZab(buffer, sourceName = 'build.zab') {
  const zab = await JSZip.loadAsync(buffer);
  const manifestEntry = zab.file('manifest.json');
  if (!manifestEntry) throw new Error(`${sourceName} is not a .zab: manifest.json is missing`);
  const manifest = JSON.parse(await manifestEntry.async('string'));
  if (!Array.isArray(manifest.zpks) || manifest.zpks.length === 0) {
    throw new Error(`${sourceName} is not a .zab: manifest.json has no zpks`);
  }

  const entries = [];
  for (const entry of manifest.zpks) {
    const zpkEntry = zab.file(entry.name);
    if (!zpkEntry) throw new Error(`manifest lists ${entry.name} but ${sourceName} does not contain it`);
    const zpk = await JSZip.loadAsync(await zpkEntry.async('nodebuffer'));
    const deviceZip = zpk.file('device.zip');
    const appSide = zpk.file('app-side.zip');
    if (!deviceZip || !appSide) throw new Error(`${entry.name} is not a .zpk (needs device.zip + app-side.zip)`);
    const deviceZipBuffer = await deviceZip.async('nodebuffer');
    entries.push({
      platform: entry.platforms[0],
      deviceZip: deviceZipBuffer,
      appSide: await appSide.async('nodebuffer'),
      config: await readAppJson(deviceZipBuffer),
    });
  }
  return { sourceName, entries };
}

function appMetaFor(parsed) {
  const app = parsed.entries[0].config.app || {};
  return {
    appId: app.appId,
    appName: app.appName,
    version: (app.version || {}).name,
  };
}

function patchConfig(config, expiry = DEFAULT_EXPIRY) {
  const patched = JSON.parse(JSON.stringify(config));
  patched.packageInfo = { ...(patched.packageInfo || {}), mode: 'preview', expiredTime: expiry };
  return patched;
}

async function rebuildDeviceZip(deviceZipBuffer, expiry = DEFAULT_EXPIRY) {
  const source = await JSZip.loadAsync(deviceZipBuffer);
  const out = new JSZip();
  for (const name of Object.keys(source.files)) {
    const entry = source.files[name];
    if (entry.dir) {
      // Keep the archive's directory entries: the original has them, so a rebuilt
      // device.zip should be structurally identical apart from app.json.
      out.file(name, null, { dir: true, date: FIXED_DATE });
      continue;
    }
    const data =
      name === 'app.json'
        ? JSON.stringify(patchConfig(JSON.parse(await entry.async('string')), expiry))
        : await entry.async('nodebuffer');
    out.file(name, data, ZIP_OPTIONS);
  }
  return out.generateAsync(GENERATE_OPTIONS);
}

async function buildZpk(deviceZipBuffer, appSideBuffer) {
  const zip = new JSZip();
  zip.file('device.zip', deviceZipBuffer, ZIP_OPTIONS);
  zip.file('app-side.zip', appSideBuffer, ZIP_OPTIONS);
  return zip.generateAsync(GENERATE_OPTIONS);
}

function modelsFor(config, devices) {
  const models = [];
  for (const platform of config.platforms || []) {
    const name = devices[platform.deviceSource];
    if (name && !models.includes(name)) models.push(name);
  }
  return models;
}

function renderNotes(document, scheme = 'zpkd1') {
  const { app, base, packages } = document;
  const lines = [
    `## ${app.appName || 'App'} ${app.version || ''}`.trim(),
    '',
    'Direct-install packages for Zepp OS, one per device platform.',
    'In the Zepp App: **Profile \u2192 your watch \u2192 Developer Mode \u2192 \uff0b \u2192 Scan**.',
    'If the phone cannot scan its own screen, the Scan screen has a gallery button.',
    '',
    'Pick the row whose watch matches yours \u2014 a package only installs on the devices it was built for.',
    '',
    '| Watch | QR | Package |',
    '|---|---|---|',
  ];
  for (const entry of packages) {
    const watch = entry.models.length ? entry.models.join(', ') : entry.label;
    lines.push(`| ${watch} | <img src="${urlFor(base, entry.qr)}" width="200"> | [${entry.file}](${urlFor(base, entry.file)}) |`);
  }
  lines.push(
    '',
    'The packages are patched for direct install (`packageInfo.mode = "preview"`, long expiry)',
    'and served from a permanent path: re-running the release republishes the same URLs with a fresh',
    'expiry, so these QR codes keep working.',
    '',
    'Every package also has an untampered `-raw` twin beside it, as a fallback.',
    '',
    `Links use the \`${scheme}://\` scheme, which the Zepp App rewrites to \`https://\`.`
  );
  return `${lines.join('\n')}\n`;
}

async function packZab(parsed, { outDir, base, scheme = 'zpkd1', expiry = DEFAULT_EXPIRY, devices = {} }) {
  fs.mkdirSync(outDir, { recursive: true });

  const app = appMetaFor(parsed);
  const stem = stemFor(app);
  const packages = [];

  for (const { platform, deviceZip, appSide, config } of parsed.entries) {
    const slug = slugFor(platform);
    const file = `${stem}-${slug}.zpk`;
    const rawFile = `${stem}-${slug}-raw.zpk`;
    const patched = await buildZpk(await rebuildDeviceZip(deviceZip, expiry), appSide);
    fs.writeFileSync(path.join(outDir, file), patched);
    fs.writeFileSync(path.join(outDir, rawFile), await buildZpk(deviceZip, appSide));
    packages.push({
      slug,
      label: labelFor(platform),
      shape: platform.screenType,
      cpu: platform.cpuPlatform,
      file,
      rawFile,
      qr: `qr-${slug}.png`,
      size: patched.length,
      models: modelsFor(config, devices),
    });
  }

  const document = {
    app,
    base: normaliseBase(base),
    packages,
    generatedFrom: parsed.sourceName,
  };
  fs.writeFileSync(path.join(outDir, 'packages.json'), `${JSON.stringify(document, null, 1)}\n`);
  fs.writeFileSync(path.join(outDir, 'release-notes.md'), renderNotes(document, scheme));
  return document;
}

module.exports = {
  DEFAULT_EXPIRY,
  loadDevices,
  slugFor,
  labelFor,
  stemFor,
  normaliseBase,
  payloadFor,
  urlFor,
  readZab,
  appMetaFor,
  patchConfig,
  rebuildDeviceZip,
  buildZpk,
  renderNotes,
  packZab,
};
