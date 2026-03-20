import test from 'node:test';
import assert from 'node:assert/strict';

import { acquireOriginalBlob } from '../../src/shared/originalBlob.js';

test('acquireOriginalBlob should fetch Gemini asset urls through background', async () => {
  const backgroundBlob = new Blob(['background'], { type: 'image/png' });
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'https://lh3.googleusercontent.com/rd-gg/example=s1024',
    image: { id: 'fixture-image' },
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return backgroundBlob;
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return new Blob(['direct'], { type: 'image/png' });
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return new Blob(['capture'], { type: 'image/png' });
    }
  });

  assert.equal(blob, backgroundBlob);
  assert.deepEqual(calls, [
    ['background', 'https://lh3.googleusercontent.com/rd-gg/example=s1024']
  ]);
});

test('acquireOriginalBlob should fetch Gemini gg-dl asset urls through background', async () => {
  const backgroundBlob = new Blob(['background'], { type: 'image/png' });
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'https://lh3.googleusercontent.com/gg-dl/example=s1024-rj',
    image: { id: 'fixture-image' },
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return backgroundBlob;
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return new Blob(['direct'], { type: 'image/png' });
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return new Blob(['capture'], { type: 'image/png' });
    }
  });

  assert.equal(blob, backgroundBlob);
  assert.deepEqual(calls, [
    ['background', 'https://lh3.googleusercontent.com/gg-dl/example=s1024-rj']
  ]);
});

test('acquireOriginalBlob should fetch tiered Gemini gg download asset urls through background', async () => {
  const backgroundBlob = new Blob(['background'], { type: 'image/png' });
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'https://lh3.googleusercontent.com/gg-premium-dl/example=s1024-rj',
    image: { id: 'fixture-image' },
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return backgroundBlob;
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return new Blob(['direct'], { type: 'image/png' });
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return new Blob(['capture'], { type: 'image/png' });
    }
  });

  assert.equal(blob, backgroundBlob);
  assert.deepEqual(calls, [
    ['background', 'https://lh3.googleusercontent.com/gg-premium-dl/example=s1024-rj']
  ]);
});

test('acquireOriginalBlob should prefer visible capture for Gemini gg preview urls when available', async () => {
  const visibleBlob = new Blob(['visible-capture'], { type: 'image/png' });
  const fixtureImage = { id: 'fixture-image' };
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
    image: fixtureImage,
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return new Blob(['background'], { type: 'image/png' });
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return new Blob(['direct'], { type: 'image/png' });
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return new Blob(['capture'], { type: 'image/png' });
    },
    captureVisibleElementBlob: async (image) => {
      calls.push(['visible-capture', image]);
      return visibleBlob;
    }
  });

  assert.equal(blob, visibleBlob);
  assert.deepEqual(calls, [
    ['visible-capture', fixtureImage]
  ]);
});

test('acquireOriginalBlob should prefer visible capture for Gemini gg tiered preview urls when available', async () => {
  const visibleBlob = new Blob(['visible-capture'], { type: 'image/png' });
  const fixtureImage = { id: 'fixture-image' };
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'https://lh3.googleusercontent.com/gg-premium/example-token=s1024-rj',
    image: fixtureImage,
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return new Blob(['background'], { type: 'image/png' });
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return new Blob(['direct'], { type: 'image/png' });
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return new Blob(['capture'], { type: 'image/png' });
    },
    captureVisibleElementBlob: async (image) => {
      calls.push(['visible-capture', image]);
      return visibleBlob;
    }
  });

  assert.equal(blob, visibleBlob);
  assert.deepEqual(calls, [
    ['visible-capture', fixtureImage]
  ]);
});

test('acquireOriginalBlob should prefer visible capture for Gemini gg ultra preview urls when available', async () => {
  const visibleBlob = new Blob(['visible-capture'], { type: 'image/png' });
  const fixtureImage = { id: 'fixture-image' };
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'https://lh3.googleusercontent.com/gg-ultra/example-token=s1024-rj',
    image: fixtureImage,
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return new Blob(['background'], { type: 'image/png' });
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return new Blob(['direct'], { type: 'image/png' });
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return new Blob(['capture'], { type: 'image/png' });
    },
    captureVisibleElementBlob: async (image) => {
      calls.push(['visible-capture', image]);
      return visibleBlob;
    }
  });

  assert.equal(blob, visibleBlob);
  assert.deepEqual(calls, [
    ['visible-capture', fixtureImage]
  ]);
});

