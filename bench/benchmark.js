const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'dist', 'main.js');
const smallFixture = path.join(root, 'examples', 'blink.ino');
const label = process.argv[2] || 'benchmark';
const iterations = Number(process.env.BENCH_ITERATIONS || 20);
const generatedDirectory = path.join(os.tmpdir(), 'aily-linter-benchmark');
const largeFixture = path.join(generatedDirectory, 'large.ino');

function directorySize(directory) {
  if (!fs.existsSync(directory)) return 0;

  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    total += entry.isDirectory() ? directorySize(entryPath) : fs.statSync(entryPath).size;
  }
  return total;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function createLargeFixture() {
  fs.mkdirSync(generatedDirectory, { recursive: true });
  const chunks = [
    '#include <Arduino.h>\n',
    'const char* message = "braces { } and // are data";\n',
    'void setup() {}\n',
    'void loop() { int value = 1; value += 1; }\n'
  ];
  const comment = '// scanner payload: delay(100), { [ ( ) ] }, String ignored; 0123456789abcdef\n';
  while (Buffer.byteLength(chunks.join('')) < 2 * 1024 * 1024) chunks.push(comment);
  fs.writeFileSync(largeFixture, chunks.join(''));
}

function runCli(fixture) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [cli, fixture, '--mode', 'fast', '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production' },
    maxBuffer: 64 * 1024 * 1024
  });
  const elapsed = performance.now() - started;
  if (result.status !== 0) {
    throw new Error(`CLI failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return elapsed;
}

function measure(fixture) {
  runCli(fixture);
  const samples = [];
  for (let index = 0; index < iterations; index++) samples.push(runCli(fixture));
  return {
    samples: samples.map(value => Number(value.toFixed(3))),
    p50Ms: Number(percentile(samples, 0.5).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    meanMs: Number((samples.reduce((sum, value) => sum + value, 0) / samples.length).toFixed(3))
  };
}

function main() {
  if (!fs.existsSync(cli)) execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true });
  createLargeFixture();

  const largeBytes = fs.statSync(largeFixture).size;
  const result = {
    label,
    timestamp: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    iterations,
    fixtureBytes: { small: fs.statSync(smallFixture).size, large: largeBytes },
    coldProcess: {
      small: measure(smallFixture),
      large: measure(largeFixture)
    },
    largeThroughputMiBPerSecond: 0,
    installedParserDependencyBytes: [
      '@ast-grep',
      'tree-sitter',
      'tree-sitter-cpp',
      'tree-sitter-c'
    ].reduce((sum, dependency) => sum + directorySize(path.join(root, 'node_modules', dependency)), 0)
  };

  result.largeThroughputMiBPerSecond = Number(
    ((largeBytes / 1024 / 1024) / (result.coldProcess.large.p50Ms / 1000)).toFixed(3)
  );

  const outputPath = path.join(__dirname, `results-${label}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main();