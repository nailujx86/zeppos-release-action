'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { PNG } = require('pngjs');

const qr = require('../src/qr');

const PAYLOAD = 'zpkd1://example.github.io/uv-index/v1.0.0/uv-index-1-0-0-round-466-zps.zpk';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zepp-qr-'));
}

test('payload survives a png round trip', async () => {
  const file = path.join(tempDir(), 'qr.png');
  const bytes = await qr.writeQr(PAYLOAD, file);
  assert.ok(bytes > 1000, `png is only ${bytes} bytes`);
  assert.equal(qr.readQr(file), PAYLOAD);
});

test('png is square, at least 300px and starts with a white quiet zone', async () => {
  const file = path.join(tempDir(), 'qr.png');
  await qr.writeQr(PAYLOAD, file);
  const png = PNG.sync.read(fs.readFileSync(file));
  assert.ok(png.width >= 300, `width ${png.width} is too small to scan`);
  assert.equal(png.width, png.height);
  assert.deepEqual([png.data[0], png.data[1], png.data[2]], [255, 255, 255]);
});

test('probe reports a served file as reachable', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.zpk'), 'x');
  const server = http.createServer((request, response) => {
    const file = path.join(dir, request.url.replace(/^\//, ''));
    if (fs.existsSync(file)) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(fs.readFileSync(file));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    assert.equal(await qr.probe(`http://127.0.0.1:${port}/a.zpk`, { retries: 1, delay: 0 }), true);
    assert.equal(await qr.probe(`http://127.0.0.1:${port}/missing.zpk`, { retries: 1, delay: 0 }), false);
  } finally {
    server.close();
  }
});

test('probe gives up after the retry budget', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    throw new Error('nope');
  };
  const ok = await qr.probe('http://example.invalid/a.zpk', { retries: 3, delay: 0, fetchImpl });
  assert.equal(ok, false);
  assert.equal(attempts, 3);
});
