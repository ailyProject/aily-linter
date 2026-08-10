import { spawn } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { Logger } from './utils/Logger';

export interface CompilerExecutionResult {
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export function parseCommandArguments(argsString: string): string[] {
  const args: string[] = [];
  let currentArgument = '';
  let inSingleQuotes = false;
  let inDoubleQuotes = false;

  for (const character of argsString) {
    if (character === "'" && !inDoubleQuotes) {
      inSingleQuotes = !inSingleQuotes;
    } else if (character === '"' && !inSingleQuotes) {
      inDoubleQuotes = !inDoubleQuotes;
    } else if (/\s/.test(character) && !inSingleQuotes && !inDoubleQuotes) {
      if (currentArgument) {
        args.push(currentArgument);
        currentArgument = '';
      }
    } else {
      currentArgument += character;
    }
  }

  if (inSingleQuotes || inDoubleQuotes) {
    throw new Error('Unterminated quote in compiler command');
  }
  if (currentArgument) args.push(currentArgument);
  return args;
}

export async function runCompilerCommand(
  compileCommand: string,
  cppFile: string,
  logger: Logger
): Promise<CompilerExecutionResult> {
  const commandMatch = compileCommand.match(/^"([^"]+)"\s+(.*)$/)
    || compileCommand.match(/^(\S+)\s+(.*)$/);
  if (!commandMatch) throw new Error('Invalid compile command format');

  const executable = commandMatch[1];
  let args = parseCommandArguments(commandMatch[2]);
  const totalLength = executable.length + args.join(' ').length;
  logger.verbose(`Total command length: ${totalLength} characters`);

  if (totalLength > 7000) {
    logger.verbose('Command line too long, using response file');
    const responseFilePath = path.join(path.dirname(cppFile), 'compile_args.txt');
    const responseArgs: string[] = [];
    const directArgs: string[] = [];
    for (const argument of args) {
      if (argument.startsWith('-I') || argument.startsWith('@')) responseArgs.push(argument);
      else directArgs.push(argument);
    }

    await fs.writeFile(responseFilePath, responseArgs.join('\n'));
    directArgs.unshift(`@${responseFilePath}`);
    args = directArgs;
    logger.verbose(`Created response file with ${responseArgs.length} arguments: ${responseFilePath}`);
  }

  logger.verbose(`Executable: ${executable}`);
  logger.verbose(`Args: ${JSON.stringify(args)}`);

  return new Promise((resolve, reject) => {
    const childProcess = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    childProcess.stdout?.on('data', data => { stdout += data.toString(); });
    childProcess.stderr?.on('data', data => { stderr += data.toString(); });
    childProcess.on('error', error => reject(new Error(`Failed to run compiler: ${error.message}`)));
    childProcess.on('close', (exitCode, signal) => {
      logger.verbose(`Compiler exit code: ${exitCode}`);
      logger.verbose(`Compiler stdout: ${stdout}`);
      logger.verbose(`Compiler stderr: ${stderr}`);
      resolve({
        output: [stderr, stdout].filter(Boolean).join('\n'),
        exitCode,
        signal
      });
    });
  });
}
