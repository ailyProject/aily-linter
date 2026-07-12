# aily-linter

`aily-linter` 是从 `aily-builder` 拆分出来的独立 Arduino 代码检查 CLI。它不依赖 `aily-builder` 的安装目录，并使用自己的构建与缓存路径。

## 安装与构建

```powershell
npm install
npm run build
node dist/main.js --help
```

生成压缩后的单文件发布包：

```powershell
npm run bundle
node dist/bundle-min/index.js --help
```

产物位于 `dist/bundle-min`，其中 `index.js` 是 CLI 入口，`aily-linter.js` 是由 esbuild 打包并压缩后的单文件代码。

如需在本机注册 `aily-linter` 命令：

```powershell
npm link
aily-linter examples/blink.ino --mode fast
```

## 使用

```powershell
# 快速静态检查，不调用编译器
aily-linter sketch.ino --mode fast

# 选择快速规则集
aily-linter sketch.ino --mode fast --rule-set strict

# 使用 Arduino 工具链进行精确检查
aily-linter sketch.ino --mode accurate `
  --board arduino:avr:uno `
  --sdk-path D:\path\to\arduino-avr `
  --tools-path D:\path\to\tools

# 先做快速检查，必要时再调用编译器
aily-linter sketch.ino --mode auto --format json
```

支持 `human`、`vscode`、`json` 三种输出格式。完整参数请运行：

```powershell
aily-linter --help
```

## 分析模式

| 模式 | 实现 | 是否需要 Arduino 工具链 |
| --- | --- | --- |
| `fast` | 单遍轻量词法扫描与 Arduino 规则 | 否 |
| `accurate` | Arduino 配置解析、依赖分析与编译器语法检查 | 是 |
| `auto` | 快速检查后按需执行精确检查 | 视检查结果而定 |

`accurate` 和可能进入编译器阶段的 `auto` 模式，需要有效的开发板 FQBN、SDK 和工具链路径。

`fast` 支持 `minimal`、`standard`、`strict`、`esp32`、`stm32` 规则集。它使用注释、字符串、括号和调用参数感知的单遍扫描器，不依赖 tree-sitter、ast-grep、WASM 或其他原生解析模块。模板实例化、重载解析、完整类型检查等 C++ 语义由 `accurate` 模式或 `auto` 的编译器阶段负责。

依赖分析使用独立的预处理指令扫描器处理 `#if`、宏展开和递归 include。头文件仍在 include 出现的位置处理，因此头文件定义的宏可以影响后续条件分支。

## 独立运行目录

Windows 上默认使用以下目录：

- 构建目录：`%LOCALAPPDATA%\aily-linter\project\<sketch>_<hash>`
- Lint 缓存：`%LOCALAPPDATA%\aily-linter\lint-cache`
- 库索引：`%LOCALAPPDATA%\aily-linter\library-index-cache-v5`

macOS 与 Linux 分别使用系统缓存目录和 `$XDG_CACHE_HOME`（未设置时为 `~/.cache`）。

## 开发验证

```powershell
npm run check
npm test
npm run smoke
npm run benchmark
```

基准脚本会生成约 2 MiB 的注释和字符串压力数据，并对小文件冷启动与大文件吞吐分别执行多次独立进程测量。结果写入 `bench/results-*.json`；可通过 `BENCH_ITERATIONS` 调整重复次数。

项目许可证为 GPL-3.0-only。
