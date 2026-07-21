#!/usr/bin/env node
'use strict';

const { main } = require('../src/menu');

main(process.argv).then(
  code => process.exit(code || 0),
  err => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  },
);
