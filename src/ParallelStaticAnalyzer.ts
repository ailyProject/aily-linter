import { promises as fs } from 'fs';
import { FastRuleSetName, getFastRuleIds } from './FastLintRules';
import { Logger } from './utils/Logger';
import { CallExpression, SourceScanResult, SourceToken, scanSource } from './utils/SourceScanner';

export interface StaticAnalysisResult {
  errors: LintError[];
  warnings: LintError[];
  notes: LintError[];
  confidence: 'high' | 'medium' | 'low';
  needsCompilerCheck: boolean;
}

export interface LintError {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning' | 'note';
  code?: string;
}

export interface FastAnalysisOptions {
  board?: string;
  ruleSet?: FastRuleSetName;
}

interface TokenRange {
  name?: string;
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
}

interface AnalysisBuckets {
  errors: LintError[];
  warnings: LintError[];
  notes: LintError[];
}

function containsToken(range: TokenRange, tokenIndex: number): boolean {
  return tokenIndex >= range.bodyStart && tokenIndex <= range.bodyEnd;
}

function numericArgument(scan: SourceScanResult, call: CallExpression, argumentIndex: number): number | null {
  const range = call.argumentRanges[argumentIndex];
  if (!range || range[1] - range[0] !== 1) return null;
  const token = scan.tokens[range[0]];
  if (token?.kind !== 'number') return null;
  const value = Number(token.text.replace(/[uUlL]+$/, ''));
  return Number.isFinite(value) ? value : null;
}

export class ParallelStaticAnalyzer {
  constructor(private logger: Logger) {}

  async analyzeFile(sketchPath: string, options: FastAnalysisOptions = {}): Promise<StaticAnalysisResult> {
    const started = Date.now();
    try {
      const content = await fs.readFile(sketchPath, 'utf8');
      const scan = scanSource(content);
      const ruleSet = options.ruleSet || (options.board?.toLowerCase().includes('esp32') ? 'esp32' : 'standard');
      const enabledRules = getFastRuleIds(ruleSet);
      const buckets: AnalysisBuckets = { errors: [], warnings: [], notes: [] };
      const functions = this.findFunctions(scan);
      const loops = this.findLoops(scan);

      this.checkDelimiters(scan, sketchPath, buckets.errors);
      this.checkSemicolons(scan, sketchPath, buckets.errors);
      this.checkRequiredFunctions(scan, functions, sketchPath, enabledRules, buckets);
      this.checkIncludes(scan, sketchPath, buckets);
      this.checkCalls(scan, functions, loops, sketchPath, enabledRules, buckets);
      this.checkTokenRules(scan, loops, sketchPath, enabledRules, buckets);
      this.deduplicate(buckets);

      const complexity = scan.tokens.length + scan.lines.length;
      const confidence = buckets.errors.length > 0 || complexity < 2000
        ? 'high'
        : complexity < 20000 ? 'medium' : 'low';
      this.logger.debug(`Single-pass static analysis completed in ${Date.now() - started}ms`);
      return {
        ...buckets,
        confidence,
        needsCompilerCheck: buckets.errors.length > 0 || confidence === 'low' || buckets.warnings.length > 5
      };
    } catch (error) {
      this.logger.error(`Static analysis failed: ${error}`);
      return {
        errors: [{
          file: sketchPath,
          line: 0,
          column: 0,
          message: `Failed to analyze file: ${error instanceof Error ? error.message : error}`,
          severity: 'error'
        }],
        warnings: [],
        notes: [],
        confidence: 'low',
        needsCompilerCheck: true
      };
    }
  }

  private diagnostic(file: string, token: SourceToken, message: string, severity: LintError['severity'], code: string): LintError {
    return { file, line: token.line, column: token.column, message, severity, code };
  }

