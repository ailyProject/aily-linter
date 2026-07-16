import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DependencyAnalyzer } from '../src/DependencyAnalyzer';
import { Logger } from '../src/utils/Logger';

test('uses response-file macros and resets dependencies between preprocess sessions', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'aily-linter-deps-'));
  const libraryRoot = path.join(fixtureRoot, 'libraries');
  const librarySource = path.join(libraryRoot, 'TestLib', 'src');
  const firstSketch = path.join(fixtureRoot, 'first.ino');
  const secondSketch = path.join(fixtureRoot, 'second.ino');
  const responseFile = path.join(fixtureRoot, 'compiler.rsp');
  const environmentKeys = [
    'LOCALAPPDATA',
    'SKETCH_PATH',
    'SDK_CORE_PATH',
    'SDK_VARIANT_PATH',
    'LIBRARIES_PATH',
    'SDK_CORE_LIBRARIES_PATH',
    'BUILD_MCU'
  ] as const;
  const previousEnvironment = new Map(
    environmentKeys.map(key => [key, process.env[key]])
  );

  try {
    await mkdir(librarySource, { recursive: true });
    await writeFile(responseFile, '-DENABLE_TEST_LIBRARY=1\n');
    await writeFile(firstSketch, `
#if ENABLE_TEST_LIBRARY
#include <TestLib.h>
#endif
`);
    await writeFile(secondSketch, 'void setup() {}\nvoid loop() {}\n');
    await writeFile(path.join(librarySource, 'TestLib.h'), '#pragma once\n');
    await writeFile(path.join(librarySource, 'TestLib.cpp'), '#include "TestLib.h"\n');

    process.env.LOCALAPPDATA = path.join(fixtureRoot, 'local-app-data');
    process.env.SKETCH_PATH = firstSketch;
    process.env.LIBRARIES_PATH = libraryRoot;
    delete process.env.SDK_CORE_PATH;
    delete process.env.SDK_VARIANT_PATH;
    delete process.env.SDK_CORE_LIBRARIES_PATH;
    delete process.env.BUILD_MCU;

    const logger = new Logger();
    logger.setQuiet(true);
    const analyzer = new DependencyAnalyzer(logger);
    const arduinoConfig = {
      fqbn: 'test:host:fixture',
      fqbnParsed: { package: 'test', platform: 'host', boardId: 'fixture' },
      platform: {
        'recipe.cpp.o.pattern': `g++ "@${responseFile}"`
      }
    };

    const firstDependencies = await analyzer.preprocess(arduinoConfig);
    const testLibrary = firstDependencies.find(dependency => dependency.name === 'TestLib');
    assert.ok(testLibrary, 'response-file macro should activate TestLib include');
    assert.ok(testLibrary.includes?.some(file => path.basename(file) === 'TestLib.cpp'));

    process.env.SKETCH_PATH = secondSketch;
    const secondDependencies = await analyzer.preprocess(arduinoConfig);
    assert.equal(secondDependencies.some(dependency => dependency.name === 'TestLib'), false);
  } finally {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
