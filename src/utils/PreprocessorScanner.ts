import {
    ExpressionEvaluator,
    MacroDefinition,
    MacroExpander
} from './PreprocessorExpression';

export interface PreprocessorScanOptions {
    onInclude?: (includePath: string) => void;
}

export interface PreprocessorScanResult {
    includes: string[];
    defines: Map<string, MacroDefinition>;
}

interface ConditionalFrame {
    parentActive: boolean;
    active: boolean;
    branchTaken: boolean;
}

function joinLogicalLines(sourceCode: string): string {
    return sourceCode.replace(/\\(?:\r\n|\n|\r)/g, '');
}

function stripCommentsByLine(sourceCode: string): string[] {
    const lines: string[] = [];
    let current = '';
    let inBlockComment = false;
    let quote: '"' | "'" | null = null;
    let escaped = false;

    for (let index = 0; index < sourceCode.length; index++) {
        const char = sourceCode[index];
        const next = sourceCode[index + 1];

        if (char === '\r' || char === '\n') {
            if (char === '\r' && next === '\n') index++;
            lines.push(current);
            current = '';
            quote = null;
            escaped = false;
            continue;
        }

        if (inBlockComment) {
            if (char === '*' && next === '/') {
                current += '  ';
                index++;
                inBlockComment = false;
            } else {
                current += ' ';
            }
            continue;
        }

        if (quote) {
            current += char;
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === quote) {
                quote = null;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            current += char;
            continue;
        }

        if (char === '/' && next === '/') {
            while (index < sourceCode.length && sourceCode[index] !== '\r' && sourceCode[index] !== '\n') {
                current += ' ';
                index++;
            }
            index--;
            continue;
        }

        if (char === '/' && next === '*') {
            current += '  ';
            index++;
            inBlockComment = true;
            continue;
        }

        current += char;
    }

    lines.push(current);
    return lines;
}

function parseMacroDefinition(text: string): MacroDefinition | null {
    const prefix = text.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)/);
    if (!prefix) return null;

    const name = prefix[1];
    let remainder = text.slice(prefix[0].length);
    if (!remainder.startsWith('(')) {
        return { name, value: remainder.trim(), isDefined: true, functionLike: false };
    }

    const closeParen = remainder.indexOf(')');
    if (closeParen < 0) return null;

    const parameterText = remainder.slice(1, closeParen).trim();
    const parameters: string[] = [];
    let variadic = false;
    if (parameterText) {
        const rawParameters = parameterText.split(',');
        for (let index = 0; index < rawParameters.length; index++) {
            const parameter = rawParameters[index].trim();
            if (parameter === '...') {
                if (index !== rawParameters.length - 1) return null;
                parameters.push('__VA_ARGS__');
                variadic = true;
            } else if (/^[A-Za-z_][A-Za-z0-9_]*\.\.\.$/.test(parameter)) {
                if (index !== rawParameters.length - 1) return null;
                parameters.push(parameter.slice(0, -3));
                variadic = true;
            } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter)) {
                parameters.push(parameter);
            } else {
                return null;
            }
        }
    }

    remainder = remainder.slice(closeParen + 1);
    return {
        name,
        value: remainder.trim(),
        isDefined: true,
        functionLike: true,
        parameters,
        variadic
    };
}

function extractIncludePath(text: string, defines: Map<string, MacroDefinition>): string | null {
    const expanded = new MacroExpander(defines).expand(text).trim();
    const systemHeader = expanded.match(/^<([^>\r\n]+)>$/);
    if (systemHeader) return systemHeader[1].trim();

    const quotedHeader = expanded.match(/^"((?:\\.|[^"\\])*)"$/);
    return quotedHeader ? quotedHeader[1].replace(/\\([\\"])/g, '$1') : null;
}

export function scanPreprocessor(
    sourceCode: string,
    defines: Map<string, MacroDefinition>,
    options: PreprocessorScanOptions = {}
): PreprocessorScanResult {
    const includes = new Set<string>();
    const conditionalStack: ConditionalFrame[] = [];
    const lines = stripCommentsByLine(joinLogicalLines(sourceCode));
    const isActive = () => conditionalStack.length === 0 || conditionalStack[conditionalStack.length - 1].active;

    for (const line of lines) {
        const directive = line.match(/^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s+(.*)|\s*)$/);
        if (!directive) continue;

        const name = directive[1];
        const body = directive[2] || '';
        if (name === 'if' || name === 'ifdef' || name === 'ifndef') {
            const parentActive = isActive();
            const evaluator = new ExpressionEvaluator(defines);
            const macroName = body.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1] || '';
            const condition = name === 'ifdef'
                ? evaluator.hasMacro(macroName)
                : name === 'ifndef'
                    ? !evaluator.hasMacro(macroName)
                    : evaluator.evaluate(body);
            conditionalStack.push({
                parentActive,
                active: parentActive && condition,
                branchTaken: condition
            });
            continue;
        }

        if (name === 'elif') {
            const frame = conditionalStack[conditionalStack.length - 1];
            if (!frame) continue;
            const condition = !frame.branchTaken && new ExpressionEvaluator(defines).evaluate(body);
            frame.active = frame.parentActive && condition;
            frame.branchTaken ||= condition;
            continue;
        }

        if (name === 'else') {
            const frame = conditionalStack[conditionalStack.length - 1];
            if (!frame) continue;
            frame.active = frame.parentActive && !frame.branchTaken;
            frame.branchTaken = true;
            continue;
        }

        if (name === 'endif') {
            conditionalStack.pop();
            continue;
        }

        if (!isActive()) continue;

        if (name === 'define') {
            const definition = parseMacroDefinition(body);
            if (definition) defines.set(definition.name, definition);
        } else if (name === 'undef') {
            const macroName = body.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
            if (macroName) defines.set(macroName, { name: macroName, isDefined: false });
        } else if (name === 'include') {
            const includePath = extractIncludePath(body, defines);
            if (includePath) {
                includes.add(includePath);
                options.onInclude?.(includePath);
            }
        }
    }

    return { includes: [...includes], defines };
}