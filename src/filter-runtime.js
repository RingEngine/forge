import * as lua from 'fengari/src/lua.js';
import * as lauxlib from 'fengari/src/lauxlib.js';
import { to_jsstring, to_luastring } from 'fengari/src/defs.js';
import { luaopen_base } from 'fengari/src/lbaselib.js';
import { luaopen_math } from 'fengari/src/lmathlib.js';
import { luaopen_string } from 'fengari/src/lstrlib.js';
import { luaopen_table } from 'fengari/src/ltablib.js';

const LUA_CTX_METHODS = [
  'getInput',
  'getParam',
  'getAsset',
  'createTarget',
  'getTarget',
  'createFloatBuffer',
  'createUIntBuffer',
  'getBuffer',
  'getOutput',
  'getFrameIndex',
  'getTimeSeconds',
  'getDeltaSeconds',
  'clearOutput',
  'runRenderPass',
  'runComputePass'
];

const PREVIEW_INPUT_CACHE = new WeakMap();
const PREVIEW_VIDEO_FRAME_CACHE = new WeakMap();
const PREVIEW_RUNTIME_ASSET_CACHE = new WeakMap();
const ENABLE_RUNTIME_TRACE = false;
const ENABLE_WEBGPU_ERROR_SCOPES = true;

export async function renderFilterPreview({
  compiledFiles,
  workspace,
  canvas,
  parameterValues = {},
  previewInputFile = null,
  previewInputVideoElement = null,
  previewInputVideoFrameMode = 'external',
  previewOutputAspectRatio = null,
  renderTimeline = null
}) {
  const profile = createProfile();

  if (!compiledFiles?.['manifest.json']) {
    throw new Error('Missing compiled manifest.json.');
  }

  const compiledManifest = timeSection(profile, 'parseCompiledManifest', () =>
    JSON.parse(String(compiledFiles['manifest.json']))
  );
  const sourceManifest = timeSection(profile, 'parseSourceManifest', () =>
    parseSourceManifest(workspace)
  );
  const inputImage = await timeAsyncSection(profile, 'loadPreviewInput', () =>
    loadPreviewInput(previewInputFile, canvas, previewInputVideoElement, previewInputVideoFrameMode, profile)
  );
  const runtimeAssets = await timeAsyncSection(profile, 'loadRuntimeAssets', () =>
    loadRuntimeAssets(compiledManifest, compiledFiles, profile)
  );
  const previewOutputSize = resolvePreviewOutputSizeOverride(
    inputImage,
    compiledManifest,
    previewOutputAspectRatio
  );

  const runtime = timeSection(profile, 'createRuntime', () => new BrowserFilterRuntime({
    compiledManifest,
    sourceManifest,
    compiledFiles,
    sourceFiles: compiledFiles.__sourceFiles ?? null,
    workspace,
    canvas,
    inputImage,
    runtimeAssets,
    previewOutputSize,
    renderTimeline,
    parameterValues,
    profile
  }));

  await timeAsyncSection(profile, 'executeRuntime', () =>
    runtime.execute(String(compiledFiles['main.lua'] ?? ''))
  );

  return {
    width: runtime.output.width,
    height: runtime.output.height,
    inputLabel: inputImage.sourcePath || 'Generated gradient',
    sourceManifest,
    compiledManifest,
    debugSnapshot: runtime.getDebugSnapshot(),
    diagnostics: profile.diagnostics,
    profile: finalizeProfile(profile)
  };
}

export function getFilterPreviewModel(workspace, compiledFiles) {
  const sourceManifest = parseSourceManifest(workspace);
  const compiledManifest = compiledFiles?.['manifest.json']
    ? JSON.parse(String(compiledFiles['manifest.json']))
    : null;

  return {
    sourceManifest,
    compiledManifest,
    parameters: sourceManifest?.parameters ?? compiledManifest?.parameters ?? []
  };
}

function resolvePreviewOutputSizeOverride(inputImage, compiledManifest, previewOutputAspectRatio) {
  if (compiledManifest?.outputSizeMode === 'active') return null;
  const aspectRatio = Number(previewOutputAspectRatio);
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return null;
  const inputWidth = Math.max(1, Math.floor(Number(inputImage?.width) || 1));
  const inputHeight = Math.max(1, Math.floor(Number(inputImage?.height) || 1));
  const width = Math.min(inputWidth, inputHeight * aspectRatio);
  const height = Math.min(inputHeight, inputWidth / aspectRatio);
  return {
    width: Math.max(1, Math.floor(width + 1e-6)),
    height: Math.max(1, Math.floor(height + 1e-6))
  };
}

async function loadRuntimeAssets(compiledManifest, compiledFiles, profile = null) {
  const assets = new Map();
  const cache = getRuntimeAssetCache(compiledFiles);
  for (const asset of compiledManifest?.assets ?? []) {
    if (!asset?.id) continue;
    const bytes = getVirtualFileBytes(compiledFiles, asset.path);
    if (!bytes) {
      throw new Error(`Missing ${asset.type || 'runtime'} asset "${asset.id}" at "${asset.path}".`);
    }
    const cacheKey = `${asset.type}:${asset.id}:${asset.path}`;
    if (cache?.has(cacheKey)) {
      assets.set(asset.id, cache.get(cacheKey));
      continue;
    }

    if (asset.type === 'image') {
      const surface = await timeAsyncSection(profile, `asset:${asset.id}:image`, () =>
        imageSurfaceFromBytes(bytes, asset.path)
      );
      cache?.set(cacheKey, surface);
      assets.set(asset.id, surface);
      continue;
    }

    if (asset.type === 'video') {
      const surface = await timeAsyncSection(profile, `asset:${asset.id}:video`, () =>
        videoAssetSurfaceFromBytes(bytes, asset.path)
      );
      cache?.set(cacheKey, surface);
      assets.set(asset.id, surface);
    }
  }
  return assets;
}

function getRuntimeAssetCache(compiledFiles) {
  if (!compiledFiles || typeof compiledFiles !== 'object') return null;
  let cache = PREVIEW_RUNTIME_ASSET_CACHE.get(compiledFiles);
  if (!cache) {
    cache = new Map();
    PREVIEW_RUNTIME_ASSET_CACHE.set(compiledFiles, cache);
  }
  return cache;
}

function getVirtualFileBytes(files, filePath) {
  const normalizedPath = normalizeShaderPath(filePath);
  const value = files?.[normalizedPath] ?? files?.[filePath];
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

async function imageSurfaceFromBytes(bytes, sourcePath) {
  const blob = new Blob([bytes], { type: inferImageMimeType(sourcePath) });
  return await imageSurfaceFromBlob(blob, sourcePath);
}

async function videoAssetSurfaceFromBytes(bytes, sourcePath) {
  const blob = new Blob([bytes], { type: inferVideoMimeType(sourcePath) });
  const objectUrl = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.loop = true;
  video.autoplay = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = objectUrl;
  await waitForVideoReady(video, sourcePath);
  await video.play().catch(() => {});

  const width = video.videoWidth || 1;
  const height = video.videoHeight || 1;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const surface = new VideoAssetSurface(video, canvas, context, sourcePath, objectUrl);
  surface.nextFrame();
  return surface;
}

function inferImageMimeType(sourcePath) {
  const path = String(sourcePath ?? '').toLowerCase();
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.bmp')) return 'image/bmp';
  return 'image/png';
}

function inferVideoMimeType(sourcePath) {
  const path = String(sourcePath ?? '').toLowerCase();
  if (path.endsWith('.webm')) return 'video/webm';
  if (path.endsWith('.mov')) return 'video/quicktime';
  return 'video/mp4';
}

function normalizeRenderTimeline(timeline) {
  return {
    frameIndex: Math.max(0, Math.floor(Number(timeline?.frameIndex) || 0)),
    timeSeconds: Math.max(0, Number(timeline?.timeSeconds) || 0),
    deltaSeconds: Math.max(0, Number(timeline?.deltaSeconds) || 0)
  };
}

class BrowserFilterRuntime {
  constructor({ compiledManifest, sourceManifest, compiledFiles, sourceFiles, workspace, canvas, inputImage, runtimeAssets, previewOutputSize, renderTimeline, parameterValues, profile }) {
    this.compiledManifest = compiledManifest;
    this.sourceManifest = sourceManifest ?? { parameters: [], passes: [], assets: [] };
    this.compiledFiles = compiledFiles ?? {};
    this.sourceFiles = sourceFiles ?? null;
    this.workspace = workspace;
    this.canvas = canvas;
    this.input = inputImage;
    this.output = new OutputImage(
      canvas,
      previewOutputSize?.width ?? inputImage.width,
      previewOutputSize?.height ?? inputImage.height
    );
    this.targets = new Map();
    this.buffers = new Map();
    this.assets = runtimeAssets ?? new Map();
    this.runtimeObjects = new Map();
    this.nextObjectId = 1;
    this.profile = profile;
    this.timeline = normalizeRenderTimeline(renderTimeline);
    this.passCommands = [];
    this.gpuRuntime = null;
    this.params = resolveParameters(
      compiledManifest.parameters ?? sourceManifest.parameters ?? [],
      parameterValues
    );
    this.passById = new Map((compiledManifest.passes ?? []).map((pass) => [pass.id, pass]));
    this.sourcePassById = new Map((this.sourceManifest.passes ?? []).map((pass) => [pass.id, pass]));
  }

  async execute(script) {
    const L = timeSection(this.profile, 'luaCreateState', () => lauxlib.luaL_newstate());
    timeSection(this.profile, 'luaOpenLibs', () => {
      openPreviewLuaLibs(L);
    });

    timeSection(this.profile, 'luaInstallCtx', () => {
      this.installCtxTable(L);
    });

    this._paramSnapshots = new Map();
    for (const [id, value] of Object.entries(this.params)) {
      if (Array.isArray(value)) {
        lua.lua_newtable(L);
        for (let i = 0; i < value.length; i++) {
          lua.lua_pushnumber(L, 0);
          lua.lua_seti(L, -2, i + 1);
        }
        const luaRef = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);
        this._paramSnapshots.set(id, { luaRef, prepared: false });
      }
    }

    timeSection(this.profile, 'luaLoadScript', () => {
      if (lauxlib.luaL_dostring(L, to_luastring(script)) !== lua.LUA_OK) {
        throw new Error(`Lua load failed: ${this.popLuaError(L)}`);
      }
    });

    timeSection(this.profile, 'luaOnReset', () => {
      for (const snap of this._paramSnapshots.values()) snap.prepared = false;
      this.invokeLuaFunction(L, 'onReset', this.compiledManifest.outputSizeMode === 'active'
        ? [() => this.pushCtxTable(L), () => this.pushOutputRequest(L)]
        : [() => this.pushCtxTable(L)]);
    });
    timeSection(this.profile, 'luaAdvance', () => {
      for (const snap of this._paramSnapshots.values()) snap.prepared = false;
      this.invokeLuaFunction(L, 'advance', [() => this.pushCtxTable(L)]);
    });
    await timeAsyncSection(this.profile, 'replayPassCommands', () => this.replayPassCommands());
  }

  installCtxTable(L) {
    lua.lua_newtable(L);
    for (const method of LUA_CTX_METHODS) {
      lua.lua_pushjsfunction(L, (state) => this.invokeCtxMethod(state, method));
      lua.lua_setfield(L, -2, to_luastring(method));
    }
    lua.lua_setglobal(L, to_luastring('ctx'));
  }

  pushCtxTable(L) {
    lua.lua_getglobal(L, to_luastring('ctx'));
  }

  pushOutputRequest(L) {
    lua.lua_newtable(L);
    lua.lua_pushjsfunction(L, (state) => {
      try {
        const width = lua.lua_tointeger(state, 2);
        const height = lua.lua_tointeger(state, 3);
        this.output.resize(width, height);
        return 0;
      } catch (error) {
        return this.raiseLuaError(state, error);
      }
    });
    lua.lua_setfield(L, -2, to_luastring('setSize'));
  }

  invokeLuaFunction(L, name, pushArgs) {
    lua.lua_getglobal(L, to_luastring(name));
    if (!lua.lua_isfunction(L, -1)) {
      lua.lua_pop(L, 1);
      return;
    }

    for (const pushArg of pushArgs) {
      pushArg();
    }

    if (lua.lua_pcall(L, pushArgs.length, 0, 0) !== lua.LUA_OK) {
      throw new Error(`Lua ${name} failed: ${this.popLuaError(L)}`);
    }
  }

  invokeCtxMethod(L, method) {
    try {
      if (method === 'getInput') {
        this.pushRuntimeObject(L, this.input);
        return 1;
      }

      if (method === 'getParam') {
        const id = this.requireLuaString(L, 2, 'parameter id');
        const snap = this._paramSnapshots?.get(id);
        if (snap) {
          lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, snap.luaRef);
          if (!snap.prepared) {
            const value = this.params[id];
            value.forEach((v, i) => {
              lua.lua_pushnumber(L, v);
              lua.lua_seti(L, -2, i + 1);
            });
            snap.prepared = true;
          }
          return 1;
        }
        this.pushLuaValue(L, this.params[id]);
        return 1;
      }

      if (method === 'getAsset') {
        const id = this.requireLuaString(L, 2, 'asset id');
        const asset = this.assets.get(id);
        if (!asset) {
          throw new Error(`Unknown asset "${id}".`);
        }
        this.pushRuntimeObject(L, asset);
        return 1;
      }

      if (method === 'createTarget') {
        const id = this.requireLuaString(L, 2, 'target id');
        const width = lua.lua_tointeger(L, 3);
        const height = lua.lua_tointeger(L, 4);
        this.targets.set(id, new ImageSurface(width, height));
        return 0;
      }

      if (method === 'getTarget') {
        const id = this.requireLuaString(L, 2, 'target id');
        const target = this.targets.get(id);
        if (!target) throw new Error(`Unknown target "${id}".`);
        this.pushRuntimeObject(L, target);
        return 1;
      }

      if (method === 'createFloatBuffer' || method === 'createUIntBuffer') {
        const id = this.requireLuaString(L, 2, 'buffer id');
        const shape = this.readLuaValue(L, 3);
        const elementCount = getElementCount(shape);
        const values = method === 'createFloatBuffer'
          ? new Float32Array(elementCount)
          : new Uint32Array(elementCount);
        this.buffers.set(id, {
          kind: 'buffer',
          elementType: method === 'createFloatBuffer' ? 'float' : 'uint',
          shape: Array.isArray(shape) ? shape : [elementCount],
          values
        });
        return 0;
      }

      if (method === 'getBuffer') {
        const id = this.requireLuaString(L, 2, 'buffer id');
        const buffer = this.buffers.get(id);
        if (!buffer) throw new Error(`Unknown buffer "${id}".`);
        this.pushRuntimeObject(L, buffer);
        return 1;
      }

      if (method === 'getOutput') {
        this.pushRuntimeObject(L, this.output);
        return 1;
      }

      if (method === 'getFrameIndex') {
        lua.lua_pushinteger(L, this.timeline.frameIndex);
        return 1;
      }

      if (method === 'getTimeSeconds') {
        lua.lua_pushnumber(L, this.timeline.timeSeconds);
        return 1;
      }

      if (method === 'getDeltaSeconds') {
        lua.lua_pushnumber(L, this.timeline.deltaSeconds);
        return 1;
      }

      if (method === 'clearOutput') {
        const output = this.readLuaValue(L, 2);
        const color = this.readLuaValue(L, 3);
        this.clearOutput(output, color);
        return 0;
      }

      if (method === 'runComputePass') {
        const passId = this.requireLuaString(L, 2, 'pass id');
        const bindings = this.readLuaValue(L, 3);
        const dispatch = this.readLuaValue(L, 4);
        this.runComputePass(passId, bindings, dispatch);
        return 0;
      }

      if (method === 'runRenderPass') {
        const passId = this.requireLuaString(L, 2, 'pass id');
        const bindings = this.readLuaValue(L, 3);
        const output = this.readLuaValue(L, 4);
        this.runRenderPass(passId, bindings, output);
        return 0;
      }

      throw new Error(`Unsupported ctx method "${method}".`);
    } catch (error) {
      return this.raiseLuaError(L, error);
    }
  }

  clearOutput(output, color) {
    this.requireWritableOutput(output, 'clearOutput output');
    this.passCommands.push({
      type: 'clear',
      output,
      color: normalizeClearColor(color)
    });
  }

  requireWritableOutput(output, label) {
    if (output instanceof OutputImage) return;
    for (const target of this.targets.values()) {
      if (target === output) return;
    }
    throw new Error(`Expected ${label} to be a Target or Output.`);
  }

  runComputePass(passId, bindings, dispatch) {
    const pass = this.passById.get(passId);
    if (!pass) throw new Error(`Unknown compute pass "${passId}".`);
    if (pass.type !== 'compute') throw new Error(`Pass "${passId}" is not a compute pass.`);
    this.passCommands.push({ type: 'compute', passId, bindings, dispatch });
  }

  async runComputePassImmediate(passId, bindings, dispatch) {
    const pass = this.passById.get(passId);
    if (!pass) throw new Error(`Unknown compute pass "${passId}".`);
    if (pass.type !== 'compute') throw new Error(`Pass "${passId}" is not a compute pass.`);
    const source = getCompiledWgslComputePassSource(pass, this.compiledFiles, this.sourceFiles);
    if (!source || typeof source.code !== 'string') {
      throw new Error(`Missing compiled WGSL compute shader for pass "${passId}".`);
    }

    if (await timeAsyncSection(this.profile, `pass:${pass.id}:webgpu-compute-total`, async () => (
      await (await this.getGpuRuntime()).runPass({
        pass,
        source,
        bindings,
        dispatch,
        profile: this.profile
      })
    ))) {
      return;
    }

    throw new Error(`Preview runtime does not yet support compute pass "${passId}".`);
  }

  runRenderPass(passId, bindings, output) {
    this.passCommands.push({ type: 'render', passId, bindings, output });
  }

  async runRenderPassImmediate(passId, bindings, output) {
    this.requireWritableOutput(output, 'render pass output');
    const pass = this.passById.get(passId);
    if (!pass) throw new Error(`Unknown render pass "${passId}".`);
    if (pass.type !== 'render') throw new Error(`Pass "${passId}" is not a render pass.`);

    if (await (await this.getGpuRuntime()).runRenderPass({
      pass,
      bindings,
      output,
      compiledFiles: this.compiledFiles,
      sourceFiles: this.sourceFiles,
      profile: this.profile
    })) {
      return;
    }

    throw new Error(`Preview runtime does not yet support render pass "${passId}".`);
  }

  async clearOutputImmediate(output, color) {
    this.requireWritableOutput(output, 'clearOutput output');
    if (await (await this.getGpuRuntime()).clearOutput({
      output,
      color,
      profile: this.profile
    })) {
      return;
    }

    throw new Error('Preview runtime does not yet support clearOutput.');
  }

  async getGpuRuntime() {
    if (!this.gpuRuntime) {
      this.gpuRuntime = await getPreviewWebGpuRuntime(this.canvas, this.output.width, this.output.height, this.profile);
      if (!this.gpuRuntime) {
        throw new Error('WebGPU preview runtime unavailable. Relaunch VS Code with WebGPU enabled, then run Forge preview again.');
      }
    }
    return this.gpuRuntime;
  }

  async replayPassCommands() {
    for (const command of this.passCommands) {
      if (command.type === 'clear') {
        await this.clearOutputImmediate(command.output, command.color);
      } else if (command.type === 'compute') {
        await this.runComputePassImmediate(command.passId, command.bindings, command.dispatch);
      } else if (command.type === 'render') {
        await this.runRenderPassImmediate(command.passId, command.bindings, command.output);
      }
    }
  }

  getDebugSnapshot() {
    return {
      queuedPasses: this.passCommands.map((command) => ({
        type: command.type,
        passId: command.passId
      })),
      buffers: Array.from(this.buffers.entries()).map(([id, buffer]) => ({
        id,
        elementType: buffer.elementType,
        shape: buffer.shape,
        count: buffer.values?.length ?? 0,
        residency: 'gpu'
      }))
    };
  }

  requireLuaString(L, index, label) {
    if (!lua.lua_isstring(L, index)) {
      throw new Error(`Expected ${label} to be a string.`);
    }
    return to_jsstring(lua.lua_tostring(L, index));
  }

  pushRuntimeObject(L, object) {
    const runtimeId = this.getOrCreateRuntimeObjectId(object);
    lua.lua_newtable(L);

    lua.lua_pushinteger(L, runtimeId);
    lua.lua_setfield(L, -2, to_luastring('__rtid'));

    if (typeof object.getWidth === 'function') {
      lua.lua_pushjsfunction(L, () => {
        lua.lua_pushinteger(L, object.getWidth());
        return 1;
      });
      lua.lua_setfield(L, -2, to_luastring('getWidth'));
    }

    if (typeof object.getHeight === 'function') {
      lua.lua_pushjsfunction(L, () => {
        lua.lua_pushinteger(L, object.getHeight());
        return 1;
      });
      lua.lua_setfield(L, -2, to_luastring('getHeight'));
    }

    if (typeof object.seek === 'function') {
      lua.lua_pushjsfunction(L, (state) => {
        object.seek(lua.lua_tointeger(state, 2));
        return 0;
      });
      lua.lua_setfield(L, -2, to_luastring('seek'));
    }

    if (typeof object.nextFrame === 'function') {
      lua.lua_pushjsfunction(L, () => {
        object.nextFrame();
        return 0;
      });
      lua.lua_setfield(L, -2, to_luastring('nextFrame'));
    }
  }

  getOrCreateRuntimeObjectId(object) {
    for (const [id, value] of this.runtimeObjects.entries()) {
      if (value === object) return id;
    }

    const id = this.nextObjectId;
    this.nextObjectId += 1;
    this.runtimeObjects.set(id, object);
    return id;
  }

  pushLuaValue(L, value) {
    if (value === undefined || value === null) {
      lua.lua_pushnil(L);
      return;
    }

    if (typeof value === 'number') {
      lua.lua_pushnumber(L, value);
      return;
    }

    if (typeof value === 'boolean') {
      lua.lua_pushboolean(L, value ? 1 : 0);
      return;
    }

    if (Array.isArray(value)) {
      lua.lua_newtable(L);
      value.forEach((item, index) => {
        this.pushLuaValue(L, item);
        lua.lua_seti(L, -2, index + 1);
      });
      return;
    }

    this.pushRuntimeObject(L, value);
  }

  readLuaValue(L, index) {
    const type = lua.lua_type(L, index);

    if (type === lua.LUA_TNUMBER) {
      return lua.lua_tonumber(L, index);
    }

    if (type === lua.LUA_TBOOLEAN) {
      return lua.lua_toboolean(L, index) !== 0;
    }

    if (type === lua.LUA_TSTRING) {
      return to_jsstring(lua.lua_tostring(L, index));
    }

    if (type === lua.LUA_TTABLE) {
      const runtimeId = this.readRuntimeId(L, index);
      if (runtimeId !== null) {
        return this.runtimeObjects.get(runtimeId);
      }
      return this.readLuaTable(L, index);
    }

    if (type === lua.LUA_TNIL) {
      return null;
    }

    throw new Error('Unsupported Lua value in preview runtime.');
  }

  readRuntimeId(L, index) {
    lua.lua_getfield(L, index, to_luastring('__rtid'));
    const runtimeId = lua.lua_isinteger(L, -1) ? lua.lua_tointeger(L, -1) : null;
    lua.lua_pop(L, 1);
    return runtimeId;
  }

  readLuaTable(L, index) {
    const tableIndex = lua.lua_absindex(L, index);
    const arrayValues = [];
    const objectValues = {};
    let hasStringKeys = false;
    let maxIndex = 0;

    lua.lua_pushnil(L);
    while (lua.lua_next(L, tableIndex) !== 0) {
      const value = this.readLuaValue(L, -1);

      if (lua.lua_isinteger(L, -2)) {
        const numericKey = lua.lua_tointeger(L, -2);
        if (numericKey >= 1) {
          arrayValues[numericKey - 1] = value;
          maxIndex = Math.max(maxIndex, numericKey);
        }
      } else {
        const key = to_jsstring(lua.lua_tostring(L, -2));
        objectValues[key] = value;
        hasStringKeys = true;
      }

      lua.lua_pop(L, 1);
    }

    if (!hasStringKeys && maxIndex > 0) {
      return arrayValues.slice(0, maxIndex);
    }

    for (let indexValue = 0; indexValue < arrayValues.length; indexValue += 1) {
      if (arrayValues[indexValue] !== undefined) {
        objectValues[indexValue + 1] = arrayValues[indexValue];
      }
    }

    return objectValues;
  }

  popLuaError(L) {
    const message = lua.lua_isstring(L, -1)
      ? to_jsstring(lua.lua_tostring(L, -1))
      : 'Unknown Lua error';
    lua.lua_pop(L, 1);
    return message;
  }

  raiseLuaError(L, error) {
    lua.lua_pushstring(L, to_luastring(error.message || String(error)));
    return lua.lua_error(L);
  }
}

