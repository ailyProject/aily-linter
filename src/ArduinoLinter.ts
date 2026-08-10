import { Logger } from './utils/Logger';
import { ArduinoConfigParser } from './ArduinoConfigParser';
import { DependencyAnalyzer } from './DependencyAnalyzer';
import { LintCacheManager, LintCacheKey } from './LintCacheManager';
import * as crypto from 'crypto';
import { FastStaticAnalyzer, StaticAnalysisResult } from './FastStaticAnalyzer';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { preprocessArduinoSketch } from './ArduinoSketchPreprocessor';
import { parseCompilerDiagnostics } from './CompilerDiagnosticParser';
import { CompilerExecutionResult, runCompilerCommand } from './CompilerProcessRunner';

export interface LintError {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity: 'error' | 'warning' | 'note';
  code?: string;
  fix?: {
    range: [number, number];
    text: string;
  };
}

export interface LintResult {
  success: boolean;
  errors: LintError[];
  warnings: LintError[];
  notes: LintError[];
  executionTime: number;
}

export interface LintOptions {
  sketchPath: string;
  board: string;
  buildPath: string;
  sdkPath?: string;
  toolsPath?: string;
  librariesPath?: string[];
  buildProperties?: Record<string, string>;
  boardOptions?: Record<string, string>;
  toolVersions?: string;
  format?: 'vscode' | 'json' | 'human';
  mode?: 'fast' | 'accurate' | 'auto';
  ruleSet?: 'minimal' | 'standard' | 'strict' | 'esp32' | 'stm32';
  verbose?: boolean;
  /** Internal snapshot of sketch-local inputs used to keep one lint run cache-consistent. */
  cacheInputHash?: string;
}

// 缓存结构
interface LintCache {
  dependencies?: any[];
}

export class ArduinoLinter {
  private dependencyAnalyzer: DependencyAnalyzer;
  private lintCacheManager: LintCacheManager;
  private staticAnalyzer: FastStaticAnalyzer;

  constructor(
    private logger: Logger,
    private configParser: ArduinoConfigParser
  ) {
    this.dependencyAnalyzer = new DependencyAnalyzer(logger);
    this.lintCacheManager = new LintCacheManager(logger);
    this.staticAnalyzer = new FastStaticAnalyzer(logger);
  }

  /**
   * 执行语法检查
   */
  async lint(options: LintOptions): Promise<LintResult> {
    const startTime = Date.now();
    const mode = options.mode || 'fast';
    const effectiveOptions = mode === 'fast'
      ? options
      : { ...options, cacheInputHash: await this.calculateSketchInputHash(options.sketchPath, options.buildPath) };
    
    try {
      this.configureEnvironment(effectiveOptions);
      this.logger.verbose(`Starting ${mode} syntax analysis...`);
      
      switch (mode) {
        case 'fast':
          return await this.performFastAnalysis(effectiveOptions, startTime);
          
        case 'accurate':
          return await this.performCompilerAnalysis(effectiveOptions, startTime);
          
        case 'auto':
          return await this.performAutoAnalysis(effectiveOptions, startTime);
        
        default:
          throw new Error(`Unknown lint mode: ${mode}`);
      }
      
    } catch (error) {
      this.logger.error(`Syntax check failed: ${error instanceof Error ? error.message : error}`);
      
      return {
        success: false,
        errors: [{
          file: options.sketchPath,
          line: 0,
          column: 0,
          message: error instanceof Error ? error.message : String(error),
          severity: 'error'
        }],
        warnings: [],
        notes: [],
        executionTime: Date.now() - startTime
      };
    }
  }



  /**
   * 格式化输出结果
   */
  formatOutput(result: LintResult, format: 'vscode' | 'json' | 'human' = 'human'): string {
    switch (format) {
      case 'json':
        return this.formatJson(result);
      case 'vscode':
        return this.formatVSCode(result);
      default:
        return this.formatHuman(result);
    }
  }

  /**
   * JSON 格式输出
   */
  private formatJson(result: LintResult): string {
    return JSON.stringify(result, null, 2);
  }

  /**
   * VS Code Problem Matcher 兼容格式
   * 格式: file(line,col): severity code: message
   * 支持 endLine/endColumn 用于范围高亮
   */
  private formatVSCode(result: LintResult): string {
    const lines: string[] = [];
    
    const allDiagnostics = [
      ...result.errors,
      ...result.warnings,
      ...result.notes
    ];
    
    for (const diag of allDiagnostics) {
      // VS Code 格式: file(line,col): severity: message
      // 如果有结束位置，使用 file(startLine,startCol,endLine,endCol) 格式
      let location: string;
      if (diag.endLine && diag.endColumn) {
        location = `${diag.file}(${diag.line},${diag.column},${diag.endLine},${diag.endColumn})`;
      } else {
        location = `${diag.file}(${diag.line},${diag.column})`;
      }
      const severity = diag.severity;
      const code = diag.code ? ` ${diag.code}` : '';
      
      lines.push(`${location}: ${severity}${code}: ${diag.message}`);
    }
    
    return lines.join('\n');
  }

