import { promises as fs } from 'fs';
import { MacroDefinition } from './PreprocessorExpression';
import { scanPreprocessor } from './PreprocessorScanner';

export type { MacroDefinition } from './PreprocessorExpression';

export interface AnalysisOptions {
    throwOnError?: boolean;
    onInclude?: (includePath: string) => void;
}

export interface AnalysisResult {
    includes: string[];
    defines: Map<string, MacroDefinition>;
}

export async function analyzeFile(
    filePath: string,
    defines: Map<string, MacroDefinition>,
    options: AnalysisOptions = {}
): Promise<string[]> {
    return (await analyzeFileWithDefines(filePath, defines, options)).includes;
}

export function analyzeSourceWithDefines(
    sourceCode: string,
    defines: Map<string, MacroDefinition>,
    options: AnalysisOptions = {}
): AnalysisResult {
    return scanPreprocessor(sourceCode, defines, options);
}

export async function analyzeFileWithDefines(
    filePath: string,
    defines: Map<string, MacroDefinition>,
    options: AnalysisOptions = {}
): Promise<AnalysisResult> {
    try {
        if (!filePath || typeof filePath !== 'string') {
            throw new Error('文件路径不能为空');
        }

        let sourceCode: string;
        try {
            sourceCode = await fs.readFile(filePath, 'utf8');
        } catch (error) {
            throw new Error(`无法读取文件 ${filePath}: ${(error as Error).message}`);
        }

        return analyzeSourceWithDefines(sourceCode, defines, options);
    } catch (error) {
        if (options.throwOnError !== false) throw error;
        console.error(`分析文件 ${filePath} 时出错:`, (error as Error).message);
        return { includes: [], defines };
    }
}