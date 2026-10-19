// ゲーム進行の状態とルール。DOM・通信に依存しない純粋なロジックとして分離する。
// 将来 1 人 1 台（ホスト権威型）へ移行する際は、このモジュールをホスト側でそのまま使う想定。

import { evaluatePick } from "./scoring.js";

/**
 * 設定からゲーム状態を作る。
 * 参加単位（entrant）は記憶モードではプレイヤー、伝達モードではチーム。
 */
export function createGame(settings) {
    const entrants = settings.mode === "memory"
        ? settings.players.map((p, i) => ({
            id: `p${i}`,
            name: p.name,
            members: [{ name: p.name, vision: p.vision }],
        }))
        : settings.teams.map((t, i) => ({
            id: `t${i}`,
            name: t.name,
            members: t.members.map((m) => ({ name: m.name, vision: m.vision })),
        }));
    return {
        settings,
        entrants,
        rounds: [], // { prepared, targets, results }
    };
}

/** そのラウンドで必要なお題の数。伝達モードは声が聞こえるため、チームごとに別の色にする。 */
export function targetCountForRound(game) {
    return game.settings.mode === "memory" ? 1 : game.entrants.length;
}

/**
 * ラウンドの手番順を作る。
 * 先手・後手の偏りを避けるため、開始位置をラウンドごとにずらす。
 * 伝達モードでは、ラウンドごとに伝える人と探す人を交代する。
 */
export function buildTurnPlan(game, roundIndex) {
    const n = game.entrants.length;
    const plan = [];
    for (let offset = 0; offset < n; offset++) {
        const entrantIndex = (roundIndex + offset) % n;
        const entrant = game.entrants[entrantIndex];
        if (game.settings.mode === "memory") {
            plan.push({
                entrantId: entrant.id,
                entrantName: entrant.name,
                describer: null,
                searcher: entrant.members[0],
                targetIndex: 0,
            });
        } else {
            plan.push({
                entrantId: entrant.id,
                entrantName: entrant.name,
                describer: entrant.members[roundIndex % 2],
                searcher: entrant.members[(roundIndex + 1) % 2],
                targetIndex: entrantIndex,
            });
        }
    }
    return plan;
}

/**
 * @param {object} prepared prepareRound の戻り値（素材・お題・結果表示用サムネイル）
 */
export function startRound(game, prepared) {
    const round = { prepared, targets: prepared.targets, results: [] };
    game.rounds.push(round);
    return round;
}

/**
 * 手番の結果を記録する。
 * @param {object} round startRound の戻り値
 * @param {object} turn buildTurnPlan の要素
 * @param {object | null} selection 探索画面の選択結果（未選択なら null）
 * @param {string} memo 伝達モードのメモ
 */
export function recordTurn(game, round, turn, selection, memo) {
    const target = round.targets[turn.targetIndex];
    const evaluation = evaluatePick(target.lin, selection ? selection.lin : null, turn.searcher.vision,
        game.settings.scoringK);
    const result = { turn, target, selection, memo, ...evaluation };
    round.results.push(result);
    return result;
}

/**
 * 順位表。合計点の降順。表示上の小数第 1 位で同じ点なら同順位とする。
 */
export function standings(game) {
    const rows = game.entrants.map((entrant) => {
        const results = game.rounds.flatMap((round) => round.results.filter((r) => r.turn.entrantId === entrant.id));
        const total = results.reduce((sum, r) => sum + r.score, 0);
        const picked = results.filter((r) => r.deltaE !== null);
        const averageDeltaE = picked.length > 0
            ? picked.reduce((sum, r) => sum + r.deltaE, 0) / picked.length
            : null;
        return { entrant, total, averageDeltaE, turns: results.length };
    });
    rows.sort((a, b) => b.total - a.total);
    let previousKey = null;
    let previousRank = 0;
    rows.forEach((row, index) => {
        const key = row.total.toFixed(1);
        row.rank = key === previousKey ? previousRank : index + 1;
        previousKey = key;
        previousRank = row.rank;
    });
    return rows;
}