  private findFunctions(scan: SourceScanResult): TokenRange[] {
    const ranges: TokenRange[] = [];
    for (let index = 0; index + 2 < scan.tokens.length; index++) {
      const token = scan.tokens[index];
      if (token.kind !== 'identifier' || scan.tokens[index + 1].text !== '(') continue;
      const closeParen = scan.delimiterPairs.get(index + 1);
      if (closeParen === undefined || scan.tokens[closeParen + 1]?.text !== '{') continue;
      const closeBrace = scan.delimiterPairs.get(closeParen + 1);
      if (closeBrace === undefined) continue;
      ranges.push({ name: token.text, start: index, end: closeBrace, bodyStart: closeParen + 2, bodyEnd: closeBrace - 1 });
    }
    return ranges;
  }

  private findLoops(scan: SourceScanResult): TokenRange[] {
    const ranges: TokenRange[] = [];
    for (let index = 0; index + 2 < scan.tokens.length; index++) {
      if (!['for', 'while'].includes(scan.tokens[index].text) || scan.tokens[index + 1].text !== '(') continue;
      const closeParen = scan.delimiterPairs.get(index + 1);
      if (closeParen === undefined) continue;
      const bodyOpen = closeParen + 1;
      if (scan.tokens[bodyOpen]?.text === '{') {
        const bodyClose = scan.delimiterPairs.get(bodyOpen);
        if (bodyClose !== undefined) ranges.push({ start: index, end: bodyClose, bodyStart: bodyOpen + 1, bodyEnd: bodyClose - 1 });
      } else {
        let bodyEnd = bodyOpen;
        while (bodyEnd < scan.tokens.length && scan.tokens[bodyEnd].text !== ';') bodyEnd++;
        ranges.push({ start: index, end: bodyEnd, bodyStart: bodyOpen, bodyEnd });
      }
    }
    return ranges;
  }

  private checkDelimiters(scan: SourceScanResult, file: string, errors: LintError[]): void {
    for (const issue of scan.delimiterIssues) {
      errors.push({ file, line: issue.line, column: issue.column, message: issue.message, severity: 'error', code: 'UNMATCHED_BRACKET' });
    }
  }

