'use strict';

const fs = require('node:fs');

const jsQR = require('jsqr');
const { PNG } = require('pngjs');
const QRCode = require('qrcode');

const QR_OPTIONS = {
  type: 'png',
  errorCorrectionLevel: 'M',
  scale: 10, // 10 px per module
  margin: 6, // 6 modules of quiet zone
  color: { dark: '#000000ff', light: '#ffffffff' },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeQr(payload, file, options = QR_OPTIONS) {
  const buffer = await QRCode.toBuffer(payload, options);
  fs.writeFileSync(file, buffer);
  return buffer.length;
}

function readQr(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return result ? result.data : null;
}

async function probe(url, options = {}) {
  const { retries = 12, delay = 10, fetchImpl = fetch, sleepImpl = sleep, onAttempt = () => {} } = options;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    onAttempt(url, attempt, retries);
    try {
      const response = await fetchImpl(url, {
        headers: { range: 'bytes=0-0' },
        signal: AbortSignal.timeout(30000),
      });
      if (response.ok || response.status === 206) return true;
    } catch {
      // connection refused, DNS failure, timeout — retry
    }
    if (attempt < retries) await sleepImpl(delay * 1000);
  }
  return false;
}

module.exports = { writeQr, readQr, probe, QR_OPTIONS };
