const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const rootPackage = require('../package.json');
const bundleDirectory = path.resolve(__dirname, '..', 'dist', 'bundle-min');
const bundlePackagePath = path.join(bundleDirectory, 'package.json');
const bundleEntryPath = path.join(bundleDirectory, 'index.js');
const bundleCodePath = path.join(bundleDirectory, 'aily-linter.js');

assert.equal(fs.existsSync(bundlePackagePath), true, 'bundle package.json is missing');
assert.equal(fs.existsSync(bundleEntryPath), true, 'bundle CLI entry is missing');
assert.equal(fs.existsSync(bundleCodePath), true, 'bundle JavaScript payload is missing');

const bundlePackage = JSON.parse(fs.readFileSync(bundlePackagePath, 'utf8'));
assert.equal(bundlePackage.name, `${rootPackage.name}-bundle`);
assert.equal(bundlePackage.version, rootPackage.version);
assert.equal(bundlePackage.private, true);
assert.equal(bundlePackage.ailyLinterDistribution, 'standalone-bundle');

const execution = spawnSync(process.execPath, [bundleEntryPath, '--version'], { encoding: 'utf8' });
assert.equal(execution.status, 0, execution.stderr);
assert.equal(execution.stdout.trim(), rootPackage.version);
process.stdout.write(`Verified standalone bundle ${bundlePackage.name}@${bundlePackage.version}\n`);
