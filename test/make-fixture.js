'use strict';

const path = require('node:path');
const { makeZab } = require('./helpers');

makeZab(path.join(__dirname, 'fixtures', 'sample.zab')).then((file) => {
  console.log(`wrote ${file}`);
});
