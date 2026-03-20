import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRootBatchProcessor,
  buildPreviewReplacementCandidates,
  fetchBlobFromBackground,
  hideProcessingOverlay,
  inferImageMimeTypeFromBytes,
  intersectCaptureRectWithViewport,
  requestVisibleTabCapture,
  resolvePreviewReplacementResult,
  resolveVisibleCaptureRect,
  shouldSkipPreviewProcessingFailure,
  shouldRetryVisibleCaptureError,
  shouldScheduleAttributeMutation,
  shouldScheduleMutationRoot,
  showProcessingOverlay,
  waitForRenderableImageSize
} from '../../src/shared/pageImageReplacement.js';

function createMockElement(tagName = 'div') {
  return {
    tagName: String(tagName).toUpperCase(),
    dataset: {},
    style: {},
    textContent: '',
    children: [],
    parentNode: null,
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) {
        this.children.splice(index, 1);
        child.parentNode = null;
      }
      return child;
    }
  };
}

test('resolveVisibleCaptureRect should prefer Gemini container rect when image rect is too small', () => {
  const container = {
    getBoundingClientRect() {
      return {
        left: 24,
        top: 36,
        width: 512,
        height: 512
      };
    }
  };

  const image = {
    parentElement: container,
    closest(selector) {
      return selector === 'generated-image,.generated-image-container'
        ? container
        : null;
    },
    getBoundingClientRect() {
      return {
        left: 28,
        top: 40,
        width: 8,
        height: 8
      };
    }
  };

  assert.deepEqual(resolveVisibleCaptureRect(image), {
    left: 24,
    top: 36,
    width: 512,
    height: 512
  });
});

test('resolveVisibleCaptureRect should keep image rect when it is already meaningful', () => {
  const container = {
    getBoundingClientRect() {
      return {
        left: 20,
        top: 30,
        width: 540,
        height: 540
      };
    }
  };

  const image = {
    parentElement: container,
    closest(selector) {
      return selector === 'generated-image,.generated-image-container'
        ? container
        : null;
    },
    getBoundingClientRect() {
      return {
        left: 42,
        top: 54,
        width: 480,
        height: 480
      };
    }
  };

  assert.deepEqual(resolveVisibleCaptureRect(image), {
    left: 42,
    top: 54,
    width: 480,
    height: 480
  });
});

test('resolveVisibleCaptureRect should crop to rendered image content box for object-fit contain previews', () => {
  const originalGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({
    objectFit: 'contain',
    objectPosition: '50% 50%'
  });

  try {
    const image = {
      naturalWidth: 1200,
      naturalHeight: 600,
      parentElement: null,
      closest: () => null,
      getBoundingClientRect() {
        return {
          left: 20,
          top: 40,
          width: 600,
          height: 600
        };
      }
    };

    assert.deepEqual(resolveVisibleCaptureRect(image), {
      left: 20,
      top: 190,
      width: 600,
      height: 300
    });
  } finally {
    globalThis.getComputedStyle = originalGetComputedStyle;
  }
});

test('intersectCaptureRectWithViewport should clip target rect to visible viewport', () => {
  assert.deepEqual(
    intersectCaptureRectWithViewport(
      {
        left: 20,
        top: 580,
        width: 500,
        height: 220
      },
      {
        left: 0,
        top: 0,
        width: 800,
        height: 640
      }
    ),
    {
      left: 20,
      top: 580,
      width: 500,
      height: 60
    }
  );
});

test('inferImageMimeTypeFromBytes should detect common image signatures', () => {
  assert.equal(
    inferImageMimeTypeFromBytes(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])),
    'image/png'
  );
  assert.equal(
    inferImageMimeTypeFromBytes(new Uint8Array([0xFF, 0xD8, 0xFF, 0xEE, 0, 0, 0, 0, 0, 0, 0, 0])),
    'image/jpeg'
  );
  assert.equal(
    inferImageMimeTypeFromBytes(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])),
    'image/webp'
  );
  assert.equal(
    inferImageMimeTypeFromBytes(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])),
    'image/avif'
  );
});

