import assert from 'node:assert/strict';
import test from 'node:test';

import { renderFilterPreview } from '../src/filter-runtime.js';

test('ctx:getAsset returns image asset runtime objects in preview', async () => {
  installImageDecodeStubs({ width: 2, height: 1 });

  const asset = { id: 'logo', path: 'assets/logo.png', type: 'image' };
  const compiledManifest = {
    kind: 'filter',
    formatVersion: '1.0.0',
    sourceSchemaVersion: '1.0.0',
    runtimeVersion: 1,
    outputSizeMode: 'passive',
    mainScript: 'main.lua',
    passes: [],
    assets: [asset]
  };
  const sourceManifest = {
    schemaVersion: '1.0.0',
    runtimeVersion: 1,
    passes: [],
    assets: [asset]
  };

  const result = await renderFilterPreview({
    compiledFiles: {
      'manifest.json': JSON.stringify(compiledManifest),
      'main.lua': [
        'function onReset(ctx) end',
        'function advance(ctx)',
        '  local logo = ctx:getAsset("logo")',
        '  if logo:getWidth() ~= 2 then error("wrong logo width") end',
        '  if logo:getHeight() ~= 1 then error("wrong logo height") end',
        'end'
      ].join('\n'),
      'assets/logo.png': new Uint8Array([137, 80, 78, 71])
    },
    workspace: {
      getFile(filePath) {
        if (filePath === 'manifest.json') {
          return { path: filePath, content: JSON.stringify(sourceManifest) };
        }
        return null;
      }
    },
    canvas: { width: 16, height: 16 },
    parameterValues: {}
  });

  assert.equal(result.width, 16);
  assert.equal(result.height, 16);
});

test('ctx:getAsset returns video asset runtime objects in preview', async () => {
  const stubs = installVideoAssetStubs({ width: 4, height: 3, duration: 2 });

  try {
    const asset = { id: 'snow', path: 'assets/snow.mp4', type: 'video' };
    const compiledManifest = {
      kind: 'filter',
      formatVersion: '1.0.0',
      sourceSchemaVersion: '1.0.0',
      runtimeVersion: 1,
      outputSizeMode: 'passive',
      mainScript: 'main.lua',
      passes: [],
      assets: [asset]
    };
    const sourceManifest = {
      schemaVersion: '1.0.0',
      runtimeVersion: 1,
      passes: [],
      assets: [asset]
    };

    const result = await renderFilterPreview({
      compiledFiles: {
        'manifest.json': JSON.stringify(compiledManifest),
        'main.lua': [
          'function onReset(ctx) end',
          'function advance(ctx)',
          '  local snow = ctx:getAsset("snow")',
          '  if snow:getWidth() ~= 4 then error("wrong snow width") end',
          '  if snow:getHeight() ~= 3 then error("wrong snow height") end',
          '  snow:seek(2)',
          '  snow:nextFrame()',
          'end'
        ].join('\n'),
        'assets/snow.mp4': new Uint8Array([0, 0, 0, 24])
      },
      workspace: {
        getFile(filePath) {
          if (filePath === 'manifest.json') {
            return { path: filePath, content: JSON.stringify(sourceManifest) };
          }
          return null;
        }
      },
      canvas: { width: 16, height: 16 },
      parameterValues: {}
    });

    assert.equal(result.width, 16);
    assert.equal(result.height, 16);
  } finally {
    stubs.restore();
  }
});

test('ctx:getAsset reuses video asset objects across preview renders', async () => {
  const stubs = installVideoAssetStubs({ width: 4, height: 3, duration: 2 });

  const asset = { id: 'snow', path: 'assets/snow.mp4', type: 'video' };
  const compiledFiles = {
    'manifest.json': JSON.stringify({
      kind: 'filter',
      formatVersion: '1.0.0',
      sourceSchemaVersion: '1.0.0',
      runtimeVersion: 1,
      outputSizeMode: 'passive',
      mainScript: 'main.lua',
      passes: [],
      assets: [asset]
    }),
    'main.lua': [
      'function onReset(ctx) end',
      'function advance(ctx)',
      '  ctx:getAsset("snow"):nextFrame()',
      'end'
    ].join('\n'),
    'assets/snow.mp4': new Uint8Array([0, 0, 0, 24])
  };
  const workspace = {
    getFile(filePath) {
      if (filePath === 'manifest.json') {
        return {
          path: filePath,
          content: JSON.stringify({
            schemaVersion: '1.0.0',
            runtimeVersion: 1,
            passes: [],
            assets: [asset]
          })
        };
      }
      return null;
    }
  };

  try {
    await renderFilterPreview({ compiledFiles, workspace, canvas: { width: 16, height: 16 }, parameterValues: {} });
    await renderFilterPreview({ compiledFiles, workspace, canvas: { width: 16, height: 16 }, parameterValues: {} });

    assert.equal(stubs.videoCreateCount(), 1);
  } finally {
    stubs.restore();
  }
});

