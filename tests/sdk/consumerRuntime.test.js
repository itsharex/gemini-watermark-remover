import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const ROOT_DIR = process.cwd();
const WINDOWS_SHELL = process.env.ComSpec || 'cmd.exe';

function run(command, args, cwd) {
    const result = spawnSync(
        process.platform === 'win32' && command === 'pnpm' ? WINDOWS_SHELL : command,
        process.platform === 'win32' && command === 'pnpm'
            ? ['/d', '/s', '/c', command, ...args]
            : args,
        {
            cwd,
            encoding: 'utf8'
        }
    );

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        const details = [result.stdout, result.stderr]
            .filter(Boolean)
            .join('\n')
            .trim();
        throw new Error(details || `${command} failed`);
    }

    return result;
}

test('packed sdk should be runnable from an isolated consumer project', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'wm-consumer-'));
    const nodeModulesDir = path.join(tempDir, 'node_modules');
    const packageRoot = path.join(nodeModulesDir, 'gemini-watermark-remover');
    const tarballDir = path.join(tempDir, 'packed');
    const consumerEntry = path.join(tempDir, 'consumer.mjs');

    await mkdir(packageRoot, { recursive: true });
    await mkdir(tarballDir, { recursive: true });

    run('pnpm', ['pack', '--pack-destination', tarballDir], ROOT_DIR);

    const packedFiles = await readdir(tarballDir);
    assert.equal(packedFiles.length, 1, `expected exactly one tarball, got ${packedFiles.join(', ')}`);

    const tarballPath = path.join(tarballDir, packedFiles[0]);
    run('tar', ['-xf', tarballPath, '-C', packageRoot, '--strip-components=1'], ROOT_DIR);

    await writeFile(consumerEntry, `
import assert from 'node:assert/strict';
import {
    createWatermarkEngine,
    removeWatermarkFromImageDataSync
} from 'gemini-watermark-remover';
import { removeWatermarkFromBuffer, inferMimeTypeFromPath } from 'gemini-watermark-remover/node';

const engine = await createWatermarkEngine();
const imageData = {
    width: 320,
    height: 320,
    data: new Uint8ClampedArray(320 * 320 * 4)
};

const syncResult = removeWatermarkFromImageDataSync(imageData, {
    adaptiveMode: 'never',
    maxPasses: 1
});

const bufferResult = await removeWatermarkFromBuffer(
    Buffer.from(JSON.stringify({
        width: imageData.width,
        height: imageData.height,
        data: Array.from(imageData.data)
    })),
    {
        mimeType: 'image/png',
        decodeImageData(buffer) {
            const payload = JSON.parse(Buffer.from(buffer).toString('utf8'));
            return {
                width: payload.width,
                height: payload.height,
                data: Uint8ClampedArray.from(payload.data)
            };
        },
        encodeImageData(output) {
            return Buffer.from(JSON.stringify({
                width: output.width,
                height: output.height,
                data: Array.from(output.data)
            }));
        },
        adaptiveMode: 'never',
        maxPasses: 1
    }
);

assert.equal(typeof engine.getAlphaMap, 'function');
assert.equal(syncResult.imageData.width, 320);
assert.equal(typeof syncResult.meta.applied, 'boolean');
assert.equal(inferMimeTypeFromPath('example.png'), 'image/png');
assert.ok(Buffer.isBuffer(bufferResult.buffer));
assert.equal(typeof bufferResult.meta.applied, 'boolean');
console.log(JSON.stringify({
    syncWidth: syncResult.imageData.width,
    syncMetaAppliedType: typeof syncResult.meta.applied,
    bufferLength: bufferResult.buffer.length,
    bufferMetaAppliedType: typeof bufferResult.meta.applied
}));
`, 'utf8');

    const execution = run('node', [consumerEntry], tempDir);
    const output = JSON.parse(execution.stdout.trim());

    assert.equal(output.syncWidth, 320);
    assert.equal(output.syncMetaAppliedType, 'boolean');
    assert.equal(output.bufferMetaAppliedType, 'boolean');
    assert.ok(output.bufferLength > 0);
});
