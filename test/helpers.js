'use strict';

const fs = require('node:fs');
const path = require('node:path');

const JSZip = require('jszip');

const FIXED_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

const PLATFORMS = [
  {
    screenType: 'round',
    screenResolution: '466x466',
    cpuPlatform: 'ZPS',
    sources: [8913152, 10092800],
  },
  {
    screenType: 'square',
    screenResolution: '390x450',
    cpuPlatform: 'NXP',
    sources: [7995648],
  },
];

async function buildZip(files) {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) {
    zip.file(name, data, { date: FIXED_DATE });
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

async function makeZab(file, options = {}) {
  const { appId = 1127270, appName = 'UV Index', version = '1.0.0', platforms = PLATFORMS } = options;
  const zpks = {};
  const entries = [];

  for (const [index, platform] of platforms.entries()) {
    const config = {
      app: { appId, appName, version: { code: 1, name: version } },
      platforms: platform.sources.map((source) => ({ deviceSource: source })),
      packageInfo: { mode: 'production', timeStamp: 1793213888, expiredTime: 172800, zpm: '3.4.2' },
    };
    const deviceZip = await buildZip({
      'app.json': JSON.stringify(config),
      'app.bin': Buffer.from('bytecode'),
      'assets/raw/locale/en-US.btxt': Buffer.from('locale'),
    });
    const appSideZip = await buildZip({ 'app-side.js': 'module.exports = 1' });
    const name = `${String(index + 1).padStart(32, '0')}.zpk`;
    zpks[name] = await buildZip({ 'device.zip': deviceZip, 'app-side.zip': appSideZip });
    entries.push({
      name,
      version: { code: 1, name: version },
      appType: 'app',
      platforms: [
        {
          screenType: platform.screenType,
          screenResolution: platform.screenResolution,
          cpuPlatform: platform.cpuPlatform,
        },
      ],
      md5: name.slice(0, -4),
    });
  }

  const files = {
    ...zpks,
    'manifest.json': JSON.stringify({ configVersion: 'v3', zpks: entries }),
    '.ip-package': Buffer.from('PK'),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, await buildZip(files));
  return file;
}

async function innerAppJson(zpkFile) {
  const zpk = await JSZip.loadAsync(fs.readFileSync(zpkFile));
  const deviceZip = await zpk.file('device.zip').async('nodebuffer');
  const inner = await JSZip.loadAsync(deviceZip);
  return JSON.parse(await inner.file('app.json').async('string'));
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

module.exports = { buildZip, makeZab, innerAppJson, PLATFORMS, FIXED_DATE, fakeFetch };