test('resolvePreviewReplacementResult should skip insufficient preview candidates and choose a confirmed one', async () => {
  const visibleBlob = new Blob(['visible'], { type: 'image/png' });
  const renderedBlob = new Blob(['rendered'], { type: 'image/png' });

  const result = await resolvePreviewReplacementResult({
    candidates: [
      { strategy: 'visible-capture' },
      { strategy: 'rendered-capture' }
    ],
    processCandidate: async (candidate) => {
      if (candidate.strategy === 'visible-capture') {
        return {
          processedBlob: visibleBlob,
          processedMeta: {
            applied: false
          }
        };
      }

      return {
        processedBlob: renderedBlob,
        processedMeta: {
          applied: true,
          processorPath: 'worker',
          size: 48,
          position: {
            x: 900,
            y: 900,
            width: 48,
            height: 48
          },
          source: 'validated-standard',
          detection: {
            originalSpatialScore: 0.24,
            processedSpatialScore: 0.08,
            suppressionGain: 0.35
          }
        }
      };
    }
  });

  assert.equal(result.strategy, 'rendered-capture');
  assert.equal(result.processedBlob, renderedBlob);
  assert.equal(result.diagnostics[0]?.processorPath, '');
  assert.equal(result.diagnostics[1]?.processorPath, 'worker');
  assert.match(result.diagnosticsSummary, /processor=worker/);
});

test('resolvePreviewReplacementResult should allow rendered capture as a safe fallback when visible capture is insufficient', async () => {
  const renderedBlob = new Blob(['rendered'], { type: 'image/png' });

  const result = await resolvePreviewReplacementResult({
    candidates: [
      { strategy: 'visible-capture' },
      { strategy: 'rendered-capture' }
    ],
    processCandidate: async (candidate) => {
      if (candidate.strategy === 'visible-capture') {
        return {
          processedBlob: new Blob(['visible'], { type: 'image/png' }),
          processedMeta: {
            applied: false
          }
        };
      }

      return {
        processedBlob: renderedBlob,
        processedMeta: {
          applied: false
        }
      };
    }
  });

  assert.equal(result.strategy, 'rendered-capture');
  assert.equal(result.processedBlob, renderedBlob);
});

test('resolvePreviewReplacementResult should throw when every preview candidate is insufficient', async () => {
  await assert.rejects(
    () => resolvePreviewReplacementResult({
      candidates: [
        { strategy: 'visible-capture' }
      ],
      processCandidate: async () => ({
        processedBlob: new Blob(['noop'], { type: 'image/png' }),
        processedMeta: {
          applied: false
        }
      })
    }),
    /No confirmed Gemini preview candidate succeeded/
  );
});

test('resolvePreviewReplacementResult should not accept visible capture only because the blob is large', async () => {
  const largeVisibleBlob = new Blob([new Uint8Array(160 * 1024)], { type: 'image/png' });

  await assert.rejects(
    () => resolvePreviewReplacementResult({
      candidates: [
        { strategy: 'visible-capture' }
      ],
      processCandidate: async () => ({
        processedBlob: largeVisibleBlob,
        processedMeta: {
          applied: false
        },
        sourceBlobType: 'image/png',
        sourceBlobSize: largeVisibleBlob.size
      })
    }),
    /No confirmed Gemini preview candidate succeeded/
  );
});

test('resolvePreviewReplacementResult should surface safe fallback errors instead of masking them as insufficient', async () => {
  await assert.rejects(
    async () => {
      await resolvePreviewReplacementResult({
        candidates: [
          { strategy: 'visible-capture' },
          { strategy: 'rendered-capture' }
        ],
        processCandidate: async (candidate) => {
          if (candidate.strategy === 'visible-capture') {
            return {
              processedBlob: new Blob(['visible'], { type: 'image/png' }),
              processedMeta: {
                applied: false
              }
            };
          }

          throw new Error('Rendered capture tainted');
        }
      });
    },
    /Rendered capture tainted/
  );
});

test('resolvePreviewReplacementResult should allow visible capture as a last resort when stronger preview candidates fail', async () => {
  const visibleBlob = new Blob(['visible'], { type: 'image/png' });

  const result = await resolvePreviewReplacementResult({
    candidates: [
      { strategy: 'background-fetch' },
      { strategy: 'page-fetch' },
      { strategy: 'visible-capture' },
      { strategy: 'rendered-capture' }
    ],
    processCandidate: async (candidate) => {
      if (candidate.strategy === 'visible-capture') {
        return {
          processedBlob: visibleBlob,
          processedMeta: {
            applied: false
          },
          sourceBlobType: 'image/png',
          sourceBlobSize: visibleBlob.size
        };
      }

      if (candidate.strategy === 'background-fetch') {
        throw new Error('Failed to decode Gemini image blob');
      }

      if (candidate.strategy === 'page-fetch') {
        throw new Error('Failed to fetch');
      }

      throw new Error("Failed to execute 'toBlob' on 'HTMLCanvasElement': Tainted canvases may not be exported.");
    }
  });

  assert.equal(result.strategy, 'visible-capture');
  assert.equal(result.processedBlob, visibleBlob);
  assert.match(result.diagnosticsSummary, /background-fetch,error/);
  assert.match(result.diagnosticsSummary, /visible-capture,insufficient/);
});