  private checkSemicolons(scan: SourceScanResult, file: string, errors: LintError[]): void {
    for (let index = 0; index < scan.codeLines.length; index++) {
      const line = scan.codeLines[index];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || /[;{},:]$/.test(trimmed)) continue;
      if (/^(?:if|for|while|switch|else|do|class|struct|enum|namespace)\b/.test(trimmed)) continue;
      if (/^(?:public|private|protected)\s*:/.test(trimmed) || trimmed.endsWith('\\')) continue;
      if (!/[=+\-*/%)]/.test(trimmed)) continue;
      errors.push({
        file,
        line: index + 1,
        column: Math.max(1, line.length),
        message: "Expected ';' at end of statement",
        severity: 'error',
        code: 'MISSING_SEMICOLON'
      });
    }
  }

  private checkRequiredFunctions(
    scan: SourceScanResult,
    functions: TokenRange[],
    file: string,
    enabledRules: Set<string>,
    buckets: AnalysisBuckets
  ): void {
    for (const name of ['setup', 'loop']) {
      const range = functions.find(item => item.name === name);
      if (!range) {
        buckets.warnings.push({
          file, line: 1, column: 1, message: `Missing required ${name}() function`, severity: 'warning', code: `MISSING_${name.toUpperCase()}`
        });
        continue;
      }
      const token = scan.tokens[range.start];
      buckets.notes.push(this.diagnostic(file, token, `Found required Arduino function: ${name}`, 'note', 'ARDUINO_FUNCTION'));
      if (range.bodyStart > range.bodyEnd && enabledRules.has(`empty-${name}`)) {
        buckets.notes.push(this.diagnostic(file, token, `Empty ${name}() function`, 'note', `empty-${name}`));
      }
    }
  }

  private checkIncludes(scan: SourceScanResult, file: string, buckets: AnalysisBuckets): void {
    const includes: string[] = [];
    for (let index = 0; index < scan.codeLines.length; index++) {
      if (!/^\s*#\s*include\b/.test(scan.codeLines[index])) continue;
      const match = scan.lines[index].match(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/);
      if (!match) continue;
      includes.push(match[1]);
      buckets.notes.push({
        file, line: index + 1, column: 1, message: `Include dependency: ${match[1]}`, severity: 'note', code: 'INCLUDE_FOUND'
      });
    }

    const usesArduinoApi = scan.calls.some(call => ['pinMode', 'digitalWrite', 'digitalRead', 'Serial.begin'].includes(call.name));
    if (usesArduinoApi && !includes.some(include => include === 'Arduino.h')) {
      buckets.warnings.push({
        file, line: 1, column: 1,
        message: 'Arduino functions used but Arduino.h not explicitly included (may be auto-included)',
        severity: 'warning', code: 'MISSING_ARDUINO_H'
      });
    }
  }

  private checkCalls(
    scan: SourceScanResult,
    functions: TokenRange[],
    loops: TokenRange[],
    file: string,
    rules: Set<string>,
    buckets: AnalysisBuckets
  ): void {
    const callNames = new Set(scan.calls.map(call => call.name));
    for (const call of scan.calls) {
      const token = scan.tokens[call.tokenIndex];
      const inLoop = loops.some(loop => containsToken(loop, call.tokenIndex));
      const inSetup = functions.some(fn => fn.name === 'setup' && containsToken(fn, call.tokenIndex));

      if (call.name === 'delay' && rules.has('delay-blocking')) {
        buckets.warnings.push(this.diagnostic(file, token, 'delay() blocks execution. Consider using millis() for non-blocking timing.', 'warning', 'delay-blocking'));
      }
      if (call.name === 'delayMicroseconds' && rules.has('delay-microseconds-long')) {
        const duration = numericArgument(scan, call, 0);
        if (duration !== null && duration > 16383) {
          buckets.notes.push(this.diagnostic(file, token, 'For delays > 16383us, consider using delay() or millis() instead', 'note', 'delay-microseconds-long'));
        }
      }
      if (call.name === 'analogWrite' && rules.has('analog-write-range')) {
        const value = numericArgument(scan, call, 1);
        if (value !== null && (value < 0 || value > 255)) {
          buckets.notes.push(this.diagnostic(file, token, 'analogWrite() value should be 0-255', 'note', 'analog-write-range'));
        }
      }
      if (call.name === 'Serial.begin' && !inSetup) {
        buckets.notes.push(this.diagnostic(file, token, 'Serial.begin() should typically be called in setup()', 'note', 'SERIAL_PLACEMENT'));
      }
      if (call.name === 'attachInterrupt' && rules.has('interrupt-caution')) {
        buckets.notes.push(this.diagnostic(file, token, 'Interrupt handlers should be short. Avoid delay(), Serial, or long operations.', 'note', 'interrupt-caution'));
      }
      if (['digitalWrite', 'digitalRead'].includes(call.name)) {
        const pin = numericArgument(scan, call, 0);
        if (pin !== null) {
          buckets.notes.push(this.diagnostic(file, token, `Using pin ${pin} - ensure pinMode() is set`, 'note', 'PIN_MODE_CHECK'));
        }
      }
      if (call.name === 'pinMode' && numericArgument(scan, call, 0) !== null && rules.has('magic-number-pin')) {
        buckets.notes.push(this.diagnostic(file, token, 'Consider using a named constant for pin numbers', 'note', 'magic-number-pin'));
      }
      if (call.name === 'digitalWrite' && inLoop && rules.has('frequent-digital-write')) {
        buckets.notes.push(this.diagnostic(file, token, 'For faster I/O, consider direct port manipulation', 'note', 'frequent-digital-write'));
      }
      if (call.name === 'malloc' && rules.has('malloc-warning')) {
        buckets.warnings.push(this.diagnostic(file, token, 'Dynamic memory allocation is risky on embedded systems. Consider static allocation.', 'warning', 'malloc-warning'));
      }
      if (call.name === 'WiFi.begin' && rules.has('esp32-wifi-begin')) {
        buckets.notes.push(this.diagnostic(file, token, 'Consider calling WiFi.mode() before WiFi.begin() on ESP32', 'note', 'esp32-wifi-begin'));
      }
      if (call.name === 'xTaskCreate' && rules.has('esp32-task-stack')) {
        buckets.notes.push(this.diagnostic(file, token, 'Ensure adequate stack size for xTaskCreate', 'note', 'esp32-task-stack'));
      }
      if (call.name.startsWith('HAL_') && rules.has('stm32-hal-init')) {
        buckets.notes.push(this.diagnostic(file, token, 'Ensure HAL_Init() and clock configuration run before peripheral use', 'note', 'stm32-hal-init'));
      }
    }

    if (callNames.has('noInterrupts') && !callNames.has('interrupts') && rules.has('no-interrupts-warning')) {
      const call = scan.calls.find(item => item.name === 'noInterrupts')!;
      buckets.warnings.push(this.diagnostic(file, scan.tokens[call.tokenIndex], 'Remember to call interrupts() after noInterrupts()', 'warning', 'no-interrupts-warning'));
    }
  }

  private checkTokenRules(
    scan: SourceScanResult,
    loops: TokenRange[],
    file: string,
    rules: Set<string>,
    buckets: AnalysisBuckets
  ): void {
    for (let index = 0; index < scan.tokens.length; index++) {
      const token = scan.tokens[index];
      const inLoop = loops.some(loop => containsToken(loop, index));
      if (token.text === 'String' && scan.tokens[index + 1]?.kind === 'identifier' && rules.has('string-fragmentation')) {
        buckets.warnings.push(this.diagnostic(file, token, 'String objects can cause memory fragmentation. Consider using char arrays.', 'warning', 'string-fragmentation'));
      }
      if (token.text === 'new' && rules.has('new-warning')) {
        buckets.warnings.push(this.diagnostic(file, token, 'Dynamic memory allocation is risky on embedded systems. Consider static allocation.', 'warning', 'new-warning'));
      }
      if (token.text === 'float' && inLoop && rules.has('float-in-loop')) {
        buckets.notes.push(this.diagnostic(file, token, 'Floating-point operations are slow on many Arduino boards.', 'note', 'float-in-loop'));
      }
      if (token.text === '%' && rules.has('modulo-power-of-two')) {
        buckets.notes.push(this.diagnostic(file, token, 'For powers of 2, consider bitwise AND instead of modulo', 'note', 'modulo-power-of-two'));
      }
      if (token.text === '/' && rules.has('division-operation')) {
        buckets.notes.push(this.diagnostic(file, token, 'Division can be slow; powers of 2 can use right shift', 'note', 'division-operation'));
      }
      if (token.kind === 'identifier' && scan.tokens[index + 1]?.text === '[' && rules.has('large-array')) {
        const close = scan.delimiterPairs.get(index + 1);
        const sizeToken = scan.tokens[index + 2];
        if (close === index + 3 && sizeToken?.kind === 'number' && Number(sizeToken.text) >= 128) {
          buckets.notes.push(this.diagnostic(file, token, 'Large arrays consume significant RAM. Consider PROGMEM for constant data.', 'note', 'large-array'));
        }
      }
    }
  }

  private deduplicate(buckets: AnalysisBuckets): void {
    for (const key of ['errors', 'warnings', 'notes'] as const) {
      const seen = new Set<string>();
      buckets[key] = buckets[key].filter(item => {
        const identity = `${item.line}:${item.column}:${item.code}:${item.message}`;
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      });
    }
  }
}