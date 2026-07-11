import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ParallelStaticAnalyzer } from '../src/ParallelStaticAnalyzer';
import { Logger } from '../src/utils/Logger';
import { scanSource } from '../src/utils/SourceScanner';

test('single pass scanner ignores comments and all string forms', () => {
  const scan = scanSource(`
// delay(fake(1)); { }
const char* normal = "delay(2) {";
const char* raw = R"tag(delay(3) })tag";
/* digitalWrite(13, HIGH); */
delay(realValue(4));
`);

  assert.deepEqual(scan.calls.map(call => call.name), ['delay', 'realValue']);
  assert.equal(scan.delimiterIssues.length, 0);
});

test('scanner reports unmatched delimiters with source positions', () => {
  const scan = scanSource('void setup() {\n  call(1];\n}');
  assert.ok(scan.delimiterIssues.length >= 1);
  assert.equal(scan.delimiterIssues[0].line, 2);
});

test('fast analyzer handles nested calls and rule sets without comment false positives', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-linter-test-'));
  const file = path.join(directory, 'rules.ino');
  await fs.writeFile(file, `
#include <Arduino.h>
void setup() {}
void loop() {
  // delay(999);
  delay(compute(1, nested(2)));
  String message;
}
`);

  try {
    const analyzer = new ParallelStaticAnalyzer(new Logger());
    const minimal = await analyzer.analyzeFile(file, { ruleSet: 'minimal' });
    const standard = await analyzer.analyzeFile(file, { ruleSet: 'standard' });
    assert.equal(minimal.warnings.filter(item => item.code === 'delay-blocking').length, 1);
    assert.equal(minimal.warnings.some(item => item.code === 'string-fragmentation'), false);
    assert.equal(standard.warnings.some(item => item.code === 'string-fragmentation'), true);
    assert.equal(standard.errors.length, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});