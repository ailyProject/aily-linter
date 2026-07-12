const esbuild = require('esbuild');
const fs = require('fs-extra');
const path = require('path');

const DIST_MAIN_PATH = './dist/main.js';
const BUNDLE_DIR = './dist/bundle-min';

async function bundleMinified() {
  try {
    ensureBuilt();

    console.log('Building minified bundle...');
    await fs.emptyDir(BUNDLE_DIR);

    await bundleJavaScript();
    await createLaunchScript();
    await createPackageJson();

    const bundleStats = await getBundleStats(BUNDLE_DIR);
    console.log('Minified bundle created successfully.');
    console.log(`Output directory: ${BUNDLE_DIR}`);
    console.log(`Total bundle size: ${bundleStats.totalSizeFormatted}`);
    console.log(`Files included: ${bundleStats.fileCount}`);
  } catch (error) {
    console.error('Minified bundle creation failed:', error);
    process.exit(1);
  }
}

function ensureBuilt() {
  if (!fs.existsSync(DIST_MAIN_PATH)) {
    throw new Error('dist/main.js not found. Please run "npm run build" first.');
  }
}

async function bundleJavaScript() {
  console.log('Bundling JavaScript code...');
  await esbuild.build({
    entryPoints: [DIST_MAIN_PATH],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: path.join(BUNDLE_DIR, 'aily-linter.js'),
    minify: true,
    sourcemap: false,
    logLevel: 'info',
  });
}

async function createLaunchScript() {
  const launchScript = `#!/usr/bin/env node
require('./aily-linter.js');
`;
  const launchScriptPath = path.join(BUNDLE_DIR, 'index.js');

  await fs.writeFile(launchScriptPath, launchScript);
  if (process.platform !== 'win32') {
    await fs.chmod(launchScriptPath, '755');
  }
}

async function createPackageJson() {
  const projectPackageJson = await fs.readJson('./package.json');
  const bundlePackageJson = {
    name: projectPackageJson.name,
    version: projectPackageJson.version,
    description: projectPackageJson.description,
    main: 'index.js',
    bin: {
      'aily-linter': 'index.js',
    },
    engines: {
      node: projectPackageJson.engines?.node || '>=18',
    },
  };

  await fs.writeFile(
    path.join(BUNDLE_DIR, 'package.json'),
    `${JSON.stringify(bundlePackageJson, null, 2)}\n`,
  );
}

async function getBundleStats(bundleDir) {
  let totalSize = 0;
  let fileCount = 0;
  const items = await fs.readdir(bundleDir);

  for (const item of items) {
    const stat = await fs.stat(path.join(bundleDir, item));
    if (stat.isFile()) {
      totalSize += stat.size;
      fileCount++;
    }
  }

  const totalSizeFormatted = totalSize > 1024 * 1024
    ? `${(totalSize / 1024 / 1024).toFixed(2)} MB`
    : `${(totalSize / 1024).toFixed(1)} KB`;

  return { totalSize, totalSizeFormatted, fileCount };
}

bundleMinified();