test('preview reports a clear error when WebGPU canvas context is unavailable', async () => {
  const restoreNavigator = installWebGpuStub();
  const restoreConsoleWarn = silenceConsoleWarn();

  try {
    await assert.rejects(
      () => renderFilterPreview({
        compiledFiles: {
          'manifest.json': JSON.stringify({
            kind: 'filter',
            formatVersion: '1.0.0',
            sourceSchemaVersion: '1.0.0',
            runtimeVersion: 1,
            outputSizeMode: 'passive',
            mainScript: 'main.lua',
            passes: [
              {
                id: 'noop',
                type: 'compute',
                stages: {
                  compute: 'shaders/noop.comp.wgsl'
                },
                localSize: { x: 1, y: 1, z: 1 },
                bindings: []
              }
            ],
            assets: []
          }),
          'main.lua': [
            'function onReset(ctx) end',
            'function advance(ctx)',
            '  ctx:runComputePass("noop", {}, { 1 })',
            'end'
          ].join('\n'),
          'shaders/noop.comp.wgsl': '@compute @workgroup_size(1) fn main() {}'
        },
        workspace: {
          getFile(filePath) {
            if (filePath === 'manifest.json') {
              return {
                path: filePath,
                content: JSON.stringify({
                  schemaVersion: '1.0.0',
                  runtimeVersion: 1,
                  passes: []
                })
              };
            }
            return null;
          }
        },
        canvas: {
          width: 16,
          height: 16,
          getContext() {
            return null;
          }
        },
        parameterValues: {}
      }),
      /WebGPU canvas context unavailable/
    );
  } finally {
    restoreConsoleWarn();
    restoreNavigator();
  }
});

function installImageDecodeStubs({ width, height }) {
  globalThis.createImageBitmap = async () => ({
    width,
    height,
    close() {}
  });

  globalThis.document = {
    createElement(tagName) {
      assert.equal(tagName, 'canvas');
      return {
        width: 0,
        height: 0,
        getContext(kind) {
          assert.equal(kind, '2d');
          return {
            drawImage() {},
            getImageData(_x, _y, imageWidth, imageHeight) {
              return {
                data: new Uint8ClampedArray(imageWidth * imageHeight * 4)
              };
            }
          };
        }
      };
    }
  };
}

function installVideoAssetStubs({ width, height, duration }) {
  let createdVideos = 0;
  const previousDocument = globalThis.document;
  const previousCreateObjectUrl = URL.createObjectURL;

  URL.createObjectURL = () => 'blob:video-asset';
  globalThis.document = {
    createElement(tagName) {
      if (tagName === 'video') {
        createdVideos += 1;
        return {
          muted: false,
          loop: false,
          autoplay: false,
          playsInline: false,
          preload: '',
          src: '',
          readyState: 2,
          videoWidth: width,
          videoHeight: height,
          duration,
          paused: false,
          currentTime: 0,
          play() {
            this.paused = false;
            return Promise.resolve();
          },
          pause() {
            this.paused = true;
          },
          addEventListener() {},
          removeEventListener() {}
        };
      }

      assert.equal(tagName, 'canvas');
      return {
        width: 0,
        height: 0,
        getContext(kind) {
          assert.equal(kind, '2d');
          return {
            drawImage() {},
            getImageData(_x, _y, imageWidth, imageHeight) {
              return {
                data: new Uint8ClampedArray(imageWidth * imageHeight * 4)
              };
            }
          };
        }
      };
    }
  };

  return {
    videoCreateCount() {
      return createdVideos;
    },
    restore() {
      URL.createObjectURL = previousCreateObjectUrl;
      globalThis.document = previousDocument;
    }
  };
}

function installWebGpuStub() {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      gpu: {
        async requestAdapter() {
          return {
            async requestDevice() {
              return {};
            }
          };
        },
        getPreferredCanvasFormat() {
          return 'rgba8unorm';
        }
      }
    }
  });

  return () => {
    if (previousDescriptor) {
      Object.defineProperty(globalThis, 'navigator', previousDescriptor);
    } else {
      delete globalThis.navigator;
    }
  };
}

function silenceConsoleWarn() {
  const previousWarn = console.warn;
  console.warn = () => {};
  return () => {
    console.warn = previousWarn;
  };
}
