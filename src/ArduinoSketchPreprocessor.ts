import fs from 'fs-extra';
import path from 'path';
import { scanSource } from './utils/SourceScanner';
import { maskInactivePreprocessorBranches } from './utils/FastPreprocessor';

export interface PreprocessedSketch {
  content: string;
  sourceFiles: string[];
  generatedPrototypes: string[];
}

function escapeLinePath(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/').replace(/"/g, '\\"');
}

function findGeneratedPrototypes(source: string): string[] {
  const analysisSource = maskInactivePreprocessorBranches(source);
  const scan = scanSource(analysisSource);
  const prototypes = new Set<string>();
  let braceDepth = 0;
  let lastTopLevelBoundary = -1;

  for (let index = 0; index < scan.tokens.length; index++) {
    const token = scan.tokens[index];
    if (token.text === '{') {
      braceDepth++;
      continue;
    }
    if (token.text === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      if (braceDepth === 0) lastTopLevelBoundary = index;
      continue;
    }
    if (braceDepth === 0 && token.text === ';') {
      lastTopLevelBoundary = index;
      continue;
    }

    if (braceDepth !== 0 || token.kind !== 'identifier' || scan.tokens[index + 1]?.text !== '(') {
      continue;
    }
    if (['if', 'for', 'while', 'switch', 'catch'].includes(token.text)) continue;

    const closeParen = scan.delimiterPairs.get(index + 1);
    if (closeParen === undefined || scan.tokens[closeParen + 1]?.text !== '{') continue;
    if (scan.tokens[index - 1]?.text === '::' || scan.tokens[index - 1]?.text === '.' || scan.tokens[index - 1]?.text === '->') {
      continue;
    }

    const signatureTokens = scan.tokens.slice(lastTopLevelBoundary + 1, closeParen + 1);
    if (signatureTokens.length < 3) continue;
    if (signatureTokens.some(item => item.text === '=' || item.text === 'template' || item.text === 'operator')) continue;

    let signature = analysisSource
      .slice(signatureTokens[0].index, signatureTokens[signatureTokens.length - 1].endIndex)
      .trim();
    const signatureLines = signature.split(/\r?\n/);
    while (signatureLines.length > 0
      && (!signatureLines[0].trim() || signatureLines[0].trim().startsWith('#'))) {
      signatureLines.shift();
    }
    signature = signatureLines.join(' ').replace(/\s+/g, ' ').trim();
    if (!signature || signature.startsWith('#') || !signature.includes(token.text)) continue;

    prototypes.add(`${signature};`);
  }

  return [...prototypes];
}

export async function preprocessArduinoSketch(sketchPath: string): Promise<PreprocessedSketch> {
  const resolvedSketchPath = path.resolve(sketchPath);
  const extension = path.extname(resolvedSketchPath).toLowerCase();
  const primaryContent = await fs.readFile(resolvedSketchPath, 'utf8');
  if (extension !== '.ino' && extension !== '.pde') {
    return { content: primaryContent, sourceFiles: [resolvedSketchPath], generatedPrototypes: [] };
  }

  const sketchDirectory = path.dirname(resolvedSketchPath);
  const entries = await fs.readdir(sketchDirectory, { withFileTypes: true });
  const additionalSketches = entries
    .filter(entry => entry.isFile() && ['.ino', '.pde'].includes(path.extname(entry.name).toLowerCase()))
    .map(entry => path.resolve(sketchDirectory, entry.name))
    .filter(filePath => filePath !== resolvedSketchPath)
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
  const sourceFiles = [resolvedSketchPath, ...additionalSketches];
  const sources = await Promise.all(sourceFiles.map(async filePath => ({
    filePath,
    content: filePath === resolvedSketchPath ? primaryContent : await fs.readFile(filePath, 'utf8')
  })));
  const generatedPrototypes = [...new Set(sources.flatMap(source => findGeneratedPrototypes(source.content)))];

  const sections: string[] = ['#include <Arduino.h>'];
  if (generatedPrototypes.length > 0) {
    sections.push(generatedPrototypes.join('\n'));
  }
  for (const source of sources) {
    sections.push(`#line 1 "${escapeLinePath(source.filePath)}"\n${source.content}`);
  }

  return {
    content: `${sections.join('\n\n')}\n`,
    sourceFiles,
    generatedPrototypes
  };
}
