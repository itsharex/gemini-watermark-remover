import { removeWatermark } from './blendModes.js';
import { removeRepeatedWatermarkLayers } from './multiPassRemoval.js';
import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation,
    detectAdaptiveWatermarkRegion,
    warpAlphaMap,
    shouldAttemptAdaptiveFallback
} from './adaptiveDetector.js';
import {
    calculateWatermarkPosition,
    detectWatermarkConfig,
    resolveInitialStandardConfig
} from './watermarkConfig.js';
import {
    hasReliableAdaptiveWatermarkSignal,
    hasReliableStandardWatermarkSignal
} from './watermarkPresence.js';

const RESIDUAL_RECALIBRATION_THRESHOLD = 0.5;
const MIN_SUPPRESSION_FOR_SKIP_RECALIBRATION = 0.18;
const MIN_RECALIBRATION_SCORE_DELTA = 0.18;
const NEAR_BLACK_THRESHOLD = 5;
const MAX_NEAR_BLACK_RATIO_INCREASE = 0.05;
const OUTLINE_REFINEMENT_THRESHOLD = 0.42;
const OUTLINE_REFINEMENT_MIN_GAIN = 1.2;
const TEMPLATE_ALIGN_SHIFTS = [-0.5, -0.25, 0, 0.25, 0.5];
const TEMPLATE_ALIGN_SCALES = [0.99, 1, 1.01];
const SUBPIXEL_REFINE_SHIFTS = [-0.25, 0, 0.25];
const SUBPIXEL_REFINE_SCALES = [0.99, 1, 1.01];
const ALPHA_GAIN_CANDIDATES = [1.05, 1.12, 1.2, 1.28, 1.36, 1.45, 1.52, 1.6, 1.7, 1.85, 2.0, 2.2, 2.4, 2.6];

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

function normalizeMetaPosition(position) {
    if (!position) return null;

    const { x, y, width, height } = position;
    if (![x, y, width, height].every((value) => Number.isFinite(value))) {
        return null;
    }

    return { x, y, width, height };
}

function normalizeMetaConfig(config) {
    if (!config) return null;

    const { logoSize, marginRight, marginBottom } = config;
    if (![logoSize, marginRight, marginBottom].every((value) => Number.isFinite(value))) {
        return null;
    }

    return { logoSize, marginRight, marginBottom };
}

function createWatermarkMeta({
    position = null,
    config = null,
    adaptiveConfidence = null,
    originalSpatialScore = null,
    originalGradientScore = null,
    processedSpatialScore = null,
    processedGradientScore = null,
    suppressionGain = null,
    templateWarp = null,
    alphaGain = 1,
    passCount = 0,
    attemptedPassCount = 0,
    passStopReason = null,
    passes = null,
    source = 'standard',
    applied = true,
    skipReason = null,
    subpixelShift = null
} = {}) {
    const normalizedPosition = normalizeMetaPosition(position);

    return {
        applied,
        skipReason: applied ? null : skipReason,
        size: normalizedPosition ? normalizedPosition.width : null,
        position: normalizedPosition,
        config: normalizeMetaConfig(config),
        detection: {
            adaptiveConfidence,
            originalSpatialScore,
            originalGradientScore,
            processedSpatialScore,
            processedGradientScore,
            suppressionGain
        },
        templateWarp: templateWarp ?? null,
        alphaGain,
        passCount,
        attemptedPassCount,
        passStopReason,
        passes: Array.isArray(passes) ? passes : null,
        source,
        subpixelShift: subpixelShift ?? null
    };
}

