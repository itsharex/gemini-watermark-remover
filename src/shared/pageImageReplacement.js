import { canvasToBlob } from '../core/canvasBlob.js';
import { classifyGeminiAttributionFromWatermarkMeta } from '../core/watermarkDecisionPolicy.js';
import {
  isGeminiPreviewAssetUrl,
  normalizeGoogleusercontentImageUrl
} from '../userscript/urlUtils.js';
import { normalizeErrorMessage } from './errorUtils.js';
import { acquireOriginalBlob } from './originalBlob.js';
import {
  getGeminiImageContainerSelector,
  getGeminiImageQuerySelector,
  getPreferredGeminiImageContainer,
  isProcessableGeminiImageElement,
  resolveCandidateImageUrl
} from './domAdapter.js';
import { loadImageFromBlob, processWatermarkBlob, removeWatermarkFromBlob } from './imageProcessing.js';

const PAGE_IMAGE_STATE_KEY = 'gwrPageImageState';
const PAGE_IMAGE_SOURCE_KEY = 'gwrPageImageSource';
const PAGE_IMAGE_OBJECT_URL_KEY = 'gwrWatermarkObjectUrl';
const PROCESSING_OVERLAY_DATA_KEY = 'gwrProcessingOverlay';
const PROCESSING_VISUAL_DATA_KEY = 'gwrProcessingVisual';
const OBSERVED_ATTRIBUTES = ['src', 'srcset', 'data-gwr-source-url'];
const PAGE_FETCH_REQUEST = 'gwr:page-fetch-request';
const PAGE_FETCH_RESPONSE = 'gwr:page-fetch-response';
const MIN_VISIBLE_CAPTURE_EDGE = 32;
const MIN_VISIBLE_CAPTURE_AREA = MIN_VISIBLE_CAPTURE_EDGE * MIN_VISIBLE_CAPTURE_EDGE;
const CONTAINER_CAPTURE_AREA_RATIO = 4;
const PROCESSING_OVERLAY_FADE_MS = 180;
const VISIBLE_TAB_CAPTURE_CACHE_TTL_MS = 1000;

const processingOverlayState = new WeakMap();
const visibleTabCaptureState = {
  dataUrl: '',
  capturedAt: 0,
  inFlightPromise: null
};

function appendLog(onLog, type, payload = {}) {
  if (typeof onLog === 'function') {
    onLog(type, payload);
  }
}

function isGeminiPreviewUrl(url) {
  return isGeminiPreviewAssetUrl(url);
}