class ImageSurface {
  constructor(width, height, pixels, sourcePath = '', options = {}) {
    this.width = width;
    this.height = height;
    this.sourcePath = sourcePath;
    this.externalTextureSource = options.externalTextureSource ?? null;
    this.textureFlipY = options.textureFlipY ?? false;
    this.pixels = pixels ?? (this.externalTextureSource ? null : new Uint8ClampedArray(width * height * 4));
  }

  getWidth() {
    return this.width;
  }

  getHeight() {
    return this.height;
  }

  resize(width, height) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    if (!this.externalTextureSource) {
      this.pixels = new Uint8ClampedArray(width * height * 4);
    }
  }
}

class VideoAssetSurface extends ImageSurface {
  constructor(video, canvas, context, sourcePath, objectUrl) {
    super(canvas.width || 1, canvas.height || 1, null, sourcePath, {
      externalTextureSource: canvas,
      textureFlipY: false
    });
    this.video = video;
    this.canvas = canvas;
    this.context = context;
    this.objectUrl = objectUrl;
    this.frameIndex = 0;
    this.frameStepSeconds = 1 / 30;
  }

  seek(frameIndex) {
    this.frameIndex = Math.max(0, Math.floor(Number(frameIndex) || 0));
    this.seekVideoTime();
    this.drawCurrentFrame();
  }

  nextFrame() {
    if (this.video.paused) {
      this.seekVideoTime();
    }
    this.drawCurrentFrame();
    this.frameIndex += 1;
  }

  seekVideoTime() {
    const duration = Number(this.video.duration);
    if (!Number.isFinite(duration) || duration <= 0) return;
    this.video.currentTime = (this.frameIndex * this.frameStepSeconds) % duration;
  }

  drawCurrentFrame() {
    const width = this.video.videoWidth || this.width || 1;
    const height = this.video.videoHeight || this.height || 1;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.width = width;
    this.height = height;
    this.context.drawImage(this.video, 0, 0, width, height);
  }
}

class OutputImage extends ImageSurface {
  constructor(canvas, width, height) {
    super(width, height);
    this.canvas = canvas;
    this.resize(width, height);
  }

  resize(width, height) {
    super.resize(width, height);
    this.canvas.width = width;
    this.canvas.height = height;
  }
}

function parseSourceManifest(workspace) {
  const manifestFile = workspace.getFile('manifest.json');
  if (!manifestFile) return null;

  try {
    return JSON.parse(String(manifestFile.content));
  } catch {
    return null;
  }
}

function resolveParameters(parameters, overrides) {
  const values = {};
  for (const parameter of parameters) {
    if (parameter.type === 'float') {
      values[parameter.id] = overrides[parameter.id]
        ?? parameter.default
        ?? parameter.min
        ?? 0;
    } else if (parameter.type === 'bool') {
      values[parameter.id] = overrides[parameter.id] ?? parameter.default ?? false;
    } else {
      values[parameter.id] = overrides[parameter.id] ?? parameter.default ?? null;
    }
  }
  return values;
}

async function loadPreviewInput(previewInputFile, canvas, previewInputVideoElement = null, previewInputVideoFrameMode = 'external', profile = null) {
  if (previewInputFile) {
    if (isVideoBlob(previewInputFile, previewInputFile.name)) {
      return await mediaSurfaceFromBlob(previewInputFile, previewInputFile.name, previewInputVideoElement, previewInputVideoFrameMode, profile);
    }

    const cached = PREVIEW_INPUT_CACHE.get(previewInputFile);
    if (cached) {
      return cached;
    }

    const surface = await mediaSurfaceFromBlob(previewInputFile, previewInputFile.name, null, 'external', profile);
    PREVIEW_INPUT_CACHE.set(previewInputFile, surface);
    return surface;
  }

  return createFallbackInput(canvas.width || 512, canvas.height || 512);
}

async function mediaSurfaceFromBlob(blob, sourcePath, previewInputVideoElement = null, previewInputVideoFrameMode = 'external', profile = null) {
  if (isVideoBlob(blob, sourcePath)) {
    if (previewInputVideoElement) {
      return await videoSurfaceFromElement(previewInputVideoElement, sourcePath, previewInputVideoFrameMode, profile);
    }

    return await videoSurfaceFromBlob(blob, sourcePath, profile);
  }

  return await imageSurfaceFromBlob(blob, sourcePath);
}

async function imageSurfaceFromBlob(blob, sourcePath) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return new ImageSurface(canvas.width, canvas.height, new Uint8ClampedArray(imageData.data), sourcePath);
}