test('resolvePreviewReplacementResult should include source blob metadata for candidate errors', async () => {
  await assert.rejects(
    async () => {
      await resolvePreviewReplacementResult({
        candidates: [
          { strategy: 'background-fetch' }
        ],
        processCandidate: async () => {
          const error = new Error('Failed to decode Gemini image blob');
          error.sourceBlobType = 'image/heic';
          error.sourceBlobSize = 245760;
          throw error;
        }
      });
    },
    (error) => {
      assert.equal(error?.candidateDiagnostics?.[0]?.strategy, 'background-fetch');
      assert.equal(error?.candidateDiagnostics?.[0]?.sourceBlobType, 'image/heic');
      assert.equal(error?.candidateDiagnostics?.[0]?.sourceBlobSize, 245760);
      assert.match(error?.candidateDiagnosticsSummary || '', /sourceType=image\/heic/);
      assert.match(error?.candidateDiagnosticsSummary || '', /sourceSize=245760/);
      return true;
    }
  );
});

test('buildPreviewReplacementCandidates should prefer page fetch bridge for preview urls when runtime messaging is unavailable', async () => {
  const image = { id: 'fixture-image' };
  const renderedBlob = new Blob(['rendered'], { type: 'image/png' });
  const sourceUrl = 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj';

  const candidates = buildPreviewReplacementCandidates({
    imageElement: image,
    sourceUrl,
    sendRuntimeMessage: null,
    captureRenderedImageBlob: async (targetImage) => {
      assert.equal(targetImage, image);
      return renderedBlob;
    }
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.strategy),
    ['page-fetch', 'rendered-capture']
  );
  assert.equal(await candidates[1].getOriginalBlob(), renderedBlob);
});

test('buildPreviewReplacementCandidates should prefer background fetch and avoid page fetch and visible capture when runtime messaging is available', async () => {
  const image = { id: 'fixture-image' };
  const sourceUrl = 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj';
  const normalizedSourceUrl = 'https://lh3.googleusercontent.com/gg/example-token=s0-rj';
  const renderedBlob = new Blob(['rendered'], { type: 'image/png' });
  const runtimeMessages = [];

  const candidates = buildPreviewReplacementCandidates({
    imageElement: image,
    sourceUrl,
    sendRuntimeMessage: async (message) => {
      runtimeMessages.push(message);
      return {
        ok: true,
        buffer: new TextEncoder().encode('background-fetch').buffer,
        mimeType: 'image/webp'
      };
    },
    fetchPreviewBlob: async (url) => {
      assert.equal(url, normalizedSourceUrl);
      return pageFetchedBlob;
    },
    captureRenderedImageBlob: async (targetImage) => {
      assert.equal(targetImage, image);
      return renderedBlob;
    }
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.strategy),
    ['background-fetch', 'rendered-capture']
  );
  const backgroundBlob = await candidates[0].getOriginalBlob();
  assert.equal(backgroundBlob.type, 'image/webp');
  assert.equal(
    new TextDecoder().decode(await backgroundBlob.arrayBuffer()),
    'background-fetch'
  );
  assert.deepEqual(runtimeMessages, [{
    type: 'gwr:fetch-image',
    url: normalizedSourceUrl
  }]);
  assert.equal(await candidates[1].getOriginalBlob(), renderedBlob);
});

test('buildPreviewReplacementCandidates should still prefer background fetch and skip page fetch and visible capture when using the default page bridge', async () => {
  const sourceUrl = 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj';
  const normalizedSourceUrl = 'https://lh3.googleusercontent.com/gg/example-token=s0-rj';
  const runtimeMessages = [];

  const candidates = buildPreviewReplacementCandidates({
    imageElement: { id: 'fixture-image' },
    sourceUrl,
    sendRuntimeMessage: async (message) => {
      runtimeMessages.push(message);
      return {
        ok: true,
        buffer: new TextEncoder().encode('background-fetch').buffer,
        mimeType: 'image/png'
      };
    },
    captureRenderedImageBlob: async () => new Blob(['rendered'], { type: 'image/png' })
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.strategy),
    ['background-fetch', 'rendered-capture']
  );

  await candidates[0].getOriginalBlob();

  assert.deepEqual(runtimeMessages, [{
    type: 'gwr:fetch-image',
    url: normalizedSourceUrl
  }]);
});

