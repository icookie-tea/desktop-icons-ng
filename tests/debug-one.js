#!/usr/bin/env gjs
/* Debug runner for a single test module: gjs tests/debug-one.js test-sort-manager */
'use strict';
const GLib = imports.gi.GLib;
const rootDir = GLib.get_current_dir();
imports.searchPath.unshift(GLib.build_filenamev([rootDir, 'app']));
imports.searchPath.unshift(GLib.build_filenamev([rootDir, 'tests']));

const name = ARGV[0] || 'test-file-changes-queue';
const mod = imports[name];
Promise.resolve(mod.runTests()).then(
    r => print(`${name} done, failed=${r}`),
    e => print(`${name} ERROR: ${e}\n${e.stack}`));
