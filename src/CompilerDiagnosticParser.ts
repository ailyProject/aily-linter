import path from 'path';
import type { LintError } from './ArduinoLinter';

export interface CompilerDiagnostics {
  errors: LintError[];
  warnings: LintError[];
  notes: LintError[];
}

function normalizeDiagnosticFile(file: string, originalFile: string): string {
  const trimmedFile = file.trim();
  return /(?:^|[\\/])sketch\.cpp$/i.test(trimmedFile)
    ? originalFile
    : path.normalize(trimmedFile);
}

function addDiagnostic(buckets: CompilerDiagnostics, diagnostic: LintError): void {
  if (diagnostic.severity === 'error') buckets.errors.push(diagnostic);
  else if (diagnostic.severity === 'warning') buckets.warnings.push(diagnostic);
  else buckets.notes.push(diagnostic);
}

export function parseCompilerDiagnostics(
  compilerOutput: string,
  originalFile: string,
  exitCode: number | null = 0,
  signal: NodeJS.Signals | null = null
): CompilerDiagnostics {
  const diagnostics: CompilerDiagnostics = { errors: [], warnings: [], notes: [] };
  if (!compilerOutput.trim() && exitCode === 0 && !signal) return diagnostics;

  for (const rawLine of compilerOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let match = line.match(/^(.*?):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.+)$/);
    if (match) {
      const [, file, lineNumber, columnNumber, severity, message] = match;
      addDiagnostic(diagnostics, {
        file: normalizeDiagnosticFile(file, originalFile),
        line: Number.parseInt(lineNumber, 10),
        column: Number.parseInt(columnNumber, 10),
        message: message.trim(),
        severity: severity.includes('error') ? 'error' : severity as 'warning' | 'note'
      });
      continue;
    }

    match = line.match(/^(.*?):(\d+):\s*(fatal error|error|warning|note):\s*(.+)$/);
    if (match) {
      const [, file, lineNumber, severity, message] = match;
      addDiagnostic(diagnostics, {
        file: normalizeDiagnosticFile(file, originalFile),
        line: Number.parseInt(lineNumber, 10),
        column: 1,
        message: message.trim(),
        severity: severity.includes('error') ? 'error' : severity as 'warning' | 'note'
      });
      continue;
    }

    match = line.match(/^(.*?):\s*(fatal error|error):\s*(.+)$/);
    if (match) {
      diagnostics.errors.push({
        file: normalizeDiagnosticFile(match[1], originalFile),
        line: 1,
        column: 1,
        message: match[3].trim(),
        severity: 'error'
      });
      continue;
    }

    if (line.includes('fatal error') || line.includes('error:')) {
      diagnostics.errors.push({
        file: originalFile,
        line: 1,
        column: 1,
        message: line,
        severity: 'error'
      });
    }
  }

  if ((exitCode !== 0 || signal) && diagnostics.errors.length === 0) {
    diagnostics.errors.push({
      file: originalFile,
      line: 1,
      column: 1,
      message: signal
        ? `Compiler terminated by signal ${signal}`
        : `Compiler exited with code ${exitCode}${compilerOutput.trim() ? `: ${compilerOutput.trim().split(/\r?\n/).slice(-1)[0]}` : ''}`,
      severity: 'error',
      code: 'COMPILER_EXECUTION_FAILED'
    });
  }

  return diagnostics;
}