test('shouldScheduleMutationRoot should ignore irrelevant added nodes', () => {
  assert.equal(shouldScheduleMutationRoot(null), false);
  assert.equal(shouldScheduleMutationRoot({ tagName: 'SPAN' }), false);
  assert.equal(shouldScheduleMutationRoot({
    tagName: 'DIV',
    matches: () => false,
    querySelector: () => null
  }), false);

  assert.equal(shouldScheduleMutationRoot({ tagName: 'IMG' }), true);
  assert.equal(shouldScheduleMutationRoot({
    tagName: 'GENERATED-IMAGE',
    matches: () => true
  }), true);
  assert.equal(shouldScheduleMutationRoot({
    tagName: 'DIV',
    matches: () => false,
    querySelector: () => ({ tagName: 'GENERATED-IMAGE' })
  }), true);
});

test('shouldScheduleAttributeMutation should ignore self-written processed blob src updates', () => {
  assert.equal(shouldScheduleAttributeMutation({
    dataset: {
      gwrWatermarkObjectUrl: 'blob:https://gemini.google.com/processed',
      gwrStableSource: 'https://lh3.googleusercontent.com/rd-gg/example=s1024'
    },
    currentSrc: 'blob:https://gemini.google.com/processed',
    src: 'blob:https://gemini.google.com/processed'
  }, 'src'), false);
});

test('shouldScheduleAttributeMutation should still react to meaningful source changes', () => {
  assert.equal(shouldScheduleAttributeMutation({
    dataset: {
      gwrWatermarkObjectUrl: 'blob:https://gemini.google.com/processed',
      gwrStableSource: 'https://lh3.googleusercontent.com/rd-gg/example=s1024'
    },
    currentSrc: 'https://lh3.googleusercontent.com/rd-gg/example=s2048',
    src: 'https://lh3.googleusercontent.com/rd-gg/example=s2048'
  }, 'src'), true);
  assert.equal(shouldScheduleAttributeMutation({
    dataset: {
      gwrStableSource: 'https://lh3.googleusercontent.com/rd-gg/example=s1024'
    }
  }, 'data-gwr-stable-source'), false);
});

test('createRootBatchProcessor should batch multiple schedule calls behind one flush', () => {
  const scheduledCallbacks = [];
  const processedRoots = [];
  const batchProcessor = createRootBatchProcessor({
    processRoot(root) {
      processedRoots.push(root);
    },
    scheduleFlush(callback) {
      scheduledCallbacks.push(callback);
    }
  });

  batchProcessor.schedule('root-a');
  batchProcessor.schedule('root-b');
  batchProcessor.schedule('root-a');

  assert.equal(scheduledCallbacks.length, 1);
  assert.deepEqual(processedRoots, []);

  scheduledCallbacks[0]();

  assert.deepEqual(processedRoots, ['root-a', 'root-b']);
});

test('createRootBatchProcessor should schedule a new flush after the previous one finishes', () => {
  const scheduledCallbacks = [];
  const processedRoots = [];
  const batchProcessor = createRootBatchProcessor({
    processRoot(root) {
      processedRoots.push(root);
    },
    scheduleFlush(callback) {
      scheduledCallbacks.push(callback);
    }
  });

  batchProcessor.schedule('root-a');
  scheduledCallbacks[0]();
  batchProcessor.schedule('root-b');

  assert.equal(scheduledCallbacks.length, 2);

  scheduledCallbacks[1]();

  assert.deepEqual(processedRoots, ['root-a', 'root-b']);
});

test('createRootBatchProcessor should ignore descendant roots when an ancestor is already pending', () => {
  const scheduledCallbacks = [];
  const processedRoots = [];
  const root = {
    name: 'root',
    contains(node) {
      return node === child;
    }
  };
  const child = {
    name: 'child',
    contains() {
      return false;
    }
  };
  const batchProcessor = createRootBatchProcessor({
    processRoot(rootNode) {
      processedRoots.push(rootNode.name);
    },
    scheduleFlush(callback) {
      scheduledCallbacks.push(callback);
    }
  });

  batchProcessor.schedule(root);
  batchProcessor.schedule(child);
  scheduledCallbacks[0]();

  assert.deepEqual(processedRoots, ['root']);
});