  /**
   * 人类可读格式（彩色输出）
   * 支持显示 endLine/endColumn 范围和自动修复建议
   */
  private formatHuman(result: LintResult): string {
    const lines: string[] = [];
    
    // 格式化诊断条目的辅助函数
    const formatDiagnostic = (diag: LintError): string[] => {
      const diagLines: string[] = [];
      // 显示位置信息（如果有范围，显示范围）
      if (diag.endLine && diag.endColumn && (diag.endLine !== diag.line || diag.endColumn !== diag.column)) {
        diagLines.push(`  ${diag.file}:${diag.line}:${diag.column}-${diag.endLine}:${diag.endColumn}`);
      } else {
        diagLines.push(`  ${diag.file}:${diag.line}:${diag.column}`);
      }
      diagLines.push(`    ${diag.message}`);
      if (diag.code) {
        diagLines.push(`    [${diag.code}]`);
      }
      // 显示自动修复建议（如果有）
      if (diag.fix) {
        diagLines.push(`    💡 Fix: Replace with "${diag.fix.text}"`);
      }
      return diagLines;
    };
    
    if (result.errors.length > 0) {
      lines.push('\n❌ Errors:');
      result.errors.forEach(err => {
        lines.push(...formatDiagnostic(err));
      });
    }
    
    if (result.warnings.length > 0) {
      lines.push('\n⚠️  Warnings:');
      result.warnings.forEach(warn => {
        lines.push(...formatDiagnostic(warn));
      });
    }
    
    if (result.notes.length > 0 && result.errors.length === 0 && result.warnings.length === 0) {
      lines.push('\nℹ️  Notes:');
      result.notes.forEach(note => {
        lines.push(...formatDiagnostic(note));
      });
    }
    
    // 摘要
    lines.push('\n' + '─'.repeat(50));
    lines.push(`Summary: ${result.errors.length} errors, ${result.warnings.length} warnings`);
    lines.push(`Time: ${result.executionTime}ms`);
    
    if (result.success) {
      lines.push('✅ Syntax check passed!');
    } else {
      lines.push('❌ Syntax check failed!');
    }
    
    return lines.join('\n');
  }


  /** Configure the environment consumed by config and dependency analysis. */
  private configureEnvironment(options: LintOptions): void {
    const sketchPath = path.resolve(options.sketchPath);
    process.env['SKETCH_PATH'] = sketchPath;
    process.env['SKETCH_NAME'] = path.basename(sketchPath, path.extname(sketchPath));
    process.env['SKETCH_DIR_PATH'] = path.dirname(sketchPath);
    process.env['BUILD_PATH'] = options.buildPath;
    if (options.sdkPath) process.env['SDK_PATH'] = options.sdkPath;
    if (options.toolsPath) process.env['TOOLS_PATH'] = options.toolsPath;
    if (options.librariesPath) {
      process.env['LIBRARIES_PATH'] = options.librariesPath.join(path.delimiter);
    }
  }