function buildRuntimeMessageSender(runtime = globalThis.chrome?.runtime) {
  if (!runtime?.sendMessage) {
    return null;
  }

  return (message) => new Promise((resolve, reject) => {
    try {
      runtime.sendMessage(message, (response) => {
        const runtimeError = runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || 'Runtime message failed'));
          return;
        }
        if (!response) {
          reject(new Error('Runtime message returned empty response'));
          return;
        }
        if (response.ok === false) {
          reject(new Error(normalizeErrorMessage(response.error, 'Runtime message failed')));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function fetchBlobDirect(url) {
  const response = await fetch(url, {
    credentials: 'omit',
    redirect: 'follow'
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }
  return response.blob();
}

function hasBytePrefix(bytes, prefix) {
  if (!bytes || bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) {
      return false;
    }
  }
  return true;
}

export function inferImageMimeTypeFromBytes(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || 0);
  if (bytes.length < 12) return '';

  if (hasBytePrefix(bytes, [0x89, 0x50, 0x4E, 0x47])) {
    return 'image/png';
  }

  if (hasBytePrefix(bytes, [0xFF, 0xD8, 0xFF])) {
    return 'image/jpeg';
  }

  if (
    hasBytePrefix(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  if (
    hasBytePrefix(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    hasBytePrefix(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return 'image/gif';
  }

  if (hasBytePrefix(bytes, [0x42, 0x4D])) {
    return 'image/bmp';
  }

  if (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const majorBrand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
    if (majorBrand.startsWith('avi')) {
      return 'image/avif';
    }
  }

  return '';
}

function resolveFetchedImageMimeType(mimeType, buffer) {
  const normalizedMimeType = typeof mimeType === 'string'
    ? mimeType.split(';')[0].trim().toLowerCase()
    : '';
  const inferredMimeType = inferImageMimeTypeFromBytes(buffer);

  if (inferredMimeType) {
    if (!normalizedMimeType || normalizedMimeType === 'application/octet-stream') {
      return inferredMimeType;
    }
    if (normalizedMimeType !== inferredMimeType) {
      return inferredMimeType;
    }
  }

  return normalizedMimeType || inferredMimeType || 'image/png';
}

export async function fetchBlobFromBackground(sendRuntimeMessage, url, fallbackFetchBlob = null) {
  if (!sendRuntimeMessage) {
    if (typeof fallbackFetchBlob === 'function') {
      return fallbackFetchBlob(url);
    }
    return fetchBlobDirect(url);
  }

  const response = await sendRuntimeMessage({
    type: 'gwr:fetch-image',
    url
  });
  const blobMimeType = resolveFetchedImageMimeType(response.mimeType, response.buffer);
  return new Blob([response.buffer], { type: blobMimeType });
}

let pageFetchRequestCounter = 0;

async function fetchBlobViaPageBridge(url, timeoutMs = 15000) {
  if (typeof window === 'undefined' || typeof window.postMessage !== 'function' || typeof window.addEventListener !== 'function') {
    throw new Error('Page fetch bridge unavailable');
  }

  const requestId = `gwr-page-fetch-${Date.now()}-${pageFetchRequestCounter += 1}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', handleMessage);
      globalThis.clearTimeout(timeoutId);
    };

    const handleMessage = (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== PAGE_FETCH_RESPONSE) return;
      if (event.data?.requestId !== requestId) return;

      cleanup();

      if (event.data?.ok === false) {
        reject(new Error(normalizeErrorMessage(event.data?.error, 'Page fetch failed')));
        return;
      }

      const blobMimeType = resolveFetchedImageMimeType(event.data?.mimeType, event.data?.buffer);
      resolve(new Blob([event.data.buffer], { type: blobMimeType }));
    };

    const timeoutId = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error('Page fetch bridge timed out'));
    }, timeoutMs);

    window.addEventListener('message', handleMessage);
    window.postMessage({
      type: PAGE_FETCH_REQUEST,
      requestId,
      url
    }, '*');
  });
}

async function imageElementToBlob(imageElement) {
  const { width, height } = await waitForRenderableImageSize(imageElement);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('2D canvas context unavailable');
  }
  context.drawImage(imageElement, 0, 0, width, height);
  return canvasToBlob(canvas);
}

async function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load captured screenshot'));
    image.src = url;
  });
}

function normalizeCaptureRect(rect) {
  if (!rect || typeof rect !== 'object') return null;

  const left = Number(rect.left);
  const top = Number(rect.top);
  const width = Number(rect.width);
  const height = Number(rect.height);

  if (![left, top, width, height].every(Number.isFinite)) {
    return null;
  }

  return {
    left,
    top,
    width: Math.max(0, width),
    height: Math.max(0, height)
  };
}

function getCaptureRectArea(rect) {
  if (!rect) return 0;
  return rect.width * rect.height;
}

function getViewportRect() {
  const viewport = globalThis.visualViewport;
  const width = Number(viewport?.width) || Math.max(window.innerWidth, 0);
  const height = Number(viewport?.height) || Math.max(window.innerHeight, 0);

  return {
    left: 0,
    top: 0,
    width: Math.max(0, width),
    height: Math.max(0, height)
  };
}

export function intersectCaptureRectWithViewport(rect, viewportRect = getViewportRect()) {
  const normalizedRect = normalizeCaptureRect(rect);
  const normalizedViewport = normalizeCaptureRect(viewportRect);
  if (!normalizedRect || !normalizedViewport) {
    return null;
  }

  const left = Math.max(normalizedRect.left, normalizedViewport.left);
  const top = Math.max(normalizedRect.top, normalizedViewport.top);
  const right = Math.min(
    normalizedRect.left + normalizedRect.width,
    normalizedViewport.left + normalizedViewport.width
  );
  const bottom = Math.min(
    normalizedRect.top + normalizedRect.height,
    normalizedViewport.top + normalizedViewport.height
  );

  return normalizeCaptureRect({
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  });
}

function isMeaningfulCaptureRect(rect) {
  return Boolean(rect)
    && rect.width >= MIN_VISIBLE_CAPTURE_EDGE
    && rect.height >= MIN_VISIBLE_CAPTURE_EDGE
    && getCaptureRectArea(rect) >= MIN_VISIBLE_CAPTURE_AREA;
}

function readRenderedImageFitStyle(imageElement) {
  const computedStyle = typeof globalThis.getComputedStyle === 'function'
    ? globalThis.getComputedStyle(imageElement)
    : null;
  const style = imageElement?.style || null;
  const objectFit = computedStyle?.objectFit || style?.objectFit || '';
  const objectPosition = computedStyle?.objectPosition || style?.objectPosition || '';

  return {
    objectFit: typeof objectFit === 'string' ? objectFit.trim().toLowerCase() : '',
    objectPosition: typeof objectPosition === 'string' ? objectPosition.trim().toLowerCase() : ''
  };
}

function parseObjectPositionAxis(token, remainingSpace) {
  if (!Number.isFinite(remainingSpace) || remainingSpace <= 0) {
    return 0;
  }

  const normalizedToken = typeof token === 'string' ? token.trim().toLowerCase() : '';
  if (!normalizedToken) {
    return remainingSpace / 2;
  }

  if (normalizedToken.endsWith('%')) {
    const percentage = Number.parseFloat(normalizedToken.slice(0, -1));
    if (Number.isFinite(percentage)) {
      return remainingSpace * (percentage / 100);
    }
  }

  if (normalizedToken.endsWith('px')) {
    const pixelOffset = Number.parseFloat(normalizedToken.slice(0, -2));
    if (Number.isFinite(pixelOffset)) {
      return Math.max(0, Math.min(remainingSpace, pixelOffset));
    }
  }

  if (normalizedToken === 'left' || normalizedToken === 'top') {
    return 0;
  }
  if (normalizedToken === 'right' || normalizedToken === 'bottom') {
    return remainingSpace;
  }
  if (normalizedToken === 'center') {
    return remainingSpace / 2;
  }

  return remainingSpace / 2;
}

function resolveRenderedImageContentRect(imageElement, imageRect) {
  const normalizedImageRect = normalizeCaptureRect(imageRect);
  if (!normalizedImageRect) {
    return null;
  }

  const naturalWidth = Number(imageElement?.naturalWidth) || 0;
  const naturalHeight = Number(imageElement?.naturalHeight) || 0;
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return normalizedImageRect;
  }

  const { objectFit, objectPosition } = readRenderedImageFitStyle(imageElement);
  if (!objectFit || objectFit === 'fill') {
    return normalizedImageRect;
  }

  let renderedWidth = normalizedImageRect.width;
  let renderedHeight = normalizedImageRect.height;

  if (objectFit === 'contain' || objectFit === 'scale-down') {
    const containScale = Math.min(
      normalizedImageRect.width / naturalWidth,
      normalizedImageRect.height / naturalHeight
    );
    const nextWidth = naturalWidth * containScale;
    const nextHeight = naturalHeight * containScale;

    if (objectFit === 'scale-down') {
      renderedWidth = Math.min(normalizedImageRect.width, nextWidth);
      renderedHeight = Math.min(normalizedImageRect.height, nextHeight);
    } else {
      renderedWidth = nextWidth;
      renderedHeight = nextHeight;
    }
  } else if (objectFit === 'none') {
    renderedWidth = Math.min(normalizedImageRect.width, naturalWidth);
    renderedHeight = Math.min(normalizedImageRect.height, naturalHeight);
  } else {
    return normalizedImageRect;
  }

  const remainingHorizontalSpace = Math.max(0, normalizedImageRect.width - renderedWidth);
  const remainingVerticalSpace = Math.max(0, normalizedImageRect.height - renderedHeight);
  const [xToken = '50%', yToken = '50%'] = objectPosition.split(/\s+/).filter(Boolean);
  const offsetX = parseObjectPositionAxis(xToken, remainingHorizontalSpace);
  const offsetY = parseObjectPositionAxis(yToken, remainingVerticalSpace);

  return normalizeCaptureRect({
    left: normalizedImageRect.left + offsetX,
    top: normalizedImageRect.top + offsetY,
    width: renderedWidth,
    height: renderedHeight
  });
}

export function resolveVisibleCaptureRect(imageElement) {
  const imageRect = normalizeCaptureRect(imageElement?.getBoundingClientRect?.());
  const imageContentRect = resolveRenderedImageContentRect(imageElement, imageRect);
  const effectiveImageRect = isMeaningfulCaptureRect(imageContentRect)
    ? imageContentRect
    : imageRect;
  const containerRect = normalizeCaptureRect(
    getPreferredGeminiImageContainer(imageElement)?.getBoundingClientRect?.()
  );

  if (!isMeaningfulCaptureRect(effectiveImageRect)) {
    return containerRect || effectiveImageRect;
  }

  if (!isMeaningfulCaptureRect(containerRect)) {
    return effectiveImageRect;
  }

  const imageArea = getCaptureRectArea(effectiveImageRect);
  const containerArea = getCaptureRectArea(containerRect);
  if (
    containerArea >= imageArea * CONTAINER_CAPTURE_AREA_RATIO
    && (
      containerRect.width >= effectiveImageRect.width * 2
      || containerRect.height >= effectiveImageRect.height * 2
    )
  ) {
    return containerRect;
  }

  return effectiveImageRect;
}

function waitForNextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }
    globalThis.setTimeout(resolve, 16);
  });
}

async function waitForFrames(frameCount = 1) {
  for (let index = 0; index < frameCount; index += 1) {
    await waitForNextFrame();
  }
}

function getRenderableImageSize(imageElement) {
  const width = Number(imageElement?.naturalWidth) || Number(imageElement?.width) || Number(imageElement?.clientWidth) || 0;
  const height = Number(imageElement?.naturalHeight) || Number(imageElement?.height) || Number(imageElement?.clientHeight) || 0;

  return { width, height };
}

export async function waitForRenderableImageSize(imageElement, timeoutMs = 1500) {
  let size = getRenderableImageSize(imageElement);
  if (size.width > 0 && size.height > 0) {
    return size;
  }

  if (typeof imageElement?.decode === 'function') {
    try {
      await imageElement.decode();
    } catch {
      // Ignore decode failures here and keep waiting for layout or load to settle.
    }
    size = getRenderableImageSize(imageElement);
    if (size.width > 0 && size.height > 0) {
      return size;
    }
  }

  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    await waitForNextFrame();
    size = getRenderableImageSize(imageElement);
    if (size.width > 0 && size.height > 0) {
      return size;
    }
  }

  throw new Error('Image has no renderable size');
}

async function ensureVisibleCaptureTargetInViewport(imageElement, { forceScroll = false } = {}) {
  const target = getPreferredGeminiImageContainer(imageElement) || imageElement;
  const currentRect = intersectCaptureRectWithViewport(resolveVisibleCaptureRect(imageElement));
  if (!forceScroll && isMeaningfulCaptureRect(currentRect)) {
    return currentRect;
  }

  if (typeof target?.scrollIntoView === 'function') {
    target.scrollIntoView({
      block: 'center',
      inline: 'center',
      behavior: 'auto'
    });
    await waitForFrames(2);
  }

  return intersectCaptureRectWithViewport(resolveVisibleCaptureRect(imageElement));
}

function hasConfirmedGeminiPreviewMeta(processedMeta) {
  return classifyGeminiAttributionFromWatermarkMeta(processedMeta).tier !== 'insufficient';
}

function isSafePreviewFallbackStrategy(strategy) {
  return strategy === 'rendered-capture'
    || strategy === 'page-fetch'
    || strategy === 'background-fetch';
}

function isBlobLike(value) {
  return Boolean(value)
    && typeof value === 'object'
    && typeof value.size === 'number'
    && typeof value.type === 'string'
    && typeof value.arrayBuffer === 'function';
}

function summarizeCandidateDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
    return '';
  }

  return diagnostics
    .map((item) => {
      const parts = [item.strategy || 'unknown', item.status || 'unknown'];
      if (item.decisionTier) parts.push(`tier=${item.decisionTier}`);
      if (item.processorPath) parts.push(`processor=${item.processorPath}`);
      if (typeof item.sourceBlobSize === 'number') parts.push(`sourceSize=${item.sourceBlobSize}`);
      if (item.sourceBlobType) parts.push(`sourceType=${item.sourceBlobType}`);
      if (typeof item.processedBlobSize === 'number') parts.push(`processedSize=${item.processedBlobSize}`);
      if (item.processedBlobType) parts.push(`processedType=${item.processedBlobType}`);
      if (item.error) parts.push(`error=${item.error}`);
      return parts.join(',');
    })
    .join(' | ');
}

export function shouldRetryVisibleCaptureError(error) {
  const message = normalizeErrorMessage(error).toLowerCase();
  return message.includes('visible capture rect outside screenshot bounds')
    || message.includes('visible capture rect too small')
    || message.includes('failed to load captured screenshot');
}

export function shouldSkipPreviewProcessingFailure(diagnostics = []) {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
    return false;
  }

  const backgroundFetchFailure = diagnostics.find((item) => item?.strategy === 'background-fetch');
  const renderedCaptureFailure = diagnostics.find((item) => item?.strategy === 'rendered-capture');
  const backgroundFetchError = String(backgroundFetchFailure?.error || '');
  const renderedCaptureError = String(renderedCaptureFailure?.error || '');

  return backgroundFetchFailure?.status === 'error'
    && /failed to fetch image: 403/i.test(backgroundFetchError)
    && renderedCaptureFailure?.status === 'error'
    && /tainted canvases may not be exported/i.test(renderedCaptureError);
}

export function requestVisibleTabCapture(
  sendRuntimeMessage,
  {
    forceRefresh = false,
    cacheState = visibleTabCaptureState,
    cacheTtlMs = VISIBLE_TAB_CAPTURE_CACHE_TTL_MS,
    now = () => Date.now()
  } = {}
) {
  if (typeof sendRuntimeMessage !== 'function') {
    throw new Error('Visible-tab capture unavailable');
  }

  if (cacheState?.inFlightPromise) {
    return cacheState.inFlightPromise;
  }

  const nowValue = Number(now()) || 0;
  const hasFreshCachedCapture = !forceRefresh
    && typeof cacheState?.dataUrl === 'string'
    && cacheState.dataUrl
    && Number.isFinite(cacheState?.capturedAt)
    && nowValue - cacheState.capturedAt <= cacheTtlMs;

  if (hasFreshCachedCapture) {
    return Promise.resolve(cacheState.dataUrl);
  }

  const capturePromise = Promise.resolve(sendRuntimeMessage({ type: 'gwr:capture-visible-tab' }))
    .then((response) => {
      const dataUrl = typeof response?.dataUrl === 'string' ? response.dataUrl : '';
      if (!dataUrl) {
        throw new Error('Visible-tab capture returned empty response');
      }
      cacheState.dataUrl = dataUrl;
      cacheState.capturedAt = Number(now()) || Date.now();
      return dataUrl;
    })
    .finally(() => {
      if (cacheState.inFlightPromise === capturePromise) {
        cacheState.inFlightPromise = null;
      }
    });

  cacheState.inFlightPromise = capturePromise;
  return capturePromise;
}

export async function resolvePreviewReplacementResult({
  candidates = [],
  processCandidate
}) {
  let lastError = null;
  let sawInsufficientCandidate = false;
  let fallbackResult = null;
  let visibleCaptureFallbackResult = null;
  let sawPreviewFetchCandidateError = false;
  const diagnostics = [];

  for (const candidate of candidates) {
    try {
      const result = await processCandidate(candidate);
      const confirmed = hasConfirmedGeminiPreviewMeta(result?.processedMeta);
      const decisionTier = classifyGeminiAttributionFromWatermarkMeta(result?.processedMeta).tier || 'insufficient';
      diagnostics.push({
        strategy: candidate.strategy || '',
        status: confirmed ? 'confirmed' : 'insufficient',
        decisionTier,
        processorPath: typeof result?.processedMeta?.processorPath === 'string' ? result.processedMeta.processorPath : '',
        sourceBlobType: result?.sourceBlobType || '',
        sourceBlobSize: typeof result?.sourceBlobSize === 'number' ? result.sourceBlobSize : undefined,
        processedBlobType: result?.processedBlob?.type || '',
        processedBlobSize: typeof result?.processedBlob?.size === 'number' ? result.processedBlob.size : undefined
      });
      if (confirmed) {
        return {
          ...result,
          strategy: candidate.strategy || '',
          diagnostics,
          diagnosticsSummary: summarizeCandidateDiagnostics(diagnostics)
        };
      }
      sawInsufficientCandidate = true;
      if (isSafePreviewFallbackStrategy(candidate.strategy) && isBlobLike(result?.processedBlob)) {
        const nextFallbackResult = {
          ...result,
          strategy: candidate.strategy || '',
          diagnostics: [...diagnostics],
          diagnosticsSummary: summarizeCandidateDiagnostics(diagnostics)
        };

        if (!fallbackResult) {
          fallbackResult = nextFallbackResult;
        }
      } else if (candidate.strategy === 'visible-capture' && isBlobLike(result?.processedBlob)) {
        visibleCaptureFallbackResult = {
          ...result,
          strategy: candidate.strategy || ''
        };
      }
    } catch (error) {
      lastError = error;
      if (candidate.strategy === 'background-fetch' || candidate.strategy === 'page-fetch') {
        sawPreviewFetchCandidateError = true;
      }
      diagnostics.push({
        strategy: candidate.strategy || '',
        status: 'error',
        sourceBlobType: typeof error?.sourceBlobType === 'string' ? error.sourceBlobType : '',
        sourceBlobSize: typeof error?.sourceBlobSize === 'number' ? error.sourceBlobSize : undefined,
        error: normalizeErrorMessage(error)
      });
    }
  }

  if (fallbackResult) {
    return fallbackResult;
  }

  if (visibleCaptureFallbackResult && sawPreviewFetchCandidateError) {
    return {
      ...visibleCaptureFallbackResult,
      diagnostics: [...diagnostics],
      diagnosticsSummary: summarizeCandidateDiagnostics(diagnostics)
    };
  }

  if (lastError) {
    const wrappedError = new Error(normalizeErrorMessage(lastError, 'Preview candidate failed'));
    wrappedError.candidateDiagnostics = diagnostics;
    wrappedError.candidateDiagnosticsSummary = summarizeCandidateDiagnostics(diagnostics);
    throw wrappedError;
  }

  if (sawInsufficientCandidate) {
    const error = new Error('No confirmed Gemini preview candidate succeeded');
    error.candidateDiagnostics = diagnostics;
    error.candidateDiagnosticsSummary = summarizeCandidateDiagnostics(diagnostics);
    throw error;
  }

  const error = new Error('No preview candidate succeeded');
  error.candidateDiagnostics = diagnostics;
  error.candidateDiagnosticsSummary = summarizeCandidateDiagnostics(diagnostics);
  throw error;
}

async function captureVisibleElementBlobOnce(
  sendRuntimeMessage,
  imageElement,
  { forceScroll = false, forceRefresh = false } = {}
) {
  if (!sendRuntimeMessage) {
    throw new Error('Visible-tab capture unavailable');
  }

  const rect = await ensureVisibleCaptureTargetInViewport(imageElement, { forceScroll });
  const viewportRect = getViewportRect();
  if (!isMeaningfulCaptureRect(rect)) {
    throw new Error('Visible capture rect outside screenshot bounds');
  }

  const screenshotDataUrl = await requestVisibleTabCapture(sendRuntimeMessage, { forceRefresh });
  const screenshot = await loadImageFromUrl(screenshotDataUrl);
  const scaleX = screenshot.naturalWidth / Math.max(viewportRect.width, 1);
  const scaleY = screenshot.naturalHeight / Math.max(viewportRect.height, 1);
  const sx = Math.max(0, Math.floor(rect.left * scaleX));
  const sy = Math.max(0, Math.floor(rect.top * scaleY));
  if (sx >= screenshot.naturalWidth || sy >= screenshot.naturalHeight) {
    throw new Error('Visible capture rect outside screenshot bounds');
  }
  const sw = Math.max(1, Math.min(screenshot.naturalWidth - sx, Math.ceil(rect.width * scaleX)));
  const sh = Math.max(1, Math.min(screenshot.naturalHeight - sy, Math.ceil(rect.height * scaleY)));
  if (sw < MIN_VISIBLE_CAPTURE_EDGE || sh < MIN_VISIBLE_CAPTURE_EDGE) {
    throw new Error('Visible capture rect too small');
  }

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('2D canvas context unavailable');
  }

  context.drawImage(screenshot, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvasToBlob(canvas);
}

async function captureVisibleElementBlob(sendRuntimeMessage, imageElement) {
  try {
    return await captureVisibleElementBlobOnce(sendRuntimeMessage, imageElement);
  } catch (error) {
    if (!shouldRetryVisibleCaptureError(error)) {
      throw error;
    }

    await waitForFrames(2);

    try {
      return await captureVisibleElementBlobOnce(sendRuntimeMessage, imageElement, {
        forceScroll: true,
        forceRefresh: true
      });
    } catch (retryError) {
      throw new Error(`Visible capture failed after retry: ${normalizeErrorMessage(retryError)}`);
    }
  }
}

export function buildPreviewReplacementCandidates({
  imageElement,
  sourceUrl = '',
  sendRuntimeMessage,
  fetchPreviewBlob = fetchBlobViaPageBridge,
  captureRenderedImageBlob = imageElementToBlob
}) {
  const candidates = [];
  const normalizedPreviewUrl = sourceUrl
    ? normalizeGoogleusercontentImageUrl(sourceUrl)
    : '';

  if (typeof sendRuntimeMessage === 'function' && normalizedPreviewUrl) {
    candidates.push({
      strategy: 'background-fetch',
      getOriginalBlob: () => fetchBlobFromBackground(
        sendRuntimeMessage,
        normalizedPreviewUrl,
        typeof fetchPreviewBlob === 'function' ? fetchPreviewBlob : null
      )
    });
  } else if (typeof fetchPreviewBlob === 'function' && normalizedPreviewUrl) {
    candidates.push({
      strategy: 'page-fetch',
      getOriginalBlob: () => fetchPreviewBlob(normalizedPreviewUrl)
    });
  }

  if (typeof captureRenderedImageBlob === 'function') {
    candidates.push({
      strategy: 'rendered-capture',
      getOriginalBlob: () => captureRenderedImageBlob(imageElement)
    });
  }

  return candidates;
}

function collectCandidateImages(root) {
  const candidates = new Set();
  if (root instanceof HTMLImageElement && isProcessableGeminiImageElement(root)) {
    candidates.add(root);
  }
  if (typeof root?.querySelectorAll === 'function') {
    for (const image of root.querySelectorAll(getGeminiImageQuerySelector())) {
      if (isProcessableGeminiImageElement(image)) {
        candidates.add(image);
      }
    }
  }
  return [...candidates];
}

function hasRelevantDescendant(root) {
  if (!root || typeof root.querySelector !== 'function') {
    return false;
  }

  const containerSelector = getGeminiImageContainerSelector();
  if (root.querySelector(containerSelector)) {
    return true;
  }

  return Boolean(root.querySelector('img') && root.querySelector('button,[role="button"]'));
}

export function shouldScheduleMutationRoot(root) {
  if (!root || typeof root !== 'object') {
    return false;
  }

  const tagName = typeof root.tagName === 'string' ? root.tagName.toUpperCase() : '';
  if (!tagName) {
    return false;
  }

  if (tagName === 'IMG' || tagName === 'GENERATED-IMAGE') {
    return true;
  }

  const containerSelector = getGeminiImageContainerSelector();
  if (typeof root.matches === 'function' && root.matches(containerSelector)) {
    return true;
  }

  return hasRelevantDescendant(root);
}

export function shouldScheduleAttributeMutation(target, attributeName = '') {
  if (!target || typeof target !== 'object') {
    return false;
  }

  const normalizedAttributeName = typeof attributeName === 'string'
    ? attributeName.trim().toLowerCase()
    : '';
  if (!normalizedAttributeName) {
    return true;
  }

  if (normalizedAttributeName === 'data-gwr-stable-source') {
    return false;
  }

  if (normalizedAttributeName !== 'src' && normalizedAttributeName !== 'srcset') {
    return true;
  }

  const trackedObjectUrl = typeof target?.dataset?.[PAGE_IMAGE_OBJECT_URL_KEY] === 'string'
    ? target.dataset[PAGE_IMAGE_OBJECT_URL_KEY].trim()
    : '';
  if (!trackedObjectUrl) {
    return true;
  }

  const currentSrc = typeof target?.currentSrc === 'string' ? target.currentSrc.trim() : '';
  const src = typeof target?.src === 'string' ? target.src.trim() : '';
  return currentSrc !== trackedObjectUrl && src !== trackedObjectUrl;
}

function scheduleOnNextFrame(callback) {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => callback());
    return;
  }
  globalThis.setTimeout(callback, 16);
}

function doesRootContain(containerRoot, candidateRoot) {
  if (!containerRoot || !candidateRoot || containerRoot === candidateRoot) {
    return false;
  }

  if (typeof containerRoot.contains === 'function') {
    try {
      return containerRoot.contains(candidateRoot);
    } catch {
      return false;
    }
  }

  return false;
}

export function createRootBatchProcessor({
  processRoot,
  scheduleFlush = scheduleOnNextFrame
} = {}) {
  const pendingRoots = new Set();
  let scheduled = false;

  function flush() {
    scheduled = false;
    const roots = [...pendingRoots];
    pendingRoots.clear();
    for (const root of roots) {
      processRoot(root);
    }
  }

  function schedule(root = document) {
    for (const pendingRoot of pendingRoots) {
      if (pendingRoot === root || doesRootContain(pendingRoot, root)) {
        return;
      }
    }

    for (const pendingRoot of [...pendingRoots]) {
      if (doesRootContain(root, pendingRoot)) {
        pendingRoots.delete(pendingRoot);
      }
    }

    pendingRoots.add(root);
    if (scheduled) return;
    scheduled = true;
    scheduleFlush(flush);
  }

  return {
    schedule,
    flush
  };
}

function createProcessingOverlayElement(createElement) {
  const overlay = createElement('div');
  overlay.dataset[PROCESSING_OVERLAY_DATA_KEY] = 'true';
  overlay.textContent = 'Processing...';

  if (overlay.style && typeof overlay.style === 'object') {
    Object.assign(overlay.style, {
      position: 'absolute',
      inset: '0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '16px',
      pointerEvents: 'none',
      borderRadius: 'inherit',
      background: 'rgba(17, 17, 17, 0.16)',
      backdropFilter: 'blur(2px)',
      color: 'rgba(255, 255, 255, 0.92)',
      fontSize: '13px',
      fontWeight: '500',
      letterSpacing: '0.02em',
      opacity: '1',
      transition: `opacity ${PROCESSING_OVERLAY_FADE_MS}ms ease`
    });
  }

  return overlay;
}

function buildProcessingFilter(previousFilter = '') {
  const tokens = [previousFilter.trim(), 'blur(4px)', 'brightness(0.78)'].filter(Boolean);
  return tokens.join(' ');
}

export function showProcessingOverlay(
  imageElement,
  {
    container = getPreferredGeminiImageContainer(imageElement) || imageElement?.parentElement || null,
    createElement = (tagName) => document.createElement(tagName),
    clearTimeoutImpl = globalThis.clearTimeout?.bind(globalThis) || null
  } = {}
) {
  if (!imageElement || !container || typeof container.appendChild !== 'function') {
    return null;
  }

  const existingState = processingOverlayState.get(imageElement);
  if (existingState) {
    if (existingState.hideTimerId !== null && typeof clearTimeoutImpl === 'function') {
      clearTimeoutImpl(existingState.hideTimerId);
      existingState.hideTimerId = null;
      existingState.hideSequence += 1;
    }
    if (existingState.overlay?.style && typeof existingState.overlay.style === 'object') {
      existingState.overlay.style.opacity = '1';
    }
    return existingState.overlay;
  }

  const overlay = createProcessingOverlayElement(createElement);
  const previousFilter = typeof imageElement?.style?.filter === 'string' ? imageElement.style.filter : '';
  const previousContainerPosition = typeof container?.style?.position === 'string' ? container.style.position : '';
  const didOverrideContainerPosition = Boolean(
    container.style && (!container.style.position || container.style.position === 'static')
  );

  if (didOverrideContainerPosition) {
    container.style.position = 'relative';
  }
  container.appendChild(overlay);

  if (imageElement.style && typeof imageElement.style === 'object') {
    imageElement.style.filter = buildProcessingFilter(previousFilter);
  }
  if (imageElement.dataset) {
    imageElement.dataset[PROCESSING_VISUAL_DATA_KEY] = 'true';
  }

  processingOverlayState.set(imageElement, {
    overlay,
    container,
    previousFilter,
    previousContainerPosition,
    didOverrideContainerPosition,
    hideTimerId: null,
    hideSequence: 0
  });

  return overlay;
}

export function hideProcessingOverlay(
  imageElement,
  {
    removeImmediately = false,
    setTimeoutImpl = globalThis.setTimeout?.bind(globalThis) || null,
    clearTimeoutImpl = globalThis.clearTimeout?.bind(globalThis) || null
  } = {}
) {
  const state = processingOverlayState.get(imageElement);
  if (!state) return;
  const nextHideSequence = state.hideSequence + 1;
  state.hideSequence = nextHideSequence;

  const cleanup = () => {
    if (processingOverlayState.get(imageElement) !== state) {
      return;
    }
    if (state.hideSequence !== nextHideSequence) {
      return;
    }
    if (state.overlay?.parentNode && typeof state.overlay.parentNode.removeChild === 'function') {
      state.overlay.parentNode.removeChild(state.overlay);
    }
    if (imageElement?.style && typeof imageElement.style === 'object') {
      imageElement.style.filter = state.previousFilter;
    }
    if (imageElement?.dataset) {
      delete imageElement.dataset[PROCESSING_VISUAL_DATA_KEY];
    }
    if (
      state.didOverrideContainerPosition
      && state.container?.style
      && typeof state.container.style === 'object'
      && state.container.style.position === 'relative'
    ) {
      state.container.style.position = state.previousContainerPosition;
    }
    state.hideTimerId = null;
    processingOverlayState.delete(imageElement);
  };

  if (removeImmediately || typeof setTimeoutImpl !== 'function') {
    if (state.hideTimerId !== null && typeof clearTimeoutImpl === 'function') {
      clearTimeoutImpl(state.hideTimerId);
      state.hideTimerId = null;
    }
    cleanup();
    return;
  }

  if (state.hideTimerId !== null && typeof clearTimeoutImpl === 'function') {
    clearTimeoutImpl(state.hideTimerId);
  }
  if (state.overlay?.style && typeof state.overlay.style === 'object') {
    state.overlay.style.opacity = '0';
  }
  state.hideTimerId = setTimeoutImpl(cleanup, PROCESSING_OVERLAY_FADE_MS);
}

function revokeTrackedObjectUrl(imageElement) {
  const objectUrl = imageElement?.dataset?.[PAGE_IMAGE_OBJECT_URL_KEY];
  if (!objectUrl) return;
  URL.revokeObjectURL(objectUrl);
  delete imageElement.dataset[PAGE_IMAGE_OBJECT_URL_KEY];
}

export function createPageImageReplacementController({
  logger = console,
  onLog = null,
  sendRuntimeMessage = buildRuntimeMessageSender(),
  fetchPreviewBlob = fetchBlobViaPageBridge,
  processWatermarkBlobImpl = processWatermarkBlob,
  removeWatermarkFromBlobImpl = removeWatermarkFromBlob
} = {}) {
  const processing = new WeakSet();
  let observer = null;

  async function processImage(imageElement) {
    if (!(imageElement instanceof HTMLImageElement)) return;
    if (!isProcessableGeminiImageElement(imageElement)) return;

    const sourceUrl = resolveCandidateImageUrl(imageElement).trim();
    if (!sourceUrl) return;

    const lastSourceUrl = imageElement.dataset[PAGE_IMAGE_SOURCE_KEY] || '';
    const lastState = imageElement.dataset[PAGE_IMAGE_STATE_KEY] || '';
    if (lastSourceUrl === sourceUrl && lastState === 'ready') return;
    if (processing.has(imageElement)) return;

    if (lastSourceUrl && lastSourceUrl !== sourceUrl) {
      hideProcessingOverlay(imageElement, { removeImmediately: true });
      revokeTrackedObjectUrl(imageElement);
    }

    processing.add(imageElement);
    imageElement.dataset.gwrStableSource = sourceUrl;
    imageElement.dataset[PAGE_IMAGE_SOURCE_KEY] = sourceUrl;
    imageElement.dataset[PAGE_IMAGE_STATE_KEY] = 'processing';
    showProcessingOverlay(imageElement);

    const normalizedUrl = normalizeGoogleusercontentImageUrl(sourceUrl);
    logger?.info?.('[Gemini Watermark Remover] page image process start', {
      sourceUrl,
      normalizedUrl
    });
    appendLog(onLog, 'page-image-process-start', {
      sourceUrl,
      normalizedUrl
    });

    if (isGeminiPreviewUrl(sourceUrl)) {
      logger?.info?.('[Gemini Watermark Remover] page image process strategy', {
        sourceUrl,
        strategy: 'preview-candidate-fallback'
      });
      appendLog(onLog, 'page-image-process-strategy', {
        sourceUrl,
        strategy: 'preview-candidate-fallback'
      });
    }

    try {
      let processedBlob = null;
      let selectedStrategy = '';
      let candidateDiagnostics = null;
      let candidateDiagnosticsSummary = '';
      let skippedReason = '';
      if (isGeminiPreviewUrl(sourceUrl)) {
        try {
          const previewResult = await resolvePreviewReplacementResult({
            candidates: buildPreviewReplacementCandidates({
              imageElement,
              sourceUrl,
              sendRuntimeMessage,
              fetchPreviewBlob,
              captureRenderedImageBlob: imageElementToBlob
            }),
            processCandidate: async (candidate) => {
              const originalBlob = await candidate.getOriginalBlob();
              try {
                const processedResult = await processWatermarkBlobImpl(originalBlob);
                return {
                  ...processedResult,
                  sourceBlobType: originalBlob.type || '',
                  sourceBlobSize: originalBlob.size || 0
                };
              } catch (error) {
                if (error && typeof error === 'object') {
                  error.sourceBlobType = originalBlob.type || '';
                  error.sourceBlobSize = originalBlob.size || 0;
                }
                throw error;
              }
            }
          });
          processedBlob = previewResult.processedBlob;
          selectedStrategy = previewResult.strategy;
          candidateDiagnostics = previewResult.diagnostics || null;
          candidateDiagnosticsSummary = previewResult.diagnosticsSummary || '';
        } catch (error) {
          const diagnostics = Array.isArray(error?.candidateDiagnostics) ? error.candidateDiagnostics : [];
          const visibleOnlyInsufficient = diagnostics.length === 1
            && diagnostics[0]?.strategy === 'visible-capture'
            && diagnostics[0]?.status === 'insufficient';
          const shouldSkipPreviewFailure = visibleOnlyInsufficient
            || shouldSkipPreviewProcessingFailure(diagnostics);
          if (shouldSkipPreviewFailure) {
            imageElement.dataset[PAGE_IMAGE_STATE_KEY] = 'skipped';
            hideProcessingOverlay(imageElement, { removeImmediately: true });
            skippedReason = visibleOnlyInsufficient
              ? 'visible-capture-insufficient'
              : 'preview-fetch-unavailable';
            logger?.info?.('[Gemini Watermark Remover] page image process skipped', {
              sourceUrl,
              normalizedUrl,
              reason: skippedReason,
              candidateDiagnostics: diagnostics,
              candidateDiagnosticsSummary: typeof error?.candidateDiagnosticsSummary === 'string'
                ? error.candidateDiagnosticsSummary
                : ''
            });
            appendLog(onLog, 'page-image-process-skipped', {
              sourceUrl,
              normalizedUrl,
              reason: skippedReason,
              candidateDiagnostics: diagnostics,
              candidateDiagnosticsSummary: typeof error?.candidateDiagnosticsSummary === 'string'
                ? error.candidateDiagnosticsSummary
                : ''
            });
            return;
          }
          throw error;
        }
      } else {
        const originalBlob = await acquireOriginalBlob({
          sourceUrl,
          image: imageElement,
          fetchBlobFromBackground: async (url) => fetchBlobFromBackground(
            sendRuntimeMessage,
            normalizeGoogleusercontentImageUrl(url),
            fetchPreviewBlob
          ),
          fetchBlobDirect,
          captureRenderedImageBlob: imageElementToBlob,
          captureVisibleElementBlob: async (image) => captureVisibleElementBlob(sendRuntimeMessage, image),
          validateBlob: loadImageFromBlob
        });

        processedBlob = await removeWatermarkFromBlobImpl(originalBlob);
      }

      const objectUrl = URL.createObjectURL(processedBlob);
      revokeTrackedObjectUrl(imageElement);
      imageElement.dataset[PAGE_IMAGE_OBJECT_URL_KEY] = objectUrl;
      imageElement.dataset[PAGE_IMAGE_STATE_KEY] = 'ready';
      imageElement.src = objectUrl;
      hideProcessingOverlay(imageElement);

      logger?.info?.('[Gemini Watermark Remover] page image process success', {
        sourceUrl,
        normalizedUrl,
        strategy: selectedStrategy || (isGeminiPreviewUrl(sourceUrl) ? 'preview-candidate' : 'default'),
        candidateDiagnostics,
        candidateDiagnosticsSummary,
        blobType: processedBlob.type || '',
        blobSize: processedBlob.size || 0
      });
      appendLog(onLog, 'page-image-process-success', {
        sourceUrl,
        normalizedUrl,
        strategy: selectedStrategy || (isGeminiPreviewUrl(sourceUrl) ? 'preview-candidate' : 'default'),
        candidateDiagnostics,
        candidateDiagnosticsSummary,
        blobType: processedBlob.type || '',
        blobSize: processedBlob.size || 0
      });
    } catch (error) {
      const candidateDiagnostics = Array.isArray(error?.candidateDiagnostics) ? error.candidateDiagnostics : null;
      const candidateDiagnosticsSummary = typeof error?.candidateDiagnosticsSummary === 'string'
        ? error.candidateDiagnosticsSummary
        : '';
      imageElement.dataset[PAGE_IMAGE_STATE_KEY] = 'failed';
      hideProcessingOverlay(imageElement, { removeImmediately: true });
      logger?.warn?.('[Gemini Watermark Remover] page image process failed', {
        sourceUrl,
        normalizedUrl,
        error: normalizeErrorMessage(error),
        candidateDiagnostics,
        candidateDiagnosticsSummary
      });
      appendLog(onLog, 'page-image-process-failed', {
        sourceUrl,
        normalizedUrl,
        error: normalizeErrorMessage(error),
        candidateDiagnostics,
        candidateDiagnosticsSummary
      });
    } finally {
      processing.delete(imageElement);
    }
  }

  function processRoot(root = document) {
    for (const imageElement of collectCandidateImages(root)) {
      void processImage(imageElement);
    }
  }
  const batchProcessor = createRootBatchProcessor({ processRoot });
  const scheduleProcess = batchProcessor.schedule;

  function observe() {
    const root = document.body || document.documentElement;
    if (!root || observer) return;
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.target instanceof HTMLImageElement) {
          if (!shouldScheduleAttributeMutation(mutation.target, mutation.attributeName)) {
            continue;
          }
          scheduleProcess(mutation.target);
          continue;
        }
        for (const node of mutation.addedNodes) {
          if (shouldScheduleMutationRoot(node)) {
            scheduleProcess(node);
          }
        }
      }
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES
    });
  }

  function install() {
    processRoot(document);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        observe();
        scheduleProcess(document);
      }, { once: true });
      return;
    }
    observe();
  }

  function dispose() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  return {
    install,
    dispose,
    processRoot
  };
}

export function installPageImageReplacement(options = {}) {
  const controller = createPageImageReplacementController(options);
  controller.install();
  return controller;
}
