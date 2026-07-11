export type SourceTokenKind = 'identifier' | 'number' | 'punctuation';

export interface SourceToken {
    kind: SourceTokenKind;
    text: string;
    index: number;
    endIndex: number;
    line: number;
    column: number;
}

export interface DelimiterIssue {
    index: number;
    line: number;
    column: number;
    message: string;
}

export interface CallExpression {
    name: string;
    tokenIndex: number;
    openTokenIndex: number;
    closeTokenIndex: number;
    argumentRanges: Array<[number, number]>;
}

export interface SourceScanResult {
    source: string;
    code: string;
    lines: string[];
    codeLines: string[];
    tokens: SourceToken[];
    delimiterPairs: Map<number, number>;
    delimiterIssues: DelimiterIssue[];
    calls: CallExpression[];
}

const OPENING: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSING: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function isIdentifierStart(char: string): boolean {
    return /[A-Za-z_]/.test(char);
}

function isIdentifierPart(char: string): boolean {
    return /[A-Za-z0-9_]/.test(char);
}

function blank(output: string[], index: number, char: string): void {
    output[index] = char === '\r' || char === '\n' ? char : ' ';
}

function findRawStringEnd(source: string, index: number): number | null {
    const prefix = source.slice(index).match(/^(?:u8|u|U|L)?R"([^\s()\\]{0,16})\(/);
    if (!prefix) return null;
    const terminator = `)${prefix[1]}"`;
    const end = source.indexOf(terminator, index + prefix[0].length);
    return end < 0 ? source.length : end + terminator.length;
}

function collectCalls(tokens: SourceToken[], pairs: Map<number, number>): CallExpression[] {
    const calls: CallExpression[] = [];
    const controlKeywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'sizeof', 'alignof', 'decltype']);

    for (let index = 0; index + 1 < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind !== 'identifier' || tokens[index + 1].text !== '(' || controlKeywords.has(token.text)) continue;
        const closeTokenIndex = pairs.get(index + 1);
        if (closeTokenIndex === undefined) continue;

        let name = token.text;
        if (index >= 2 && (tokens[index - 1].text === '.' || tokens[index - 1].text === '->')) {
            name = `${tokens[index - 2].text}.${name}`;
        }

        const argumentRanges: Array<[number, number]> = [];
        let argumentStart = index + 2;
        let nestedDepth = 0;
        for (let cursor = argumentStart; cursor < closeTokenIndex; cursor++) {
            const text = tokens[cursor].text;
            if (text === '(' || text === '[' || text === '{') nestedDepth++;
            else if (text === ')' || text === ']' || text === '}') nestedDepth--;
            else if (text === ',' && nestedDepth === 0) {
                argumentRanges.push([argumentStart, cursor]);
                argumentStart = cursor + 1;
            }
        }
        if (argumentStart < closeTokenIndex) argumentRanges.push([argumentStart, closeTokenIndex]);

        calls.push({ name, tokenIndex: index, openTokenIndex: index + 1, closeTokenIndex, argumentRanges });
    }
    return calls;
}

export function scanSource(source: string): SourceScanResult {
    const output = source.split('');
    const tokens: SourceToken[] = [];
    let line = 1;
    let column = 1;

    const advancePosition = (char: string) => {
        if (char === '\n') {
            line++;
            column = 1;
        } else {
            column++;
        }
    };

    for (let index = 0; index < source.length;) {
        const char = source[index];
        const next = source[index + 1];

        if (char === '/' && next === '/') {
            while (index < source.length && source[index] !== '\n') {
                blank(output, index, source[index]);
                advancePosition(source[index]);
                index++;
            }
            continue;
        }

        if (char === '/' && next === '*') {
            while (index < source.length) {
                const current = source[index];
                const closes = current === '*' && source[index + 1] === '/';
                blank(output, index, current);
                advancePosition(current);
                index++;
                if (closes && index < source.length) {
                    blank(output, index, source[index]);
                    advancePosition(source[index]);
                    index++;
                    break;
                }
            }
            continue;
        }

        const rawStringEnd = findRawStringEnd(source, index);
        if (rawStringEnd !== null) {
            while (index < rawStringEnd) {
                blank(output, index, source[index]);
                advancePosition(source[index]);
                index++;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            const quote = char;
            let escaped = false;
            blank(output, index, source[index]);
            advancePosition(source[index]);
            index++;
            while (index < source.length) {
                const current = source[index];
                blank(output, index, current);
                advancePosition(current);
                index++;
                if (escaped) escaped = false;
                else if (current === '\\') escaped = true;
                else if (current === quote) break;
            }
            continue;
        }

        if (isIdentifierStart(char)) {
            const start = index;
            const tokenLine = line;
            const tokenColumn = column;
            index++;
            column++;
            while (index < source.length && isIdentifierPart(source[index])) {
                index++;
                column++;
            }
            tokens.push({
                kind: 'identifier',
                text: source.slice(start, index),
                index: start,
                endIndex: index,
                line: tokenLine,
                column: tokenColumn
            });
            continue;
        }

        if (/[0-9]/.test(char)) {
            const start = index;
            const tokenLine = line;
            const tokenColumn = column;
            index++;
            column++;
            while (index < source.length && /[A-Za-z0-9_'.]/.test(source[index])) {
                index++;
                column++;
            }
            tokens.push({
                kind: 'number',
                text: source.slice(start, index),
                index: start,
                endIndex: index,
                line: tokenLine,
                column: tokenColumn
            });
            continue;
        }

        const doublePunctuation = source.slice(index, index + 2);
        const punctuation = ['->', '::', '++', '--', '&&', '||', '==', '!=', '<=', '>=', '<<', '>>']
            .includes(doublePunctuation) ? doublePunctuation : char;
        if (/[^\s]/.test(char)) {
            tokens.push({
                kind: 'punctuation',
                text: punctuation,
                index,
                endIndex: index + punctuation.length,
                line,
                column
            });
        }
        for (let offset = 0; offset < punctuation.length; offset++) advancePosition(source[index + offset]);
        index += punctuation.length;
    }

    const delimiterPairs = new Map<number, number>();
    const delimiterIssues: DelimiterIssue[] = [];
    const stack: number[] = [];
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (OPENING[token.text]) {
            stack.push(index);
        } else if (CLOSING[token.text]) {
            const openIndex = stack.pop();
            if (openIndex === undefined || tokens[openIndex].text !== CLOSING[token.text]) {
                delimiterIssues.push({
                    index: token.index,
                    line: token.line,
                    column: token.column,
                    message: `Unexpected '${token.text}' - no matching opening bracket`
                });
                if (openIndex !== undefined) stack.push(openIndex);
            } else {
                delimiterPairs.set(openIndex, index);
                delimiterPairs.set(index, openIndex);
            }
        }
    }
    for (const tokenIndex of stack) {
        const token = tokens[tokenIndex];
        delimiterIssues.push({
            index: token.index,
            line: token.line,
            column: token.column,
            message: `Unmatched '${token.text}' - missing closing '${OPENING[token.text]}'`
        });
    }

    const code = output.join('');
    return {
        source,
        code,
        lines: source.split(/\r?\n/),
        codeLines: code.split(/\r?\n/),
        tokens,
        delimiterPairs,
        delimiterIssues,
        calls: collectCalls(tokens, delimiterPairs)
    };
}