#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import path from 'path';
import os from 'os';
import { ArduinoLinter, LintOptions } from './src/ArduinoLinter';
import { ArduinoConfigParser } from './src/ArduinoConfigParser';
import { Logger } from './src/utils/Logger';
import { calculateMD5 } from './src/utils/md5';

const program = new Command();
const logger = new Logger();

function collectValue(value: string, values: string[]): string[] {
  values.push(value);
  return values;
}

function collectKeyValue(value: string, values: Record<string, string>): Record<string, string> {
  const separator = value.indexOf('=');
  if (separator <= 0) {
    throw new InvalidArgumentError(`Expected key=value, received: ${value}`);
  }

  values[value.slice(0, separator)] = value.slice(separator + 1);
  return values;
}

function getDefaultBuildPath(sketchPath: string): string {
  const sketchName = path.basename(sketchPath, path.extname(sketchPath));
  const projectHash = calculateMD5(sketchPath).substring(0, 8);
  const projectName = `${sketchName}_${projectHash}`;

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'aily-linter', 'project', projectName);
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'aily-linter', 'project', projectName);
  }

  const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(cacheHome, 'aily-linter', 'project', projectName);
}

program
  .name('aily-linter')
  .description('Standalone multi-mode syntax analysis for Arduino sketches')
  .version('1.0.0')
  .argument('<sketch>', 'Path to an Arduino sketch (.ino file)')
  .option('-b, --board <board>', 'Target board FQBN', 'arduino:avr:uno')
  .option('--build-path <path>', 'Build output directory')
  .option('--sdk-path <path>', 'Path to the Arduino core/SDK')
  .option('--tools-path <path>', 'Path to compiler and platform tools')
  .option('--libraries-path <path>', 'Additional libraries path; repeatable', collectValue, [])
  .option('--build-property <key=value>', 'Additional build property; repeatable', collectKeyValue, {})
  .option('--board-options <key=value>', 'Board menu option; repeatable', collectKeyValue, {})
  .option('--tool-versions <versions>', 'Tool versions, e.g. gcc@12.2.0,esptool_py@4.8.1')
  .option('--rule-set <name>', 'ast-grep rule set: minimal, standard, strict, esp32, stm32')
  .option('--format <format>', 'Output format: human, vscode, json', 'human')
  .option('--mode <mode>', 'Analysis mode: fast, accurate, auto, ast-grep', 'fast')
  .option('--verbose', 'Enable verbose output', false)
  .addHelpText('after', `
Examples:
  $ aily-linter sketch.ino
  $ aily-linter sketch.ino --mode ast-grep --format vscode
  $ aily-linter sketch.ino --mode accurate --sdk-path C:\\Arduino\\hardware\\avr
  $ aily-linter sketch.ino --libraries-path C:\\Arduino\\libraries --format json

Modes:
  fast      Lightweight static checks without invoking a compiler
  accurate  Compiler-based syntax and type validation
  auto      Fast checks first, then compiler validation when necessary
  ast-grep  C++ AST rules powered by ast-grep
`)
  .action(async (sketch: string, options) => {
    logger.setVerbose(Boolean(options.verbose));
    logger.setQuiet(options.format !== 'human');

    const validFormats = ['human', 'vscode', 'json'] as const;
    const validModes = ['fast', 'accurate', 'auto', 'ast-grep'] as const;
    const validRuleSets = ['minimal', 'standard', 'strict', 'esp32', 'stm32'] as const;

    if (!validFormats.includes(options.format)) {
      logger.error(`Invalid format: ${options.format}. Must be one of: ${validFormats.join(', ')}`);
      process.exitCode = 1;
      return;
    }

    if (!validModes.includes(options.mode)) {
      logger.error(`Invalid mode: ${options.mode}. Must be one of: ${validModes.join(', ')}`);
      process.exitCode = 1;
      return;
    }

    if (options.ruleSet && !validRuleSets.includes(options.ruleSet)) {
      logger.error(`Invalid rule set: ${options.ruleSet}. Must be one of: ${validRuleSets.join(', ')}`);
      process.exitCode = 1;
      return;
    }

    const sketchPath = path.resolve(sketch);
    const buildPath = options.buildPath
      ? path.resolve(options.buildPath)
      : getDefaultBuildPath(sketchPath);

    process.env.SKETCH_PATH = sketchPath;
    process.env.SKETCH_NAME = path.basename(sketchPath, path.extname(sketchPath));
    process.env.SKETCH_DIR_PATH = path.dirname(sketchPath);
    process.env.BUILD_PATH = buildPath;
    if (options.sdkPath) process.env.SDK_PATH = path.resolve(options.sdkPath);
    if (options.toolsPath) process.env.TOOLS_PATH = path.resolve(options.toolsPath);
    if (options.librariesPath.length > 0) {
      process.env.LIBRARIES_PATH = options.librariesPath
        .map((libraryPath: string) => path.resolve(libraryPath))
        .join(path.delimiter);
    }

    if (options.format === 'human' || options.verbose) {
      logger.info(`Sketch: ${sketchPath}`);
      logger.info(`Board: ${options.board}`);
      logger.info(`Mode: ${options.mode}`);
      logger.info(`Build path: ${buildPath}`);
    }

    const lintOptions: LintOptions = {
      sketchPath,
      board: options.board,
      buildPath,
      sdkPath: options.sdkPath ? path.resolve(options.sdkPath) : undefined,
      toolsPath: options.toolsPath ? path.resolve(options.toolsPath) : undefined,
      librariesPath: options.librariesPath.map((libraryPath: string) => path.resolve(libraryPath)),
      buildProperties: options.buildProperty,
      boardOptions: options.boardOptions,
      toolVersions: options.toolVersions,
      ruleSet: options.ruleSet,
      format: options.format,
      mode: options.mode,
      verbose: options.verbose
    };

    try {
      const linter = new ArduinoLinter(logger, new ArduinoConfigParser());
      const result = await linter.lint(lintOptions);
      process.stdout.write(`${linter.formatOutput(result, options.format)}\n`);
      process.exitCode = result.success ? 0 : 1;
    } catch (error) {
      logger.error(`Lint failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch(error => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
