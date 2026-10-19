// ピクセル平均、均一性判定、お題色の選定。
// ImageData 互換オブジェクト（{ data, width, height }）だけを扱い、DOM に依存しない。

import { deltaE2000, linearToLab, srgb8ToLinear } from "./color.js";

/**
 * (x, y) を中心とした (2r+1)x(2r+1) 範囲の平均色を線形 sRGB で返す。
 * 画像の端では端のピクセルを繰り返して扱う。
 */
export function averageLinearAt(image, x, y, radius) {
    const { data, width, height } = image;
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (let dy = -radius; dy <= radius; dy++) {
        const py = clampInt(y + dy, 0, height - 1);
        for (let dx = -radius; dx <= radius; dx++) {
            const px = clampInt(x + dx, 0, width - 1);
            const i = (py * width + px) * 4;
            r += srgb8ToLinear(data[i]);
            g += srgb8ToLinear(data[i + 1]);
            b += srgb8ToLinear(data[i + 2]);
            count++;
        }
    }
    return [r / count, g / count, b / count];
}

/**
 * 平均色と、範囲内の各ピクセルとの最大 ΔE00。
 * 値が大きい場所は境界やノイズ上にあり、1 ピクセルのずれで色が大きく変わる。
 */
export function localNonUniformity(image, x, y, radius, averageLab) {
    const { data, width, height } = image;
    let worst = 0;
    for (let dy = -radius; dy <= radius; dy++) {
        const py = clampInt(y + dy, 0, height - 1);
        for (let dx = -radius; dx <= radius; dx++) {
            const px = clampInt(x + dx, 0, width - 1);
            const i = (py * width + px) * 4;
            const lab = linearToLab([srgb8ToLinear(data[i]), srgb8ToLinear(data[i + 1]), srgb8ToLinear(data[i + 2])]);
            const d = deltaE2000(averageLab, lab);
            if (d > worst) {
                worst = d;
            }
        }
    }
    return worst;
}

/**
 * フレームプール（静止画なら 1 枚、動画なら複数フレーム）を逐次受け取り、
 * 参照サンプルとお題候補を蓄積する。ImageData 自体は保持しない（4K 動画でもメモリを圧迫しないため）。
 */
export class TargetCollector {
    /**
     * @param {object} options
     * @param {number} options.radius 平均範囲の半径（1 なら 3x3）
     * @param {number} options.referenceSamplesPerFrame 難易度計測用のサンプル数（1 フレームあたり）
     * @param {number} options.candidatesPerFrame お題候補数（1 フレームあたり）
     * @param {number} options.maxNonUniformity 候補として許す局所的な色ムラ（ΔE00）
     * @param {number} options.minLightness 候補の L* 下限
     * @param {number} options.maxLightness 候補の L* 上限
     * @param {() => number} rng 0 以上 1 未満の乱数
     */
    constructor(options, rng = Math.random) {
        this.options = options;
        this.rng = rng;
        this.referenceLabs = [];
        this.candidates = [];
    }

    /**
     * @param {{ data: Uint8ClampedArray, width: number, height: number }} image
     * @param {number} frameIndex
     * @param {number | null} time 動画のフレーム時刻（静止画は null）
     */
    addFrame(image, frameIndex, time) {
        const { radius, referenceSamplesPerFrame, candidatesPerFrame, maxNonUniformity, minLightness, maxLightness }
            = this.options;
        if (image.width <= radius * 2 || image.height <= radius * 2) {
            throw new RangeError(`画像が小さすぎます（${image.width}x${image.height}）`);
        }

        for (let i = 0; i < referenceSamplesPerFrame; i++) {
            const x = this.randomInt(radius, image.width - 1 - radius);
            const y = this.randomInt(radius, image.height - 1 - radius);
            this.referenceLabs.push(linearToLab(averageLinearAt(image, x, y, radius)));
        }

        // 条件を満たす場所が少ない画像でも無限ループしないよう、試行回数に上限を設ける。
        const maxAttempts = candidatesPerFrame * 40;
        let accepted = 0;
        for (let attempt = 0; attempt < maxAttempts && accepted < candidatesPerFrame; attempt++) {
            const x = this.randomInt(radius, image.width - 1 - radius);
            const y = this.randomInt(radius, image.height - 1 - radius);
            const lin = averageLinearAt(image, x, y, radius);
            const lab = linearToLab(lin);
            if (lab[0] < minLightness || lab[0] > maxLightness) {
                continue;
            }
            if (localNonUniformity(image, x, y, radius, lab) > maxNonUniformity) {
                continue;
            }
            this.candidates.push({ lin, lab, frameIndex, time, x, y, ease: 0 });
            accepted++;
        }
    }

    /**
     * 必要数のお題を選ぶ。
     * 1 つ目はランダム。2 つ目以降は、既に選んだお題と十分に色が離れている候補の中から、
     * 1 つ目と「見つけやすさ」が最も近いものを選ぶ（チーム間で難易度を揃えるため）。
     *
     * 見つけやすさ（ease）= 参照サンプルのうち ΔE00 が easeThreshold 以下のものの割合。
     *
     * @param {number} count
     * @param {{ easeThreshold: number, minSeparation: number }} options
     */
    pickTargets(count, { easeThreshold, minSeparation }) {
        if (this.candidates.length === 0) {
            throw new Error("お題に使える色が見つかりませんでした。色ムラが少なく、極端に暗く・明るくない領域を含む素材を使ってください。");
        }
        if (this.candidates.length < count) {
            throw new Error(`お題候補が不足しています（必要 ${count}、候補 ${this.candidates.length}）。`);
        }

        const references = this.referenceLabs;
        for (const candidate of this.candidates) {
            let near = 0;
            for (const ref of references) {
                if (deltaE2000(candidate.lab, ref) <= easeThreshold) {
                    near++;
                }
            }
            candidate.ease = references.length > 0 ? near / references.length : 0;
        }

        const remaining = [...this.candidates];
        const first = remaining.splice(this.randomInt(0, remaining.length - 1), 1)[0];
        const chosen = [first];

        while (chosen.length < count) {
            let bestIndex = -1;
            let bestEaseGap = Infinity;
            let fallbackIndex = -1;
            let fallbackSeparation = -Infinity;
            remaining.forEach((candidate, index) => {
                const separation = Math.min(...chosen.map((c) => deltaE2000(c.lab, candidate.lab)));
                if (separation >= minSeparation) {
                    const gap = Math.abs(candidate.ease - first.ease);
                    if (gap < bestEaseGap) {
                        bestEaseGap = gap;
                        bestIndex = index;
                    }
                }
                if (separation > fallbackSeparation) {
                    fallbackSeparation = separation;
                    fallbackIndex = index;
                }
            });
            // 十分に離れた候補がない場合は、最も離れた候補で妥協する。
            const index = bestIndex >= 0 ? bestIndex : fallbackIndex;
            chosen.push(remaining.splice(index, 1)[0]);
        }
        return chosen;
    }

    randomInt(min, max) {
        return min + Math.floor(this.rng() * (max - min + 1));
    }
}

function clampInt(v, min, max) {
    return v < min ? min : (v > max ? max : v);
}