function shouldRecalibrateAlphaStrength({ originalScore, processedScore, suppressionGain }) {
    return originalScore >= 0.6 &&
        processedScore >= RESIDUAL_RECALIBRATION_THRESHOLD &&
        suppressionGain <= MIN_SUPPRESSION_FOR_SKIP_RECALIBRATION;
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

function findBestTemplateWarp({
    originalImageData,
    alphaMap,
    position,
    baselineSpatialScore,
    baselineGradientScore
}) {
    const size = position.width;
    if (!size || size <= 8) return null;

    let best = {
        spatialScore: baselineSpatialScore,
        gradientScore: baselineGradientScore,
        shift: { dx: 0, dy: 0, scale: 1 },
        alphaMap
    };

    for (const scale of TEMPLATE_ALIGN_SCALES) {
        for (const dy of TEMPLATE_ALIGN_SHIFTS) {
            for (const dx of TEMPLATE_ALIGN_SHIFTS) {
                if (dx === 0 && dy === 0 && scale === 1) continue;
                const warped = warpAlphaMap(alphaMap, size, { dx, dy, scale });
                const spatialScore = computeRegionSpatialCorrelation({
                    imageData: originalImageData,
                    alphaMap: warped,
                    region: { x: position.x, y: position.y, size }
                });
                const gradientScore = computeRegionGradientCorrelation({
                    imageData: originalImageData,
                    alphaMap: warped,
                    region: { x: position.x, y: position.y, size }
                });

                const confidence =
                    Math.max(0, spatialScore) * 0.7 +
                    Math.max(0, gradientScore) * 0.3;
                const bestConfidence =
                    Math.max(0, best.spatialScore) * 0.7 +
                    Math.max(0, best.gradientScore) * 0.3;

                if (confidence > bestConfidence + 0.01) {
                    best = {
                        spatialScore,
                        gradientScore,
                        shift: { dx, dy, scale },
                        alphaMap: warped
                    };
                }
            }
        }
    }

    const improvedSpatial = best.spatialScore >= baselineSpatialScore + 0.01;
    const improvedGradient = best.gradientScore >= baselineGradientScore + 0.01;
    return improvedSpatial || improvedGradient ? best : null;
}

function refineSubpixelOutline({
    sourceImageData,
    alphaMap,
    position,
    alphaGain,
    originalNearBlackRatio,
    baselineSpatialScore,
    baselineGradientScore,
    baselineShift
}) {
    const size = position.width;
    if (!size || size <= 8) return null;
    if (alphaGain < OUTLINE_REFINEMENT_MIN_GAIN) return null;

    const maxAllowedNearBlackRatio = Math.min(1, originalNearBlackRatio + MAX_NEAR_BLACK_RATIO_INCREASE);
    const gainCandidates = [alphaGain];
    const lower = Math.max(1, Number((alphaGain - 0.01).toFixed(2)));
    const upper = Number((alphaGain + 0.01).toFixed(2));
    if (lower !== alphaGain) gainCandidates.push(lower);
    if (upper !== alphaGain) gainCandidates.push(upper);

    const baseDx = baselineShift?.dx ?? 0;
    const baseDy = baselineShift?.dy ?? 0;
    const baseScale = baselineShift?.scale ?? 1;

    let best = null;
    for (const scaleDelta of SUBPIXEL_REFINE_SCALES) {
        const scale = Number((baseScale * scaleDelta).toFixed(4));
        for (const dyDelta of SUBPIXEL_REFINE_SHIFTS) {
            const dy = baseDy + dyDelta;
            for (const dxDelta of SUBPIXEL_REFINE_SHIFTS) {
                const dx = baseDx + dxDelta;
                const warped = warpAlphaMap(alphaMap, size, { dx, dy, scale });
                for (const gain of gainCandidates) {
                    const candidate = cloneImageData(sourceImageData);
                    removeWatermark(candidate, warped, position, { alphaGain: gain });
                    const nearBlackRatio = calculateNearBlackRatio(candidate, position);
                    if (nearBlackRatio > maxAllowedNearBlackRatio) continue;

                    const spatialScore = computeRegionSpatialCorrelation({
                        imageData: candidate,
                        alphaMap: warped,
                        region: { x: position.x, y: position.y, size }
                    });
                    const gradientScore = computeRegionGradientCorrelation({
                        imageData: candidate,
                        alphaMap: warped,
                        region: { x: position.x, y: position.y, size }
                    });

                    const cost = Math.abs(spatialScore) * 0.6 + Math.max(0, gradientScore);
                    if (!best || cost < best.cost) {
                        best = {
                            imageData: candidate,
                            alphaMap: warped,
                            alphaGain: gain,
                            shift: { dx, dy, scale },
                            spatialScore,
                            gradientScore,
                            nearBlackRatio,
                            cost
                        };
                    }
                }
            }
        }
    }

    if (!best) return null;

    const improvedGradient = best.gradientScore <= baselineGradientScore - 0.04;
    const keptSpatial = Math.abs(best.spatialScore) <= Math.abs(baselineSpatialScore) + 0.08;
    if (!improvedGradient || !keptSpatial) return null;

    return best;
}

function recalibrateAlphaStrength({
    sourceImageData,
    alphaMap,
    position,
    originalSpatialScore,
    processedSpatialScore,
    originalNearBlackRatio
}) {
    let bestScore = processedSpatialScore;
    let bestGain = 1;
    let bestImageData = null;
    const maxAllowedNearBlackRatio = Math.min(1, originalNearBlackRatio + MAX_NEAR_BLACK_RATIO_INCREASE);

    for (const alphaGain of ALPHA_GAIN_CANDIDATES) {
        const candidate = cloneImageData(sourceImageData);
        removeWatermark(candidate, alphaMap, position, { alphaGain });
        const candidateNearBlackRatio = calculateNearBlackRatio(candidate, position);
        if (candidateNearBlackRatio > maxAllowedNearBlackRatio) {
            continue;
        }

        const score = computeRegionSpatialCorrelation({
            imageData: candidate,
            alphaMap,
            region: {
                x: position.x,
                y: position.y,
                size: position.width
            }
        });

        if (score < bestScore) {
            bestScore = score;
            bestGain = alphaGain;
            bestImageData = candidate;
        }
    }

    const refinedCandidates = [];
    for (let delta = -0.05; delta <= 0.05; delta += 0.01) {
        refinedCandidates.push(Number((bestGain + delta).toFixed(2)));
    }

    for (const alphaGain of refinedCandidates) {
        if (alphaGain <= 1 || alphaGain >= 3) continue;
        const candidate = cloneImageData(sourceImageData);
        removeWatermark(candidate, alphaMap, position, { alphaGain });
        const candidateNearBlackRatio = calculateNearBlackRatio(candidate, position);
        if (candidateNearBlackRatio > maxAllowedNearBlackRatio) {
            continue;
        }

        const score = computeRegionSpatialCorrelation({
            imageData: candidate,
            alphaMap,
            region: {
                x: position.x,
                y: position.y,
                size: position.width
            }
        });

        if (score < bestScore) {
            bestScore = score;
            bestGain = alphaGain;
            bestImageData = candidate;
        }
    }

    const scoreDelta = processedSpatialScore - bestScore;
    if (!bestImageData || scoreDelta < MIN_RECALIBRATION_SCORE_DELTA) {
        return null;
    }

    return {
        imageData: bestImageData,
        alphaGain: bestGain,
        processedSpatialScore: bestScore,
        suppressionGain: originalSpatialScore - bestScore
    };
}

export function processWatermarkImageData(imageData, options = {}) {
    const adaptiveMode = options.adaptiveMode || 'auto';
    const allowAdaptiveSearch = adaptiveMode !== 'never' && adaptiveMode !== 'off';
    const originalImageData = cloneImageData(imageData);
    const { alpha48, alpha96 } = options;

    if (!alpha48 || !alpha96) {
        throw new Error('processWatermarkImageData requires alpha48 and alpha96');
    }

    const defaultConfig = detectWatermarkConfig(originalImageData.width, originalImageData.height);
    const resolvedConfig = resolveInitialStandardConfig({
        imageData: originalImageData,
        defaultConfig,
        alpha48,
        alpha96
    });

    let config = resolvedConfig;
    let position = calculateWatermarkPosition(originalImageData.width, originalImageData.height, config);
    let alphaMap = config.logoSize === 96 ? alpha96 : alpha48;
    let source = 'standard';
    let adaptiveConfidence = null;
    let alphaGain = 1;
    let subpixelShift = null;
    let passCount = 0;
    let attemptedPassCount = 0;
    let passStopReason = null;
    let passes = null;

    const standardSpatialScore = computeRegionSpatialCorrelation({
        imageData: originalImageData,
        alphaMap,
        region: {
            x: position.x,
            y: position.y,
            size: position.width
        }
    });
    const standardGradientScore = computeRegionGradientCorrelation({
        imageData: originalImageData,
        alphaMap,
        region: {
            x: position.x,
            y: position.y,
            size: position.width
        }
    });

    if (!hasReliableStandardWatermarkSignal({
        spatialScore: standardSpatialScore,
        gradientScore: standardGradientScore
    })) {
        const adaptive = allowAdaptiveSearch
            ? detectAdaptiveWatermarkRegion({
                imageData: originalImageData,
                alpha96,
                defaultConfig: config
            })
            : null;

        adaptiveConfidence = adaptive?.confidence ?? null;

        if (!hasReliableAdaptiveWatermarkSignal(adaptive)) {
            return {
                imageData: originalImageData,
                meta: createWatermarkMeta({
                    adaptiveConfidence,
                    originalSpatialScore: standardSpatialScore,
                    originalGradientScore: standardGradientScore,
                    processedSpatialScore: standardSpatialScore,
                    processedGradientScore: standardGradientScore,
                    suppressionGain: 0,
                    alphaGain: 1,
                    source: 'skipped',
                    applied: false,
                    skipReason: 'no-watermark-detected'
                })
            };
        }

        const size = adaptive.region.size;
        position = {
            x: adaptive.region.x,
            y: adaptive.region.y,
            width: size,
            height: size
        };
        alphaMap = size === 96 ? alpha96 : options.getAlphaMap?.(size);
        if (!alphaMap) {
            throw new Error(`Missing alpha map for adaptive size ${size}`);
        }
        config = {
            logoSize: size,
            marginRight: originalImageData.width - position.x - size,
            marginBottom: originalImageData.height - position.y - size
        };
        source = 'adaptive';
    }

    const fixedImageData = cloneImageData(originalImageData);
    removeWatermark(fixedImageData, alphaMap, position);

    let finalImageData = fixedImageData;
    const shouldFallback = adaptiveMode === 'always'
        ? true
        : shouldAttemptAdaptiveFallback({
            processedImageData: fixedImageData,
            alphaMap,
            position,
            originalImageData,
            originalSpatialMismatchThreshold: 0
        });

    if (shouldFallback && allowAdaptiveSearch) {
        const adaptive = detectAdaptiveWatermarkRegion({
            imageData: originalImageData,
            alpha96,
            defaultConfig: config
        });

        if (hasReliableAdaptiveWatermarkSignal(adaptive)) {
            adaptiveConfidence = adaptive.confidence;
            const size = adaptive.region.size;
            const adaptivePosition = {
                x: adaptive.region.x,
                y: adaptive.region.y,
                width: size,
                height: size
            };
            const positionDelta =
                Math.abs(adaptivePosition.x - position.x) +
                Math.abs(adaptivePosition.y - position.y) +
                Math.abs(adaptivePosition.width - position.width);

            if (positionDelta >= 4) {
                position = adaptivePosition;
                alphaMap = size === 96 ? alpha96 : options.getAlphaMap?.(size);
                if (!alphaMap) {
                    throw new Error(`Missing alpha map for adaptive size ${size}`);
                }
                config = {
                    logoSize: size,
                    marginRight: originalImageData.width - adaptivePosition.x - size,
                    marginBottom: originalImageData.height - adaptivePosition.y - size
                };
                source = 'adaptive';
                const adaptiveImageData = cloneImageData(originalImageData);
                removeWatermark(adaptiveImageData, alphaMap, position);
                finalImageData = adaptiveImageData;
            }
        }
    }

    let originalSpatialScore = computeRegionSpatialCorrelation({
        imageData: originalImageData,
        alphaMap,
        region: {
            x: position.x,
            y: position.y,
            size: position.width
        }
    });
    let originalGradientScore = computeRegionGradientCorrelation({
        imageData: originalImageData,
        alphaMap,
        region: {
            x: position.x,
            y: position.y,
            size: position.width
        }
    });

    const templateWarp = findBestTemplateWarp({
        originalImageData,
        alphaMap,
        position,
        baselineSpatialScore: originalSpatialScore,
        baselineGradientScore: originalGradientScore
    });
    if (templateWarp) {
        alphaMap = templateWarp.alphaMap;
        originalSpatialScore = templateWarp.spatialScore;
        originalGradientScore = templateWarp.gradientScore;
    }

    const firstPassSpatialScore = computeRegionSpatialCorrelation({
        imageData: finalImageData,
        alphaMap,
        region: { x: position.x, y: position.y, size: position.width }
    });
    const firstPassGradientScore = computeRegionGradientCorrelation({
        imageData: finalImageData,
        alphaMap,
        region: { x: position.x, y: position.y, size: position.width }
    });
    const firstPassNearBlackRatio = calculateNearBlackRatio(finalImageData, position);
    const firstPassRecord = {
        index: 1,
        beforeSpatialScore: originalSpatialScore,
        beforeGradientScore: originalGradientScore,
        afterSpatialScore: firstPassSpatialScore,
        afterGradientScore: firstPassGradientScore,
        improvement: Math.abs(originalSpatialScore) - Math.abs(firstPassSpatialScore),
        gradientDelta: firstPassGradientScore - originalGradientScore,
        nearBlackRatio: firstPassNearBlackRatio
    };

    const totalMaxPasses = Math.max(1, options.maxPasses ?? 4);
    const remainingPasses = Math.max(0, totalMaxPasses - 1);
    const extraPassResult = remainingPasses > 0
        ? removeRepeatedWatermarkLayers({
            imageData: finalImageData,
            alphaMap,
            position,
            maxPasses: remainingPasses,
            startingPassIndex: 1
        })
        : null;
    finalImageData = extraPassResult?.imageData ?? finalImageData;
    passCount = extraPassResult?.passCount ?? 1;
    attemptedPassCount = extraPassResult?.attemptedPassCount ?? 1;
    passStopReason = extraPassResult?.stopReason ?? (Math.abs(firstPassSpatialScore) <= 0.25 ? 'residual-low' : 'max-passes');
    passes = [firstPassRecord, ...(extraPassResult?.passes ?? [])];
    if (passCount > 1) {
        source = `${source}+multipass`;
    }

    const processedSpatialScore = computeRegionSpatialCorrelation({
        imageData: finalImageData,
        alphaMap,
        region: {
            x: position.x,
            y: position.y,
            size: position.width
        }
    });
    const processedGradientScore = computeRegionGradientCorrelation({
        imageData: finalImageData,
        alphaMap,
        region: {
            x: position.x,
            y: position.y,
            size: position.width
        }
    });
    let finalProcessedSpatialScore = processedSpatialScore;
    let finalProcessedGradientScore = processedGradientScore;
    let suppressionGain = originalSpatialScore - finalProcessedSpatialScore;

    if (shouldRecalibrateAlphaStrength({
        originalScore: originalSpatialScore,
        processedScore: finalProcessedSpatialScore,
        suppressionGain
    })) {
        const originalNearBlackRatio = calculateNearBlackRatio(finalImageData, position);
        const recalibrated = recalibrateAlphaStrength({
            sourceImageData: finalImageData,
            alphaMap,
            position,
            originalSpatialScore,
            processedSpatialScore: finalProcessedSpatialScore,
            originalNearBlackRatio
        });

        if (recalibrated) {
            finalImageData = recalibrated.imageData;
            alphaGain = recalibrated.alphaGain;
            finalProcessedSpatialScore = recalibrated.processedSpatialScore;
            suppressionGain = recalibrated.suppressionGain;
            source = source === 'adaptive' ? 'adaptive+gain' : `${source}+gain`;
        }
    }

    if (finalProcessedSpatialScore <= 0.3 && finalProcessedGradientScore >= OUTLINE_REFINEMENT_THRESHOLD) {
        const originalNearBlackRatio = calculateNearBlackRatio(finalImageData, position);
        const baselineShift = templateWarp?.shift ?? { dx: 0, dy: 0, scale: 1 };
        const refined = refineSubpixelOutline({
            sourceImageData: finalImageData,
            alphaMap,
            position,
            alphaGain,
            originalNearBlackRatio,
            baselineSpatialScore: finalProcessedSpatialScore,
            baselineGradientScore: finalProcessedGradientScore,
            baselineShift
        });

        if (refined) {
            finalImageData = refined.imageData;
            alphaMap = refined.alphaMap;
            alphaGain = refined.alphaGain;
            finalProcessedSpatialScore = refined.spatialScore;
            finalProcessedGradientScore = refined.gradientScore;
            suppressionGain = originalSpatialScore - finalProcessedSpatialScore;
            source = `${source}+subpixel`;
            subpixelShift = refined.shift;
        }
    }

    return {
        imageData: finalImageData,
        meta: createWatermarkMeta({
            position,
            config,
            adaptiveConfidence,
            originalSpatialScore,
            originalGradientScore,
            processedSpatialScore: finalProcessedSpatialScore,
            processedGradientScore: finalProcessedGradientScore,
            suppressionGain,
            templateWarp: templateWarp?.shift ?? null,
            alphaGain,
            passCount,
            attemptedPassCount,
            passStopReason,
            passes,
            source,
            applied: true,
            subpixelShift
        })
    };
}
