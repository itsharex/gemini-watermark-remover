import test from 'node:test';
import assert from 'node:assert/strict';

import { processWatermarkImageData } from '../../src/core/watermarkProcessor.js';
import { interpolateAlphaMap } from '../../src/core/adaptiveDetector.js';

function createSyntheticAlpha(size = 96) {
    const alpha = new Float32Array(size * size);
    const c = (size - 1) / 2;
    const radius = size / 2;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (x - c) / radius;
            const dy = (y - c) / radius;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const diamond = Math.max(Math.abs(dx), Math.abs(dy));

            const core = Math.max(0, 1.0 - diamond * 1.65);
            const ring = Math.max(0, 0.22 - Math.abs(dist - 0.44)) * 2.4;

            alpha[y * size + x] = Math.min(1, core + ring);
        }
    }

    return alpha;
}

function createBaseImageData(width, height) {
    const data = new Uint8ClampedArray(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            data[idx] = 40 + ((x * 17 + y * 7) % 140);
            data[idx + 1] = 35 + ((x * 9 + y * 19) % 145);
            data[idx + 2] = 30 + ((x * 23 + y * 11) % 150);
            data[idx + 3] = 255;
        }
    }

    return { width, height, data };
}

function applyWatermark(imageData, alphaMap, position, layers = 1) {
    for (let i = 0; i < layers; i++) {
        for (let row = 0; row < position.width; row++) {
            for (let col = 0; col < position.width; col++) {
                const a = alphaMap[row * position.width + col];
                if (a <= 0.001) continue;

                const idx = ((position.y + row) * imageData.width + (position.x + col)) * 4;
                for (let c = 0; c < 3; c++) {
                    const original = imageData.data[idx + c];
                    const blended = a * 255 + (1 - a) * original;
                    imageData.data[idx + c] = Math.max(0, Math.min(255, Math.round(blended)));
                }
            }
        }
    }
}

test('processWatermarkImageData should run in Node without asset imports and record multi-pass meta', () => {
    const alpha96 = createSyntheticAlpha(96);
    const alpha48 = interpolateAlphaMap(alpha96, 96, 48);
    const imageData = createBaseImageData(320, 320);
    const position = { x: 320 - 32 - 48, y: 320 - 32 - 48, width: 48, height: 48 };
    applyWatermark(imageData, alpha48, position, 2);

    const result = processWatermarkImageData(imageData, {
        alpha48,
        alpha96,
        maxPasses: 4
    });

    assert.equal(result.imageData.width, 320);
    assert.ok(result.meta.applied);
    assert.ok(result.meta.passCount >= 2, `passCount=${result.meta.passCount}`);
    assert.equal(result.meta.passStopReason, 'residual-low');
    assert.ok(Array.isArray(result.meta.passes));
    assert.ok(result.meta.detection.processedSpatialScore < 0.25, `score=${result.meta.detection.processedSpatialScore}`);
});
