#!/usr/bin/env -S gjs --module
/* Debug runner for a single test module: gjs tests/debug-one.js test-sort-manager */

const name = ARGV[0] || 'test-file-changes-queue';
const mod = await import(`./${name}.js`);
Promise.resolve(mod.runTests()).then(
    r => print(`${name} done, failed=${r}`),
    e => print(`${name} ERROR: ${e}\n${e.stack}`));
