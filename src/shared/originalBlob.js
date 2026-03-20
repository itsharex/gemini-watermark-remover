import { isGeminiGeneratedAssetUrl, isGeminiPreviewAssetUrl } from '../userscript/urlUtils.js';

export function shouldFetchBlobDirectly(sourceUrl) {
  return typeof sourceUrl === 'string'
    && (sourceUrl.startsWith('blob:') || sourceUrl.startsWith('data:'));
}

function isTaintedCanvasError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  const name = error instanceof Error ? error.name : '';
  return name === 'SecurityError' || /tainted canvases may not be exported/i.test(message);
}

function shouldPreferRenderedCapture(sourceUrl) {
  return isGeminiPreviewAssetUrl(sourceUrl);
}

async function captureWithFallback({
  image,
  captureRenderedImageBlob,
  captureVisibleElementBlob
}) {
  try {
    return await captureRenderedImageBlob(image);
  } catch (error) {
    if (typeof captureVisibleElementBlob === 'function' && isTaintedCanvasError(error)) {
      return captureVisibleElementBlob(image);
    }
    throw error;
  }
}

async function capturePreviewBlob({
  image,
  captureRenderedImageBlob,
  captureVisibleElementBlob
}) {
  let visibleCaptureError = null;

  if (typeof captureVisibleElementBlob === 'function') {
    try {
      return await captureVisibleElementBlob(image);
    } catch (error) {
      visibleCaptureError = error;
    }
  }

  if (typeof captureRenderedImageBlob === 'function') {
    return captureRenderedImageBlob(image);
  }

  throw visibleCaptureError || new Error('Preview capture unavailable');
}

export async function acquireOriginalBlob({
  sourceUrl,
  image,
  fetchBlobFromBackground,
  fetchBlobDirect,
  captureRenderedImageBlob,
  captureVisibleElementBlob,
  validateBlob
}) {
  const normalizedSourceUrl = typeof sourceUrl === 'string' ? sourceUrl.trim() : '';

  if (shouldPreferRenderedCapture(normalizedSourceUrl)) {
    return capturePreviewBlob({
      image,
      captureRenderedImageBlob,
      captureVisibleElementBlob
    });
  }

  if (isGeminiGeneratedAssetUrl(normalizedSourceUrl)) {
    const blob = await fetchBlobFromBackground(normalizedSourceUrl);
    if (typeof validateBlob === 'function') {
      try {
        await validateBlob(blob);
      } catch {
        return captureWithFallback({
          image,
          captureRenderedImageBlob,
          captureVisibleElementBlob
        });
      }
    }
    return blob;
  }

  if (shouldFetchBlobDirectly(normalizedSourceUrl)) {
    return fetchBlobDirect(normalizedSourceUrl);
  }

  return captureWithFallback({
    image,
    captureRenderedImageBlob,
    captureVisibleElementBlob
  });
}
