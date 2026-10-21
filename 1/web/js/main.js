// エントリポイント。画面遷移とゲーム進行をつなぐ。

import { DEFAULT_SETTINGS, RELAY_RULE_LABELS, STORAGE_KEY } from "./config.js";
import { AssetRotation, isAbortError, prepareRound } from "./field.js";
import { buildTurnPlan, createGame, recordTurn, standings, startRound, targetCountForRound } from "./game.js";
import { SearchView } from "./search-view.js";
import {
    showError, showFinal, showHandoff, showLoading, showObserve, showReveal, showRoundResults, showSetup,
    validateSettings,
} from "./screens.js";

const app = document.getElementById("app");
const statusText = document.getElementById("header-status");
const abortButton = document.getElementById("abort-button");

/**
 * server.py の素材一覧 API から素材を取得する。
 * GitHub Pages などの静的ホスティングでは API が無いため、空の一覧を返し、
 * 設定画面でプレイヤーの手元のファイルを追加してもらう（local: true）。
 */
async function fetchAssets() {
    try {
        const response = await fetch("api/assets", { cache: "no-store" });
        if (response.ok) {
            const data = await response.json();
            if (Array.isArray(data.images) && Array.isArray(data.videos)) {
                return { ...data, local: false };
            }
        }
    } catch {
        // API が無い環境として扱う。
    }
    return { images: [], videos: [], local: true };
}

function loadSettings() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const saved = JSON.parse(raw);
            const merged = { ...structuredClone(DEFAULT_SETTINGS), ...saved };
            merged.relayRules = { ...DEFAULT_SETTINGS.relayRules, ...(saved.relayRules ?? {}) };
            if (Array.isArray(merged.players) && Array.isArray(merged.teams)) {
                return merged;
            }
        }
    } catch {
        // 壊れた保存データは無視して既定値を使う。
    }
    return structuredClone(DEFAULT_SETTINGS);
}

function saveSettings(settings) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
        // 保存できなくてもゲームは続行できる。
    }
}

function activeRules(settings) {
    return Object.entries(settings.relayRules).filter(([, on]) => on).map(([key]) => RELAY_RULE_LABELS[key]);
}

function setStatus(text) {
    statusText.textContent = text;
}

/**
 * 1 ゲームを実行する。
 * @returns {Promise<"replay" | "setup">}
 */
async function runGame(settings, assets) {
    const controller = new AbortController();
    const signal = controller.signal;
    abortButton.hidden = false;
    abortButton.onclick = () => {
        if (confirm("ゲームを中断して設定画面に戻りますか？")) {
            controller.abort();
        }
    };

    const fieldAssets = [
        ...(settings.useImages ? assets.images.map((a) => ({ ...a, kind: "image" })) : []),
        ...(settings.useVideos ? assets.videos.map((a) => ({ ...a, kind: "video" })) : []),
    ];
    const rotation = new AssetRotation(fieldAssets, settings.fixedAssetUrl);
    const game = createGame(settings);
    const relay = settings.mode === "relay";
    const rules = relay ? activeRules(settings) : [];

    try {
        for (let roundIndex = 0; roundIndex < settings.rounds; roundIndex++) {
            const roundLabel = `ラウンド ${roundIndex + 1} / ${settings.rounds}`;
            setStatus(roundLabel);
            const prepared = await prepareWithFallback(rotation, targetCountForRound(game), signal, roundLabel);
            const round = startRound(game, prepared);

            for (const turn of buildTurnPlan(game, roundIndex)) {
                const target = round.targets[turn.targetIndex];
                let memo = "";
                if (relay) {
                    await showHandoff(app, signal, {
                        heading: `${roundLabel} ／ ${turn.entrantName}`,
                        name: `伝える人: ${turn.describer.name}`,
                        message: `${turn.searcher.name} さんと他チームは画面を見ないでください。準備ができたら押してください。`,
                    });
                    memo = await showObserve(app, signal, {
                        lin: target.lin, seconds: settings.observeSeconds,
                        title: "このお題の色を探す人に伝えてください", rules,
                    });
                    await showHandoff(app, signal, {
                        heading: `${roundLabel} ／ ${turn.entrantName}`,
                        name: `探す人: ${turn.searcher.name}`,
                        message: "探す人に交代してください。開始すると制限時間が始まります。",
                        buttonLabel: "探索開始",
                    });
                } else {
                    await showHandoff(app, signal, {
                        heading: roundLabel,
                        name: turn.searcher.name,
                        message: `他の人は画面を見ないでください。開始するとお題の色が ${settings.revealSeconds} 秒間表示され、その後すぐに探索が始まります。`,
                        buttonLabel: "お題を見る",
                    });
                    await showReveal(app, signal, {
                        lin: target.lin, seconds: settings.revealSeconds, title: "この色を覚えてください",
                    });
                }

                const view = new SearchView({
                    prepared,
                    seconds: settings.searchSeconds,
                    signal,
                    title: relay ? `探す人: ${turn.searcher.name}` : turn.searcher.name,
                    subtitle: relay ? `${turn.entrantName} ／ ${roundLabel}` : roundLabel,
                    memo,
                    rules,
                });
                const selection = await view.run(app);
                recordTurn(game, round, turn, selection, memo);
            }

            await showRoundResults(app, signal, {
                game, round, roundIndex, totalRounds: settings.rounds, standingsRows: standings(game),
            });
        }
        abortButton.hidden = true;
        setStatus("最終結果");
        return await showFinal(app, { standingsRows: standings(game) });
    } catch (error) {
        if (isAbortError(error)) {
            return "setup";
        }
        console.error(error);
        abortButton.hidden = true;
        await showError(app, { title: "エラーが発生しました", message: error instanceof Error ? error.message : String(error) });
        return "setup";
    } finally {
        abortButton.hidden = true;
        abortButton.onclick = null;
        setStatus("");
    }
}

/** 素材の読み込みに失敗した場合は、その素材を除外して別の素材で再試行する。 */
async function prepareWithFallback(rotation, targetCount, signal, roundLabel) {
    const failures = [];
    for (;;) {
        const asset = rotation.next();
        if (asset === null) {
            const detail = failures.length > 0 ? `\n${failures.join("\n")}` : "";
            throw new Error(`使用できるフィールドがありません。${detail}`);
        }
        showLoading(app, `${roundLabel} の準備中…（${asset.name}）`);
        try {
            return await prepareRound(asset, targetCount, signal);
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            console.warn(`フィールドを除外しました: ${asset.name}`, error);
            failures.push(`・${asset.name}: ${error instanceof Error ? error.message : String(error)}`);
            rotation.markFailed(asset);
        }
    }
}

async function main() {
    const assets = await fetchAssets();

    let settings = loadSettings();
    for (;;) {
        setStatus("");
        settings = await showSetup(app, assets, settings);
        saveSettings(settings);
        let outcome = "replay";
        while (outcome === "replay") {
            if (validateSettings(settings, assets).length > 0) {
                break;
            }
            outcome = await runGame(settings, assets);
        }
    }
}

main();
