// 採点。DOM に依存しない。

import { deltaE2000, labForVision } from "./color.js";

/**
 * 表示用の段階ラベル。ΔE00 の上限値で判定する（上から順に評価）。
 * 点数は連続関数で計算し、ラベルは表示専用とする（境界で点数が跳ねないようにするため）。
 */
export const GRADES = Object.freeze([
    { id: "perfect", label: "PERFECT", maxDeltaE: 1 },
    { id: "excellent", label: "EXCELLENT", maxDeltaE: 3 },
    { id: "great", label: "GREAT", maxDeltaE: 6 },
    { id: "good", label: "GOOD", maxDeltaE: 10 },
    { id: "ok", label: "OK", maxDeltaE: 20 },
    { id: "miss", label: "MISS", maxDeltaE: Infinity },
]);

export const NO_PICK_GRADE = Object.freeze({ id: "none", label: "NO PICK", maxDeltaE: Infinity });

/** S = 100 * exp(-ΔE / k)。k が大きいほど甘くなる。 */
export function scoreFromDeltaE(deltaE, k) {
    if (!(k > 0)) {
        throw new RangeError(`採点係数 k は正の数である必要があります: ${k}`);
    }
    return 100 * Math.exp(-deltaE / k);
}

export function gradeFromDeltaE(deltaE) {
    return GRADES.find((grade) => deltaE <= grade.maxDeltaE);
}

/**
 * お題色と選択色を、探す人の色覚タイプで見た色として比較する。
 * @param {number[]} targetLin お題色（線形 sRGB）
 * @param {number[] | null} pickedLin 選択色（未選択なら null）
 * @param {string} vision 探す人の色覚タイプ
 * @param {number} k 採点係数
 */
export function evaluatePick(targetLin, pickedLin, vision, k) {
    if (pickedLin === null) {
        return { deltaE: null, score: 0, grade: NO_PICK_GRADE };
    }
    const deltaE = deltaE2000(labForVision(targetLin, vision), labForVision(pickedLin, vision));
    return { deltaE, score: scoreFromDeltaE(deltaE, k), grade: gradeFromDeltaE(deltaE) };
}