test('acquireOriginalBlob should fall back to rendered capture when Gemini gg visible capture fails', async () => {
  const renderedBlob = new Blob(['rendered-capture'], { type: 'image/png' });
  const fixtureImage = { id: 'fixture-image' };
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
    image: fixtureImage,
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return new Blob(['background'], { type: 'image/png' });
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return new Blob(['direct'], { type: 'image/png' });
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return renderedBlob;
    },
    captureVisibleElementBlob: async (image) => {
      calls.push(['visible-capture', image]);
      throw new Error('Visible capture rect too small');
    }
  });

  assert.equal(blob, renderedBlob);
  assert.deepEqual(calls, [
    ['visible-capture', fixtureImage],
    ['capture', fixtureImage]
  ]);
});

test('acquireOriginalBlob should fetch blob urls directly in the page context', async () => {
  const directBlob = new Blob(['direct'], { type: 'image/png' });
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'blob:https://gemini.google.com/1234',
    image: { id: 'fixture-image' },
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return new Blob(['background'], { type: 'image/png' });
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return directBlob;
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return new Blob(['capture'], { type: 'image/png' });
    }
  });

  assert.equal(blob, directBlob);
  assert.deepEqual(calls, [
    ['direct', 'blob:https://gemini.google.com/1234']
  ]);
});

test('acquireOriginalBlob should fetch data urls directly in the page context', async () => {
  const directBlob = new Blob(['direct'], { type: 'image/png' });
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'data:image/png;base64,AAAA',
    image: { id: 'fixture-image' },
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return new Blob(['background'], { type: 'image/png' });
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return directBlob;
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return new Blob(['capture'], { type: 'image/png' });
    }
  });

  assert.equal(blob, directBlob);
  assert.deepEqual(calls, [
    ['direct', 'data:image/png;base64,AAAA']
  ]);
});

test('acquireOriginalBlob should fall back to rendered capture for non-Gemini non-inline sources', async () => {
  const capturedBlob = new Blob(['capture'], { type: 'image/png' });
  const fixtureImage = { id: 'fixture-image' };
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'https://example.com/rendered.png',
    image: fixtureImage,
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return new Blob(['background'], { type: 'image/png' });
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return new Blob(['direct'], { type: 'image/png' });
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return capturedBlob;
    }
  });

  assert.equal(blob, capturedBlob);
  assert.deepEqual(calls, [
    ['capture', fixtureImage]
  ]);
});

test('acquireOriginalBlob should fall back to rendered capture for Gemini gg preview urls when visible capture is unavailable', async () => {
  const capturedBlob = new Blob(['capture'], { type: 'image/png' });
  const fixtureImage = { id: 'fixture-image' };
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
    image: fixtureImage,
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return invalidBlob;
    },
    fetchBlobDirect: async (url) => {
      calls.push(['direct', url]);
      return new Blob(['direct'], { type: 'image/png' });
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      return capturedBlob;
    }
  });

  assert.equal(blob, capturedBlob);
  assert.deepEqual(calls, [
    ['capture', fixtureImage]
  ]);
});

test('acquireOriginalBlob should still use visible capture when Gemini gg preview render capture would be tainted', async () => {
  const visibleBlob = new Blob(['visible-capture'], { type: 'image/png' });
  const fixtureImage = { id: 'fixture-image' };
  const calls = [];

  const blob = await acquireOriginalBlob({
    sourceUrl: 'https://lh3.googleusercontent.com/gg/example-token=s1024-rj',
    image: fixtureImage,
    fetchBlobFromBackground: async (url) => {
      calls.push(['background', url]);
      return new Blob(['background'], { type: 'image/png' });
    },
    fetchBlobDirect: async () => {
      throw new Error('direct fetch should not be used');
    },
    captureRenderedImageBlob: async (image) => {
      calls.push(['capture', image]);
      const error = new Error("Failed to execute 'toBlob' on 'HTMLCanvasElement': Tainted canvases may not be exported.");
      error.name = 'SecurityError';
      throw error;
    },
    captureVisibleElementBlob: async (image) => {
      calls.push(['visible-capture', image]);
      return visibleBlob;
    }
  });

  assert.equal(blob, visibleBlob);
  assert.deepEqual(calls, [
    ['visible-capture', fixtureImage]
  ]);
});
