import {
  PreprocessorDirectiveFlags,
  PreprocessorDirectiveOpcode,
  scanPreprocessorDirectives
} from './PreprocessorDirectiveScanner';
import { ExpressionEvaluator, MacroDefinition } from './PreprocessorExpression';

type ConditionalState = boolean | null;

interface ConditionalFrame {
  parentState: ConditionalState;
  currentState: ConditionalState;
  branchTaken: ConditionalState;
  seenElse: boolean;
}

function blankLine(line: string): string {
  return line.replace(/[^\r]/g, ' ');
}

function parentAndCondition(parent: ConditionalState, condition: ConditionalState): ConditionalState {
  if (parent === false || condition === false) return false;
  if (parent === null || condition === null) return null;
  return true;
}

function parseMacroName(payload: string): string | null {
  return payload.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)/)?.[1] || null;
}

function evaluateExpression(
  expression: string,
  defines: Map<string, MacroDefinition>
): ConditionalState {
  const result = new ExpressionEvaluator(defines).evaluateDetailed(expression);
  return result.kind === 'known' ? result.value : null;
}

function getBoardDefines(board?: string): Map<string, MacroDefinition> {
  const defines = new Map<string, MacroDefinition>();
  const set = (name: string, value = '1') => defines.set(name, { name, value, isDefined: true });
  set('ARDUINO', '100');

  const normalized = (board || '').toUpperCase();
  if (normalized.includes('ESP32')) {
    set('ESP32');
    set('ARDUINO_ARCH_ESP32');
  } else if (normalized.includes('STM32')) {
    set('ARDUINO_ARCH_STM32');
  } else if (normalized.includes('AVR')) {
    set('ARDUINO_ARCH_AVR');
  }
  return defines;
}

/**
 * Masks only branches that can be proven inactive with the macros available to
 * fast mode. Unknown conditions remain visible so the lightweight analyzer does
 * not silently discard a possible branch.
 */
export function maskInactivePreprocessorBranches(source: string, board?: string): string {
  const tape = scanPreprocessorDirectives(source);
  if (tape.diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
    return source;
  }

  const lines = source.split('\n');
  const output = [...lines];
  const directivesByLine = new Map<number, number>();
  for (let index = 0; index < tape.opcodes.length; index++) {
    directivesByLine.set(tape.lineNumbers[index], index);
  }

  const defines = getBoardDefines(board);
  const frames: ConditionalFrame[] = [];
  const currentState = (): ConditionalState => frames.length > 0
    ? frames[frames.length - 1].currentState
    : true;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineNumber = lineIndex + 1;
    const directiveIndex = directivesByLine.get(lineNumber);
    if (directiveIndex === undefined) {
      if (currentState() === false) output[lineIndex] = blankLine(lines[lineIndex]);
      continue;
    }

    let directiveEndLine = lineIndex;
    while (directiveEndLine + 1 < lines.length && /\\\s*\r?$/.test(lines[directiveEndLine])) {
      directiveEndLine++;
    }

    const opcode = tape.opcodes[directiveIndex] as PreprocessorDirectiveOpcode;
    const flags = tape.flags[directiveIndex] as PreprocessorDirectiveFlags;
    const payloadIndex = tape.payloadIndices[directiveIndex];
    const payload = payloadIndex >= 0 ? tape.payloads[payloadIndex] : '';
    const stateBeforeDirective = currentState();
    let preserveDirective = false;

    if (opcode === PreprocessorDirectiveOpcode.If
      || opcode === PreprocessorDirectiveOpcode.Ifdef
      || opcode === PreprocessorDirectiveOpcode.Ifndef) {
      let condition: ConditionalState;
      if (opcode === PreprocessorDirectiveOpcode.If) {
        condition = evaluateExpression(payload, defines);
      } else {
        const name = parseMacroName(payload);
        condition = name ? defines.get(name)?.isDefined === true : null;
        if (condition !== null && opcode === PreprocessorDirectiveOpcode.Ifndef) condition = !condition;
      }
      const branchState = parentAndCondition(stateBeforeDirective, condition);
      frames.push({
        parentState: stateBeforeDirective,
        currentState: branchState,
        branchTaken: condition,
        seenElse: false
      });
    } else if (opcode === PreprocessorDirectiveOpcode.Elif
      || opcode === PreprocessorDirectiveOpcode.Elifdef
      || opcode === PreprocessorDirectiveOpcode.Elifndef) {
      const frame = frames[frames.length - 1];
      if (frame && !frame.seenElse) {
        let condition: ConditionalState;
        if (opcode === PreprocessorDirectiveOpcode.Elif) {
          condition = evaluateExpression(payload, defines);
        } else {
          const name = parseMacroName(payload);
          condition = name ? defines.get(name)?.isDefined === true : null;
          if (condition !== null && opcode === PreprocessorDirectiveOpcode.Elifndef) condition = !condition;
        }

        if (frame.parentState === false || frame.branchTaken === true) {
          frame.currentState = false;
        } else if (frame.parentState === null || frame.branchTaken === null || condition === null) {
          frame.currentState = null;
        } else {
          frame.currentState = condition;
        }
        if (frame.branchTaken === false) frame.branchTaken = condition;
        else if (frame.branchTaken === null || condition === null) frame.branchTaken = null;
      }
    } else if (opcode === PreprocessorDirectiveOpcode.Else) {
      const frame = frames[frames.length - 1];
      if (frame && !frame.seenElse) {
        frame.seenElse = true;
        if (frame.parentState === false || frame.branchTaken === true) frame.currentState = false;
        else if (frame.parentState === null || frame.branchTaken === null) frame.currentState = null;
        else frame.currentState = true;
        if (frame.currentState === true) frame.branchTaken = true;
      }
    } else if (opcode === PreprocessorDirectiveOpcode.Endif) {
      frames.pop();
    } else if (stateBeforeDirective === true && opcode === PreprocessorDirectiveOpcode.Define) {
      const match = payload.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s+(.*))?$/);
      if (match && (flags & PreprocessorDirectiveFlags.FunctionLikeMacro) === 0) {
        defines.set(match[1], {
          name: match[1],
          value: match[2]?.trim() || '1',
          isDefined: true
        });
      }
    } else if (stateBeforeDirective === true && opcode === PreprocessorDirectiveOpcode.Undef) {
      const name = parseMacroName(payload);
      if (name) defines.set(name, { name, isDefined: false });
    } else if (stateBeforeDirective !== false
      && (opcode === PreprocessorDirectiveOpcode.Include
        || opcode === PreprocessorDirectiveOpcode.IncludeNext
        || opcode === PreprocessorDirectiveOpcode.Import)) {
      preserveDirective = true;
    }

    if (!preserveDirective) {
      for (let index = lineIndex; index <= directiveEndLine; index++) {
        output[index] = blankLine(lines[index]);
      }
    }
    lineIndex = directiveEndLine;
  }

  return output.join('\n');
}
