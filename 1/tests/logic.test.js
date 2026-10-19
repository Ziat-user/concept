// 色計算・お題選定・ゲーム進行ロジックの単体テスト（Node.js 18 以降、追加パッケージ不要）。
// 実行: node --test（プロジェクトのルートで）

import assert from "node:assert/strict";
import { test } from "node:test";

import { deltaE2000, labForVision, linearToHex, linearToLab, simulateVision, srgb8ToLinear } from "../web/js/color.js";
import { DEFAULT_SETTINGS } from "../web/js/config.js";
import { buildTurnPlan, createGame, recordTurn, standings, startRound, targetCountForRound } from "../web/js/game.js";
import { averageLinearAt, TargetCollector } from "../web/js/sampler.js";
import { evaluatePick, gradeFromDeltaE, scoreFromDeltaE } from "../web/js/scoring.js";

const lin = (r, g, b) => [srgb8ToLinear(r), srgb8ToLinear(g), srgb8ToLinear(b)];

// Sharma, Wu, Dalal (2005) の CIEDE2000 検証データ（抜粋）
const SHARMA_PAIRS = [
    [[50.0000, 2.6772, -79.7751], [50.0000, 0.0000, -82.7485], 2.0425],
    [[50.0000, 3.1571, -77.2803], [50.0000, 0.0000, -82.7485], 2.8615],
    [[50.0000, 2.8361, -74.0200], [50.0000, 0.0000, -82.7485], 3.4412],
    [[50.0000, -1.3802, -84.2814], [50.0000, 0.0000, -82.7485], 1.0000],
    [[50.0000, 0.0000, 0.0000], [50.0000, -1.0000, 2.0000], 2.3669],
    [[50.0000, 2.4900, -0.0010], [50.0000, -2.4900, 0.0009], 7.1792],
    [[50.0000, 2.4900, -0.0010], [50.0000, -2.4900, 0.0011], 7.2195],
    [[50.0000, 2.5000, 0.0000], [73.0000, 25.0000, -18.0000], 27.1492],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.2630],
    [[2.0776, 0.0795, -1.1350], [0.9033, -0.0636, -0.5514], 0.9082],
    [[90.8027, -2.0831, 1.4410], [91.1528, -1.6435, 0.0447], 1.4441],
];

test("CIEDE2000 が Sharma らの検証データと一致する", () => {
    for (const [a, b, expected] of SHARMA_PAIRS) {
        assert.ok(Math.abs(deltaE2000(a, b) - expected) < 1e-4, `${a} vs ${b}: ${deltaE2000(a, b)} != ${expected}`);
        assert.ok(Math.abs(deltaE2000(b, a) - expected) < 1e-4, "対称性");
    }
});

test("sRGB → CIELAB の基準値", () => {
    const close = (actual, expected, eps = 0.02) => actual.forEach((v, i) =>
        assert.ok(Math.abs(v - expected[i]) < eps, `${actual} != ${expected}`));
    close(linearToLab(lin(255, 255, 255)), [100, 0, 0]);
    close(linearToLab(lin(0, 0, 0)), [0, 0, 0]);
    close(linearToLab(lin(255, 0, 0)), [53.24, 80.09, 67.20]);
    close(linearToLab(lin(0, 255, 0)), [87.73, -86.18, 83.18]);
    close(linearToLab(lin(0, 0, 255)), [32.30, 79.19, -107.86]);
});

test("HEX 変換は 8bit 値を往復できる", () => {
    assert.equal(linearToHex(lin(18, 52, 86)), "#123456");
    assert.equal(linearToHex(lin(0, 128, 255)), "#0080FF");
});

test("色覚シミュレーション: P型では赤と緑の差が一般色覚より小さくなる", () => {
    const red = lin(200, 60, 40);
    const green = lin(110, 120, 40);
    const normal = deltaE2000(labForVision(red, "normal"), labForVision(green, "normal"));
    const protan = deltaE2000(labForVision(red, "protan"), labForVision(green, "protan"));
    assert.ok(protan < normal, `protan ${protan} >= normal ${normal}`);
    // 無彩色はどの色覚でもほぼ無彩色のまま
    const gray = simulateVision(lin(128, 128, 128), "deutan");
    assert.ok(Math.abs(gray[0] - gray[1]) < 0.01 && Math.abs(gray[1] - gray[2]) < 0.01);
    assert.throws(() => simulateVision(gray, "unknown"), RangeError);
});

test("採点: 連続的に減少し、ラベルは ΔE 境界で決まる", () => {
    assert.equal(scoreFromDeltaE(0, 10), 100);
    assert.ok(Math.abs(scoreFromDeltaE(10, 10) - 100 / Math.E) < 1e-9);
    assert.ok(scoreFromDeltaE(4.9, 10) - scoreFromDeltaE(5.1, 10) < 2, "境界で点数が跳ねない");
    assert.equal(gradeFromDeltaE(0.5).id, "perfect");
    assert.equal(gradeFromDeltaE(1).id, "perfect");
    assert.equal(gradeFromDeltaE(25).id, "miss");
    assert.throws(() => scoreFromDeltaE(1, 0), RangeError);
    const none = evaluatePick(lin(10, 20, 30), null, "normal", 10);
    assert.equal(none.score, 0);
    assert.equal(none.deltaE, null);
    const same = evaluatePick(lin(10, 20, 30), lin(10, 20, 30), "normal", 10);
    assert.equal(same.score, 100);
});

