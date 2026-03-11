import test from 'node:test';
import assert from 'node:assert/strict';

import { removeWatermark } from '../../src/core/blendModes.js';
import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation,
    interpolateAlphaMap
} from '../../src/core/adaptiveDetector.js';

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

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
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

function scoreRegion(imageData, alphaMap, position) {
    return {
        spatial: computeRegionSpatialCorrelation({
            imageData,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        }),
        gradient: computeRegionGradientCorrelation({
            imageData,
            alphaMap,
            region: { x: position.x, y: position.y, size: position.width }
        })
    };
}

async function getRemoveRepeatedWatermarkLayers() {
    try {
        const mod = await import('../../src/core/multiPassRemoval.js');
        return mod.removeRepeatedWatermarkLayers;
    } catch (error) {
        assert.fail(`removeRepeatedWatermarkLayers not implemented: ${error.message}`);
    }
}

test('removeRepeatedWatermarkLayers should keep peeling repeated watermark layers until residual falls', async () => {
    const removeRepeatedWatermarkLayers = await getRemoveRepeatedWatermarkLayers();
    const alpha96 = createSyntheticAlpha(96);
    const alpha72 = interpolateAlphaMap(alpha96, 96, 72);
    const original = createBaseImageData(512, 384);
    const watermarked = cloneImageData(original);
    const position = { x: 512 - 44 - 72, y: 384 - 52 - 72, width: 72, height: 72 };

    applyWatermark(watermarked, alpha72, position, 3);

    const singlePass = cloneImageData(watermarked);
    removeWatermark(singlePass, alpha72, position);

    const singlePassScore = scoreRegion(singlePass, alpha72, position);
    const result = removeRepeatedWatermarkLayers({
        imageData: watermarked,
        alphaMap: alpha72,
        position,
        maxPasses: 4
    });
    const multiPassScore = scoreRegion(result.imageData, alpha72, position);

    assert.ok(result.passCount >= 2, `passCount=${result.passCount}`);
    assert.ok(
        multiPassScore.spatial < singlePassScore.spatial - 0.08,
        `single=${singlePassScore.spatial}, multi=${multiPassScore.spatial}`
    );
    assert.equal(result.stopReason, 'residual-low');
    assert.ok(Number.isFinite(multiPassScore.gradient), `gradient=${multiPassScore.gradient}`);
    assert.ok(
        result.passes.some((pass) => pass.improvement > 0),
        `passes=${JSON.stringify(result.passes)}`
    );
    assert.equal(result.passCount, result.passes[result.passes.length - 1].index);
});

test('removeRepeatedWatermarkLayers should stop early when single pass already clears the watermark', async () => {
    const removeRepeatedWatermarkLayers = await getRemoveRepeatedWatermarkLayers();
    const alpha96 = createSyntheticAlpha(96);
    const alpha48 = interpolateAlphaMap(alpha96, 96, 48);
    const original = createBaseImageData(320, 320);
    const watermarked = cloneImageData(original);
    const position = { x: 320 - 32 - 48, y: 320 - 32 - 48, width: 48, height: 48 };

    applyWatermark(watermarked, alpha48, position, 1);

    const result = removeRepeatedWatermarkLayers({
        imageData: watermarked,
        alphaMap: alpha48,
        position,
        maxPasses: 4
    });

    assert.equal(result.passCount, 1);
    assert.equal(result.stopReason, 'residual-low');
    assert.equal(result.passes.length, 1);
});

test('removeRepeatedWatermarkLayers should support continuing pass numbering from an existing first pass', async () => {
    const removeRepeatedWatermarkLayers = await getRemoveRepeatedWatermarkLayers();
    const alpha96 = createSyntheticAlpha(96);
    const alpha72 = interpolateAlphaMap(alpha96, 96, 72);
    const original = createBaseImageData(512, 384);
    const watermarked = cloneImageData(original);
    const position = { x: 512 - 44 - 72, y: 384 - 52 - 72, width: 72, height: 72 };

    applyWatermark(watermarked, alpha72, position, 2);
    removeWatermark(watermarked, alpha72, position);

    const result = removeRepeatedWatermarkLayers({
        imageData: watermarked,
        alphaMap: alpha72,
        position,
        maxPasses: 3,
        startingPassIndex: 1
    });

    assert.ok(result.passCount >= 2, `passCount=${result.passCount}`);
    assert.ok(result.passes.length >= 1, `passes=${JSON.stringify(result.passes)}`);
    assert.equal(result.passes[0].index, 2);
    assert.equal(result.passCount, result.passes[result.passes.length - 1].index);
});