  private parseToolVersions(toolVersions?: string): Record<string, string> {
    const parsed: Record<string, string> = {};
    for (const pair of toolVersions?.split(',') || []) {
      const separator = pair.lastIndexOf('@');
      if (separator <= 0 || separator === pair.length - 1) continue;
      parsed[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
    }
    return parsed;
  }

  private getMergedBuildProperties(options: LintOptions): Record<string, string> {
    return {
      ...(options.buildProperties || {}),
      ...(options.boardOptions || {})
    };
  }

  private async performFastAnalysis(options: LintOptions, startTime: number): Promise<LintResult> {
    const analysisResult = await this.staticAnalyzer.analyzeFile(options.sketchPath, {
      board: options.board,
      ruleSet: options.ruleSet
    });
    
    return {
      success: analysisResult.errors.length === 0,
      errors: analysisResult.errors,
      warnings: analysisResult.warnings,
      notes: analysisResult.notes,
      executionTime: Date.now() - startTime
    };
  }

  /**
   * 编译器精确分析模式
   */
  private async performCompilerAnalysis(options: LintOptions, startTime: number): Promise<LintResult> {
    // 检查缓存（仅当不是通过 optimized 方法调用时）
    const cachedResult = await this.getCachedCompilerResult(options);
    if (cachedResult) {
      this.logger.verbose('Using cached compiler analysis result');
      cachedResult.executionTime = Date.now() - startTime;
      return cachedResult;
    }
    
    try {
      // === 环境变量设置（与 ArduinoCompiler 保持一致）===
      
      // 设置 SDK 路径环境变量
      if (options.sdkPath) {
        process.env['SDK_PATH'] = options.sdkPath;
        this.logger.verbose(`Set SDK_PATH: ${process.env['SDK_PATH']}`);
      }

      // 设置工具路径环境变量
      if (options.toolsPath) {
        process.env['TOOLS_PATH'] = options.toolsPath;
        this.logger.verbose(`Set TOOLS_PATH: ${process.env['TOOLS_PATH']}`);
      }

      // 设置库路径环境变量
      if (options.librariesPath && options.librariesPath.length > 0) {
        const pathSeparator = os.platform() === 'win32' ? ';' : ':';
        process.env['LIBRARIES_PATH'] = options.librariesPath.join(pathSeparator);
        this.logger.verbose(`Set LIBRARIES_PATH: ${process.env['LIBRARIES_PATH']}`);
      }

      // === 解析工具版本（与 ArduinoCompiler 保持一致）===
      const toolVersions = this.parseToolVersions(options.toolVersions);
      for (const [tool, version] of Object.entries(toolVersions)) {
        this.logger.verbose(`Tool version: ${tool}@${version}`);
      }

      // === 合并构建属性（与 ArduinoCompiler 保持一致）===
      const buildProperties = this.getMergedBuildProperties(options);
      
      this.logger.verbose(`Build properties for lint: ${JSON.stringify(buildProperties)}`);

      // === 调用 ArduinoConfigParser（与 ArduinoCompiler 保持一致）===
      const arduinoConfig = await this.configParser.parseByFQBN(options.board, buildProperties, toolVersions);
      const config = { ...arduinoConfig.platform, ...arduinoConfig.board };
      await this.prepareCompilerOptionFiles(config, options);
      
      // 2. 创建临时目录
      const tempDir = path.join(os.tmpdir(), `aily-lint-compiler-${Date.now()}`);
      await fs.ensureDir(tempDir);
      
      try {
        // 3. 生成预处理后的 C++ 文件
        const cppFile = await this.generateCppFile(options.sketchPath, tempDir);
        
        // 4. 执行编译器语法检查
        const compilerResult = await this.executeCompilerSyntaxCheck(cppFile, config, options, arduinoConfig);
        
        // 5. 解析编译器输出
        this.logger.verbose(`Parsing compiler output: ${compilerResult.output}`);
        const issues = parseCompilerDiagnostics(
          compilerResult.output,
          options.sketchPath,
          compilerResult.exitCode,
          compilerResult.signal
        );
        
        const result = {
          success: issues.errors.length === 0,
          errors: issues.errors,
          warnings: issues.warnings,
          notes: issues.notes || [],
          executionTime: Date.now() - startTime
        };
        
        // 缓存编译器分析结果（异步执行，不阻塞返回）
        this.cacheCompilerResult(options, result).catch(error => {
          this.logger.debug(`Failed to cache compiler result: ${error instanceof Error ? error.message : error}`);
        });
        
        return result;
        
      } finally {
        // 恢复临时文件清理
        await fs.remove(tempDir).catch(() => {});
      }
      
    } catch (error) {
      throw new Error(`Compiler analysis failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * 自动模式：合并快速规则结果与强制编译器语义验证结果。
   */
  private async performAutoAnalysis(options: LintOptions, startTime: number): Promise<LintResult> {
    // 先执行轻量静态分析，再使用编译器验证语义正确性。
    this.logger.verbose('Starting static analysis...');
    const staticAnalysisResult = await this.staticAnalyzer.analyzeFile(options.sketchPath, {
      board: options.board,
      ruleSet: options.ruleSet
    });
    
    // auto 必须完成语义验证；fast 的置信度只描述启发式扫描质量，
    // 不能证明符号、类型或重载解析正确。
    this.logger.verbose(`Static analysis confidence: ${staticAnalysisResult.confidence}; running compiler validation`);
    
    const compilerPreparation = await this.prepareCompilerAnalysis(options);
    
    const resetStartTime = Date.now(); // 重置计时，只计算编译器检查时间
    
    try {
      // 使用准备好的数据进行编译器分析
      const accurateResult = await this.performOptimizedCompilerAnalysis(options, compilerPreparation.cachedData, resetStartTime);
      
      // 合并静态分析和编译器分析的结果
      const mergedResult = this.mergeAnalysisResults(staticAnalysisResult, accurateResult);
      mergedResult.executionTime = Date.now() - startTime; // 总时间
      
      return mergedResult;
    } catch (error) {
      // 编译器不可用时不能把仅经过启发式检查的结果标记为成功。
      this.logger.verbose(`Compiler analysis failed: ${error instanceof Error ? error.message : error}`);
      return {
        success: false,
        errors: [...staticAnalysisResult.errors, {
          file: options.sketchPath,
          line: 1,
          column: 1,
          message: `Auto mode could not complete compiler validation: ${error instanceof Error ? error.message : error}`,
          severity: 'error',
          code: 'AUTO_COMPILER_VALIDATION_FAILED'
        }],
        warnings: staticAnalysisResult.warnings,
        notes: staticAnalysisResult.notes,
        executionTime: Date.now() - startTime
      };
    }
  }

  /**
   * Reproduce the option-file part of Arduino platform prebuild hooks.
   * Compiler recipes may reference these files with @response-file syntax.
   */
  private async prepareCompilerOptionFiles(config: Record<string, any>, options: LintOptions): Promise<void> {
    await fs.ensureDir(options.buildPath);

    const buildOptName = config['build.opt.name'] || 'build_opt.h';
    const configuredBuildOptPath = config['build.opt.path'];
    const buildOptPath = typeof configuredBuildOptPath === 'string' && !configuredBuildOptPath.includes('{')
      ? configuredBuildOptPath
      : path.join(options.buildPath, buildOptName);
    const sketchBuildOptPath = path.join(path.dirname(options.sketchPath), buildOptName);

    await fs.ensureDir(path.dirname(buildOptPath));
    if (await fs.pathExists(sketchBuildOptPath)) {
      await fs.copy(sketchBuildOptPath, buildOptPath, { overwrite: true });
    } else {
      await fs.writeFile(buildOptPath, '');
    }

    const configuredFileOptsPath = config['file_opts.path'];
    const fileOptsPath = typeof configuredFileOptsPath === 'string' && !configuredFileOptsPath.includes('{')
      ? configuredFileOptsPath
      : path.join(options.buildPath, 'file_opts');
    await fs.ensureDir(path.dirname(fileOptsPath));
    await fs.writeFile(fileOptsPath, '');
  }

  /**
   * 生成预处理后的 C++ 文件
   */
  private async generateCppFile(sketchPath: string, tempDir: string): Promise<string> {
    const preprocessedSketch = await preprocessArduinoSketch(sketchPath);
    const cppContent = preprocessedSketch.content;
    this.logger.verbose(
      `Preprocessed ${preprocessedSketch.sourceFiles.length} sketch file(s) with ${preprocessedSketch.generatedPrototypes.length} generated prototype(s)`
    );
    
    const cppFile = path.join(tempDir, 'sketch.cpp');
    await fs.writeFile(cppFile, cppContent, 'utf-8');
    
    return cppFile;
  }

  /**
   * 执行编译器语法检查
   * 使用 platform.txt 中的 recipe.cpp.o.pattern 来确保与实际编译一致
   */
  private async executeCompilerSyntaxCheck(cppFile: string, config: Record<string, any>, options: LintOptions, arduinoConfig: any): Promise<CompilerExecutionResult> {
    // 获取编译 recipe
    let compileCmd = config['recipe.cpp.o.pattern'] || config['recipe.c.o.pattern'];
    if (!compileCmd) {
      throw new Error('No compile recipe found in platform configuration');
    }
    
    this.logger.verbose(`Original compile recipe: ${compileCmd}`);
    
    // 替换 recipe 中的变量为语法检查模式
    // 移除输出文件参数
    compileCmd = compileCmd.replace(/\s+"-o"\s+"[^"]*"/g, ''); // 移除 "-o" "output_file"
    compileCmd = compileCmd.replace(/\s+-o\s+"[^"]*"/g, ''); // 移除 -o "output_file"
    compileCmd = compileCmd.replace(/\s+"-o"\s+%[^%]*%/g, ''); // 移除 "-o" %VAR%
    compileCmd = compileCmd.replace(/\s+-o\s+%[^%]*%/g, ''); // 移除 -o %VAR%
    
    // 替换源文件路径
    compileCmd = compileCmd.replace(/\{source_file\}/g, `"${cppFile}"`);
    compileCmd = compileCmd.replace(/"%SOURCE_FILE_PATH%"/g, `"${cppFile}"`);
    
    // 替换构建路径占位符
    const tempDir = path.dirname(cppFile);
    compileCmd = compileCmd.replace(/\{build\.source\.path\}/g, `"${tempDir}"`);
    compileCmd = compileCmd.replace(/"-I\{build\.source\.path\}"/g, `-I"${tempDir}"`);
    
    // 替换 include 路径变量
    const includePaths = (await this.buildIncludePaths(config, options, arduinoConfig)).join(' ');
    compileCmd = compileCmd.replace(/%INCLUDE_PATHS%/g, includePaths);
    
    // 移除不需要的选项文件引用（@文件），这些在语法检查中不需要
    compileCmd = compileCmd.replace(/"@%OUTPUT_PATH%\/build_opt\.h"/g, '');
    compileCmd = compileCmd.replace(/"@%OUTPUT_PATH%\/file_opts"/g, '');
    compileCmd = compileCmd.replace(/@%OUTPUT_PATH%\/build_opt\.h/g, '');
    compileCmd = compileCmd.replace(/@%OUTPUT_PATH%\/file_opts/g, '');
    
    // 移除依赖文件生成选项，防止生成 .d 文件
    compileCmd = compileCmd.replace(/\s+-MMD\s+/g, ' ');
    compileCmd = compileCmd.replace(/\s+-MP\s+/g, ' ');
    compileCmd = compileCmd.replace(/\s+-MF\s+"[^"]*"/g, ''); // 移除 -MF "file.d"
    compileCmd = compileCmd.replace(/\s+-MF\s+\S+/g, ''); // 移除 -MF file.d
    
    // 添加语法检查标志
    if (!compileCmd.includes('-fsyntax-only')) {
      // 在编译器命令后面添加 -fsyntax-only
      compileCmd = compileCmd.replace(/^("[^"]+"\s+)/, '$1-fsyntax-only ');
      compileCmd = compileCmd.replace(/^([^"\s]+\s+)/, '$1-fsyntax-only ');
    }
    
    // 禁用颜色输出并移除 -w 参数以显示错误
    compileCmd = compileCmd.replace(/\s+-w\s+/g, ' '); // 移除 -w 参数
    if (!compileCmd.includes('-fdiagnostics-color')) {
      compileCmd = compileCmd.replace(/^("[^"]+"\s+)/, '$1-fdiagnostics-color=never ');
      compileCmd = compileCmd.replace(/^([^"\s]+\s+)/, '$1-fdiagnostics-color=never ');
    }
    
    // 规范化路径分隔符 - 修复混合斜杠问题
    compileCmd = this.normalizePathSeparators(compileCmd);
    
    this.logger.verbose(`Modified compile command: ${compileCmd}`);
    
    // 调试：显示生成的 C++ 文件内容
    const cppContent = await fs.readFile(cppFile, 'utf-8');
    this.logger.verbose('Generated C++ file content:');
    this.logger.verbose('------- START -------');
    this.logger.verbose(cppContent);
    this.logger.verbose('------- END -------');
    
    return runCompilerCommand(compileCmd, cppFile, this.logger);
  }



  /**
   * 构建包含路径 - 使用 DependencyAnalyzer 动态分析依赖
   */
  private async buildIncludePaths(config: Record<string, any>, options: LintOptions, arduinoConfig: any): Promise<string[]> {
    const includes: string[] = [`-I"${path.dirname(path.resolve(options.sketchPath))}"`];
    
    try {
      // 设置 DependencyAnalyzer 需要的环境变量（参考 ArduinoCompiler）
      const sketchPath = path.resolve(options.sketchPath);
      const sketchName = path.basename(sketchPath, '.ino');
      
      process.env['SKETCH_PATH'] = sketchPath;
      process.env['SKETCH_NAME'] = sketchName;
      process.env['SKETCH_DIR_PATH'] = path.dirname(sketchPath);
      process.env['BUILD_PATH'] = options.buildPath;
      
      this.logger.verbose(`Set environment for DependencyAnalyzer:`);
      this.logger.verbose(`  SKETCH_PATH: ${process.env['SKETCH_PATH']}`);
      this.logger.verbose(`  SKETCH_NAME: ${process.env['SKETCH_NAME']}`);
      this.logger.verbose(`  BUILD_PATH: ${process.env['BUILD_PATH']}`);
      
      // 1. 首先添加核心SDK路径（Arduino.h所在位置）
      if (process.env['SDK_CORE_PATH'] && fs.existsSync(process.env['SDK_CORE_PATH'])) {
        includes.push(`-I"${process.env['SDK_CORE_PATH']}"`);
        this.logger.verbose(`Added core path: ${process.env['SDK_CORE_PATH']}`);
      }
      
      // 2. 添加变体路径
      if (process.env['SDK_VARIANT_PATH'] && fs.existsSync(process.env['SDK_VARIANT_PATH'])) {
        includes.push(`-I"${process.env['SDK_VARIANT_PATH']}"`);
        this.logger.verbose(`Added variant path: ${process.env['SDK_VARIANT_PATH']}`);
      }

      // 3. 使用 DependencyAnalyzer 分析库依赖
      const analyzer = new DependencyAnalyzer(this.logger);
      const allDependencies = await analyzer.preprocess(arduinoConfig);
      
      this.logger.verbose(`DependencyAnalyzer found ${allDependencies.length} dependencies before filtering`);
      
      // 4. 智能依赖过滤
      const filteredDependencies = this.filterSmartDependencies(allDependencies, options.sketchPath);
      
      this.logger.verbose(`After smart filtering: ${filteredDependencies.length} dependencies`);
      
      // 5. 从依赖分析结果中构建include路径（与NinjaCompilationPipeline保持一致）
      for (const dependency of filteredDependencies) {
        if (dependency.path && fs.existsSync(dependency.path)) {
          // 直接添加依赖路径（与compile功能保持一致）
          includes.push(`-I"${dependency.path}"`);
          this.logger.verbose(`Added library root path: ${dependency.path}`);
        }
      }
      
    } catch (error) {
      this.logger.error(`Dependency analysis failed: ${error}`);
      throw error;
    }
    
    this.logger.verbose(`Total include paths: ${includes.length}`);
    return includes;
  }

  /**
   * 智能依赖过滤 - 参考compile功能的方法，保持与ArduinoCompiler一致
   */
  private filterSmartDependencies(dependencies: any[], sketchPath: string): any[] {
    // 参考ArduinoCompiler的做法，不进行过激的过滤
    // DependencyAnalyzer已经做了合理的依赖分析，我们只做最小必要的过滤
    
    // 1. 只过滤明确会导致编译错误的库
    const knownProblematicLibraries = [
      // 只保留确实无法编译的库
    ];
    
    // 2. 保留核心依赖和所有库依赖（与compile功能保持一致）
    const filtered = dependencies.filter(dep => {
      // 保留所有核心和变体依赖
      if (dep.type === 'core' || dep.type === 'variant') {
        return true;
      }
      
      // 保留所有库依赖（除非明确有问题）
      if (dep.type === 'library') {
        if (knownProblematicLibraries.includes(dep.name)) {
          this.logger.verbose(`Skipping known problematic library: ${dep.name}`);
          return false;
        }
        return true;
      }
      
      return true;
    });
    
    this.logger.verbose(`After minimal filtering: ${filtered.length} dependencies (was ${dependencies.length})`);
    return filtered;
  }
  



  /**
   * 优化的依赖分析 - 使用 DependencyAnalyzer
   */
  private async performOptimizedDependencyAnalysis(options: LintOptions, suppliedConfigResult?: any): Promise<any[]> {
    try {
      // 构建 FQBN 字符串
      const fqbn = options.board;
      const buildProperties = this.getMergedBuildProperties(options);
      
      // 首先尝试从缓存获取配置解析结果
      let configResult = suppliedConfigResult || await this.getCachedConfigResult(options);
      
      if (!configResult) {
        // 缓存未命中，执行配置解析
        configResult = await this.configParser.parseByFQBN(
          fqbn,
          buildProperties,
          this.parseToolVersions(options.toolVersions)
        );
        // 缓存配置结果
        await this.cacheConfigResult(options, configResult);
      }
      
      // 构建完整的 Arduino 配置对象（与 ArduinoCompiler 兼容）
      const arduinoConfig = {
        fqbn: configResult.fqbn,
        fqbnParsed: configResult.fqbnParsed,
        platform: configResult.platform,
        board: configResult.board
      };
      
      // 使用 DependencyAnalyzer 进行分析
      const dependencies = await this.dependencyAnalyzer.preprocess(arduinoConfig);
      
      this.logger.verbose(`Found ${dependencies.length} dependencies using optimized analysis`);
      return dependencies;
    } catch (error) {
      this.logger.verbose(`Dependency analysis failed, falling back to simple mode: ${error}`);
      return [];
    }
  }

  /**
   * 优化的编译器分析 - 使用缓存的依赖信息
   */
  private async performOptimizedCompilerAnalysis(
    options: LintOptions, 
    cachedData: LintCache, 
    startTime: number
  ): Promise<LintResult> {
    let result: LintResult;
    
    // 如果有缓存的依赖信息，使用更精确的包含路径
    if (cachedData.dependencies && cachedData.dependencies.length > 0) {
      this.logger.verbose('Using cached dependencies for optimized compiler analysis');
      
      // 使用依赖信息构建更精确的包含路径
      const optimizedOptions = {
        ...options,
        librariesPath: this.buildLibraryPathsFromDependencies(cachedData.dependencies)
      };
      
      result = await this.performCompilerAnalysis(optimizedOptions, startTime);
    } else {
      // 回退到标准编译器分析
      result = await this.performCompilerAnalysis(options, startTime);
    }
    
    // 缓存编译器分析结果（异步执行，不阻塞返回）
    this.cacheCompilerResult(options, result).catch(error => {
      this.logger.debug(`Failed to cache compiler result: ${error instanceof Error ? error.message : error}`);
    });
    
    return result;
  }

  /**
   * 从依赖信息构建库路径
   */
  private buildLibraryPathsFromDependencies(dependencies: any[]): string[] {
    const libraryPaths = new Set<string>();
    
    for (const dep of dependencies) {
      if (dep.type === 'library' && dep.path && fs.existsSync(dep.path)) {
        libraryPaths.add(dep.path);
      }
    }
    
    return [...libraryPaths];
  }

  private async calculateSketchInputHash(sketchPath: string, buildPath?: string): Promise<string> {
    const resolvedSketchPath = path.resolve(sketchPath);
    const sketchDirectory = path.dirname(resolvedSketchPath);
    const excludedBuildPath = buildPath ? path.resolve(buildPath) : null;
    const sourceExtensions = new Set([
      '.ino', '.pde', '.h', '.hh', '.hpp', '.hxx',
      '.c', '.cc', '.cpp', '.cxx', '.s', '.S'
    ]);
    const sourceFiles: string[] = [];

    const visit = async (directory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.resolve(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '.git' || entry.name === 'node_modules' || entryPath === excludedBuildPath) continue;
          await visit(entryPath);
        } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
          sourceFiles.push(entryPath);
        }
      }
    };

    try {
      await visit(sketchDirectory);
      sourceFiles.sort((left, right) => left.localeCompare(right));
      const hash = crypto.createHash('sha256');
      for (const sourceFile of sourceFiles) {
        hash.update(path.relative(sketchDirectory, sourceFile).replace(/\\/g, '/'));
        hash.update('\0');
        hash.update(await fs.readFile(sourceFile));
        hash.update('\0');
      }
      return hash.digest('hex');
    } catch {
      const fileContent = await fs.readFile(resolvedSketchPath);
      return crypto.createHash('sha256').update(fileContent).digest('hex');
    }
  }

  /**
   * 创建 LintCacheKey
   */
  private async createLintCacheKey(options: LintOptions, operation: 'dependency' | 'compiler' | 'config'): Promise<LintCacheKey> {
    const librariesPath = Array.isArray(options.librariesPath) 
      ? options.librariesPath.join(';') 
      : (options.librariesPath || '');
    
    // 所有草图目录内的源码/头文件共享一个快照哈希，多 tab 或本地头变化时一并失效。
    let fileContentHash = '';
    try {
      fileContentHash = options.cacheInputHash
        || await this.calculateSketchInputHash(options.sketchPath, options.buildPath);
    } catch (error) {
      // 如果读取文件失败，使用文件路径和时间戳
      fileContentHash = crypto.createHash('md5').update(`${options.sketchPath}_${Date.now()}`).digest('hex');
    }
      
    return {
      operation,
      board: options.board,
      sdkPath: options.sdkPath || '',
      toolsPath: options.toolsPath || '',
      librariesPath,
      buildProperties: JSON.stringify(options.buildProperties || {}),
      boardOptions: JSON.stringify(options.boardOptions || {}),
      sourceFile: options.sketchPath,
      fileContentHash, // 新增：文件内容哈希
      toolVersions: options.toolVersions || '',
      mode: options.mode
    };
  }

  /**
   * 准备编译器分析所需的配置、依赖与内存缓存。
   */
  private async prepareCompilerAnalysis(options: LintOptions): Promise<{
    cachedData: LintCache;
    configResult: any;
    dependencies: any[];
  }> {
    const configResult = await this.getOrParseConfig(options);
    let dependencies = await this.getCachedDependencyResult(options);

    if (dependencies === null) {
      this.logger.verbose('Dependency cache miss, analyzing dependencies...');
      dependencies = await this.performOptimizedDependencyAnalysis(options, configResult);
      await this.cacheDependencyResult(options, dependencies);
    } else {
      this.logger.verbose('Using cached dependency analysis');
    }

    const cachedData: LintCache = { dependencies };

    await this.cacheConfigResult(options, configResult);
    return { cachedData, configResult, dependencies };
  }

  /**
   * 获取或解析配置（带缓存）
   */
  private async getOrParseConfig(options: LintOptions): Promise<any> {
    let configResult = await this.getCachedConfigResult(options);
    
    if (!configResult) {
      // 缓存未命中，执行配置解析
      configResult = await this.configParser.parseByFQBN(
        options.board,
        this.getMergedBuildProperties(options),
        this.parseToolVersions(options.toolVersions)
      );
    } else {
      this.logger.verbose('Using cached configuration result');
    }
    
    return configResult;
  }

  /**
   * 合并静态分析和编译器分析结果
   */
  private mergeAnalysisResults(staticResult: StaticAnalysisResult, compilerResult: LintResult): LintResult {
    // 优先使用编译器结果，但保留静态分析的独特发现
    const mergedErrors = [...compilerResult.errors];
    const mergedWarnings = [...compilerResult.warnings];
    const mergedNotes = [...compilerResult.notes];

    // 添加静态分析独有的错误（避免重复）
    staticResult.errors.forEach(error => {
      const isDuplicate = mergedErrors.some(existing => 
        existing.line === error.line && 
        existing.column === error.column && 
        existing.message === error.message
      );
      if (!isDuplicate) {
        mergedErrors.push(error);
      }
    });

    // 添加静态分析独有的警告
    staticResult.warnings.forEach(warning => {
      const isDuplicate = mergedWarnings.some(existing => 
        existing.line === warning.line && 
        existing.column === warning.column && 
        existing.message === warning.message
      );
      if (!isDuplicate) {
        mergedWarnings.push(warning);
      }
    });

    // 添加静态分析的注释
    staticResult.notes.forEach(note => {
      const isDuplicate = mergedNotes.some(existing => 
        existing.line === note.line && 
        existing.column === note.column && 
        existing.message === note.message
      );
      if (!isDuplicate) {
        mergedNotes.push(note);
      }
    });

    return {
      success: mergedErrors.length === 0,
      errors: mergedErrors,
      warnings: mergedWarnings,
      notes: mergedNotes,
      executionTime: compilerResult.executionTime
    };
  }

  /**
   * 缓存依赖分析结果
   */
  private async cacheDependencyResult(options: LintOptions, dependencies: any[]): Promise<void> {
    try {
      const cacheKey = await this.createLintCacheKey(options, 'dependency');
      await this.lintCacheManager.storeToCache(cacheKey, dependencies);
      this.logger.debug(`Cached dependency analysis result for ${path.basename(options.sketchPath)}`);
    } catch (error) {
      this.logger.debug(`Failed to cache dependency result: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * 从缓存获取依赖分析结果
   */
  private async getCachedDependencyResult(options: LintOptions): Promise<any[] | null> {
    try {
      const cacheKey = await this.createLintCacheKey(options, 'dependency');
      const result = await this.lintCacheManager.getFromCache(cacheKey);
      if (result) {
        this.logger.debug(`Retrieved cached dependency analysis for ${path.basename(options.sketchPath)}`);
      }
      return result;
    } catch (error) {
      this.logger.debug(`Failed to retrieve cached dependency result: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  /**
   * 缓存编译器分析结果
   */
  private async cacheCompilerResult(options: LintOptions, result: LintResult): Promise<void> {
    try {
      const cacheKey = await this.createLintCacheKey(options, 'compiler');
      const cacheData = {
        success: result.success,
        errors: result.errors,
        warnings: result.warnings,
        notes: result.notes
      };
      await this.lintCacheManager.storeToCache(cacheKey, cacheData);
      this.logger.debug(`Cached compiler analysis result for ${path.basename(options.sketchPath)}`);
    } catch (error) {
      this.logger.debug(`Failed to cache compiler result: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * 从缓存获取编译器分析结果
   */
  private async getCachedCompilerResult(options: LintOptions): Promise<LintResult | null> {
    try {
      const cacheKey = await this.createLintCacheKey(options, 'compiler');
      const cacheData = await this.lintCacheManager.getFromCache(cacheKey);
      
      if (cacheData) {
        this.logger.debug(`Retrieved cached compiler analysis for ${path.basename(options.sketchPath)}`);
        return {
          success: cacheData.success,
          errors: cacheData.errors || [],
          warnings: cacheData.warnings || [],
          notes: cacheData.notes || [],
          executionTime: 0 // 缓存结果不计算执行时间
        };
      }
      
      return null;
    } catch (error) {
      this.logger.debug(`Failed to retrieve cached compiler result: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  /**
   * 缓存配置解析结果
   */
  private async cacheConfigResult(options: LintOptions, config: any): Promise<void> {
    try {
      const cacheKey = await this.createLintCacheKey(options, 'config');
      await this.lintCacheManager.storeToCache(cacheKey, config);
      this.logger.debug(`Cached config analysis result for ${path.basename(options.sketchPath)}`);
    } catch (error) {
      this.logger.debug(`Failed to cache config result: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * 从缓存获取配置解析结果
   */
  private async getCachedConfigResult(options: LintOptions): Promise<any | null> {
    try {
      const cacheKey = await this.createLintCacheKey(options, 'config');
      const result = await this.lintCacheManager.getFromCache(cacheKey);
      if (result) {
        this.logger.debug(`Retrieved cached config analysis for ${path.basename(options.sketchPath)}`);
      }
      return result;
    } catch (error) {
      this.logger.debug(`Failed to retrieve cached config result: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  /**
   * 规范化命令中的路径分隔符，修复混合斜杠问题
   */
  private normalizePathSeparators(command: string): string {
    // 在 Windows 上，将混合的路径分隔符统一为反斜杠
    if (process.platform === 'win32') {
      // 处理引号内的路径
      command = command.replace(/"([^"]*[/\\][^"]*)"/g, (match, path) => {
        // 统一为反斜杠，但避免双斜杠
        let normalized = path.replace(/[/\\]+/g, '\\');
        
        // 修复 ESP32 工具链的重复 /bin//bin/ 问题
        normalized = normalized.replace(/\\bin\\bin\\/, '\\bin\\');
        normalized = normalized.replace(/\/bin\/\/bin\//, '/bin/');
        
        return `"${normalized}"`;
      });
      
      // 处理不在引号内的路径（更谨慎的处理）
      command = command.replace(/(\s)([A-Za-z]:[/\\][^\s"]*)/g, (match, space, path) => {
        let normalized = path.replace(/[/\\]+/g, '\\');
        
        // 修复重复 bin 目录问题
        normalized = normalized.replace(/\\bin\\bin\\/, '\\bin\\');
        
        return space + normalized;
      });
    }
    
    return command;
  }
}