function makeImage(width, height, paint) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [r, g, b] = paint(x, y);
            const i = (y * width + x) * 4;
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
            data[i + 3] = 255;
        }
    }
    return { data, width, height };
}

function seededRng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

test("3x3 平均は線形光で計算し、端では端のピクセルを繰り返す", () => {
    const image = makeImage(3, 3, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255]));
    const center = averageLinearAt(image, 1, 1, 1);
    assert.ok(Math.abs(center[0] - 2 / 3) < 1e-9);
    const corner = averageLinearAt(image, 0, 0, 1);
    // 端の繰り返しにより x=0 の列が 2 回数えられる
    assert.ok(Math.abs(corner[0] - 1 / 3) < 1e-9);
});

const OPTIONS = {
    radius: 1, referenceSamplesPerFrame: 2000, candidatesPerFrame: 60,
    maxNonUniformity: 6, minLightness: 8, maxLightness: 97,
};

test("お題候補は色ムラのある場所・極端な明度を除外する", () => {
    // 左半分: 市松模様（ムラが大きい）、右半分: 単色
    const image = makeImage(64, 64, (x, y) => (x < 32
        ? ((x + y) % 2 === 0 ? [255, 0, 0] : [0, 0, 255])
        : [90, 140, 200]));
    const collector = new TargetCollector(OPTIONS, seededRng(1));
    collector.addFrame(image, 0, null);
    assert.ok(collector.candidates.length > 0);
    for (const c of collector.candidates) {
        assert.ok(c.x >= 31, `ムラのある領域が候補になっている: x=${c.x}`);
    }

    const black = new TargetCollector(OPTIONS, seededRng(2));
    black.addFrame(makeImage(32, 32, () => [0, 0, 0]), 0, null);
    assert.equal(black.candidates.length, 0);
    assert.throws(() => black.pickTargets(1, { easeThreshold: 5, minSeparation: 15 }), /お題に使える色/);
});

test("複数のお題は互いに十分離れた色になる", () => {
    // 4 色の帯
    const colors = [[200, 60, 60], [60, 160, 80], [70, 90, 200], [220, 200, 80]];
    const image = makeImage(128, 64, (x) => colors[Math.floor(x / 32)]);
    const collector = new TargetCollector(OPTIONS, seededRng(3));
    collector.addFrame(image, 0, null);
    const targets = collector.pickTargets(3, { easeThreshold: 5, minSeparation: 15 });
    assert.equal(targets.length, 3);
    for (let i = 0; i < targets.length; i++) {
        for (let j = i + 1; j < targets.length; j++) {
            assert.ok(deltaE2000(targets[i].lab, targets[j].lab) >= 15);
        }
        assert.ok(targets[i].ease > 0.15 && targets[i].ease < 0.35, `ease=${targets[i].ease}`);
    }
});

test("手番順: 開始位置がラウンドごとにずれ、伝達モードは役割が交代する", () => {
    const memory = createGame({ ...structuredClone(DEFAULT_SETTINGS), mode: "memory",
        players: [{ name: "A", vision: "normal" }, { name: "B", vision: "normal" }, { name: "C", vision: "normal" }] });
    assert.equal(targetCountForRound(memory), 1);
    assert.deepEqual(buildTurnPlan(memory, 0).map((t) => t.entrantName), ["A", "B", "C"]);
    assert.deepEqual(buildTurnPlan(memory, 1).map((t) => t.entrantName), ["B", "C", "A"]);

    const relay = createGame({ ...structuredClone(DEFAULT_SETTINGS), mode: "relay" });
    assert.equal(targetCountForRound(relay), 2);
    const r0 = buildTurnPlan(relay, 0);
    const r1 = buildTurnPlan(relay, 1);
    assert.equal(r0[0].describer.name, "A-1");
    assert.equal(r0[0].searcher.name, "A-2");
    const teamAInR1 = r1.find((t) => t.entrantName === "チームA");
    assert.equal(teamAInR1.describer.name, "A-2");
    assert.equal(teamAInR1.searcher.name, "A-1");
    // チームごとのお題はラウンド内で固定のインデックス
    assert.equal(teamAInR1.targetIndex, 0);
    assert.equal(r1.find((t) => t.entrantName === "チームB").targetIndex, 1);
});

test("順位表: 合計点の降順、同点は同順位", () => {
    const settings = { ...structuredClone(DEFAULT_SETTINGS), mode: "memory",
        players: [{ name: "A", vision: "normal" }, { name: "B", vision: "normal" }, { name: "C", vision: "normal" }] };
    const game = createGame(settings);
    const target = { lin: lin(100, 150, 200) };
    const round = startRound(game, { targets: [target] });
    const plan = buildTurnPlan(game, 0);
    recordTurn(game, round, plan[0], { lin: lin(100, 150, 200) }, "");
    recordTurn(game, round, plan[1], { lin: lin(100, 150, 200) }, "");
    recordTurn(game, round, plan[2], null, "");
    const rows = standings(game);
    assert.deepEqual(rows.map((r) => r.rank), [1, 1, 3]);
    assert.equal(rows[2].entrant.name, "C");
    assert.equal(rows[2].averageDeltaE, null);
});