async function videoSurfaceFromBlob(blob, sourcePath, profile = null) {
  const objectUrl = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = objectUrl;

  try {
    await waitForVideoReady(video, sourcePath);
    return drawVideoSurface(video, sourcePath, profile);
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

async function videoSurfaceFromElement(video, sourcePath, frameMode = 'external', profile = null) {
  await waitForVideoReady(video, sourcePath);
  if (frameMode === 'pixels') {
    return drawVideoSurface(video, sourcePath, profile);
  }
  return getPreviewVideoExternalSurface(video, sourcePath);
}

async function waitForVideoReady(video, sourcePath) {
  if ((video.readyState ?? 0) >= 2 && (video.videoWidth || 0) > 0 && (video.videoHeight || 0) > 0) {
    return;
  }

  await new Promise((resolve, reject) => {
    const onLoadedData = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Failed to decode preview video: ${sourcePath}`));
    };
    const cleanup = () => {
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('error', onError);
    };

    video.addEventListener('loadeddata', onLoadedData);
    video.addEventListener('error', onError);
  });
}

function drawVideoSurface(video, sourcePath, profile = null) {
  const width = video.videoWidth || 512;
  const height = video.videoHeight || 512;
  const frameSurface = getPreviewVideoFrameSurface(video, width, height);

  timeSection(profile, 'videoFrame:drawImage', () => {
    frameSurface.context.drawImage(video, 0, 0, width, height);
  });
  const imageData = timeSection(profile, 'videoFrame:getImageData', () =>
    frameSurface.context.getImageData(0, 0, width, height)
  );
  const pixels = timeSection(profile, 'videoFrame:copyPixels', () =>
    new Uint8ClampedArray(imageData.data)
  );
  const stats = summarizeRgbaPixels(pixels);
  addDiagnostic(profile, 'info', 'WebGPU video frame upload prepared.', {
    source: sourcePath,
    size: `${width}x${height}`,
    luma: stats.luma,
    alpha: stats.alpha
  });
  return new ImageSurface(width, height, pixels, sourcePath);
}

function getPreviewVideoExternalSurface(video, sourcePath) {
  const width = video.videoWidth || 512;
  const height = video.videoHeight || 512;
  const cached = getPreviewVideoFrameSurface(video, width, height);
  cached.context.drawImage(video, 0, 0, width, height);
  if (cached.surface) {
    cached.surface.width = width;
    cached.surface.height = height;
    cached.surface.sourcePath = sourcePath;
    return cached.surface;
  }

  cached.surface = new ImageSurface(width, height, null, sourcePath, {
    externalTextureSource: cached.canvas,
    textureFlipY: false
  });
  return cached.surface;
}

function getPreviewVideoFrameSurface(video, width, height) {
  const cached = PREVIEW_VIDEO_FRAME_CACHE.get(video);
  if (cached) {
    if (cached.canvas.width !== width) cached.canvas.width = width;
    if (cached.canvas.height !== height) cached.canvas.height = height;
    return cached;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const surface = { canvas, context };
  PREVIEW_VIDEO_FRAME_CACHE.set(video, surface);
  return surface;
}

function isVideoBlob(blob, sourcePath) {
  if (typeof blob?.type === 'string' && blob.type.startsWith('video/')) {
    return true;
  }

  return /\.(mp4|webm|mov|m4v)$/i.test(String(sourcePath || ''));
}

function createFallbackInput(width, height) {
  const surface = new ImageSurface(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      surface.pixels[index] = Math.round((x / Math.max(width - 1, 1)) * 255);
      surface.pixels[index + 1] = Math.round((y / Math.max(height - 1, 1)) * 255);
      surface.pixels[index + 2] = 160;
      surface.pixels[index + 3] = 255;
    }
  }
  return surface;
}

function getElementCount(shape) {
  if (!Array.isArray(shape) || shape.length === 0) return 0;
  return shape.reduce((product, value) => product * Number(value || 0), 1);
}

async function runGenericComputePassWebGpu({ pass, sourcePass, bindings, dispatch, workspace, profile }) {
  const source = getComputePassShaderSource(workspace, pass, sourcePass);
  if (typeof source !== 'string') return false;

  const runner = await getPreviewWebGpuComputeRunner(profile);
  if (!runner) return false;

  return await timeAsyncSection(profile, `pass:${pass.id}:webgpu-generic`, () =>
    runner.runPass({ pass, source, bindings, dispatch, profile })
  );
}

const PREVIEW_WEBGPU_RUNTIMES = new WeakMap();

async function getPreviewWebGpuRuntime(canvas, width, height, profile) {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    addDiagnostic(profile, 'info', 'WebGPU preview unavailable.');
    throw new Error('WebGPU preview unavailable. Relaunch VS Code with WebGPU enabled, then run Forge preview again.');
  }

  try {
    let runtime = PREVIEW_WEBGPU_RUNTIMES.get(canvas);
    if (!runtime) {
      runtime = await PreviewWebGpuRuntime.create(canvas);
      PREVIEW_WEBGPU_RUNTIMES.set(canvas, runtime);
    }
    runtime.resize(width, height);
    return runtime;
  } catch (error) {
    addDiagnostic(profile, 'warning', 'WebGPU preview failed to initialize.', {
      error: error.message || String(error)
    });
    console.warn('WebGPU preview failed to initialize:', error);
    throw error;
  }
}

class PreviewWebGpuRuntime {
  static async create(canvas) {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error('WebGPU adapter unavailable.');
    }

    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu');
    if (!context) {
      throw new Error('WebGPU canvas context unavailable.');
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    return new PreviewWebGpuRuntime(canvas, device, context, format);
  }

  constructor(canvas, device, context, format) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.format = format;
    this.pipelineCache = new Map();
    this.renderPipelineCache = new Map();
    this.resourceCache = new WeakMap();
    this.defaultSampler = null;
    this.fullscreenVertexBuffer = createFullscreenTriangleGpuBuffer(device);
    this.configuredWidth = 0;
    this.configuredHeight = 0;
    this.lastProfile = null;
    this.device.addEventListener?.('uncapturederror', (event) => {
      addDiagnostic(this.lastProfile, 'error', 'WebGPU uncaptured error.', {
        message: event.error?.message || String(event.error || event)
      });
    });
  }

  resize(width, height) {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    if (this.configuredWidth === width && this.configuredHeight === height) return;
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'premultiplied'
    });
    this.configuredWidth = width;
    this.configuredHeight = height;
  }

  async runPass({ pass, source, bindings, dispatch, profile }) {
    const device = this.device;
    const code = typeof source === 'string' ? source : source?.code;
    if (typeof code !== 'string') {
      throw new Error(`Missing compute shader source for pass "${pass.id}".`);
    }
    const boundResources = buildComputeGpuResources(this, pass, bindings, profile);
    const pipeline = this.getPipeline(pass, code);
    const bindGroups = createGpuBindGroupsFromLayouts(device, pipeline.bindGroupLayouts, boundResources.groups);
    const workgroups = calculateWorkgroups(dispatch, pass.localSize);

    const encoder = timeSection(profile, `pass:${pass.id}:webgpu-encode`, () => {
      const commandEncoder = device.createCommandEncoder();
      const computePass = commandEncoder.beginComputePass();
      computePass.setPipeline(pipeline);
      for (const { set, bindGroup } of bindGroups) {
        computePass.setBindGroup(set, bindGroup);
      }
      computePass.dispatchWorkgroups(workgroups.x, workgroups.y, workgroups.z);
      computePass.end();
      return commandEncoder;
    });
    timeSection(profile, `pass:${pass.id}:webgpu-submit`, () => {
      device.queue.submit([encoder.finish()]);
    });
    boundResources.destroy();
    return true;
  }

  getPipeline(pass, code) {
    const cacheKey = `${pass.id}:${hashString(code)}`;
    const cached = this.pipelineCache.get(cacheKey);
    if (cached) return cached;

    const module = this.device.createShaderModule({ code });
    const label = `preview compute pass ${pass.id}`;
    const bindGroupLayouts = buildComputeBindGroupLayouts(this.device, pass, label);
    const layout = this.device.createPipelineLayout({
      label: `${label} pipeline layout`,
      bindGroupLayouts
    });
    const pipeline = this.device.createComputePipeline({
      label,
      layout,
      compute: { module, entryPoint: 'main' }
    });
    pipeline.bindGroupLayouts = bindGroupLayouts;
    this.pipelineCache.set(cacheKey, pipeline);
    return pipeline;
  }

  async runRenderPass({ pass, bindings, output, compiledFiles, sourceFiles, profile }) {
    this.lastProfile = profile;
    this.resize(output.width, output.height);
    return await timeAsyncSection(profile, `pass:${pass.id}:webgpu-render-generic`, async () => {
      const compiledWgsl = getCompiledWgslRenderPassSource(pass, compiledFiles, sourceFiles);
      if (!compiledWgsl) {
        throw new Error(`Missing compiled WGSL render shader for pass "${pass.id}".`);
      }
      const shaderSources = {
        vertexWgslPath: compiledWgsl.vertex.path,
        fragmentWgslPath: compiledWgsl.fragment.path
      };
      addTraceDiagnostic(profile, `WebGPU render pass "${pass.id}" prepared.`, {
        output: describeRenderOutput(output),
        bindings: summarizeRenderBindings(pass, bindings),
        wgslPreview: compiledWgsl.fragment.code.slice(0, 1800)
      });
      const pipeline = await this.getRenderPipeline(pass, compiledWgsl, shaderSources);
      const boundResources = buildRenderGpuResources(this, pass, bindings, profile);
      let scopePushed = false;
      try {
        if (ENABLE_WEBGPU_ERROR_SCOPES && typeof this.device.pushErrorScope === 'function') {
          this.device.pushErrorScope('validation');
          scopePushed = true;
        }
        const bindGroups = createGpuBindGroupsFromLayouts(this.device, pipeline.bindGroupLayouts, boundResources.groups);
        const outputView = this.getRenderOutputView(output, profile, `pass:${pass.id}:output`);
        const encoder = this.device.createCommandEncoder();
        const renderPass = encoder.beginRenderPass({
          colorAttachments: [{
            view: outputView,
            loadOp: 'load',
            storeOp: 'store'
          }]
        });
        renderPass.setPipeline(pipeline);
        for (const { set, bindGroup } of bindGroups) {
          renderPass.setBindGroup(set, bindGroup);
        }
        if ((pass.vertexInput ?? []).length > 0) {
          renderPass.setVertexBuffer(0, this.fullscreenVertexBuffer);
        }
        renderPass.draw(3);
        renderPass.end();
        timeSection(profile, `pass:${pass.id}:webgpu-submit`, () => {
          this.device.queue.submit([encoder.finish()]);
        });
        if (scopePushed) {
          const scopedError = await this.device.popErrorScope();
          scopePushed = false;
          if (scopedError) {
            throw createWebGpuPipelineError(pass, 'WebGPU render pass validation failed.', {
              shaderSources,
              error: scopedError,
              generatedWgsl: compiledWgsl.fragment.code,
              lineMap: compiledWgsl.fragment.lineMap
            });
          }
        }
        addTraceDiagnostic(profile, `WebGPU render pass "${pass.id}" submitted.`, {
          canvas: `${this.canvas.width}x${this.canvas.height}`,
          output: describeRenderOutput(output)
        });
        return true;
      } finally {
        if (scopePushed) {
          await this.device.popErrorScope();
        }
        boundResources.destroy();
      }
    });
  }

  async clearOutput({ output, color, profile }) {
    this.lastProfile = profile;
    this.resize(output.width, output.height);
    return await timeAsyncSection(profile, 'clearOutput:webgpu', async () => {
      let scopePushed = false;
      try {
        if (ENABLE_WEBGPU_ERROR_SCOPES && typeof this.device.pushErrorScope === 'function') {
          this.device.pushErrorScope('validation');
          scopePushed = true;
        }
        const outputView = this.getRenderOutputView(output, profile, 'clearOutput:output');
        const encoder = this.device.createCommandEncoder();
        const renderPass = encoder.beginRenderPass({
          colorAttachments: [{
            view: outputView,
            clearValue: color,
            loadOp: 'clear',
            storeOp: 'store'
          }]
        });
        renderPass.end();
        timeSection(profile, 'clearOutput:webgpu-submit', () => {
          this.device.queue.submit([encoder.finish()]);
        });
        if (scopePushed) {
          const scopedError = await this.device.popErrorScope();
          scopePushed = false;
          if (scopedError) {
            throw new Error(`WebGPU clearOutput validation failed: ${scopedError.message || scopedError}`);
          }
        }
        addTraceDiagnostic(profile, 'WebGPU output cleared.', {
          output: describeRenderOutput(output),
          color
        });
        return true;
      } finally {
        if (scopePushed) {
          await this.device.popErrorScope();
        }
      }
    });
  }

  async getRenderPipeline(pass, translatedShader, shaderSources = {}) {
    const legacyCode = typeof translatedShader === 'string' ? translatedShader : translatedShader?.code;
    const vertexCode = translatedShader?.vertex?.code ?? legacyCode;
    const fragmentCode = translatedShader?.fragment?.code ?? legacyCode;
    const cacheKey = `${pass.id}:${hashString(vertexCode)}:${hashString(fragmentCode)}:${this.format}`;
    const cached = this.renderPipelineCache.get(cacheKey);
    if (cached) return cached;

    const pipelinePromise = this.createRenderPipeline(pass, translatedShader, shaderSources);
    this.renderPipelineCache.set(cacheKey, pipelinePromise);
    try {
      return await pipelinePromise;
    } catch (error) {
      this.renderPipelineCache.delete(cacheKey);
      throw error;
    }
  }

  async createRenderPipeline(pass, translatedShader, shaderSources = {}) {
    const legacyCode = typeof translatedShader === 'string' ? translatedShader : translatedShader?.code;
    const legacyLineMap = typeof translatedShader === 'string' ? [] : translatedShader?.lineMap;
    const vertexShader = translatedShader?.vertex ?? {
      code: legacyCode,
      lineMap: legacyLineMap,
      entryPoint: 'main'
    };
    const fragmentShader = translatedShader?.fragment ?? {
      code: legacyCode,
      lineMap: legacyLineMap,
      entryPoint: 'main'
    };
    const label = `preview render pass ${pass.id}`;
    const vertexModule = this.device.createShaderModule({
      label: `${label} vertex WGSL`,
      code: vertexShader.code
    });
    const fragmentModule = this.device.createShaderModule({
      label: `${label} fragment WGSL`,
      code: fragmentShader.code
    });
    const vertexCompilationMessages = await getShaderModuleCompilationMessages(vertexModule);
    const fragmentCompilationMessages = await getShaderModuleCompilationMessages(fragmentModule);
    const compilationMessages = [...vertexCompilationMessages, ...fragmentCompilationMessages];
    const errorMessages = compilationMessages.filter((message) => message.type === 'error');
    if (errorMessages.length > 0) {
      throw createWebGpuPipelineError(pass, 'WGSL shader module compilation failed.', {
        shaderSources,
        messages: errorMessages,
        generatedWgsl: fragmentShader.code,
        lineMap: fragmentShader.lineMap
      });
    }

    const bindGroupLayouts = buildRenderBindGroupLayouts(this.device, pass, label);
    const layout = this.device.createPipelineLayout({
      label: `${label} pipeline layout`,
      bindGroupLayouts
    });

    const descriptor = {
      label,
      layout,
      vertex: {
        module: vertexModule,
        entryPoint: 'main',
        buffers: buildRenderVertexBufferLayouts(pass)
      },
      fragment: {
        module: fragmentModule,
        entryPoint: 'main',
        targets: [{ format: this.format }]
      },
      primitive: { topology: 'triangle-list' }
    };

    let scopedError = null;
    let scopePushed = false;
    if (ENABLE_WEBGPU_ERROR_SCOPES && typeof this.device.pushErrorScope === 'function') {
      this.device.pushErrorScope('validation');
      scopePushed = true;
    }
    try {
      const pipeline = typeof this.device.createRenderPipelineAsync === 'function'
        ? await this.device.createRenderPipelineAsync(descriptor)
        : this.device.createRenderPipeline(descriptor);
      pipeline.bindGroupLayouts = bindGroupLayouts;
      return pipeline;
    } catch (error) {
      throw createWebGpuPipelineError(pass, 'WebGPU render pipeline creation failed.', {
        shaderSources,
        messages: compilationMessages,
        error,
        generatedWgsl: fragmentShader.code,
        lineMap: fragmentShader.lineMap
      });
    } finally {
      if (scopePushed && typeof this.device.popErrorScope === 'function') {
        scopedError = await this.device.popErrorScope();
      }
      if (scopedError) {
        throw createWebGpuPipelineError(pass, 'WebGPU render pipeline validation failed.', {
          shaderSources,
          messages: compilationMessages,
          error: scopedError,
          generatedWgsl: fragmentShader.code,
          lineMap: fragmentShader.lineMap
        });
      }
    }
  }

  getRenderOutputView(output, profile = null, label = 'renderTarget') {
    if (output instanceof OutputImage) {
      return this.context.getCurrentTexture().createView();
    }
    return this.getRenderTargetTexture(output, profile, label).createView();
  }

  getRenderTargetTexture(resource, profile = null, label = 'renderTarget') {
    const cached = this.resourceCache.get(resource);
    const usage = GPUTextureUsage.RENDER_ATTACHMENT
      | GPUTextureUsage.TEXTURE_BINDING
      | GPUTextureUsage.COPY_SRC
      | GPUTextureUsage.COPY_DST;
    const canReuseTexture = cached?.texture
      && cached.width === resource.width
      && cached.height === resource.height
      && (cached.usage & usage) === usage;

    if (canReuseTexture) {
      cached.rendered = true;
      cached.dirty = false;
      return cached.texture;
    }

    if (cached?.buffer) cached.buffer.destroy();
    if (cached?.texture) cached.texture.destroy();

    const texture = timeSection(profile, `${label}:createTexture`, () => this.device.createTexture({
      size: { width: resource.width, height: resource.height },
      format: this.format,
      usage
    }));
    this.resourceCache.set(resource, {
      texture,
      width: resource.width,
      height: resource.height,
      usage,
      rendered: true,
      dirty: false
    });
    return texture;
  }

  getCachedGpuBuffer(resource, usage, initialData = null) {
    const cached = this.resourceCache.get(resource);
    if (cached && (cached.usage & usage) === usage) {
      return cached.buffer;
    }

    if (cached?.buffer) {
      cached.buffer.destroy();
    }

    const byteLength = initialData?.byteLength ?? resource?.values?.byteLength ?? 0;
    const buffer = createGpuBuffer(this.device, byteLength, usage);
    if (initialData && initialData.byteLength > 0) {
      this.device.queue.writeBuffer(buffer, 0, initialData);
    }
    this.resourceCache.set(resource, { buffer, usage });
    return buffer;
  }

  getCachedTexture(resource, profile = null, label = 'texture') {
    const cached = this.resourceCache.get(resource);
    const canReuseTexture = cached?.texture
      && cached.width === resource.width
      && cached.height === resource.height;

    if (canReuseTexture) {
      if (cached.rendered && !cached.dirty) {
        return cached.texture;
      }
      if (resource.externalTextureSource) {
        uploadGpuTextureResource(this.device, cached.texture, resource, profile, label);
      }
      return cached.texture;
    }

    if (cached?.buffer) cached.buffer.destroy();
    if (cached?.texture) cached.texture.destroy();

    const textureUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;
    const texture = timeSection(profile, `${label}:createTexture`, () => this.device.createTexture({
      size: { width: resource.width, height: resource.height },
      format: 'rgba8unorm',
      usage: textureUsage
    }));
    uploadGpuTextureResource(this.device, texture, resource, profile, label);
    this.resourceCache.set(resource, {
      texture,
      width: resource.width,
      height: resource.height,
      usage: textureUsage,
      rendered: false,
      dirty: false
    });
    return texture;
  }

  getDefaultSampler() {
    if (!this.defaultSampler) {
      this.defaultSampler = this.device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge'
      });
    }
    return this.defaultSampler;
  }
}

async function getShaderModuleCompilationMessages(module) {
  if (typeof module.getCompilationInfo !== 'function') return [];
  try {
    const info = await module.getCompilationInfo();
    return Array.from(info?.messages ?? []).map((message) => ({
      type: message.type || 'info',
      message: message.message || String(message),
      lineNum: message.lineNum ?? 0,
      linePos: message.linePos ?? 0,
      offset: message.offset ?? 0,
      length: message.length ?? 0
    }));
  } catch (error) {
    return [{
      type: 'error',
      message: `Unable to read shader compilation info: ${error?.message || error}`,
      lineNum: 0,
      linePos: 0,
      offset: 0,
      length: 0
    }];
  }
}

function createWebGpuPipelineError(pass, summary, {
  shaderSources = {},
  messages = [],
  error = null,
  generatedWgsl = '',
  lineMap = []
} = {}) {
  const details = [];
  const sourceLabel = [
    shaderSources.wgslPath ? `wgsl=${shaderSources.wgslPath}` : '',
    shaderSources.vertexPath ? `vertex=${shaderSources.vertexPath}` : '',
    shaderSources.fragmentPath ? `fragment=${shaderSources.fragmentPath}` : ''
  ].filter(Boolean).join(', ');
  details.push(`Pass "${pass.id}": ${summary}`);
  if (sourceLabel) details.push(`Source: ${sourceLabel}`);

  const formattedMessages = messages
    .filter((message) => message.message)
    .map((message) => formatGpuCompilationMessage(message, lineMap));
  if (formattedMessages.length > 0) {
    details.push('Shader diagnostics:');
    details.push(...formattedMessages.map((message) => `  ${message}`));
  }

  const errorMessage = error?.message || (error ? String(error) : '');
  const mappedErrorMessages = formatRawWebGpuErrorMessage(errorMessage, lineMap);
  if (mappedErrorMessages.length > 0) {
    details.push('Mapped WebGPU error:');
    details.push(...mappedErrorMessages.map((message) => `  ${message}`));
  }
  if (errorMessage && !formattedMessages.some((message) => message.includes(errorMessage))) {
    details.push('WebGPU error:');
    details.push(`  ${errorMessage}`);
  }

  return new Error(details.join('\n'));
}

function formatRawWebGpuErrorMessage(errorMessage, lineMap = []) {
  if (!errorMessage || !Array.isArray(lineMap)) return [];

  const results = [];
  const seen = new Set();
  const pattern = /\bwgsl:(\d+):(\d+)\b/g;
  for (const match of errorMessage.matchAll(pattern)) {
    const lineNum = Number(match[1]);
    const linePos = Number(match[2]);
    const key = `${lineNum}:${linePos}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sourceLocation = lineMap[lineNum - 1];
    if (!sourceLocation) continue;

    results.push(`${sourceLocation.path}:${sourceLocation.line}:${linePos} (generated WGSL ${lineNum}:${linePos})`);
  }

  return results;
}

function formatGpuCompilationMessage(message, lineMap = []) {
  const sourceLocation = lineMap?.[message.lineNum - 1];
  const location = sourceLocation
    ? `${sourceLocation.path}:${sourceLocation.line}:${message.linePos || 1} (generated WGSL ${message.lineNum}:${message.linePos || 1})`
    : message.lineNum > 0
      ? `generated WGSL ${message.lineNum}:${message.linePos || 1}`
      : 'generated WGSL';
  return `[${message.type}] ${location}: ${formatGpuCompilationMessageText(message.message)}`;
}

function formatGpuCompilationMessageText(message) {
  const lines = String(message ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstLine = lines[0] ?? '';
  const parsingPrefix = /^Shader\s+'[^']+'\s+parsing error:\s*/;
  return firstLine.replace(parsingPrefix, '') || firstLine;
}

function buildComputeBindGroupLayouts(device, pass, label) {
  const bindingsBySet = groupBindingsBySet(pass.bindings ?? []);
  const maxSet = getMaxBindingSet(pass.bindings ?? []);
  const layouts = [];
  for (let set = 0; set <= maxSet; set += 1) {
    layouts.push(device.createBindGroupLayout({
      label: `${label} bind group ${set} layout`,
      entries: buildComputeBindGroupLayoutEntries(bindingsBySet.get(set) ?? [])
    }));
  }
  return layouts;
}

function buildComputeBindGroupLayoutEntries(bindings) {
  return bindings.map((binding) => {
    const entry = {
      binding: binding.binding,
      visibility: GPUShaderStage.COMPUTE
    };
    if (binding.type === 'sampledImage') {
      return [
        {
          ...entry,
          texture: {
            sampleType: 'float',
            viewDimension: '2d',
            multisampled: false
          }
        },
        {
          binding: binding.samplerBinding ?? binding.binding + 1,
          visibility: GPUShaderStage.COMPUTE,
          sampler: { type: 'filtering' }
        }
      ];
    }
    if (binding.type === 'buffer') {
      entry.buffer = { type: binding.access === 'read' ? 'read-only-storage' : 'storage' };
    } else if (binding.type === 'uniformBlock' || binding.type === 'uniform') {
      entry.buffer = { type: 'uniform' };
    } else {
      entry.buffer = { type: 'uniform' };
    }
    return entry;
  }).flat();
}

function buildRenderBindGroupLayouts(device, pass, label) {
  const bindingsBySet = groupBindingsBySet(pass.bindings ?? []);
  const maxSet = getMaxBindingSet(pass.bindings ?? []);
  const layouts = [];
  for (let set = 0; set <= maxSet; set += 1) {
    layouts.push(device.createBindGroupLayout({
      label: `${label} bind group ${set} layout`,
      entries: buildRenderBindGroupLayoutEntries(bindingsBySet.get(set) ?? [])
    }));
  }
  return layouts;
}

function buildRenderBindGroupLayoutEntries(bindings) {
  return bindings.map((binding) => {
    const entry = {
      binding: binding.binding,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
    };
    if (binding.type === 'sampledImage') {
      return [
        {
          ...entry,
          texture: {
            sampleType: 'float',
            viewDimension: '2d',
            multisampled: false
          }
        },
        {
          binding: binding.samplerBinding ?? binding.binding + 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' }
        }
      ];
    } else if (binding.type === 'buffer') {
      entry.buffer = { type: 'read-only-storage' };
    } else if (binding.type === 'uniformBlock' || binding.type === 'uniform') {
      entry.buffer = { type: 'uniform' };
    } else {
      entry.buffer = { type: 'uniform' };
    }
    return entry;
  }).flat();
}

function groupBindingsBySet(bindings) {
  const groups = new Map();
  for (const binding of bindings) {
    const set = getBindingSet(binding);
    if (!groups.has(set)) groups.set(set, []);
    groups.get(set).push(binding);
  }
  return groups;
}

function getMaxBindingSet(bindings) {
  let maxSet = -1;
  for (const binding of bindings) {
    maxSet = Math.max(maxSet, getBindingSet(binding));
  }
  return maxSet;
}

function getBindingSet(binding) {
  const set = Number(binding?.set ?? 0);
  if (!Number.isInteger(set) || set < 0) {
    throw new Error(`Invalid bind group set for binding "${binding?.name ?? '<unknown>'}".`);
  }
  return set;
}

function addGpuResourceEntry(groups, binding, entry) {
  const set = getBindingSet(binding);
  if (!groups.has(set)) groups.set(set, []);
  groups.get(set).push(entry);
}

function createGpuBindGroupsFromPipeline(device, pipeline, groups) {
  return Array.from(groups.entries())
    .sort(([left], [right]) => left - right)
    .map(([set, entries]) => ({
      set,
      bindGroup: device.createBindGroup({
        layout: pipeline.getBindGroupLayout(set),
        entries
      })
    }));
}

function createGpuBindGroupsFromLayouts(device, layouts, groups) {
  return Array.from(groups.entries())
    .sort(([left], [right]) => left - right)
    .map(([set, entries]) => {
      const layout = layouts[set];
      if (!layout) {
        throw new Error(`Missing WebGPU bind group layout for set ${set}.`);
      }
      return {
        set,
        bindGroup: device.createBindGroup({
          layout,
          entries
        })
      };
    });
}

function buildRenderVertexBufferLayouts(pass) {
  const inputs = pass.vertexInput ?? [];
  if (inputs.length === 0) return [];
  if (inputs.length !== 1 || inputs[0]?.type !== 'vec2') {
    throw new Error(`Unsupported render vertex input layout for pass "${pass.id}".`);
  }
  return [{
    arrayStride: 2 * Float32Array.BYTES_PER_ELEMENT,
    stepMode: 'vertex',
    attributes: [{
      shaderLocation: Number(inputs[0].location ?? 0),
      offset: 0,
      format: 'float32x2'
    }]
  }];
}

function createGpuBuffer(device, size, usage) {
  return device.createBuffer({
    size: alignTo(Number(size), 4),
    usage
  });
}

function createFullscreenTriangleGpuBuffer(device) {
  const vertices = new Float32Array([
    -1, -1,
    3, -1,
    -1, 3
  ]);
  const buffer = device.createBuffer({
    size: vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
  });
  device.queue.writeBuffer(buffer, 0, vertices);
  return buffer;
}

function uploadGpuTextureResource(device, texture, resource, profile, label) {
  if (resource?.externalTextureSource && typeof device.queue.copyExternalImageToTexture === 'function') {
    timeSection(profile, `${label}:copyExternalImage`, () => {
      device.queue.copyExternalImageToTexture(
        {
          source: resource.externalTextureSource,
          flipY: Boolean(resource.textureFlipY)
        },
        { texture },
        { width: resource.width, height: resource.height }
      );
    });
    return;
  }

  if (!(resource?.pixels instanceof Uint8ClampedArray) && !(resource?.pixels instanceof Uint8Array)) {
    throw new Error(`Preview texture "${label}" is missing uploadable pixels.`);
  }

  timeSection(profile, `${label}:writeTexture`, () => {
    device.queue.writeTexture(
      { texture },
      resource.pixels,
      { bytesPerRow: resource.width * 4, rowsPerImage: resource.height },
      { width: resource.width, height: resource.height }
    );
  });
}

function alignTo(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function packImageSurfacePixels(image) {
  const source = image?.pixels;
  if (!(source instanceof Uint8ClampedArray) && !(source instanceof Uint8Array)) {
    throw new Error('Preview image pixels must be an RGBA byte array.');
  }

  const pixelCount = Math.floor(source.length / 4);
  const packed = new Uint32Array(pixelCount);
  const width = Math.max(Number(image?.width ?? 0), 0);
  const height = Math.max(Number(image?.height ?? 0), 0);
  for (let index = 0; index < pixelCount; index += 1) {
    const x = width > 0 ? index % width : index;
    const y = width > 0 ? Math.floor(index / width) : 0;
    const sourceY = height > 0 ? height - 1 - y : y;
    const sourceIndex = width > 0 ? sourceY * width + x : index;
    const offset = sourceIndex * 4;
    packed[index] = (
      (source[offset] ?? 0)
      | ((source[offset + 1] ?? 0) << 8)
      | ((source[offset + 2] ?? 0) << 16)
      | ((source[offset + 3] ?? 255) << 24)
    ) >>> 0;
  }
  return packed;
}

function buildComputeGpuResources(runtime, pass, bindings, profile = null) {
  const device = runtime.device;
  const groups = new Map();
  const ownedBuffers = [];

  for (const binding of pass.bindings ?? []) {
    const value = bindings?.[binding.name];
    if (!value) throw new Error(`Missing compute binding "${binding.name}".`);

    if (binding.type === 'sampledImage') {
      const texture = runtime.getCachedTexture(value, profile, `pass:${pass.id}:${binding.name}`);
      addGpuResourceEntry(groups, binding, { binding: binding.binding, resource: texture.createView() });
      addGpuResourceEntry(groups, binding, {
        binding: binding.samplerBinding ?? binding.binding + 1,
        resource: runtime.getDefaultSampler()
      });
      continue;
    }

    if (binding.type === 'buffer') {
      const buffer = runtime.getCachedGpuBuffer(
        value,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        value.values
      );
      addGpuResourceEntry(groups, binding, { binding: binding.binding, resource: { buffer } });
      continue;
    }

    if (binding.type === 'uniformBlock') {
      const bytes = packUniformBlock(binding, value);
      const buffer = createGpuBuffer(device, Math.max(bytes.byteLength, 16), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(buffer, 0, bytes);
      ownedBuffers.push(buffer);
      addGpuResourceEntry(groups, binding, { binding: binding.binding, resource: { buffer } });
      continue;
    }

    throw new Error(`Unsupported compute binding type "${binding.type}".`);
  }

  return {
    groups,
    destroy() {
      for (const buffer of ownedBuffers) {
        buffer.destroy();
      }
    }
  };
}

function packUniformBlock(binding, value) {
  const byteLength = alignTo(Math.max(...(binding.fields ?? []).map((field) => (field.offset ?? 0) + (field.size ?? 4)), 4), 16);
  const bytes = new ArrayBuffer(byteLength);
  const view = new DataView(bytes);
  for (const field of binding.fields ?? []) {
    const offset = field.offset ?? 0;
    const fieldValue = value?.[field.name] ?? 0;
    if (field.type === 'float') {
      view.setFloat32(offset, Number(fieldValue), true);
    } else if (field.type === 'bool') {
      view.setUint32(offset, fieldValue ? 1 : 0, true);
    } else if (field.type === 'uint') {
      view.setUint32(offset, Number(fieldValue), true);
    } else if (field.type === 'int') {
      view.setInt32(offset, Number(fieldValue), true);
    } else if (field.type === 'vec2') {
      writeFloat32Array(view, offset, fieldValue, 2);
    } else if (field.type === 'vec3') {
      writeFloat32Array(view, offset, fieldValue, 3);
    } else if (field.type === 'vec4') {
      writeFloat32Array(view, offset, fieldValue, 4);
    } else if (field.type === 'ivec2') {
      writeInt32Array(view, offset, fieldValue, 2);
    } else if (field.type === 'ivec3') {
      writeInt32Array(view, offset, fieldValue, 3);
    } else if (field.type === 'ivec4') {
      writeInt32Array(view, offset, fieldValue, 4);
    } else if (field.type === 'uvec2') {
      writeUint32Array(view, offset, fieldValue, 2);
    } else if (field.type === 'uvec3') {
      writeUint32Array(view, offset, fieldValue, 3);
    } else if (field.type === 'uvec4') {
      writeUint32Array(view, offset, fieldValue, 4);
    } else if (field.type === 'mat2') {
      writeFloat32Std140Matrix(view, offset, fieldValue, 2, 2, 1);
    } else if (field.type === 'mat3') {
      writeFloat32Std140Matrix(view, offset, fieldValue, 3, 3, 1);
    } else if (field.type === 'mat4') {
      writeFloat32Std140Matrix(view, offset, fieldValue, 4, 4, 1);
    } else {
      throw new Error(`Unsupported uniform field type "${field.type}".`);
    }
  }
  return new Uint8Array(bytes);
}

function writeFloat32Array(view, offset, value, length, fallback = 0) {
  const values = normalizeUniformArray(value, length, fallback);
  for (let index = 0; index < length; index += 1) {
    view.setFloat32(offset + index * 4, Number(values[index] ?? fallback), true);
  }
}

function writeInt32Array(view, offset, value, length, fallback = 0) {
  const values = normalizeUniformArray(value, length, fallback);
  for (let index = 0; index < length; index += 1) {
    view.setInt32(offset + index * 4, Number(values[index] ?? fallback), true);
  }
}

function writeUint32Array(view, offset, value, length, fallback = 0) {
  const values = normalizeUniformArray(value, length, fallback);
  for (let index = 0; index < length; index += 1) {
    view.setUint32(offset + index * 4, Number(values[index] ?? fallback), true);
  }
}

function writeFloat32Std140Matrix(view, offset, value, columns, rows, fallback = 0) {
  const values = normalizeUniformArray(value, columns * rows, fallback);
  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < rows; row += 1) {
      const valueIndex = column * rows + row;
      view.setFloat32(offset + column * 16 + row * 4, Number(values[valueIndex] ?? fallback), true);
    }
  }
}

function calculateWorkgroups(dispatch, localSize) {
  return {
    x: Math.ceil(Number(dispatch?.[0] ?? 1) / Number(localSize?.x ?? 1)),
    y: Math.ceil(Number(dispatch?.[1] ?? 1) / Number(localSize?.y ?? 1)),
    z: Math.ceil(Number(dispatch?.[2] ?? 1) / Number(localSize?.z ?? 1))
  };
}

function getComputePassShaderSource(workspace, pass, sourcePass) {
  const shaderPath = sourcePass?.computeShader ?? sourcePathFromCompiledStage(pass.stages?.compute);
  const source = workspace.getFile(shaderPath)?.content;
  return typeof source === 'string' ? source : null;
}

function translateComputeShaderForWebGpu(source, pass, bindings) {
  const declarations = buildComputeBindingDeclarations(pass);
  const entryHeader = buildComputeEntryHeader(pass);
  const sampledImages = (pass.bindings ?? []).filter((binding) => binding.type === 'sampledImage');
  const bufferMembers = new Map(
    (pass.bindings ?? [])
      .filter((binding) => binding.type === 'buffer')
      .map((binding) => [binding.name, findBufferArrayMember(source, binding.name) ?? 'values'])
  );

  let translated = stripVersion(source);
  translated = translateDefines(translated);
  translated = removeComputeBindingDeclarations(translated, pass);
  translated = translateUniformBoolFieldReferences(translated, pass);
  translated = translateTextureFetches(translated, sampledImages, bindings);
  translated = translateBufferAccess(translated, pass, bufferMembers);
  const splitCompute = splitShaderMain(translated);
  const translatedHelpers = translateComputeSyntax(splitCompute.helpers);
  const translatedBody = translateComputeBodySyntax(splitCompute.mainBody);

  return {
    code: [
      declarations,
      translatedHelpers,
      entryHeader,
      translatedBody,
      '}'
    ].join('\n')
  };
}

function buildRenderGpuResources(runtime, pass, bindings, profile = null) {
  const device = runtime.device;
  const groups = new Map();
  const ownedBuffers = [];

  for (const binding of pass.bindings ?? []) {
    const value = bindings?.[binding.name];
    if (!value) throw new Error(`Missing render binding "${binding.name}".`);

    if (binding.type === 'sampledImage') {
      const texture = runtime.getCachedTexture(value, profile, `pass:${pass.id}:${binding.name}`);
      addGpuResourceEntry(groups, binding, { binding: binding.binding, resource: texture.createView() });
      addGpuResourceEntry(groups, binding, {
        binding: binding.samplerBinding ?? binding.binding + 1,
        resource: runtime.getDefaultSampler()
      });
      continue;
    }

    if (binding.type === 'buffer') {
      const buffer = runtime.getCachedGpuBuffer(value, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, value.values);
      addGpuResourceEntry(groups, binding, { binding: binding.binding, resource: { buffer } });
      continue;
    }

    if (binding.type === 'uniformBlock') {
      const bytes = packUniformBlock(binding, value);
      const buffer = createGpuBuffer(device, Math.max(bytes.byteLength, 16), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(buffer, 0, bytes);
      ownedBuffers.push(buffer);
      addGpuResourceEntry(groups, binding, { binding: binding.binding, resource: { buffer } });
      continue;
    }
  }

  return {
    groups,
    destroy() {
      for (const buffer of ownedBuffers) buffer.destroy();
    }
  };
}

function describeRenderOutput(output) {
  return {
    kind: output instanceof OutputImage ? 'output' : output instanceof ImageSurface ? 'imageSurface' : typeof output,
    size: `${output?.width ?? 0}x${output?.height ?? 0}`,
    hasCanvas: Boolean(output?.canvas),
    hasPixels: Boolean(output?.pixels),
    hasExternalTextureSource: Boolean(output?.externalTextureSource)
  };
}

function normalizeClearColor(color) {
  if (Array.isArray(color)) {
    return {
      r: normalizeColorComponent(color[0], 'r'),
      g: normalizeColorComponent(color[1], 'g'),
      b: normalizeColorComponent(color[2], 'b'),
      a: normalizeColorComponent(color[3] ?? 1, 'a')
    };
  }

  if (color && typeof color === 'object') {
    return {
      r: normalizeColorComponent(color.r ?? color.red, 'r'),
      g: normalizeColorComponent(color.g ?? color.green, 'g'),
      b: normalizeColorComponent(color.b ?? color.blue, 'b'),
      a: normalizeColorComponent(color.a ?? color.alpha ?? 1, 'a')
    };
  }

  throw new Error('clearOutput color must be { r, g, b, a } or { r, g, b }.');
}

function normalizeColorComponent(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`clearOutput color component "${label}" must be a finite number.`);
  }
  return Math.min(1, Math.max(0, number));
}

function summarizeRenderBindings(pass, bindings) {
  return (pass.bindings ?? []).map((binding) => {
    const value = bindings?.[binding.name];
    const summary = {
      name: binding.name,
      type: binding.type,
      binding: binding.binding,
      present: Boolean(value)
    };
    if (binding.type === 'sampledImage') {
      summary.resource = describeRenderOutput(value);
    } else if (binding.type === 'uniformBlock') {
      summary.fields = Object.fromEntries(
        (binding.fields ?? []).map((field) => [field.name, value?.[field.name]])
      );
    } else if (binding.type === 'buffer') {
      summary.elementType = value?.elementType;
      summary.shape = value?.shape;
      summary.count = value?.values?.length ?? 0;
    }
    return summary;
  });
}

function translateRenderShadersForWebGpu(shaderSources, pass, bindings) {
  const sampledImages = (pass.bindings ?? []).filter((binding) => binding.type === 'sampledImage');
  const bufferMembers = new Map(
    (pass.bindings ?? [])
      .filter((binding) => binding.type === 'buffer')
      .map((binding) => [binding.name, findBufferArrayMember(shaderSources.fragment, binding.name) ?? 'values'])
  );

  const vertex = stripVersion(shaderSources.vertex);
  const fragmentInputs = parseShaderIoDeclarations(shaderSources.fragment, 'in');
  const vertexOutputs = parseShaderIoDeclarations(shaderSources.vertex, 'out');
  const varyings = matchRenderVaryings(vertexOutputs, fragmentInputs);
  const vertexBody = translateRenderVertexBody(createMappedSource(vertex, shaderSources.vertexLineMap), varyings);

  let fragment = createMappedSource(stripVersion(shaderSources.fragment), shaderSources.fragmentLineMap);
  fragment = mapSourceCode(fragment, translateRenderDefines);
  fragment = removeRenderBindingDeclarationsMapped(fragment, pass);
  fragment = mapSourceCode(fragment, (code) => translateFragmentInputReferences(code, varyings));
  fragment = mapSourceCode(fragment, (code) => translateUniformBoolFieldReferences(code, pass));
  fragment = translateRenderTextureFetchesMapped(fragment, sampledImages, bindings);
  fragment = mapSourceCode(fragment, (code) => translateBufferAccess(code, pass, bufferMembers));
  const splitFragment = splitRenderMainMapped(fragment);
  const translatedHelpers = mapSourceCode(splitFragment.helpers, translateRenderSyntax);
  const translatedBody = mapSourceCode(splitFragment.mainBody, translateRenderBodySyntax);

  const declarations = buildRenderBindingDeclarations(pass, varyings, vertexBody, translatedHelpers, translatedBody);
  return {
    code: declarations.code,
    lineMap: declarations.lineMap
  };
}

function buildRenderBindingDeclarations(pass, varyings, vertexBody = '', helperCode = '', bodyCode = '') {
  const builder = createMappedCodeBuilder();
  builder.addGenerated('struct VertexOut {');
  builder.addGenerated('  @builtin(position) position: vec4<f32>,');
  for (const varying of varyings) {
    builder.addGenerated(`  @location(${varying.location}) ${varying.fragmentName}: ${toWgslType(varying.type)},`);
  }
  builder.addGenerated([
    '};',
    '@vertex',
    'fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {',
    '  var positions = array<vec2<f32>, 3>(',
    '    vec2<f32>(-1.0, -1.0),',
    '    vec2<f32>(3.0, -1.0),',
    '    vec2<f32>(-1.0, 3.0)',
    '  );',
    '  var out: VertexOut;',
    '  let pos = positions[vertexIndex];',
    ...varyings.map((varying) => `  var ${varying.vertexName}: ${toWgslType(varying.type)};`),
    '  out.position = vec4<f32>(pos.x, -pos.y, 0.0, 1.0);',
    ...buildDefaultVaryingInitializers(varyings)
  ]);
  builder.addMapped(vertexBody, '  ');
  builder.addGenerated([
    ...varyings.map((varying) => `  out.${varying.fragmentName} = ${varying.vertexName};`),
    '  return out;',
    '}',
    ''
  ]);

  for (const binding of pass.bindings ?? []) {
    const prefix = `@group(${binding.set ?? 0}) @binding(${binding.binding})`;
    if (binding.type === 'sampledImage') {
      builder.addGenerated(`${prefix} var ${binding.name}: texture_2d<f32>;`);
      continue;
    }
    if (binding.type === 'buffer') {
      const elementType = binding.elementType === 'uint' ? 'u32' : 'f32';
      builder.addGenerated(`${prefix} var<storage, read> ${binding.name}: array<${elementType}>;`);
      continue;
    }
    if (binding.type === 'uniformBlock') {
      builder.addGenerated(`struct ${binding.name}_Block {`);
      for (const field of binding.fields ?? []) {
        builder.addGenerated(`  ${formatWgslUniformBlockField(field)}`);
      }
      builder.addGenerated('};');
      builder.addGenerated(`${prefix} var<uniform> ${binding.name}: ${binding.name}_Block;`);
    }
  }

  if (helperCode.code.trim()) {
    builder.addMapped(trimMappedSource(helperCode));
  }
  builder.addGenerated('@fragment');
  builder.addGenerated('fn fragmentMain(in: VertexOut) -> @location(0) vec4<f32> {');
  if (bodyCode.code.trim()) {
    builder.addMapped(trimMappedSource(bodyCode));
  }
  builder.addGenerated('}');
  return builder.build();
}

function createMappedSource(code, lineMap = []) {
  return {
    code: String(code ?? ''),
    lineMap: normalizeLineMap(String(code ?? ''), lineMap)
  };
}

function normalizeLineMap(code, lineMap = []) {
  const lineCount = splitLines(code).length;
  return Array.from({ length: lineCount }, (_, index) => lineMap[index] ?? null);
}

function mapSourceCode(source, transform) {
  const nextCode = transform(source.code);
  const oldLineCount = splitLines(source.code).length;
  const nextLineCount = splitLines(nextCode).length;
  return {
    code: nextCode,
    lineMap: nextLineCount === oldLineCount
      ? source.lineMap
      : normalizeLineMap(nextCode, source.lineMap)
  };
}

function createMappedCodeBuilder() {
  const lines = [];
  const lineMap = [];
  return {
    addGenerated(value) {
      for (const line of Array.isArray(value) ? value : splitLines(String(value))) {
        lines.push(line);
        lineMap.push(null);
      }
    },
    addMapped(source, indent = '') {
      const sourceLines = splitLines(source.code);
      for (let index = 0; index < sourceLines.length; index += 1) {
        lines.push(`${indent}${sourceLines[index]}`);
        lineMap.push(source.lineMap[index] ?? null);
      }
    },
    build() {
      return {
        code: lines.join('\n'),
        lineMap
      };
    }
  };
}

function trimMappedSource(source) {
  const lines = splitLines(source.code);
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return {
    code: lines.slice(start, end).join('\n'),
    lineMap: source.lineMap.slice(start, end)
  };
}

function removeRenderBindingDeclarationsMapped(source, pass) {
  let result = mapSourceCode(source, (code) => code
    .replace(
      /\blayout\s*\(\s*location\s*=\s*\d+\s*\)\s*in\s+(?:float|uint|int|vec2|vec3|vec4|ivec2|ivec3|ivec4)\s+[A-Za-z_][A-Za-z0-9_]*\s*;\s*/g,
      blankPreservingLineCount
    )
    .replace(
      /\blayout\s*\(\s*location\s*=\s*\d+\s*\)\s*out\s+vec4\s+outColor\s*;\s*/g,
      blankPreservingLineCount
    ));

  for (const binding of pass.bindings ?? []) {
    if (binding.type === 'sampledImage') {
      result = mapSourceCode(result, (code) => code.replace(
        new RegExp(String.raw`layout\s*\([^)]*binding\s*=\s*${binding.binding}[^)]*\)\s*uniform\s+sampler2D\s+${binding.name}\s*;\s*`, 'g'),
        blankPreservingLineCount
      ));
    }
    if (binding.type === 'buffer') {
      result = mapSourceCode(result, (code) => code.replace(
        new RegExp(String.raw`layout\s*\([^)]*\)\s*(?:readonly\s+)?buffer\s+[A-Za-z_][A-Za-z0-9_]*\s*\{[\s\S]*?\}\s*${binding.name}\s*;\s*`, 'g'),
        blankPreservingLineCount
      ));
    }
    if (binding.type === 'uniformBlock') {
      result = mapSourceCode(result, (code) => code.replace(
        new RegExp(String.raw`layout\s*\([^)]*binding\s*=\s*${binding.binding}[^)]*\)\s*uniform\s+[A-Za-z_][A-Za-z0-9_]*\s*\{[\s\S]*?\}\s*${binding.name}\s*;\s*`, 'g'),
        blankPreservingLineCount
      ));
    }
  }
  return result;
}

function blankPreservingLineCount(match) {
  return '\n'.repeat(countNewlines(match));
}

function countNewlines(value) {
  return (String(value).match(/\n/g) ?? []).length;
}

function removeRenderBindingDeclarations(source, pass) {
  let result = source
    .replace(/\blayout\s*\(\s*location\s*=\s*\d+\s*\)\s*in\s+(?:float|uint|int|vec2|vec3|vec4|ivec2|ivec3|ivec4)\s+[A-Za-z_][A-Za-z0-9_]*\s*;\s*/g, '')
    .replace(/\blayout\s*\(\s*location\s*=\s*\d+\s*\)\s*out\s+vec4\s+outColor\s*;\s*/g, '');

  for (const binding of pass.bindings ?? []) {
    if (binding.type === 'sampledImage') {
      result = result.replace(
        new RegExp(String.raw`layout\s*\([^)]*binding\s*=\s*${binding.binding}[^)]*\)\s*uniform\s+sampler2D\s+${binding.name}\s*;\s*`, 'g'),
        ''
      );
    }
    if (binding.type === 'buffer') {
      result = result.replace(
        new RegExp(String.raw`layout\s*\([^)]*\)\s*(?:readonly\s+)?buffer\s+[A-Za-z_][A-Za-z0-9_]*\s*\{[\s\S]*?\}\s*${binding.name}\s*;\s*`, 'g'),
        ''
      );
    }
    if (binding.type === 'uniformBlock') {
      result = result.replace(
        new RegExp(String.raw`layout\s*\([^)]*binding\s*=\s*${binding.binding}[^)]*\)\s*uniform\s+[A-Za-z_][A-Za-z0-9_]*\s*\{[\s\S]*?\}\s*${binding.name}\s*;\s*`, 'g'),
        ''
      );
    }
  }
  return result;
}

function parseShaderIoDeclarations(source, direction) {
  const declarations = [];
  const pattern = new RegExp(
    String.raw`\blayout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*${direction}\s+(float|uint|int|vec2|vec3|vec4|ivec2|ivec3|ivec4)\s+([A-Za-z_][A-Za-z0-9_]*)\s*;`,
    'g'
  );
  let match;
  while ((match = pattern.exec(String(source)))) {
    declarations.push({
      location: Number(match[1]),
      type: match[2],
      name: match[3]
    });
  }
  return declarations.sort((left, right) => left.location - right.location);
}

function matchRenderVaryings(vertexOutputs, fragmentInputs) {
  if (fragmentInputs.length === 0) {
    return [{ location: 0, type: 'vec2', vertexName: 'v_uv', fragmentName: 'v_uv' }];
  }

  return fragmentInputs.map((input) => {
    const output = vertexOutputs.find((candidate) => candidate.location === input.location)
      ?? vertexOutputs.find((candidate) => candidate.name === input.name)
      ?? input;
    return {
      location: input.location,
      type: input.type,
      vertexName: output.name,
      fragmentName: input.name
    };
  });
}

function translateRenderVertexBody(source, varyings) {
  const splitVertex = splitShaderMainMapped(source);
  let body = mapSourceCode(splitVertex.mainBody, (code) => code
    .replace(/\bgl_Position\s*=\s*[^;]+;\s*/g, (match) => blankPreservingLineCount(match))
    .replace(/\ba_position\b/g, 'pos')
    .replace(/\bpos\s*\*\s*0\.5\s*\+\s*0\.5\b/g, 'pos * 0.5 + vec2<f32>(0.5)'));
  for (const varying of varyings) {
    if (varying.vertexName !== varying.fragmentName) {
      body = mapSourceCode(body, (code) => code.replace(
        new RegExp(String.raw`\b${escapeRegExp(varying.fragmentName)}\b\s*=`, 'g'),
        `${varying.vertexName} =`
      ));
    }
  }
  return trimMappedSource(mapSourceCode(body, translateRenderSyntax));
}

function buildDefaultVaryingInitializers(varyings) {
  return varyings.map((varying) => `  ${varying.vertexName} = ${defaultWgslValue(varying.type)};`);
}

function translateFragmentInputReferences(source, varyings) {
  let result = source;
  for (const varying of varyings) {
    result = result.replace(
      new RegExp(String.raw`(?<!\.)\b${escapeRegExp(varying.fragmentName)}\b`, 'g'),
      `in.${varying.fragmentName}`
    );
  }
  return result;
}

function defaultWgslValue(type) {
  if (type === 'float') return '0.0';
  if (type === 'uint') return '0u';
  if (type === 'int') return '0';
  if (type === 'vec2') return 'vec2<f32>(0.0)';
  if (type === 'vec3') return 'vec3<f32>(0.0)';
  if (type === 'vec4') return 'vec4<f32>(0.0)';
  if (type === 'ivec2') return 'vec2<i32>(0)';
  if (type === 'ivec3') return 'vec3<i32>(0)';
  if (type === 'ivec4') return 'vec4<i32>(0)';
  if (type === 'uvec2') return 'vec2<u32>(0u)';
  if (type === 'uvec3') return 'vec3<u32>(0u)';
  if (type === 'uvec4') return 'vec4<u32>(0u)';
  return `${toWgslType(type)}()`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function translateRenderTextureFetches(source, sampledImages, bindings) {
  let result = source;
  for (const binding of sampledImages) {
    result = result.replace(
      new RegExp(String.raw`texture\s*\(\s*${binding.name}\s*,\s*([^)]+)\)`, 'g'),
      `sampleImage_${binding.name}($1)`
    );
    result = [
      `fn sampleImage_${binding.name}(uv: vec2<f32>) -> vec4<f32> {`,
      `  let dims = textureDimensions(${binding.name});`,
      '  let width = u32(max(dims.x, 1));',
      '  let height = u32(max(dims.y, 1));',
      '  let x = min(u32(clamp(uv.x, 0.0, 1.0) * f32(max(width - 1u, 1u))), max(width - 1u, 0u));',
      '  let y = min(u32(clamp(uv.y, 0.0, 1.0) * f32(max(height - 1u, 1u))), max(height - 1u, 0u));',
      `  return textureLoad(${binding.name}, vec2<i32>(i32(x), i32(y)), 0);`,
      '}',
      result
    ].join('\n');
  }
  return result;
}

function translateRenderTextureFetchesMapped(source, sampledImages, bindings) {
  let result = source;
  for (const binding of sampledImages) {
    result = mapSourceCode(result, (code) => code.replace(
      new RegExp(String.raw`texture\s*\(\s*${binding.name}\s*,\s*([^)]+)\)`, 'g'),
      `sampleImage_${binding.name}($1)`
    ));
    const helperLines = [
      `fn sampleImage_${binding.name}(uv: vec2<f32>) -> vec4<f32> {`,
      `  let dims = textureDimensions(${binding.name});`,
      '  let width = u32(max(dims.x, 1));',
      '  let height = u32(max(dims.y, 1));',
      '  let x = min(u32(clamp(uv.x, 0.0, 1.0) * f32(max(width - 1u, 1u))), max(width - 1u, 0u));',
      '  let y = min(u32(clamp(uv.y, 0.0, 1.0) * f32(max(height - 1u, 1u))), max(height - 1u, 0u));',
      `  return textureLoad(${binding.name}, vec2<i32>(i32(x), i32(y)), 0);`,
      '}'
    ];
    result = {
      code: [...helperLines, result.code].join('\n'),
      lineMap: [...Array(helperLines.length).fill(null), ...result.lineMap]
    };
  }
  return result;
}

function splitRenderMain(source) {
  return splitShaderMain(source);
}

function splitRenderMainMapped(source) {
  return splitShaderMainMapped(source);
}

function splitShaderMain(source) {
  const mainMatch = /void\s+main\s*\(\s*\)\s*\{/.exec(source);
  if (!mainMatch) {
    return {
      helpers: source,
      mainBody: ''
    };
  }

  const bodyStart = mainMatch.index + mainMatch[0].length;
  let depth = 1;
  let cursor = bodyStart;
  while (cursor < source.length && depth > 0) {
    const char = source[cursor];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    cursor += 1;
  }

  const bodyEnd = Math.max(bodyStart, cursor - 1);
  return {
    helpers: `${source.slice(0, mainMatch.index)}${source.slice(cursor)}`.trim(),
    mainBody: source.slice(bodyStart, bodyEnd).trim()
  };
}

function splitShaderMainMapped(source) {
  const mainMatch = /void\s+main\s*\(\s*\)\s*\{/.exec(source.code);
  if (!mainMatch) {
    return {
      helpers: source,
      mainBody: createMappedSource('', [])
    };
  }

  const bodyStart = mainMatch.index + mainMatch[0].length;
  let depth = 1;
  let cursor = bodyStart;
  while (cursor < source.code.length && depth > 0) {
    const char = source.code[cursor];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    cursor += 1;
  }

  const bodyEnd = Math.max(bodyStart, cursor - 1);
  return {
    helpers: trimMappedSource(concatMappedSources([
      sliceMappedSource(source, 0, mainMatch.index),
      sliceMappedSource(source, cursor, source.code.length)
    ])),
    mainBody: trimMappedSource(sliceMappedSource(source, bodyStart, bodyEnd))
  };
}

function concatMappedSources(sources) {
  const nonEmptySources = sources.filter((source) => source.code);
  return {
    code: nonEmptySources.map((source) => source.code).join('\n'),
    lineMap: nonEmptySources.flatMap((source) => source.lineMap)
  };
}

function sliceMappedSource(source, start, end) {
  const prefix = source.code.slice(0, start);
  const slice = source.code.slice(start, end);
  const startLine = getLineIndexAtOffset(source.code, start);
  const lineCount = splitLines(slice).length;
  return {
    code: slice,
    lineMap: source.lineMap.slice(startLine, startLine + lineCount)
  };
}

function getLineIndexAtOffset(source, offset) {
  const safeOffset = Math.max(0, Math.min(Number(offset) || 0, String(source).length));
  const prefix = String(source).slice(0, safeOffset);
  const newlineCount = countNewlines(prefix);
  return safeOffset > 0 && String(source)[safeOffset - 1] !== '\n'
    ? newlineCount
    : Math.max(0, newlineCount);
}

function splitLines(value) {
  return String(value ?? '').split('\n');
}

function translateRenderSyntax(source) {
  return source
    .replace(/\b(bool|float|uint|int|vec2|vec3|vec4|ivec2|ivec3|ivec4|uvec2|uvec3|uvec4|mat2|mat3|mat4)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g, (_, type, name) => `var ${name}: ${toWgslType(type)} =`)
    .replace(/\b(bool|float|uint|int|vec2|vec3|vec4|ivec2|ivec3|ivec4|uvec2|uvec3|uvec4|mat2|mat3|mat4)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/g, (_, returnType, name, args) =>
      `fn ${name}(${translateFunctionArgs(args)}) -> ${toWgslType(returnType)} {`
    )
    .replace(/\bfloat\s*\(/g, 'f32(')
    .replace(/\buint\s*\(/g, 'u32(')
    .replace(/\bint\s*\(/g, 'i32(')
    .replace(/\bivec2\s*\(/g, 'vec2<i32>(')
    .replace(/\bivec3\s*\(/g, 'vec3<i32>(')
    .replace(/\bivec4\s*\(/g, 'vec4<i32>(')
    .replace(/\buvec2\s*\(/g, 'vec2<u32>(')
    .replace(/\buvec3\s*\(/g, 'vec3<u32>(')
    .replace(/\buvec4\s*\(/g, 'vec4<u32>(')
    .replace(/\bvec2\s*\(/g, 'vec2<f32>(')
    .replace(/\bvec3\s*\(/g, 'vec3<f32>(')
    .replace(/\bvec4\s*\(/g, 'vec4<f32>(')
    .replace(/\bmat2\s*\(/g, 'mat2x2<f32>(')
    .replace(/\bmat3\s*\(/g, 'mat3x3<f32>(')
    .replace(/\bmat4\s*\(/g, 'mat4x4<f32>(')
    .replace(
      /clamp\s*\(\s*(sourceColor\.rgb\s*\*\s*[A-Za-z_][A-Za-z0-9_]*)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)/g,
      'clamp($1, vec3<f32>($2), vec3<f32>($3))'
    )
    .replace(/\+\+([A-Za-z_][A-Za-z0-9_]*)/g, '$1 = $1 + 1')
    .replace(/for\s*\(\s*var\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(i32|u32)\s*=\s*([^;]+);\s*([^;]+);\s*\1\s*=\s*\1\s*\+\s*1\s*\)/g, 'for (var $1: $2 = $3; $4; $1 = $1 + 1)')
    .replace(/for\s*\(\s*int\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+);\s*([^;]+);\s*\+\+\1\s*\)/g, 'for (var $1: i32 = $2; $3; $1 = $1 + 1)')
    .replace(/for\s*\(\s*uint\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+);\s*([^;]+);\s*\+\+\1\s*\)/g, 'for (var $1: u32 = $2; $3; $1 = $1 + 1u)');
}

function translateRenderBodySyntax(source) {
  return translateRenderSyntax(source)
    .replace(/\boutColor\s*=\s*/g, 'return ');
}

function inferWgslReturnType(signature, source) {
  const match = /\b(bool|float|uint|int|vec2|vec3|vec4|ivec2|ivec3|ivec4|uvec2|uvec3|uvec4|mat2|mat3|mat4)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(signature);
  if (!match) return 'f32';
  return toWgslType(match[1]);
}

function buildComputeBindingDeclarations(pass) {
  const lines = [];
  for (const binding of pass.bindings ?? []) {
    const bindingPrefix = `@group(${binding.set ?? 0}) @binding(${binding.binding})`;
    if (binding.type === 'sampledImage') {
      lines.push(`${bindingPrefix} var ${binding.name}: texture_2d<f32>;`);
      continue;
    }

    if (binding.type === 'buffer') {
      const elementType = binding.elementType === 'uint' ? 'u32' : 'f32';
      const mode = binding.access === 'read' ? 'read' : 'read_write';
      const storageType = binding.access === 'readWrite' && binding.elementType === 'uint'
        ? `array<atomic<${elementType}>>`
        : `array<${elementType}>`;
      lines.push(`${bindingPrefix} var<storage, ${mode}> ${binding.name}: ${storageType};`);
      continue;
    }

    if (binding.type === 'uniformBlock') {
      lines.push(`struct ${binding.name}_Block {`);
      for (const field of binding.fields ?? []) {
        lines.push(`  ${formatWgslUniformBlockField(field)}`);
      }
      lines.push('};');
      lines.push(`${bindingPrefix} var<uniform> ${binding.name}: ${binding.name}_Block;`);
    }
  }

  return lines.join('\n');
}

function buildComputeEntryHeader(pass) {
  const localSize = pass.localSize ?? {};
  return [
    `@compute @workgroup_size(${localSize.x ?? 1}, ${localSize.y ?? 1}, ${localSize.z ?? 1})`,
    'fn main(',
    '  @builtin(global_invocation_id) global_id: vec3<u32>,',
    '  @builtin(local_invocation_index) local_index: u32',
    ') {'
  ].join('\n');
}

function translateDefines(source) {
  return source.replace(/^\s*#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(\d+)\s*$/gm, 'const $1: u32 = $2u;');
}

function translateRenderDefines(source) {
  return source.replace(/^\s*#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(\d+)\s*$/gm, 'const $1 = $2;');
}

function removeComputeBindingDeclarations(source, pass) {
  let result = source.replace(/layout\s*\(\s*local_size_[^)]+\)\s*in\s*;\s*/g, '');

  for (const binding of pass.bindings ?? []) {
    if (binding.type === 'sampledImage') {
      result = result.replace(
        new RegExp(String.raw`layout\s*\([^)]*binding\s*=\s*${binding.binding}[^)]*\)\s*uniform\s+sampler2D\s+${binding.name}\s*;\s*`, 'g'),
        ''
      );
    }

    if (binding.type === 'buffer') {
      result = result.replace(
        new RegExp(String.raw`layout\s*\([^)]*\)\s*(?:readonly\s+)?buffer\s+[A-Za-z_][A-Za-z0-9_]*\s*\{[\s\S]*?\}\s*${binding.name}\s*;\s*`, 'g'),
        ''
      );
    }

    if (binding.type === 'uniformBlock') {
      result = result.replace(
        new RegExp(String.raw`layout\s*\([^)]*binding\s*=\s*${binding.binding}[^)]*\)\s*uniform\s+[A-Za-z_][A-Za-z0-9_]*\s*\{[\s\S]*?\}\s*${binding.name}\s*;\s*`, 'g'),
        ''
      );
    }
  }

  return result;
}

function translateTextureFetches(source, sampledImages, bindings) {
  let result = source;
  for (const binding of sampledImages) {
    const image = bindings?.[binding.name];
    if (!image) continue;
    result = result.replace(
      new RegExp(String.raw`textureSize\s*\(\s*${binding.name}\s*,\s*0\s*\)`, 'g'),
      `vec2<i32>(i32(textureDimensions(${binding.name}).x), i32(textureDimensions(${binding.name}).y))`
    );
    result = result.replace(
      new RegExp(String.raw`texelFetch\s*\(\s*${binding.name}\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*0\s*\)\s*\.rgb`, 'g'),
      `textureLoad(${binding.name}, $1, 0).rgb`
    );
  }
  return result;
}

function translateBufferAccess(source, pass, bufferMembers) {
  let result = source;
  for (const binding of pass.bindings ?? []) {
    if (binding.type !== 'buffer') continue;
    const member = bufferMembers.get(binding.name);
    const accessPattern = `${binding.name}\\s*\\.\\s*${member}\\s*\\[\\s*([^\\]]+)\\s*\\]`;
    if (binding.access === 'readWrite' && binding.elementType === 'uint') {
      result = result.replace(
        new RegExp(String.raw`atomicAdd\s*\(\s*${accessPattern}\s*,\s*([^)]+)\)`, 'g'),
        `atomicAdd(&${binding.name}[$1], $2)`
      );
      result = result.replace(
        new RegExp(String.raw`${accessPattern}\s*=\s*([^;]+);`, 'g'),
        `atomicStore(&${binding.name}[$1], $2);`
      );
      result = result.replace(new RegExp(accessPattern, 'g'), `atomicLoad(&${binding.name}[$1])`);
    } else {
      result = result.replace(new RegExp(accessPattern, 'g'), `${binding.name}[$1]`);
    }
  }
  return result;
}

function translateComputeSyntax(source) {
  return source
    .replace(/\b(bool|float|uint|int|vec2|vec3|vec4|ivec2|ivec3|ivec4|uvec2|uvec3|uvec4|mat2|mat3|mat4)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g, (_, type, name) => `var ${name}: ${toWgslType(type)} =`)
    .replace(/\b(bool|float|uint|int|vec2|vec3|vec4|ivec2|ivec3|ivec4|uvec2|uvec3|uvec4|mat2|mat3|mat4)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/g, (_, returnType, name, args) =>
      `fn ${name}(${translateFunctionArgs(args)}) -> ${toWgslType(returnType)} {`
    )
    .replace(/\buint\s+([A-Za-z_][A-Za-z0-9_]*)\s*\)/g, 'u32 $1)')
    .replace(/\bfloat\s+([A-Za-z_][A-Za-z0-9_]*)\s*\)/g, 'f32 $1)')
    .replace(/\bvec3\s+([A-Za-z_][A-Za-z0-9_]*)\s*\)/g, 'vec3<f32> $1)')
    .replace(/\bgl_GlobalInvocationID\b/g, 'global_id')
    .replace(/\bgl_LocalInvocationIndex\b/g, 'local_index')
    .replace(/\bfloat\s*\(/g, 'f32(')
    .replace(/\buint\s*\(/g, 'u32(')
    .replace(/\bint\s*\(/g, 'i32(')
    .replace(/\bivec2\s*\(/g, 'vec2<i32>(')
    .replace(/\bivec3\s*\(/g, 'vec3<i32>(')
    .replace(/\bivec4\s*\(/g, 'vec4<i32>(')
    .replace(/\buvec2\s*\(/g, 'vec2<u32>(')
    .replace(/\buvec3\s*\(/g, 'vec3<u32>(')
    .replace(/\buvec4\s*\(/g, 'vec4<u32>(')
    .replace(/\bvec2\s*\(/g, 'vec2<f32>(')
    .replace(/\bvec3\s*\(/g, 'vec3<f32>(')
    .replace(/\bvec4\s*\(/g, 'vec4<f32>(')
    .replace(/\bmat2\s*\(/g, 'mat2x2<f32>(')
    .replace(/\bmat3\s*\(/g, 'mat3x3<f32>(')
    .replace(/\bmat4\s*\(/g, 'mat4x4<f32>(')
    .replace(/\+\+([A-Za-z_][A-Za-z0-9_]*)/g, '$1 = $1 + 1u')
    .replace(/for\s*\(\s*uint\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+);\s*([^;]+);\s*\+\+\1\s*\)/g, 'for (var $1 = $2; $3; $1 = $1 + 1u)');
}

function translateComputeBodySyntax(source) {
  return translateComputeSyntax(source);
}

function translateFunctionArgs(args) {
  if (!args.trim()) return '';
  return args.split(',').map((arg) => {
    const match = /^\s*(bool|float|uint|int|vec2|vec3|vec4|ivec2|ivec3|ivec4|uvec2|uvec3|uvec4|mat2|mat3|mat4)\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(arg);
    if (!match) return arg.trim();
    return `${match[2]}: ${toWgslType(match[1])}`;
  }).join(', ');
}

function translateUniformBoolFieldReferences(source, pass) {
  let result = source;
  for (const binding of pass.bindings ?? []) {
    if (binding.type !== 'uniformBlock') continue;
    for (const field of binding.fields ?? []) {
      if (field.type !== 'bool') continue;
      result = result.replace(
        new RegExp(String.raw`\b${escapeRegExp(binding.name)}\s*\.\s*${escapeRegExp(field.name)}\b`, 'g'),
        `(${binding.name}.${field.name} != 0u)`
      );
    }
  }
  return result;
}

function formatWgslUniformBlockField(field) {
  const attrs = [];
  const align = uniformFieldAlign(field.type);
  const size = field.size ?? uniformFieldSize(field.type);
  if (align > naturalWgslAlign(field.type)) attrs.push(`@align(${align})`);
  if (size > naturalWgslSize(field.type)) attrs.push(`@size(${size})`);
  const prefix = attrs.length > 0 ? `${attrs.join(' ')} ` : '';
  return `${prefix}${field.name}: ${toWgslUniformFieldType(field.type)},`;
}

function uniformFieldAlign(type) {
  if (type === 'vec2' || type === 'ivec2' || type === 'uvec2') return 8;
  if (type === 'vec3' || type === 'vec4' || type === 'ivec3' || type === 'ivec4' || type === 'uvec3' || type === 'uvec4') return 16;
  if (type === 'mat2' || type === 'mat3' || type === 'mat4') return 16;
  return 4;
}

function uniformFieldSize(type) {
  if (type === 'vec2' || type === 'ivec2' || type === 'uvec2') return 8;
  if (type === 'vec3' || type === 'vec4' || type === 'ivec3' || type === 'ivec4' || type === 'uvec3' || type === 'uvec4') return 16;
  if (type === 'mat2') return 32;
  if (type === 'mat3') return 48;
  if (type === 'mat4') return 64;
  return 4;
}

function naturalWgslAlign(type) {
  if (type === 'vec2' || type === 'ivec2' || type === 'uvec2') return 8;
  if (type === 'vec3' || type === 'vec4' || type === 'ivec3' || type === 'ivec4' || type === 'uvec3' || type === 'uvec4') return 16;
  if (type === 'mat3' || type === 'mat4') return 16;
  if (type === 'mat2') return 8;
  return 4;
}

function naturalWgslSize(type) {
  if (type === 'vec2' || type === 'ivec2' || type === 'uvec2') return 8;
  if (type === 'vec3' || type === 'ivec3' || type === 'uvec3') return 12;
  if (type === 'vec4' || type === 'ivec4' || type === 'uvec4') return 16;
  if (type === 'mat2') return 16;
  if (type === 'mat3') return 48;
  if (type === 'mat4') return 64;
  return 4;
}

function toWgslType(type) {
  if (type === 'bool') return 'bool';
  if (type === 'float') return 'f32';
  if (type === 'uint') return 'u32';
  if (type === 'int') return 'i32';
  if (type === 'vec2') return 'vec2<f32>';
  if (type === 'vec3') return 'vec3<f32>';
  if (type === 'vec4') return 'vec4<f32>';
  if (type === 'ivec2') return 'vec2<i32>';
  if (type === 'ivec3') return 'vec3<i32>';
  if (type === 'ivec4') return 'vec4<i32>';
  if (type === 'uvec2') return 'vec2<u32>';
  if (type === 'uvec3') return 'vec3<u32>';
  if (type === 'uvec4') return 'vec4<u32>';
  if (type === 'mat2') return 'mat2x2<f32>';
  if (type === 'mat3') return 'mat3x3<f32>';
  if (type === 'mat4') return 'mat4x4<f32>';
  return type;
}

function toWgslUniformFieldType(type) {
  return type === 'bool' ? 'u32' : toWgslType(type);
}

function runGenericRenderPassWebGl({ pass, sourcePass, bindings, output, workspace, sourceFiles, profile }) {
  if (!output.canvas || typeof document === 'undefined') return false;

  return timeSection(profile, `pass:${pass.id}:webgl-generic`, () => {
    try {
      const renderer = getPreviewWebGlRenderer(output.canvas, output.width, output.height);
      if (!renderer) return false;
      return renderer.drawGenericPass({ pass, sourcePass, bindings, output, workspace, sourceFiles, profile });
    } catch (error) {
      addDiagnostic(profile, 'warning', `Generic WebGL preview failed for pass "${pass.id}".`, {
        error: error.message || String(error)
      });
      console.warn(`Generic WebGL preview failed for pass "${pass.id}":`, error);
      return false;
    }
  });
}

const PREVIEW_WEBGL_RENDERERS = new WeakMap();

function getPreviewWebGlRenderer(canvas, width, height) {
  let renderer = PREVIEW_WEBGL_RENDERERS.get(canvas);
  if (!renderer) {
    renderer = PreviewWebGlRenderer.create();
    if (!renderer) return null;
    PREVIEW_WEBGL_RENDERERS.set(canvas, renderer);
  }

  renderer.resize(width, height);
  return renderer;
}

class PreviewWebGlRenderer {
  static create() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      desynchronized: true,
      preserveDrawingBuffer: true,
      stencil: false
    });
    if (!gl) return null;

    try {
      return new PreviewWebGlRenderer(canvas, gl);
    } catch (error) {
      console.warn('WebGL preview renderer unavailable:', error);
      return null;
    }
  }

  constructor(canvas, gl) {
    this.canvas = canvas;
    this.gl = gl;
    this.vertexBuffer = createFullscreenTriangle(gl);
    this.sourceTexture = createTexture(gl);
    this.cdfTexture = createTexture(gl);
    this.genericProgramCache = new Map();
    this.genericTextures = new Map();
  }

  resize(width, height) {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
  }

  drawGenericPass({ pass, sourcePass, bindings, output, workspace, sourceFiles, profile }) {
    const shaderSources = getRenderPassShaderSources(workspace, pass, sourcePass, sourceFiles);
    if (!shaderSources) return false;

    const program = this.getGenericProgram(pass, shaderSources, profile);
    this.gl.useProgram(program);
    this.bindGenericVertexInput(program, pass, profile);
    this.bindGenericResources(program, pass, bindings, profile);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
    this.blitTo(output.canvas);
    return true;
  }

  getGenericProgram(pass, shaderSources, profile) {
    const cacheKey = `${pass.id}:${hashString(shaderSources.vertex)}:${hashString(shaderSources.fragment)}`;
    const cached = this.genericProgramCache.get(cacheKey);
    if (cached) {
      addDiagnostic(profile, 'info', `Reused WebGL program for pass "${pass.id}".`);
      validateGenericProgramInterface(this.gl, cached, pass, profile);
      return cached;
    }

    const translated = translateRenderShadersForWebGl(shaderSources, pass);
    const program = createProgram(this.gl, translated.vertex, translated.fragment, {
      label: `generic render pass "${pass.id}"`,
      vertexSourcePath: sourcePathFromCompiledStage(pass.stages?.vertex),
      fragmentSourcePath: sourcePathFromCompiledStage(pass.stages?.fragment),
      profile
    });
    addDiagnostic(profile, 'info', `Compiled WebGL program for pass "${pass.id}".`, {
      vertex: sourcePathFromCompiledStage(pass.stages?.vertex),
      fragment: sourcePathFromCompiledStage(pass.stages?.fragment)
    });
    validateGenericProgramInterface(this.gl, program, pass, profile);
    this.genericProgramCache.set(cacheKey, program);
    return program;
  }

  bindGenericVertexInput(program, pass, profile) {
    const { gl } = this;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);

    for (const input of pass.vertexInput ?? []) {
      if (input.type !== 'vec2') throw new Error(`Unsupported vertex input type "${input.type}".`);
      const location = gl.getAttribLocation(program, input.name);
      addDiagnostic(profile, location < 0 ? 'warning' : 'info', `Attribute location: ${input.name}`, {
        location,
        type: input.type
      });
      if (location < 0) continue;
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    }
  }

  bindGenericResources(program, pass, bindings, profile) {
    const { gl } = this;
    let textureUnit = 0;

    for (const binding of pass.bindings ?? []) {
      const value = bindings?.[binding.name];
      if (binding.type === 'sampledImage') {
        if (!value) throw new Error(`Missing sampled image binding "${binding.name}".`);
        const texture = this.getGenericTexture(binding.name);
        gl.activeTexture(gl.TEXTURE0 + textureUnit);
        uploadSourceTexture(gl, texture, value);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        const location = gl.getUniformLocation(program, binding.name);
        addDiagnostic(profile, location === null ? 'warning' : 'info', `Uniform sampler binding: ${binding.name}`, {
          location: formatUniformLocation(location),
          textureUnit,
          binding: binding.binding,
          kind: binding.type
        });
        if (location !== null) gl.uniform1i(location, textureUnit);
        textureUnit += 1;
        continue;
      }

      if (binding.type === 'buffer') {
        if (!value) throw new Error(`Missing buffer binding "${binding.name}".`);
        const texture = this.getGenericTexture(binding.name);
        gl.activeTexture(gl.TEXTURE0 + textureUnit);
        uploadBufferTexture(gl, texture, value);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        const location = gl.getUniformLocation(program, binding.name);
        addDiagnostic(profile, location === null ? 'warning' : 'info', `Uniform buffer texture binding: ${binding.name}`, {
          location: formatUniformLocation(location),
          textureUnit,
          binding: binding.binding,
          kind: binding.type,
          elementType: value.elementType,
          elements: value.values?.length ?? 0
        });
        if (location !== null) gl.uniform1i(location, textureUnit);
        textureUnit += 1;
        continue;
      }

      if (binding.type === 'uniformBlock') {
        bindUniformBlockFields(gl, program, binding, value ?? {}, profile);
        continue;
      }

      if (binding.type === 'uniform') {
        bindLooseUniform(gl, program, binding, value, profile);
      }
    }
  }

  getGenericTexture(key) {
    const existing = this.genericTextures.get(key);
    if (existing) return existing;
    const texture = createTexture(this.gl);
    this.genericTextures.set(key, texture);
    return texture;
  }

  blitTo(canvas) {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(this.canvas, 0, 0);
  }
}

function createFullscreenTriangle(gl) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,
    3, -1,
    -1, 3
  ]), gl.STATIC_DRAW);
  return buffer;
}

function createTexture(gl) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function uploadSourceTexture(gl, texture, source) {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, Boolean(source?.textureFlipY));

  if (source?.externalTextureSource) {
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source.externalTextureSource
    );
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    return;
  }

  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    source.width,
    source.height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    source.pixels
  );
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
}

function uploadBufferTexture(gl, texture, buffer) {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  if (buffer.elementType === 'float') {
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32F,
      buffer.values.length,
      1,
      0,
      gl.RED,
      gl.FLOAT,
      buffer.values
    );
    return;
  }

  if (buffer.elementType === 'uint') {
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32UI,
      buffer.values.length,
      1,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_INT,
      buffer.values
    );
    return;
  }

  throw new Error(`Unsupported buffer element type "${buffer.elementType}".`);
}

function getRenderPassShaderSources(workspace, pass, sourcePass, compiledFiles = {}, sourceFiles = null) {
  const vertexPath = sourcePathFromCompiledStage(pass.stages?.vertex) || sourcePass?.vertexShader;
  const fragmentPath = sourcePathFromCompiledStage(pass.stages?.fragment) || sourcePass?.fragmentShader;
  const vertex = loadCompiledShaderSource(compiledFiles, sourceFiles, vertexPath)
    ?? loadShaderSourceWithIncludes(workspace, sourceFiles, sourcePass?.vertexShader ?? vertexPath);
  const fragment = loadCompiledShaderSource(compiledFiles, sourceFiles, fragmentPath)
    ?? loadShaderSourceWithIncludes(workspace, sourceFiles, sourcePass?.fragmentShader ?? fragmentPath);
  if (!vertex || !fragment) return null;
  return {
    vertex: vertex.code,
    fragment: fragment.code,
    vertexLineMap: vertex.lineMap,
    fragmentLineMap: fragment.lineMap,
    vertexPath,
    fragmentPath
  };
}

function getCompiledWgslRenderPassSource(pass, compiledFiles = {}, sourceFiles = null) {
  const vertexPath = typeof pass.stages?.vertex === 'string' ? pass.stages.vertex : '';
  const fragmentPath = typeof pass.stages?.fragment === 'string' ? pass.stages.fragment : '';
  if (!isWgslStagePath(vertexPath) || !isWgslStagePath(fragmentPath)) return null;
  const vertex = loadCompiledShaderSource(compiledFiles, sourceFiles, vertexPath);
  const fragment = loadCompiledShaderSource(compiledFiles, sourceFiles, fragmentPath);
  if (!vertex || !fragment) return null;
  return {
    vertex: {
      path: normalizeShaderPath(vertexPath),
      code: vertex.code,
      lineMap: vertex.lineMap
    },
    fragment: {
      path: normalizeShaderPath(fragmentPath),
      code: fragment.code,
      lineMap: fragment.lineMap
    }
  };
}

function getCompiledWgslComputePassSource(pass, compiledFiles = {}, sourceFiles = null) {
  const stagePath = typeof pass.stages?.compute === 'string' ? pass.stages.compute : '';
  if (!isWgslStagePath(stagePath)) return null;
  const source = loadCompiledShaderSource(compiledFiles, sourceFiles, stagePath);
  if (!source) return null;
  return {
    path: normalizeShaderPath(stagePath),
    code: source.code,
    lineMap: source.lineMap
  };
}

function loadCompiledShaderSource(compiledFiles, sourceFiles, path) {
  const normalizedPath = normalizeShaderPath(path);
  const content = compiledFiles?.[normalizedPath] ?? compiledFiles?.[path];
  if (typeof content !== 'string') return null;
  const lineMap = parseCompiledShaderLineMap(compiledFiles?.[`${normalizedPath}.map.json`], sourceFiles, content);
  return {
    code: content,
    lineMap
  };
}

function parseCompiledShaderLineMap(mapText, sourceFiles, content) {
  if (typeof mapText !== 'string') return createGeneratedLineMap(content);
  try {
    const rawMap = JSON.parse(mapText);
    if (!Array.isArray(rawMap)) return createGeneratedLineMap(content);
    return rawMap.map((entry) => {
      if (!entry?.path || !Number.isInteger(entry.line)) return null;
      return {
        path: entry.path,
        line: entry.line,
        source: typeof sourceFiles?.[entry.path] === 'string' ? sourceFiles[entry.path] : ''
      };
    });
  } catch {
    return createGeneratedLineMap(content);
  }
}

function createGeneratedLineMap(content) {
  return splitLines(content).map(() => null);
}

function loadShaderSourceWithIncludes(workspace, sourceFiles, path, includeStack = []) {
  const normalizedPath = normalizeShaderPath(path);
  const content = sourceFiles?.[normalizedPath] ?? sourceFiles?.[path] ?? workspace.getFile(normalizedPath)?.content ?? workspace.getFile(path)?.content;
  if (typeof content !== 'string') return null;
  if (includeStack.includes(normalizedPath)) {
    throw new Error(`Circular shader include: ${[...includeStack, normalizedPath].join(' -> ')}`);
  }

  const outputLines = [];
  const lineMap = [];
  const sourceLines = splitLines(content);
  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index];
    const includeMatch = /^\s*#include\s+[<"]([^>"]+)[>"]\s*$/.exec(line);
    if (includeMatch) {
      const includePath = resolveShaderIncludePath(normalizedPath, includeMatch[1]);
      const included = loadShaderSourceWithIncludes(workspace, sourceFiles, includePath, [...includeStack, normalizedPath]);
      if (!included) {
        throw new Error(`Missing shader include "${includeMatch[1]}" from ${normalizedPath}:${index + 1}`);
      }
      outputLines.push(...splitLines(included.code));
      lineMap.push(...included.lineMap);
      continue;
    }
    outputLines.push(line);
    lineMap.push({
      path: normalizedPath,
      line: index + 1,
      source: content
    });
  }

  return {
    code: outputLines.join('\n'),
    lineMap
  };
}

function resolveShaderIncludePath(fromPath, includePath) {
  const normalizedInclude = normalizeShaderPath(includePath);
  if (!fromPath || normalizedInclude.startsWith('/')) return normalizedInclude.replace(/^\/+/, '');
  const directory = normalizeShaderPath(fromPath).split('/').slice(0, -1).join('/');
  return normalizeShaderPath(directory ? `${directory}/${normalizedInclude}` : normalizedInclude);
}

function normalizeShaderPath(path) {
  const parts = String(path ?? '').replace(/\\/g, '/').split('/');
  const normalized = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return normalized.join('/');
}

function sourcePathFromCompiledStage(stagePath) {
  if (typeof stagePath !== 'string' || isWgslStagePath(stagePath)) return '';
  return stagePath.replace(/\.(vert|frag|comp)\.spv$/i, '.$1.glsl');
}

function isWgslStagePath(stagePath) {
  return typeof stagePath === 'string' && /\.wgsl$/i.test(stagePath);
}

function translateRenderShadersForWebGl(shaderSources, pass) {
  return {
    vertex: translateVertexShaderForWebGl(shaderSources.vertex),
    fragment: translateFragmentShaderForWebGl(shaderSources.fragment, pass)
  };
}

function translateVertexShaderForWebGl(source) {
  return [
    '#version 300 es',
    'precision highp float;',
    stripVersion(source)
      .replace(/\blayout\s*\(\s*location\s*=\s*\d+\s*\)\s*out\b/g, 'out')
  ].join('\n');
}

function translateFragmentShaderForWebGl(source, pass) {
  let translated = stripVersion(source)
    .replace(/\blayout\s*\(\s*location\s*=\s*\d+\s*\)\s*in\b/g, 'in')
    .replace(/\blayout\s*\(\s*location\s*=\s*\d+\s*\)\s*out\b/g, 'out')
    .replace(/\blayout\s*\(\s*set\s*=\s*\d+\s*,\s*binding\s*=\s*\d+\s*\)\s*uniform\s+sampler2D\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g, 'uniform sampler2D $1;');

  for (const binding of pass.bindings ?? []) {
    if (binding.type === 'uniformBlock') {
      translated = replaceUniformBlock(translated, binding);
    }
    if (binding.type === 'buffer') {
      translated = replaceBufferBlock(translated, binding);
    }
  }

  return [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'precision highp sampler2D;',
    'precision highp usampler2D;',
    translated
  ].join('\n');
}

function stripVersion(source) {
  return String(source)
    .replace(/^[^\S\r\n]*#version[^\S\r\n]+\d+(?:[^\S\r\n]+[A-Za-z_][A-Za-z0-9_]*)?[^\S\r\n]*(?:\r?\n|$)/m, '\n')
    .replace(/^[^\S\r\n]*#extension[^\r\n]*(?:\r?\n|$)/gm, '\n');
}

function replaceUniformBlock(source, binding) {
  const pattern = new RegExp(
    String.raw`layout\s*\([^)]*binding\s*=\s*${binding.binding}[^)]*\)\s*uniform\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{[\s\S]*?\}\s*${binding.name}\s*;`,
    'm'
  );
  const fields = (binding.fields ?? []).map((field) => `  ${field.type} ${field.name};`).join('\n');
  return source.replace(pattern, `struct ${binding.name}_Block {\n${fields}\n};\nuniform ${binding.name}_Block ${binding.name};`);
}

function replaceBufferBlock(source, binding) {
  const samplerType = binding.elementType === 'uint' ? 'usampler2D' : 'sampler2D';
  const pattern = new RegExp(
    String.raw`layout\s*\([^)]*\)\s*(?:readonly\s+)?buffer\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{[\s\S]*?\}\s*${binding.name}\s*;`,
    'm'
  );
  const member = findBufferArrayMember(source, binding.name) ?? 'values';
  const fetch = binding.elementType === 'uint'
    ? `uint(texelFetch(${binding.name}, ivec2(clamp(int($1), 0, textureSize(${binding.name}, 0).x - 1), 0), 0).r)`
    : `texelFetch(${binding.name}, ivec2(clamp(int($1), 0, textureSize(${binding.name}, 0).x - 1), 0), 0).r`;
  return source
    .replace(pattern, `uniform ${samplerType} ${binding.name};`)
    .replace(new RegExp(`${binding.name}\\s*\\.\\s*${member}\\s*\\[\\s*([^\\]]+)\\s*\\]`, 'g'), fetch);
}

function findBufferArrayMember(source, instanceName) {
  const pattern = new RegExp(String.raw`\}\s*${instanceName}\s*;`);
  const endMatch = pattern.exec(source);
  if (!endMatch) return null;
  const prefix = source.slice(0, endMatch.index);
  const blockStart = prefix.lastIndexOf('{');
  if (blockStart < 0) return null;
  const block = prefix.slice(blockStart + 1);
  const memberMatch = /\b[A-Za-z_][A-Za-z0-9_]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\[[^\]]+\]\s*;/.exec(block);
  return memberMatch?.[1] ?? null;
}

function bindUniformBlockFields(gl, program, binding, value, profile) {
  for (const field of binding.fields ?? []) {
    const uniformName = `${binding.name}.${field.name}`;
    const location = gl.getUniformLocation(program, uniformName);
    addDiagnostic(profile, location === null ? 'warning' : 'info', `Uniform field location: ${uniformName}`, {
      location: formatUniformLocation(location),
      type: field.type,
      binding: binding.binding,
      value: value?.[field.name]
    });
    if (location === null) {
      console.warn(`Preview WebGL uniform not found: ${uniformName}`);
      continue;
    }
    bindUniformValue(gl, location, field.type, value?.[field.name]);
  }
}

function bindLooseUniform(gl, program, binding, value, profile) {
  const location = gl.getUniformLocation(program, binding.name);
  addDiagnostic(profile, location === null ? 'warning' : 'info', `Uniform location: ${binding.name}`, {
    location: formatUniformLocation(location),
    type: binding.valueType,
    binding: binding.binding,
    value
  });
  if (location === null) {
    console.warn(`Preview WebGL uniform not found: ${binding.name}`);
    return;
  }
  bindUniformValue(gl, location, binding.valueType, value);
}

function bindUniformValue(gl, location, type, value) {
  if (location === null) return;
  if (type === 'float') return gl.uniform1f(location, Number(value ?? 0));
  if (type === 'bool') return gl.uniform1i(location, value ? 1 : 0);
  if (type === 'int') return gl.uniform1i(location, Number(value ?? 0));
  if (type === 'uint') return gl.uniform1ui(location, Number(value ?? 0));
  if (type === 'vec2') return gl.uniform2fv(location, normalizeUniformArray(value, 2));
  if (type === 'vec3') return gl.uniform3fv(location, normalizeUniformArray(value, 3));
  if (type === 'vec4') return gl.uniform4fv(location, normalizeUniformArray(value, 4));
  if (type === 'ivec2') return gl.uniform2iv(location, normalizeUniformArray(value, 2));
  if (type === 'ivec3') return gl.uniform3iv(location, normalizeUniformArray(value, 3));
  if (type === 'ivec4') return gl.uniform4iv(location, normalizeUniformArray(value, 4));
  if (type === 'uvec2') return gl.uniform2uiv(location, normalizeUniformArray(value, 2));
  if (type === 'uvec3') return gl.uniform3uiv(location, normalizeUniformArray(value, 3));
  if (type === 'uvec4') return gl.uniform4uiv(location, normalizeUniformArray(value, 4));
  if (type === 'mat2') return gl.uniformMatrix2fv(location, false, normalizeUniformArray(value, 4, 1));
  if (type === 'mat3') return gl.uniformMatrix3fv(location, false, normalizeUniformArray(value, 9, 1));
  if (type === 'mat4') return gl.uniformMatrix4fv(location, false, normalizeUniformArray(value, 16, 1));
}

function normalizeUniformArray(value, length, fallback = 0) {
  const values = Array.isArray(value) ? value : [];
  return Array.from({ length }, (_, index) => Number(values[index] ?? fallback));
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function createProgram(gl, vertexSource, fragmentSource, options = {}) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource, options);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, options);
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'Unknown WebGL program link error.';
    gl.deleteProgram(program);
    addDiagnostic(options.profile, 'error', options.label ? `Failed to link ${options.label}.` : 'Failed to link WebGL program.', {
      log: message
    });
    throw new Error([
      options.label ? `Failed to link ${options.label}.` : 'Failed to link WebGL program.',
      message
    ].join(' '));
  }

  addDiagnostic(options.profile, 'info', options.label ? `Linked ${options.label}.` : 'Linked WebGL program.');

  return program;
}

function compileShader(gl, type, source, options = {}) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'Unknown WebGL shader compile error.';
    gl.deleteShader(shader);
    const stage = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    const sourcePath = stage === 'vertex' ? options.vertexSourcePath : options.fragmentSourcePath;
    addDiagnostic(options.profile, 'error', `Failed to compile ${stage} shader.`, {
      label: options.label,
      sourcePath,
      log: message
    });
    throw new Error([
      options.label ? `Failed to compile ${stage} shader for ${options.label}.` : `Failed to compile ${stage} shader.`,
      sourcePath ? `Source: ${sourcePath}.` : '',
      message
    ].filter(Boolean).join(' '));
  }

  addDiagnostic(options.profile, 'info', `Compiled ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader.`, {
    label: options.label,
    sourcePath: type === gl.VERTEX_SHADER ? options.vertexSourcePath : options.fragmentSourcePath
  });

  return shader;
}

function validateGenericProgramInterface(gl, program, pass, profile) {
  const activeUniforms = getActiveUniformNames(gl, program);
  addDiagnostic(profile, 'info', `Active uniforms for pass "${pass.id}".`, {
    uniforms: Array.from(activeUniforms)
  });

  for (const binding of pass.bindings ?? []) {
    if (binding.type === 'sampledImage' || binding.type === 'buffer' || binding.type === 'uniform') {
      if (!activeUniforms.has(binding.name)) {
        addDiagnostic(profile, 'warning', `Active uniform missing: ${binding.name}`, {
          pass: pass.id,
          binding: binding.binding,
          kind: binding.type
        });
        console.warn(`Preview WebGL active uniform missing for pass "${pass.id}": ${binding.name}`);
      }
      continue;
    }

    if (binding.type === 'uniformBlock') {
      for (const field of binding.fields ?? []) {
        const uniformName = `${binding.name}.${field.name}`;
        if (!activeUniforms.has(uniformName)) {
          addDiagnostic(profile, 'warning', `Active uniform missing: ${uniformName}`, {
            pass: pass.id,
            binding: binding.binding,
            kind: binding.type,
            type: field.type
          });
          console.warn(`Preview WebGL active uniform missing for pass "${pass.id}": ${uniformName}`);
        }
      }
    }
  }
}

function getActiveUniformNames(gl, program) {
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  const names = new Set();
  for (let index = 0; index < count; index += 1) {
    const info = gl.getActiveUniform(program, index);
    if (!info?.name) continue;
    names.add(info.name.replace(/\[0\]$/, ''));
  }
  return names;
}

function formatUniformLocation(location) {
  return location === null ? null : 'ok';
}

function toByte(value) {
  return Math.round(clamp01(value) * 255);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

const IDENTITY_MAT4 = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1
]);

function openPreviewLuaLibs(L) {
  const libraries = [
    ['_G', luaopen_base],
    ['math', luaopen_math],
    ['string', luaopen_string],
    ['table', luaopen_table]
  ];

  for (const [name, openLibrary] of libraries) {
    lauxlib.luaL_requiref(L, to_luastring(name), openLibrary, 1);
    lua.lua_pop(L, 1);
  }

  installTimeLibrary(L);
  installMat4Library(L);
}

function installTimeLibrary(L) {
  lua.lua_newtable(L);
  setLuaLibraryFunction(L, -1, 'now', () => {
    lua.lua_pushnumber(L, Date.now() / 1000);
    return 1;
  });
  setLuaLibraryFunction(L, -1, 'parts', (state) => luaTimeParts(state));
  setLuaLibraryFunction(L, -1, 'fromDate', (state) => luaTimeFromDate(state));
  lua.lua_setglobal(L, to_luastring('time'));
}

function luaTimeParts(L) {
  requireLuaTable(L, 1, 'time.parts output');
  const timestamp = requireLuaNumber(L, 2, 'time.parts timestamp');
  const options = readTimeOptions(L, 3);
  const date = new Date(Math.floor(timestamp * 1000));
  const year = options.utc ? date.getUTCFullYear() : date.getFullYear();
  const month = (options.utc ? date.getUTCMonth() : date.getMonth()) + 1;
  const day = options.utc ? date.getUTCDate() : date.getDate();
  const hour = options.utc ? date.getUTCHours() : date.getHours();
  const min = options.utc ? date.getUTCMinutes() : date.getMinutes();
  const sec = options.utc ? date.getUTCSeconds() : date.getSeconds();
  const millis = options.utc ? date.getUTCMilliseconds() : date.getMilliseconds();
  const wday = (options.utc ? date.getUTCDay() : date.getDay()) + 1;
  const yday = getCalendarDayOfYear(date, options.utc);

  setLuaTableNumberField(L, 1, 'year', year);
  setLuaTableNumberField(L, 1, 'month', month);
  setLuaTableNumberField(L, 1, 'day', day);
  setLuaTableNumberField(L, 1, 'hour', hour);
  setLuaTableNumberField(L, 1, 'min', min);
  setLuaTableNumberField(L, 1, 'sec', sec);
  setLuaTableNumberField(L, 1, 'millis', millis);
  setLuaTableNumberField(L, 1, 'wday', wday);
  setLuaTableNumberField(L, 1, 'yday', yday);
  lua.lua_pushvalue(L, 1);
  return 1;
}

function luaTimeFromDate(L) {
  requireLuaTable(L, 1, 'time.fromDate date');
  const options = readTimeOptions(L, 2);
  const year = requireLuaTableNumberField(L, 1, 'year', 'time.fromDate date.year');
  const month = requireLuaTableNumberField(L, 1, 'month', 'time.fromDate date.month');
  const day = requireLuaTableNumberField(L, 1, 'day', 'time.fromDate date.day');
  const hour = readLuaTableNumberField(L, 1, 'hour', 0);
  const min = readLuaTableNumberField(L, 1, 'min', 0);
  const sec = readLuaTableNumberField(L, 1, 'sec', 0);
  const millis = readLuaTableNumberField(L, 1, 'millis', 0);
  const date = new Date(0);

  if (options.utc) {
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, min, sec, millis);
  } else {
    date.setFullYear(year, month - 1, day);
    date.setHours(hour, min, sec, millis);
  }

  lua.lua_pushnumber(L, date.getTime() / 1000);
  return 1;
}

function readTimeOptions(L, index) {
  if (lua.lua_isnoneornil(L, index)) return { utc: false };
  requireLuaTable(L, index, 'time options');
  const optionsIndex = lua.lua_absindex(L, index);
  lua.lua_getfield(L, optionsIndex, to_luastring('utc'));
  const utc = lua.lua_toboolean(L, -1) !== 0;
  lua.lua_pop(L, 1);
  return { utc };
}

function getCalendarDayOfYear(date, utc) {
  if (utc) {
    const start = Date.UTC(date.getUTCFullYear(), 0, 1);
    const current = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    return Math.floor((current - start) / 86400000) + 1;
  }

  const start = Date.UTC(date.getFullYear(), 0, 1);
  const current = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor((current - start) / 86400000) + 1;
}

function installMat4Library(L) {
  const methods = {
    identity: (state) => luaMat4Identity(state),
    copy: (state) => luaMat4Copy(state),
    multiply: (state) => luaMat4Multiply(state, false),
    preMultiply: (state) => luaMat4Multiply(state, true),
    translate: (state) => luaMat4Append(state, mat4Translation(
      requireLuaNumber(state, 2, 'mat4.translate x'),
      requireLuaNumber(state, 3, 'mat4.translate y'),
      requireLuaNumber(state, 4, 'mat4.translate z')
    )),
    scale: (state) => luaMat4Append(state, mat4Scale(
      requireLuaNumber(state, 2, 'mat4.scale x'),
      requireLuaNumber(state, 3, 'mat4.scale y'),
      requireLuaNumber(state, 4, 'mat4.scale z')
    )),
    rotateX: (state) => luaMat4Append(state, mat4RotationX(requireLuaNumber(state, 2, 'mat4.rotateX radians'))),
    rotateY: (state) => luaMat4Append(state, mat4RotationY(requireLuaNumber(state, 2, 'mat4.rotateY radians'))),
    rotateZ: (state) => luaMat4Append(state, mat4RotationZ(requireLuaNumber(state, 2, 'mat4.rotateZ radians'))),
    setTranslation: (state) => luaMat4Set(state, mat4Translation(
      requireLuaNumber(state, 2, 'mat4.setTranslation x'),
      requireLuaNumber(state, 3, 'mat4.setTranslation y'),
      requireLuaNumber(state, 4, 'mat4.setTranslation z')
    )),
    setScale: (state) => luaMat4Set(state, mat4Scale(
      requireLuaNumber(state, 2, 'mat4.setScale x'),
      requireLuaNumber(state, 3, 'mat4.setScale y'),
      requireLuaNumber(state, 4, 'mat4.setScale z')
    )),
    setRotationX: (state) => luaMat4Set(state, mat4RotationX(requireLuaNumber(state, 2, 'mat4.setRotationX radians'))),
    setRotationY: (state) => luaMat4Set(state, mat4RotationY(requireLuaNumber(state, 2, 'mat4.setRotationY radians'))),
    setRotationZ: (state) => luaMat4Set(state, mat4RotationZ(requireLuaNumber(state, 2, 'mat4.setRotationZ radians'))),
    setOrtho: (state) => luaMat4Set(state, mat4Ortho(
      requireLuaNumber(state, 2, 'mat4.setOrtho left'),
      requireLuaNumber(state, 3, 'mat4.setOrtho right'),
      requireLuaNumber(state, 4, 'mat4.setOrtho bottom'),
      requireLuaNumber(state, 5, 'mat4.setOrtho top'),
      requireLuaNumber(state, 6, 'mat4.setOrtho near'),
      requireLuaNumber(state, 7, 'mat4.setOrtho far')
    )),
    invert: (state) => luaMat4Invert(state),
    transpose: (state) => luaMat4Transpose(state),
    transformPoint4: (state) => luaMat4TransformPoint4(state),
    transformPoint2: (state) => luaMat4TransformPoint2(state)
  };

  lua.lua_newtable(L);
  for (const [name, callback] of Object.entries(methods)) {
    setLuaLibraryFunction(L, -1, name, callback);
  }
  lua.lua_setglobal(L, to_luastring('mat4'));
}

function luaMat4Identity(L) {
  return luaMat4Set(L, IDENTITY_MAT4);
}

function luaMat4Copy(L) {
  requireLuaTable(L, 1, 'mat4.copy destination');
  requireLuaTable(L, 2, 'mat4.copy source');
  writeMat4Table(L, 1, readMat4Table(L, 2));
  lua.lua_pushvalue(L, 1);
  return 1;
}

function luaMat4Multiply(L, preMultiply) {
  requireLuaTable(L, 1, preMultiply ? 'mat4.preMultiply matrix' : 'mat4.multiply matrix');
  requireLuaTable(L, 2, preMultiply ? 'mat4.preMultiply lhs' : 'mat4.multiply rhs');
  const a = readMat4Table(L, 1);
  const b = readMat4Table(L, 2);
  writeMat4Table(L, 1, preMultiply ? multiplyMat4(b, a) : multiplyMat4(a, b));
  lua.lua_pushvalue(L, 1);
  return 1;
}

function luaMat4Append(L, rhs) {
  requireLuaTable(L, 1, 'mat4 matrix');
  writeMat4Table(L, 1, multiplyMat4(readMat4Table(L, 1), rhs));
  lua.lua_pushvalue(L, 1);
  return 1;
}

function luaMat4Set(L, values) {
  requireLuaTable(L, 1, 'mat4 matrix');
  writeMat4Table(L, 1, values);
  lua.lua_pushvalue(L, 1);
  return 1;
}

function luaMat4Invert(L) {
  requireLuaTable(L, 1, 'mat4.invert matrix');
  const inverted = invertMat4(readMat4Table(L, 1));
  if (!inverted) {
    lua.lua_pushboolean(L, 0);
    return 1;
  }
  writeMat4Table(L, 1, inverted);
  lua.lua_pushboolean(L, 1);
  return 1;
}

function luaMat4Transpose(L) {
  requireLuaTable(L, 1, 'mat4.transpose matrix');
  const m = readMat4Table(L, 1);
  writeMat4Table(L, 1, [
    m[0], m[4], m[8], m[12],
    m[1], m[5], m[9], m[13],
    m[2], m[6], m[10], m[14],
    m[3], m[7], m[11], m[15]
  ]);
  lua.lua_pushvalue(L, 1);
  return 1;
}

function luaMat4TransformPoint4(L) {
  requireLuaTable(L, 1, 'mat4.transformPoint4 matrix');
  const result = transformPoint4(
    readMat4Table(L, 1),
    requireLuaNumber(L, 2, 'mat4.transformPoint4 x'),
    requireLuaNumber(L, 3, 'mat4.transformPoint4 y'),
    requireLuaNumber(L, 4, 'mat4.transformPoint4 z'),
    requireLuaNumber(L, 5, 'mat4.transformPoint4 w')
  );
  for (const value of result) lua.lua_pushnumber(L, value);
  return 4;
}

function luaMat4TransformPoint2(L) {
  requireLuaTable(L, 1, 'mat4.transformPoint2 matrix');
  const result = transformPoint4(
    readMat4Table(L, 1),
    requireLuaNumber(L, 2, 'mat4.transformPoint2 x'),
    requireLuaNumber(L, 3, 'mat4.transformPoint2 y'),
    0,
    1
  );
  lua.lua_pushnumber(L, result[0]);
  lua.lua_pushnumber(L, result[1]);
  return 2;
}

function setLuaLibraryFunction(L, tableIndex, name, callback) {
  const absoluteTableIndex = lua.lua_absindex(L, tableIndex);
  lua.lua_pushjsfunction(L, (state) => {
    try {
      return callback(state);
    } catch (error) {
      lua.lua_pushstring(state, to_luastring(error?.message || String(error)));
      return lua.lua_error(state);
    }
  });
  lua.lua_setfield(L, absoluteTableIndex, to_luastring(name));
}

function requireLuaTable(L, index, label) {
  if (!lua.lua_istable(L, index)) {
    throw new Error(`Expected ${label} to be a table.`);
  }
}

function requireLuaNumber(L, index, label) {
  const value = lua.lua_tonumberx(L, index);
  if (value === false) {
    throw new Error(`Expected ${label} to be a number.`);
  }
  return value;
}

function readLuaTableNumberField(L, index, field, fallback) {
  const tableIndex = lua.lua_absindex(L, index);
  lua.lua_getfield(L, tableIndex, to_luastring(field));
  const rawValue = lua.lua_tonumberx(L, -1);
  lua.lua_pop(L, 1);
  return rawValue === false ? fallback : rawValue;
}

function requireLuaTableNumberField(L, index, field, label) {
  const value = readLuaTableNumberField(L, index, field, null);
  if (value === null) {
    throw new Error(`Expected ${label} to be a number.`);
  }
  return value;
}

function setLuaTableNumberField(L, index, field, value) {
  const tableIndex = lua.lua_absindex(L, index);
  lua.lua_pushnumber(L, value);
  lua.lua_setfield(L, tableIndex, to_luastring(field));
}

function readMat4Table(L, index) {
  const tableIndex = lua.lua_absindex(L, index);
  const values = [];
  for (let field = 1; field <= 16; field += 1) {
    lua.lua_geti(L, tableIndex, field);
    const rawValue = lua.lua_tonumberx(L, -1);
    lua.lua_pop(L, 1);
    values.push(rawValue === false ? IDENTITY_MAT4[field - 1] : rawValue);
  }
  return values;
}

function writeMat4Table(L, index, values) {
  const tableIndex = lua.lua_absindex(L, index);
  for (let field = 1; field <= 16; field += 1) {
    lua.lua_pushnumber(L, Number(values[field - 1] ?? 0));
    lua.lua_seti(L, tableIndex, field);
  }
}

function multiplyMat4(a, b) {
  const out = new Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[column * 4 + row] =
        a[0 * 4 + row] * b[column * 4 + 0]
        + a[1 * 4 + row] * b[column * 4 + 1]
        + a[2 * 4 + row] * b[column * 4 + 2]
        + a[3 * 4 + row] * b[column * 4 + 3];
    }
  }
  return out;
}

function mat4Translation(x, y, z) {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1
  ];
}

function mat4Scale(x, y, z) {
  return [
    x, 0, 0, 0,
    0, y, 0, 0,
    0, 0, z, 0,
    0, 0, 0, 1
  ];
}

function mat4RotationX(radians) {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [
    1, 0, 0, 0,
    0, c, s, 0,
    0, -s, c, 0,
    0, 0, 0, 1
  ];
}

function mat4RotationY(radians) {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [
    c, 0, -s, 0,
    0, 1, 0, 0,
    s, 0, c, 0,
    0, 0, 0, 1
  ];
}

function mat4RotationZ(radians) {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [
    c, s, 0, 0,
    -s, c, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ];
}

function mat4Ortho(left, right, bottom, top, near, far) {
  const lr = 1 / (left - right);
  const bt = 1 / (bottom - top);
  const nf = 1 / (near - far);
  return [
    -2 * lr, 0, 0, 0,
    0, -2 * bt, 0, 0,
    0, 0, 2 * nf, 0,
    (left + right) * lr, (top + bottom) * bt, (far + near) * nf, 1
  ];
}

function transformPoint4(m, x, y, z, w) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w
  ];
}

function invertMat4(a) {
  const out = new Array(16);
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;

  if (!det) return null;
  const invDet = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * invDet;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * invDet;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * invDet;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * invDet;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * invDet;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * invDet;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * invDet;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * invDet;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * invDet;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * invDet;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * invDet;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * invDet;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * invDet;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * invDet;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * invDet;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * invDet;
  return out;
}

function createProfile() {
  return {
    startedAt: now(),
    sections: new Map(),
    diagnostics: []
  };
}

function addDiagnostic(profile, level, message, details = {}) {
  if (!profile?.diagnostics) return;
  profile.diagnostics.push({
    level,
    message,
    details
  });
}

function addTraceDiagnostic(profile, message, details = {}) {
  if (!ENABLE_RUNTIME_TRACE) return;
  addDiagnostic(profile, 'info', message, details);
}

function timeSection(profile, name, action) {
  const start = now();
  try {
    return action();
  } finally {
    recordProfileSection(profile, name, now() - start);
  }
}

async function timeAsyncSection(profile, name, action) {
  const start = now();
  try {
    return await action();
  } finally {
    recordProfileSection(profile, name, now() - start);
  }
}

function recordProfileSection(profile, name, durationMs) {
  if (!profile) return;
  const entry = profile.sections.get(name) ?? { totalMs: 0, count: 0 };
  entry.totalMs += durationMs;
  entry.count += 1;
  profile.sections.set(name, entry);
}

function finalizeProfile(profile) {
  if (!profile) return null;
  const totalMs = now() - profile.startedAt;
  return {
    totalMs,
    sections: Array.from(profile.sections.entries())
      .map(([name, entry]) => ({
        name,
        totalMs: entry.totalMs,
        count: entry.count
      }))
  };
}

function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function summarizeNumericArray(values) {
  if (!values?.length) {
    return {
      count: 0,
      nonZeroCount: 0,
      min: 0,
      max: 0,
      sum: 0
    };
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let nonZeroCount = 0;

  for (const rawValue of values) {
    const value = Number(rawValue ?? 0);
    if (value !== 0) nonZeroCount += 1;
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }

  return {
    count: values.length,
    nonZeroCount,
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 0,
    sum
  };
}

function summarizeRgbaPixels(pixels) {
  if (!pixels?.length) {
    return { luma: '0.0', alpha: '0.0' };
  }

  const pixelCount = Math.floor(pixels.length / 4);
  const step = Math.max(1, Math.floor(pixelCount / 2048));
  let lumaTotal = 0;
  let alphaTotal = 0;
  let count = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += step) {
    const offset = pixel * 4;
    lumaTotal += ((pixels[offset] ?? 0) + (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0)) / 3;
    alphaTotal += pixels[offset + 3] ?? 255;
    count += 1;
  }

  return {
    luma: (lumaTotal / Math.max(count, 1)).toFixed(1),
    alpha: (alphaTotal / Math.max(count, 1)).toFixed(1)
  };
}
