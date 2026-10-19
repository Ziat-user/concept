// 色空間変換と色差計算。
//
// 内部表現は「線形 sRGB（0..1 の 3 要素配列）」に統一する。
// - 3x3 平均は物理的に正しい線形光の空間で取る。
// - 表示用には sRGB 8bit へ、判定用には CIELAB へ変換する。
// DOM に依存しないため、Node.js から単体テストできる。

/** 色覚タイプ。設定画面の選択肢と一致させる。 */
export const VISION_TYPES = Object.freeze({
    normal: "一般色覚",
    protan: "P型（1型）",
    deutan: "D型（2型）",
    tritan: "T型（3型）",
});

// Machado, Oliveira, Fernandes (2009) の色覚シミュレーション行列（severity = 1.0）。
// 線形 RGB に対して適用する。
const CVD_MATRICES = Object.freeze({
    protan: [
        [0.152286, 1.052583, -0.204868],
        [0.114503, 0.786281, 0.099216],
        [-0.003882, -0.048116, 1.051998],
    ],
    deutan: [
        [0.367322, 0.860646, -0.227968],
        [0.280085, 0.672501, 0.047413],
        [-0.011820, 0.042940, 0.968881],
    ],
    tritan: [
        [1.255528, -0.076749, -0.178779],
        [-0.078411, 0.930809, 0.147602],
        [0.004733, 0.691367, 0.303900],
    ],
});

// D65 白色点
const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;

const SRGB8_TO_LINEAR = (() => {
    const table = new Float64Array(256);
    for (let i = 0; i < 256; i++) {
        table[i] = srgbUnitToLinear(i / 255);
    }
    return table;
})();

function srgbUnitToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgbUnit(c) {
    return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function clamp01(v) {
    return v < 0 ? 0 : (v > 1 ? 1 : v);
}

/** sRGB 8bit 値（整数 0..255）を線形値へ。 */
export function srgb8ToLinear(value) {
    return SRGB8_TO_LINEAR[value];
}

/** 線形 sRGB を sRGB 8bit（整数）へ。表示用。 */
export function linearToSrgb8(lin) {
    return lin.map((c) => Math.round(clamp01(linearToSrgbUnit(clamp01(c))) * 255));
}

/** 線形 sRGB を CSS 色文字列へ。 */
export function linearToCss(lin) {
    const [r, g, b] = linearToSrgb8(lin);
    return `rgb(${r}, ${g}, ${b})`;
}

/** 線形 sRGB を #RRGGBB へ。 */
export function linearToHex(lin) {
    return "#" + linearToSrgb8(lin).map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function labF(t) {
    const delta = 6 / 29;
    return t > delta * delta * delta ? Math.cbrt(t) : t / (3 * delta * delta) + 4 / 29;
}

/** 線形 sRGB を CIELAB（D65）へ。戻り値は [L, a, b]。 */
export function linearToLab(lin) {
    const r = clamp01(lin[0]);
    const g = clamp01(lin[1]);
    const b = clamp01(lin[2]);
    const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
    const y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    const z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
    const fx = labF(x / XN);
    const fy = labF(y / YN);
    const fz = labF(z / ZN);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** 指定した色覚タイプで見たときの色を線形 sRGB で返す。 */
export function simulateVision(lin, vision) {
    if (vision === "normal" || vision === undefined) {
        return [lin[0], lin[1], lin[2]];
    }
    const m = CVD_MATRICES[vision];
    if (m === undefined) {
        throw new RangeError(`未知の色覚タイプです: ${vision}`);
    }
    return [
        clamp01(m[0][0] * lin[0] + m[0][1] * lin[1] + m[0][2] * lin[2]),
        clamp01(m[1][0] * lin[0] + m[1][1] * lin[1] + m[1][2] * lin[2]),
        clamp01(m[2][0] * lin[0] + m[2][1] * lin[1] + m[2][2] * lin[2]),
    ];
}

/** 色覚タイプを考慮した CIELAB 値。 */
export function labForVision(lin, vision) {
    return linearToLab(simulateVision(lin, vision));
}

const DEG = Math.PI / 180;
const POW25_7 = Math.pow(25, 7);

/**
 * CIEDE2000 色差（kL = kC = kH = 1）。
 * Sharma, Wu, Dalal (2005) の実装上の注意点（色相の扱い）に従う。
 */
export function deltaE2000(lab1, lab2) {
    const [l1, a1, b1] = lab1;
    const [l2, a2, b2] = lab2;

    const c1 = Math.hypot(a1, b1);
    const c2 = Math.hypot(a2, b2);
    const cBar7 = Math.pow((c1 + c2) / 2, 7);
    const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + POW25_7)));

    const a1p = (1 + g) * a1;
    const a2p = (1 + g) * a2;
    const c1p = Math.hypot(a1p, b1);
    const c2p = Math.hypot(a2p, b2);
    const h1p = hueDegrees(a1p, b1);
    const h2p = hueDegrees(a2p, b2);

    const dLp = l2 - l1;
    const dCp = c2p - c1p;
    const chromaProduct = c1p * c2p;

    let dhp = 0;
    if (chromaProduct !== 0) {
        dhp = h2p - h1p;
        if (dhp > 180) {
            dhp -= 360;
        } else if (dhp < -180) {
            dhp += 360;
        }
    }
    const dHp = 2 * Math.sqrt(chromaProduct) * Math.sin((dhp / 2) * DEG);

    const lBarP = (l1 + l2) / 2;
    const cBarP = (c1p + c2p) / 2;

    let hBarP;
    if (chromaProduct === 0) {
        hBarP = h1p + h2p;
    } else if (Math.abs(h1p - h2p) <= 180) {
        hBarP = (h1p + h2p) / 2;
    } else if (h1p + h2p < 360) {
        hBarP = (h1p + h2p + 360) / 2;
    } else {
        hBarP = (h1p + h2p - 360) / 2;
    }

    const t = 1
        - 0.17 * Math.cos((hBarP - 30) * DEG)
        + 0.24 * Math.cos(2 * hBarP * DEG)
        + 0.32 * Math.cos((3 * hBarP + 6) * DEG)
        - 0.20 * Math.cos((4 * hBarP - 63) * DEG);
    const dTheta = 30 * Math.exp(-Math.pow((hBarP - 275) / 25, 2));
    const cBarP7 = Math.pow(cBarP, 7);
    const rc = 2 * Math.sqrt(cBarP7 / (cBarP7 + POW25_7));
    const lDev2 = (lBarP - 50) * (lBarP - 50);
    const sl = 1 + (0.015 * lDev2) / Math.sqrt(20 + lDev2);
    const sc = 1 + 0.045 * cBarP;
    const sh = 1 + 0.015 * cBarP * t;
    const rt = -Math.sin(2 * dTheta * DEG) * rc;

    const lTerm = dLp / sl;
    const cTerm = dCp / sc;
    const hTerm = dHp / sh;
    return Math.sqrt(lTerm * lTerm + cTerm * cTerm + hTerm * hTerm + rt * cTerm * hTerm);
}

function hueDegrees(a, b) {
    if (a === 0 && b === 0) {
        return 0;
    }
    const h = Math.atan2(b, a) / DEG;
    return h < 0 ? h + 360 : h;
}
