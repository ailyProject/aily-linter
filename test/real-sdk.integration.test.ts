import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(__dirname, '..');
const toolsPath = process.env.AILY_LINTER_TOOLS_PATH;

async function runAccurateLint(
  sketchPath: string,
  board: string,
  sdkPath: string,
  toolVersions: string,
  workspace: string
): Promise<any> {
  const { stdout } = await execFileAsync(process.execPath, [
    '--import', 'tsx', path.join(repositoryRoot, 'main.ts'), sketchPath,
    '--mode', 'accurate', '--format', 'json', '--board', board,
    '--sdk-path', sdkPath, '--tools-path', toolsPath!,
    '--tool-versions', toolVersions, '--build-path', path.join(workspace, 'build')
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      LOCALAPPDATA: path.join(workspace, 'appdata'),
      XDG_CACHE_HOME: path.join(workspace, 'cache')
    },
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000
  });
  return JSON.parse(stdout);
}

test('real AVR SDK accepts a standard sketch', {
  skip: !process.env.AILY_LINTER_AVR_SDK_PATH || !toolsPath,
  timeout: 120_000
}, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'aily-linter-avr-integration-'));
  const sketchDirectory = path.join(workspace, 'blink');
  const sketchPath = path.join(sketchDirectory, 'blink.ino');
  try {
    await mkdir(sketchDirectory, { recursive: true });
    await writeFile(sketchPath, 'void setup() { pinMode(LED_BUILTIN, OUTPUT); }\nvoid loop() { digitalWrite(LED_BUILTIN, HIGH); }\n');
    const result = await runAccurateLint(
      sketchPath,
      'arduino:avr:uno',
      process.env.AILY_LINTER_AVR_SDK_PATH!,
      process.env.AILY_LINTER_AVR_TOOL_VERSIONS || 'avr-gcc@7.3.0',
      workspace
    );
    assert.equal(result.success, true, JSON.stringify(result.errors));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('real ESP32 SDK accepts an ESP32-S3 sketch', {
  skip: !process.env.AILY_LINTER_ESP32_SDK_PATH || !toolsPath,
  timeout: 120_000
}, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'aily-linter-esp32-integration-'));
  const sketchDirectory = path.join(workspace, 'esp32');
  const sketchPath = path.join(sketchDirectory, 'esp32.ino');
  try {
    await mkdir(sketchDirectory, { recursive: true });
    await writeFile(sketchPath, 'void setup() { Serial.begin(115200); }\nvoid loop() { delay(1000); }\n');
    const result = await runAccurateLint(
      sketchPath,
      'esp32:esp32:esp32s3',
      process.env.AILY_LINTER_ESP32_SDK_PATH!,
      process.env.AILY_LINTER_ESP32_TOOL_VERSIONS || 'esp-x32@14.2.0,esp32-arduino-libs@5.5.1,esptool_py@5.1.0',
      workspace
    );
    assert.equal(result.success, true, JSON.stringify(result.errors));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
