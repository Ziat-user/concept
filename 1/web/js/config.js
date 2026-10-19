// 調整用パラメータ。ゲームバランスに関わる値はここに集約する。

export const LIMITS = Object.freeze({
    memoryPlayers: { min: 1, max: 8 },
    teams: { min: 1, max: 4 },
    rounds: { min: 1, max: 20 },
    revealSeconds: { min: 1, max: 30 },
    observeSeconds: { min: 3, max: 120 },
    searchSeconds: { min: 10, max: 600 },
    scoringK: { min: 2, max: 40 },
    nameLength: 16,
    memoLength: 200,
});

export const DEFAULT_SETTINGS = Object.freeze({
    mode: "memory", // "memory" | "relay"
    useImages: true,
    useVideos: true,
    fixedAssetUrl: "", // 空文字ならラウンドごとにランダム
    rounds: 4,
    revealSeconds: 5,
    observeSeconds: 20,
    searchSeconds: 60,
    scoringK: 10,
    players: [
        { name: "プレイヤー1", vision: "normal" },
        { name: "プレイヤー2", vision: "normal" },
    ],
    teams: [
        { name: "チームA", members: [{ name: "A-1", vision: "normal" }, { name: "A-2", vision: "normal" }] },
        { name: "チームB", members: [{ name: "B-1", vision: "normal" }, { name: "B-2", vision: "normal" }] },
    ],
    relayRules: {
        noNumbers: true,
        noObjectNames: false,
        noPositions: true,
        talkDuringSearch: true,
    },
});

export const RELAY_RULE_LABELS = Object.freeze({
    noNumbers: "数値・色コード（RGB / HEX など）で伝えない",
    noObjectNames: "具体的な物の名前（「ポストの色」など）で伝えない",
    noPositions: "画面上の位置（「左上の車」など）で伝えない",
    talkDuringSearch: "探索中も伝える人は話してよい（不可なら観察時間のメモのみ）",
});

export const SAMPLING = Object.freeze({
    radius: 1, // 3x3 平均
    videoPoolFrames: 8, // お題候補を集める動画フレーム数
    referenceSampleBudget: 4000, // 難易度計測用サンプルの総数（フレーム数で按分）
    candidateBudget: 96, // お題候補の総数（フレーム数で按分）
    maxNonUniformity: 6, // 3x3 内の色ムラの上限（ΔE00）
    minLightness: 8, // 黒つぶれ・レターボックスを除外
    maxLightness: 97, // 白飛びを除外
    easeThreshold: 5, // 「見つけやすさ」の計測に使う ΔE00 しきい値
    minTargetSeparation: 15, // 伝達モードでチームごとのお題を区別するための最小 ΔE00
});

export const UI = Object.freeze({
    loupeSourceSize: 15, // ルーペに表示する元画像のピクセル数（一辺、奇数）
    loupeDisplaySize: 240, // ルーペの表示サイズ（CSS px）
    thumbnailMaxSize: 480, // 結果画面用サムネイルの長辺
    videoFrameStep: 1 / 30, // コマ送り幅（秒）。ブラウザから実際のフレームレートは取得できない
    playbackRates: [0.1, 0.25, 0.5, 1, 1.5, 2],
    warnSeconds: 10,
    revealBackground: "#777777", // L* ≒ 50 の中間グレー
});

export const STORAGE_KEY = "color-search-game.settings.v1";
