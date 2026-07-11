# aily-linter

`aily-linter` 是从 `aily-builder` 拆分出来的独立 Arduino 代码检查 CLI。它不依赖 `aily-builder` 的安装目录，并使用自己的构建与缓存路径。

## 安装与构建

```powershell
npm install
npm run build
node dist/main.js --help
```

如需在本机注册 `aily-linter` 命令：

```powershell
npm link
aily-linter examples/blink.ino --mode fast
```

## 使用

```powershell
# 快速静态检查，不调用编译器
aily-linter sketch.ino --mode fast

# 基于 C++ AST 的规则检查
aily-linter sketch.ino --mode ast-grep

# 选择 ast-grep 规则集
aily-linter sketch.ino --mode ast-grep --rule-set strict

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
| `fast` | 并行轻量静态检查 | 否 |
| `ast-grep` | ast-grep C++ AST 规则 | 否 |
| `accurate` | Arduino 配置解析、依赖分析与编译器语法检查 | 是 |
| `auto` | 快速检查后按需执行精确检查 | 视检查结果而定 |

`accurate` 和可能进入编译器阶段的 `auto` 模式，需要有效的开发板 FQBN、SDK 和工具链路径。

## 独立运行目录

Windows 上默认使用以下目录：

- 构建目录：`%LOCALAPPDATA%\aily-linter\project\<sketch>_<hash>`
- Lint 缓存：`%LOCALAPPDATA%\aily-linter\lint-cache`
- 库索引：`%LOCALAPPDATA%\aily-linter\library-index-cache-v5`

macOS 与 Linux 分别使用系统缓存目录和 `$XDG_CACHE_HOME`（未设置时为 `~/.cache`）。

## 开发验证

```powershell
npm run check
npm run smoke
```

项目许可证为 GPL-3.0-only。
