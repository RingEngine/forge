# Forge

[中文](#中文) | [English](#english)

---

## 中文

Forge 是 Ring Engine 的 VS Code 扩展，为 `filter-src` 滤镜工程提供编写、预览和导出支持。

### 背景

Ring Engine 是一个跨平台图像滤镜平台。滤镜以 `filter-src` 工程的形式编写，包含：

- `manifest.json` — 工程元数据、参数声明和渲染 pass 列表
- `main.lua` — 基于 Lua 的渲染工作流脚本
- GLSL 着色器文件

`filter-src` 工程由 `compiler-js` 编译为运行时格式，并打包为 `.rfp` 文件供平台 runtime 加载执行。Forge 是这条工具链中面向作者的核心工具：在 VS Code 内完成编译、预览和导出，让作者无需离开编辑器即可迭代滤镜效果。

### 功能

- 自动发现工作区内所有 `filter-src` 工程
- 支持图片和视频预览输入，内置默认素材
- 实时参数控件：`float`、`bool`、`vec4`、颜色拾取、`ndcPoint2` 点拾取（可点击 / 拖拽）、`ndcRect` 区域定义（可拖拽）、`mat4`
- 通过 `compiler-js` `web-preview` backend 编译 GLSL → WGSL，在 WebGPU 画布上实时渲染
- 大预览面板，保留完整参数控制
- 导出 `.rfp` 包，支持主密钥加密与私钥签名
- 诊断信息实时映射到 VS Code Problems 面板

### 安装

从 [Releases](https://github.com/RingEngine/forge/releases) 页下载最新 `.vsix` 文件，然后在 VS Code 中安装：

```
扩展面板 → ⋯ → Install from VSIX...
```

或通过命令行：

```bash
code --install-extension forge-x.x.x.vsix
```

### 使用流程

1. 在 VS Code 中打开包含 `filter-src` 工程的目录
2. 点击活动栏中的 Forge 图标，打开侧边栏
3. 从工程列表中选择目标工程
4. 在预览区选择输入图片或视频
5. 点击 **Run Preview** 编译并渲染
6. 在参数面板中实时调节参数，预览随即更新
7. 确认效果后点击 **Export RFP** 导出 `.rfp` 包

**filter-src 工程最简结构**

```
my-filter/
  manifest.json
  main.lua
  shaders/
    pass.vert.glsl
    pass.frag.glsl
```

完整格式规范见 [Ring Engine Docs](https://github.com/RingEngine/Docs)。

### 开发

```bash
npm install
npm run check
```

在 VS Code 中打开 `forge/` 目录，按 F5 启动扩展宿主进行调试。

---

## English

Forge is the VS Code extension for Ring Engine, providing authoring, preview, and export support for `filter-src` projects.

### Background

Ring Engine is a cross-platform image filter platform. Filters are authored as `filter-src` projects containing:

- `manifest.json` — project metadata, parameter declarations, and render pass list
- `main.lua` — Lua-based render workflow script
- GLSL shader files

`filter-src` projects are compiled by `compiler-js` into a runtime format and packaged as `.rfp` files for platform runtimes to load and execute. Forge is the author-facing tool in this chain: it compiles, previews, and exports filters directly inside VS Code so authors can iterate without leaving the editor.

### Features

- Auto-discovers all `filter-src` projects in the workspace
- Image and video preview inputs with built-in default media
- Live parameter controls: `float`, `bool`, `vec4`, color picker, `ndcPoint2` point picker (click / drag), `ndcRect` region picker (drag to define), `mat4`
- Compiles GLSL → WGSL via `compiler-js` `web-preview` backend and renders on a WebGPU canvas
- Large preview panel with full parameter controls
- Exports `.rfp` packages with optional master key encryption and private key signing
- Diagnostics mapped to the VS Code Problems panel in real time

### Installation

Download the latest `.vsix` from the [Releases](https://github.com/RingEngine/forge/releases) page, then install in VS Code:

```
Extensions panel → ⋯ → Install from VSIX...
```

Or from the command line:

```bash
code --install-extension forge-x.x.x.vsix
```

### Workflow

1. Open a directory containing one or more `filter-src` projects in VS Code
2. Click the Forge icon in the Activity Bar to open the sidebar
3. Select your target project from the project list
4. Choose a preview input image or video
5. Click **Run Preview** to compile and render
6. Adjust parameters live in the parameter panel — preview updates immediately
7. Click **Export RFP** to package the filter when ready

**Minimal filter-src project structure**

```
my-filter/
  manifest.json
  main.lua
  shaders/
    pass.vert.glsl
    pass.frag.glsl
```

See [Ring Engine Docs](https://github.com/RingEngine/Docs) for the full specification.

### Development

```bash
npm install
npm run check
```

Open the `forge/` directory in VS Code and press F5 to launch the extension host for debugging.
