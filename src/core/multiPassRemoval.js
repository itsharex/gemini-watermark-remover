import { removeWatermark } from './blendModes.js';
import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation
} from './adaptiveDetector.js';

const DEFAULT_MAX_PASSES = 4;
const DEFAULT_RESIDUAL_THRESHOLD = 0.25;
const NEAR_BLACK_THRESHOLD = 5;
const MAX_NEAR_BLACK_RATIO_INCREASE = 0.05;
const TEXTURE_REFERENCE_MARGIN = 1;
const TEXTURE_STD_FLOOR_RATIO = 0.8;

function cloneImageData(imageData) {
    if (typeof ImageData !== 'undefined' && imageData instanceof ImageData) {
        return new ImageData(
            new Uint8ClampedArray(imageData.data),
            imageData.width,
            imageData.height
        );
    }

    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function calculateNearBlackRatio(imageData, position) {
    let nearBlack = 0;
    let total = 0;

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const idx = ((position.y + row) * imageData.width + (position.x + col)) * 4;
            const r = imageData.data[idx];
            const g = imageData.data[idx + 1];
            const b = imageData.data[idx + 2];
            if (r <= NEAR_BLACK_THRESHOLD && g <= NEAR_BLACK_THRESHOLD && b <= NEAR_BLACK_THRESHOLD) {
                nearBlack++;
            }
            total++;
        }
    }

    return total > 0 ? nearBlack / total : 0;
}

function calculateRegionTextureStats(imageData, region) {
    let sum = 0;
    let sq = 0;
    let total = 0;

    for (let row = 0; row < region.height; row++) {
        for (let col = 0; col < region.width; col++) {
            const idx = ((region.y + row) * imageData.width + (region.x + col)) * 4;
            const lum =
                0.2126 * imageData.data[idx] +
                0.7152 * imageData.data[idx + 1] +
                0.0722 * imageData.data[idx + 2];
            sum += lum;
            sq += lum * lum;
            total++;
        }
    }

    const meanLum = total > 0 ? sum / total : 0;
    const variance = total > 0 ? Math.max(0, sq / total - meanLum * meanLum) : 0;

    return {
        meanLum,
        stdLum: Math.sqrt(variance)
    };
}

function getReferenceRegion(position, imageData) {
    const referenceY = position.y - position.height;
    if (referenceY < 0) return null;

    return {
        x: position.x,
        y: referenceY,
        width: position.width,
        height: position.height
    };
}

function scoreRegion(imageData, alphaMap, position) {
    return {
        spatialScore: computeRegionSpatialCorrelation({
            imageData,
            alphaMap,
            region: {
                x: position.x,
                y: position.y,
                size: position.width
            }
        }),
        gradientScore: computeRegionGradientCorrelation({
            imageData,
            alphaMap,
            region: {
                x: position.x,
                y: position.y,
                size: position.width
            }
        })
    };
}

export function removeRepeatedWatermarkLayers(imageDataOrOptions, alphaMapArg, positionArg, optionsArg = {}) {
    const isObjectCall =
        imageDataOrOptions &&
        typeof imageDataOrOptions === 'object' &&
        'imageData' in imageDataOrOptions &&
        alphaMapArg === undefined;

    const imageData = isObjectCall ? imageDataOrOptions.imageData : imageDataOrOptions;
    const alphaMap = isObjectCall ? imageDataOrOptions.alphaMap : alphaMapArg;
    const position = isObjectCall ? imageDataOrOptions.position : positionArg;
    const options = isObjectCall ? imageDataOrOptions : optionsArg;

    const maxPasses = Math.max(1, options.maxPasses ?? DEFAULT_MAX_PASSES);
    const residualThreshold = options.residualThreshold ?? DEFAULT_RESIDUAL_THRESHOLD;
    const startingPassIndex = Math.max(0, options.startingPassIndex ?? 0);
    const alphaGain = Number.isFinite(options.alphaGain) && options.alphaGain > 0
        ? options.alphaGain
        : 1;

    let currentImageData = cloneImageData(imageData);
    const baseNearBlackRatio = calculateNearBlackRatio(currentImageData, position);
    const maxNearBlackRatio = Math.min(1, baseNearBlackRatio + MAX_NEAR_BLACK_RATIO_INCREASE);
    const referenceRegion = getReferenceRegion(position, currentImageData);
    const referenceTextureStats = referenceRegion
        ? calculateRegionTextureStats(currentImageData, referenceRegion)
        : null;
    const passes = [];
    let stopReason = 'max-passes';
    let appliedPassCount = startingPassIndex;
    let attemptedPassCount = startingPassIndex;

    for (let passIndex = 0; passIndex < maxPasses; passIndex++) {
        attemptedPassCount = startingPassIndex + passIndex + 1;
        const before = scoreRegion(currentImageData, alphaMap, position);
        const candidate = cloneImageData(currentImageData);
        removeWatermark(candidate, alphaMap, position, { alphaGain });

        const after = scoreRegion(candidate, alphaMap, position);
        const nearBlackRatio = calculateNearBlackRatio(candidate, position);
        const improvement = Math.abs(before.spatialScore) - Math.abs(after.spatialScore);
        const gradientDelta = after.gradientScore - before.gradientScore;
        const candidateTextureStats = referenceTextureStats
            ? calculateRegionTextureStats(candidate, position)
            : null;

        if (nearBlackRatio > maxNearBlackRatio) {
            stopReason = 'safety-near-black';
            break;
        }

        if (referenceTextureStats && candidateTextureStats) {
            const tooDark =
                candidateTextureStats.meanLum < referenceTextureStats.meanLum - TEXTURE_REFERENCE_MARGIN;
            const tooFlat =
                candidateTextureStats.stdLum < referenceTextureStats.stdLum * TEXTURE_STD_FLOOR_RATIO;

            if (tooDark && tooFlat) {
                stopReason = 'safety-texture-collapse';
                break;
            }
        }

        currentImageData = candidate;
        appliedPassCount = startingPassIndex + passIndex + 1;
        passes.push({
            index: appliedPassCount,
            beforeSpatialScore: before.spatialScore,
            beforeGradientScore: before.gradientScore,
            afterSpatialScore: after.spatialScore,
            afterGradientScore: after.gradientScore,
            improvement,
            gradientDelta,
            nearBlackRatio
        });

        if (Math.abs(after.spatialScore) <= residualThreshold) {
            stopReason = 'residual-low';
            break;
        }
    }

    return {
        imageData: currentImageData,
        passCount: appliedPassCount,
        attemptedPassCount,
        stopReason,
        passes
    };
}