test('createRootBatchProcessor should replace pending descendants when a parent root arrives later', () => {
  const scheduledCallbacks = [];
  const processedRoots = [];
  const root = {
    name: 'root',
    contains(node) {
      return node === child;
    }
  };
  const child = {
    name: 'child',
    contains() {
      return false;
    }
  };
  const batchProcessor = createRootBatchProcessor({
    processRoot(rootNode) {
      processedRoots.push(rootNode.name);
    },
    scheduleFlush(callback) {
      scheduledCallbacks.push(callback);
    }
  });

  batchProcessor.schedule(child);
  batchProcessor.schedule(root);
  scheduledCallbacks[0]();

  assert.deepEqual(processedRoots, ['root']);
});

test('fetchBlobFromBackground should use provided page fetcher when runtime messaging is unavailable', async () => {
  const fetchedBlob = new Blob(['gm-fetch'], { type: 'image/webp' });
  const calls = [];

  const blob = await fetchBlobFromBackground(
    null,
    'https://lh3.googleusercontent.com/gg-dl/example-token=s0-rj',
    async (url) => {
      calls.push(url);
      return fetchedBlob;
    }
  );

  assert.equal(blob, fetchedBlob);
  assert.deepEqual(calls, [
    'https://lh3.googleusercontent.com/gg-dl/example-token=s0-rj'
  ]);
});

test('fetchBlobFromBackground should prefer inferred image type when runtime response mime disagrees with bytes', async () => {
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4E, 0x47,
    0x0D, 0x0A, 0x1A, 0x0A,
    0x00, 0x00, 0x00, 0x0D
  ]);

  const blob = await fetchBlobFromBackground(
    async () => ({
      ok: true,
      buffer: pngBytes.buffer,
      mimeType: 'image/jpeg'
    }),
    'https://lh3.googleusercontent.com/gg/example-token=s0-rj'
  );

  assert.equal(blob.type, 'image/png');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), pngBytes);
});

test('shouldRetryVisibleCaptureError should classify transient viewport capture failures as retryable', () => {
  assert.equal(shouldRetryVisibleCaptureError(new Error('Visible capture rect outside screenshot bounds')), true);
  assert.equal(shouldRetryVisibleCaptureError(new Error('Visible capture rect too small')), true);
  assert.equal(shouldRetryVisibleCaptureError(new Error('Failed to load captured screenshot')), true);
  assert.equal(shouldRetryVisibleCaptureError(new Error('Visible-tab capture unavailable')), false);
});

test('shouldSkipPreviewProcessingFailure should skip previews when fetch is forbidden and rendered capture is tainted', () => {
  assert.equal(shouldSkipPreviewProcessingFailure([
    {
      strategy: 'background-fetch',
      status: 'error',
      error: 'Failed to fetch image: 403'
    },
    {
      strategy: 'rendered-capture',
      status: 'error',
      error: "Failed to execute 'toBlob' on 'HTMLCanvasElement': Tainted canvases may not be exported."
    }
  ]), true);

  assert.equal(shouldSkipPreviewProcessingFailure([
    {
      strategy: 'background-fetch',
      status: 'error',
      error: 'Failed to decode Gemini image blob'
    },
    {
      strategy: 'rendered-capture',
      status: 'error',
      error: "Failed to execute 'toBlob' on 'HTMLCanvasElement': Tainted canvases may not be exported."
    }
  ]), false);
});

test('requestVisibleTabCapture should reuse an in-flight screenshot request', async () => {
  const runtimeCalls = [];
  let releaseRequest = null;

  const sendRuntimeMessage = () => {
    runtimeCalls.push('capture');
    return new Promise((resolve) => {
      releaseRequest = () => resolve({ dataUrl: 'data:image/png;base64,AAAA' });
    });
  };

  const firstPromise = requestVisibleTabCapture(sendRuntimeMessage, {
    forceRefresh: true,
    cacheTtlMs: 1000,
    now: () => 100
  });
  const secondPromise = requestVisibleTabCapture(sendRuntimeMessage, {
    cacheTtlMs: 1000,
    now: () => 100
  });

  assert.equal(runtimeCalls.length, 1);

  releaseRequest();

  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(first, 'data:image/png;base64,AAAA');
  assert.equal(second, 'data:image/png;base64,AAAA');
});

