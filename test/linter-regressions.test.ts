import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preprocessArduinoSketch } from '../src/ArduinoSketchPreprocessor';
import { parseCompilerDiagnostics } from '../src/CompilerDiagnosticParser';
import { parseCommandArguments } from '../src/CompilerProcessRunner';
import { LintCacheKey, LintCacheManager } from '../src/LintCacheManager';
import { FastStaticAnalyzer } from '../src/FastStaticAnalyzer';
import { Logger } from '../src/utils/Logger';

function quietLogger(): Logger {
  const logger = new Logger();
  logger.setQuiet(true);
  return logger;
}

test('fast analysis accepts next-line braces and multiline assignments', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-linter-fast-valid-'));
  const sketch = path.join(directory, 'valid.ino');
  await fs.writeFile(sketch, `
void setup()
{
  int value =
    1 + 2;
}

void loop()
{
}
`);

  try {
    const result = await new FastStaticAnalyzer(quietLogger()).analyzeFile(sketch);
    assert.deepEqual(result.errors, []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('fast analysis reports conservative missing-semicolon cases', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-linter-fast-invalid-'));
  const sketch = path.join(directory, 'invalid.ino');
  await fs.writeFile(sketch, `
void setup() {
  int value
  return
}
void loop() {}
`);

  try {
    const result = await new FastStaticAnalyzer(quietLogger()).analyzeFile(sketch);
    assert.equal(result.errors.filter(error => error.code === 'MISSING_SEMICOLON').length, 2);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('fast analysis ignores definitely inactive preprocessor branches', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-linter-fast-ifdef-'));
  const sketch = path.join(directory, 'inactive.ino');
  await fs.writeFile(sketch, `
#if 0
void broken( {
  delay(999);
#endif
void setup() {}
void loop() {}
`);

  try {
    const result = await new FastStaticAnalyzer(quietLogger()).analyzeFile(sketch);
    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.some(warning => warning.code === 'delay-blocking'), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Arduino sketch preprocessing injects core header, prototypes, tabs, and line mappings', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-linter-sketch-'));
  const primary = path.join(directory, 'primary.ino');
  const secondary = path.join(directory, 'secondary.ino');
  await fs.writeFile(primary, `
void setup() { helper(); }
void loop() {}
void helper() {}
`);
  await fs.writeFile(secondary, 'int secondHelper(int value) { return value + 1; }\n');

  try {
    const result = await preprocessArduinoSketch(primary);
    assert.match(result.content, /^#include <Arduino\.h>/);
    assert.ok(result.generatedPrototypes.includes('void helper();'));
    assert.ok(result.generatedPrototypes.includes('int secondHelper(int value);'));
    assert.deepEqual(result.sourceFiles, [primary, secondary]);
    assert.match(result.content, /#line 1 ".*primary\.ino"/);
    assert.match(result.content, /#line 1 ".*secondary\.ino"/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('lint cache preserves arrays and includes content/tool versions in its key', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-linter-cache-'));
  const sourceFile = path.join(directory, 'source.ino');
  await fs.writeFile(sourceFile, 'void setup() {}\nvoid loop() {}\n');
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = directory;

  try {
    const manager = new LintCacheManager(quietLogger());
    const baseKey: LintCacheKey = {
      operation: 'dependency',
      board: 'test:host:board',
      sdkPath: '',
      toolsPath: '',
      librariesPath: '',
      buildProperties: '{}',
      boardOptions: '{}',
      sourceFile,
      fileContentHash: 'content-a',
      toolVersions: 'gcc@1',
      mode: 'auto'
    };
    await manager.storeToCache(baseKey, [{ name: 'LibraryA' }]);
    const cached = await manager.getFromCache(baseKey);
    assert.equal(Array.isArray(cached), true);
    assert.equal(cached[0].name, 'LibraryA');

    const getPath = (manager as any).getCacheFilePath.bind(manager);
    assert.notEqual(getPath(baseKey), getPath({ ...baseKey, fileContentHash: 'content-b' }));
    assert.notEqual(getPath(baseKey), getPath({ ...baseKey, toolVersions: 'gcc@2' }));
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('compiler diagnostics retain header paths and synthesize nonzero execution failures', () => {
  const sketch = path.resolve('fixture.ino');
  const header = path.resolve('include', 'fixture.h');
  const parsed = parseCompilerDiagnostics(`${header}:7:3: error: broken header`, sketch, 1, null);
  assert.equal(parsed.errors[0].file, path.normalize(header));
  assert.equal(parsed.errors[0].line, 7);

  const executionFailure = parseCompilerDiagnostics('compiler stopped unexpectedly', sketch, 2, null);
  assert.equal(executionFailure.errors[0].code, 'COMPILER_EXECUTION_FAILED');
});

test('compiler command parsing preserves quoted paths and rejects unterminated quotes', () => {
  assert.deepEqual(
    parseCommandArguments('-I"C:\\SDK path\\cores" -DVALUE=1 "source file.cpp"'),
    ['-IC:\\SDK path\\cores', '-DVALUE=1', 'source file.cpp']
  );
  assert.throws(() => parseCommandArguments('"unterminated'), /Unterminated quote/);
});
