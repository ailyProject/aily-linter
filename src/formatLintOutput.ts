export interface OutputDiagnostic {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity: 'error' | 'warning' | 'note';
  code?: string;
}

export interface OutputLintResult {
  success: boolean;
  errors: OutputDiagnostic[];
  warnings: OutputDiagnostic[];
  notes: OutputDiagnostic[];
  executionTime: number;
}

export function formatLintOutput(
  result: OutputLintResult,
  format: 'vscode' | 'json' | 'human' = 'human'
): string {
  if (format === 'json') return JSON.stringify(result, null, 2);

  const diagnostics = [...result.errors, ...result.warnings, ...result.notes];
  if (format === 'vscode') {
    return diagnostics.map(diagnostic => {
      const location = diagnostic.endLine && diagnostic.endColumn
        ? `${diagnostic.file}(${diagnostic.line},${diagnostic.column},${diagnostic.endLine},${diagnostic.endColumn})`
        : `${diagnostic.file}(${diagnostic.line},${diagnostic.column})`;
      const code = diagnostic.code ? ` ${diagnostic.code}` : '';
      return `${location}: ${diagnostic.severity}${code}: ${diagnostic.message}`;
    }).join('\n');
  }

  const lines: string[] = [];
  const append = (title: string, items: OutputDiagnostic[]) => {
    if (items.length === 0) return;
    lines.push(`\n${title}:`);
    for (const item of items) {
      lines.push(`  ${item.file}:${item.line}:${item.column}`);
      lines.push(`    ${item.message}`);
      if (item.code) lines.push(`    [${item.code}]`);
    }
  };
  append('Errors', result.errors);
  append('Warnings', result.warnings);
  if (result.errors.length === 0 && result.warnings.length === 0) append('Notes', result.notes);
  lines.push('\n' + '-'.repeat(50));
  lines.push(`Summary: ${result.errors.length} errors, ${result.warnings.length} warnings`);
  lines.push(`Time: ${result.executionTime}ms`);
  lines.push(result.success ? 'Syntax check passed!' : 'Syntax check failed!');
  return lines.join('\n');
}