test('requestVisibleTabCapture should reuse a fresh cached screenshot until ttl expires', async () => {
  const runtimeCalls = [];
  const sendRuntimeMessage = async () => {
    runtimeCalls.push('capture');
    return {
      dataUrl: `data:image/png;base64,${runtimeCalls.length}`
    };
  };

  const first = await requestVisibleTabCapture(sendRuntimeMessage, {
    forceRefresh: true,
    cacheTtlMs: 1000,
    now: () => 100
  });
  const second = await requestVisibleTabCapture(sendRuntimeMessage, {
    cacheTtlMs: 1000,
    now: () => 600
  });
  const third = await requestVisibleTabCapture(sendRuntimeMessage, {
    cacheTtlMs: 1000,
    now: () => 1501
  });

  assert.equal(first, 'data:image/png;base64,1');
  assert.equal(second, 'data:image/png;base64,1');
  assert.equal(third, 'data:image/png;base64,2');
  assert.equal(runtimeCalls.length, 2);
});

test('showProcessingOverlay should append one overlay and apply a subdued processing look to the image', () => {
  const container = createMockElement('div');
  const image = createMockElement('img');
  image.style.filter = 'contrast(1.1)';

  const createdElements = [];
  const createElement = (tagName) => {
    const element = createMockElement(tagName);
    createdElements.push(element);
    return element;
  };

  showProcessingOverlay(image, {
    container,
    createElement
  });
  showProcessingOverlay(image, {
    container,
    createElement
  });

  assert.equal(container.children.length, 1);
  assert.equal(createdElements.length, 1);
  assert.equal(container.children[0].dataset.gwrProcessingOverlay, 'true');
  assert.equal(container.children[0].textContent, 'Processing...');
  assert.match(image.style.filter, /blur/);
  assert.match(image.style.filter, /brightness/);
  assert.match(image.style.filter, /contrast\(1\.1\)/);
});

test('hideProcessingOverlay should remove overlay and restore the previous image filter', () => {
  const container = createMockElement('div');
  const image = createMockElement('img');
  image.style.filter = 'saturate(1.2)';

  showProcessingOverlay(image, {
    container,
    createElement: createMockElement
  });

  hideProcessingOverlay(image, {
    removeImmediately: true
  });

  assert.equal(container.children.length, 0);
  assert.equal(image.style.filter, 'saturate(1.2)');
  assert.equal(image.dataset.gwrProcessingVisual, undefined);
});

test('hideProcessingOverlay should fade the overlay out before removing it by default', () => {
  const container = createMockElement('div');
  const image = createMockElement('img');
  const timers = [];

  showProcessingOverlay(image, {
    container,
    createElement: createMockElement
  });

  hideProcessingOverlay(image, {
    setTimeoutImpl(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    }
  });

  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].style.opacity, '0');
  assert.equal(timers.length, 1);
  assert.ok(timers[0].delay > 0);

  timers[0].callback();

  assert.equal(container.children.length, 0);
  assert.equal(image.dataset.gwrProcessingVisual, undefined);
});

test('stale hide callback should not remove an overlay that has been shown again', () => {
  const container = createMockElement('div');
  const image = createMockElement('img');
  const timers = [];

  showProcessingOverlay(image, {
    container,
    createElement: createMockElement
  });

  hideProcessingOverlay(image, {
    setTimeoutImpl(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    }
  });

  showProcessingOverlay(image, {
    container,
    createElement: createMockElement,
    clearTimeoutImpl() {
      // Simulate a timer that can no longer be reliably cancelled.
    }
  });

  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].style.opacity, '1');

  timers[0].callback();

  assert.equal(container.children.length, 1);
  assert.equal(image.dataset.gwrProcessingVisual, 'true');
});

test('hideProcessingOverlay should not overwrite container position changed by page code during processing', () => {
  const container = createMockElement('div');
  const image = createMockElement('img');

  showProcessingOverlay(image, {
    container,
    createElement: createMockElement
  });

  container.style.position = 'sticky';

  hideProcessingOverlay(image, {
    removeImmediately: true
  });

  assert.equal(container.style.position, 'sticky');
});

test('waitForRenderableImageSize should wait for preview images that become renderable on the next frame', async () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const image = {
    naturalWidth: 0,
    naturalHeight: 0,
    width: 0,
    height: 0,
    clientWidth: 0,
    clientHeight: 0
  };

  globalThis.requestAnimationFrame = (callback) => {
    image.naturalWidth = 1024;
    image.naturalHeight = 1024;
    image.clientWidth = 512;
    image.clientHeight = 512;
    setTimeout(() => callback(16), 0);
    return 1;
  };

  try {
    await assert.doesNotReject(() => waitForRenderableImageSize(image, 50));
  } finally {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  }
});
