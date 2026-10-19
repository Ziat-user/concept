// 探索画面以外の各画面。各関数は画面を描画し、ユーザー操作を Promise で返す。

import { linearToCss, linearToHex, VISION_TYPES } from "./color.js";
import { DEFAULT_SETTINGS, LIMITS, RELAY_RULE_LABELS, UI } from "./config.js";
import { clear, formatSeconds, h, swatch } from "./dom.js";
import { abortError } from "./field.js";
import { Countdown } from "./timer.js";

/**
 * 画面を描画し、resolve/reject を受け取るセットアップ関数を実行する。
 * signal が中断されたら AbortError で reject し、後片付けを行う。
 */
function screen(container, signal, setup) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
            reject(abortError());
            return;
        }
        const cleanups = [];
        let settled = false;
        const settle = (fn, value) => {
            if (settled) {
                return;
            }
            settled = true;
            for (const cleanup of cleanups.splice(0).reverse()) {
                cleanup();
            }
            fn(value);
        };
        const done = (value) => settle(resolve, value);
        const failed = (error) => settle(reject, error);
        if (signal) {
            const onAbort = () => failed(abortError());
            signal.addEventListener("abort", onAbort, { once: true });
            cleanups.push(() => signal.removeEventListener("abort", onAbort));
        }
        clear(container);
        try {
            const root = setup({ done, failed, onCleanup: (fn) => cleanups.push(fn) });
            container.appendChild(root);
        } catch (error) {
            failed(error);
        }
    });
}

// ---- 設定画面 -----------------------------------------------------------

/**
 * @param {HTMLElement} container
 * @param {{ images: object[], videos: object[] }} assets
 * @param {object} initial 前回の設定
 * @returns {Promise<object>} 確定した設定
 */
export function showSetup(container, assets, initial) {
    const draft = structuredClone(initial);
    return screen(container, null, ({ done }) => {
        const root = h("div", { class: "page setup" });
        const errorBox = h("div", { class: "error-box", role: "alert", hidden: true });

        const render = () => {
            clear(root);
            root.append(
                h("h1", { text: "色探しゲーム" }),
                h("p", { class: "lead", text: "お題の色を、記憶や言葉だけを頼りにフィールドの中から探し出すゲームです。" }),
                section("モード", renderMode()),
                section("フィールド", renderField()),
                section(draft.mode === "memory" ? "プレイヤー" : "チーム（伝える人・探す人の 2 人組）",
                    draft.mode === "memory" ? renderPlayers() : renderTeams()),
                section("ラウンドと時間", renderTiming()),
                draft.mode === "relay" ? section("伝達ルール（ハウスルールとして画面に表示します）", renderRules()) : null,
                errorBox,
                h("div", { class: "actions" },
                    h("button", { class: "button", type: "button", text: "既定値に戻す", onclick: () => {
                        Object.assign(draft, structuredClone(DEFAULT_SETTINGS));
                        render();
                    } }),
                    h("button", { class: "button primary", type: "button", text: "ゲーム開始", onclick: start })));
        };

        const renderMode = () => h("div", { class: "choice-row" },
            radio("mode", "memory", draft.mode === "memory", "記憶モード（個人戦）",
                "お題を一定時間だけ見て、記憶を頼りに探す", () => {
                    draft.mode = "memory";
                    render();
                }),
            radio("mode", "relay", draft.mode === "relay", "伝達モード（2 人 1 組のチーム戦）",
                "伝える人だけがお題を見て、言葉で探す人に伝える", () => {
                    draft.mode = "relay";
                    if (draft.rounds % 2 !== 0) {
                        draft.rounds += 1;
                    }
                    render();
                }));

        const renderField = () => {
            const enabled = [
                ...(draft.useImages ? assets.images.map((a) => ({ ...a, kind: "image" })) : []),
                ...(draft.useVideos ? assets.videos.map((a) => ({ ...a, kind: "video" })) : []),
            ];
            if (!enabled.some((a) => a.url === draft.fixedAssetUrl)) {
                draft.fixedAssetUrl = "";
            }
            const select = h("select", { onchange: (e) => {
                draft.fixedAssetUrl = e.target.value;
            } },
                h("option", { value: "", text: "ラウンドごとにランダム", selected: draft.fixedAssetUrl === "" }),
                enabled.map((a) => h("option", { value: a.url, selected: draft.fixedAssetUrl === a.url,
                    text: `${a.kind === "image" ? "画像" : "動画"}: ${a.name}` })));
            return h("div", { class: "stack" },
                h("div", { class: "choice-row" },
                    checkbox(draft.useImages, `静止画（${assets.images.length} 件）`, assets.images.length === 0,
                        (v) => {
                            draft.useImages = v;
                            render();
                        }),
                    checkbox(draft.useVideos, `動画（${assets.videos.length} 件）`, assets.videos.length === 0,
                        (v) => {
                            draft.useVideos = v;
                            render();
                        })),
                h("label", { class: "field" }, h("span", { text: "使用するフィールド" }), select),
                h("p", { class: "hint", text: "素材は assets/images/ と assets/videos/ に置き、ページを再読み込みすると反映されます。" }));
        };

        const visionSelect = (member) => h("select", { "aria-label": "色覚タイプ", onchange: (e) => {
            member.vision = e.target.value;
        } }, Object.entries(VISION_TYPES).map(([value, label]) =>
            h("option", { value, text: label, selected: member.vision === value })));

        const nameInput = (target, placeholder) => h("input", { type: "text", value: target.name, placeholder,
            maxlength: String(LIMITS.nameLength), oninput: (e) => {
                target.name = e.target.value;
            } });

        const renderPlayers = () => h("div", { class: "stack" },
            draft.players.map((player, index) => h("div", { class: "row" },
                h("span", { class: "row-index", text: String(index + 1) }),
                nameInput(player, "名前"),
                visionSelect(player),
                h("button", { class: "button subtle", type: "button", text: "削除",
                    disabled: draft.players.length <= LIMITS.memoryPlayers.min, onclick: () => {
                        draft.players.splice(index, 1);
                        render();
                    } }))),
            h("button", { class: "button", type: "button", text: "プレイヤーを追加",
                disabled: draft.players.length >= LIMITS.memoryPlayers.max, onclick: () => {
                    draft.players.push({ name: `プレイヤー${draft.players.length + 1}`, vision: "normal" });
                    render();
                } }),
            h("p", { class: "hint", text: "1 人ならソロ練習になります。色覚タイプを設定すると、その色覚で見分けられない差では減点されません。" }));

        const renderTeams = () => h("div", { class: "stack" },
            draft.teams.map((team, index) => h("div", { class: "team-card" },
                h("div", { class: "row" },
                    h("span", { class: "row-index", text: String(index + 1) }),
                    nameInput(team, "チーム名"),
                    h("button", { class: "button subtle", type: "button", text: "削除",
                        disabled: draft.teams.length <= LIMITS.teams.min, onclick: () => {
                            draft.teams.splice(index, 1);
                            render();
                        } })),
                team.members.map((member, m) => h("div", { class: "row indent" },
                    h("span", { class: "row-index muted", text: `メンバー${m + 1}` }),
                    nameInput(member, "名前"),
                    visionSelect(member))))),
            h("button", { class: "button", type: "button", text: "チームを追加",
                disabled: draft.teams.length >= LIMITS.teams.max, onclick: () => {
                    const n = draft.teams.length + 1;
                    draft.teams.push({ name: `チーム${n}`, members: [
                        { name: `${n}-1`, vision: "normal" }, { name: `${n}-2`, vision: "normal" }] });
                    render();
                } }),
            h("p", { class: "hint", text: "伝える人と探す人はラウンドごとに交代します。声が相手チームにも聞こえるため、チームごとに「別の色・同程度の見つけやすさ」のお題を出します。" }));

        const renderTiming = () => {
            const relay = draft.mode === "relay";
            return h("div", { class: "grid-fields" },
                numberField("ラウンド数", draft.rounds, relay ? Math.max(2, LIMITS.rounds.min) : LIMITS.rounds.min,
                    LIMITS.rounds.max, relay ? 2 : 1, (v) => {
                        draft.rounds = v;
                    }, relay ? "役割を均等にするため偶数" : null),
                relay
                    ? numberField("観察時間（秒）", draft.observeSeconds, LIMITS.observeSeconds.min,
                        LIMITS.observeSeconds.max, 1, (v) => {
                            draft.observeSeconds = v;
                        }, "伝える人だけがお題を見る時間")
                    : numberField("記憶時間（秒）", draft.revealSeconds, LIMITS.revealSeconds.min,
                        LIMITS.revealSeconds.max, 1, (v) => {
                            draft.revealSeconds = v;
                        }, "お題を見られる時間"),
                numberField("探索時間（秒）", draft.searchSeconds, LIMITS.searchSeconds.min, LIMITS.searchSeconds.max,
                    5, (v) => {
                        draft.searchSeconds = v;
                    }),
                numberField("採点の甘さ k", draft.scoringK, LIMITS.scoringK.min, LIMITS.scoringK.max, 1, (v) => {
                    draft.scoringK = v;
                }, "点数 = 100 × exp(−ΔE / k)。大きいほど甘い"));
        };

        const renderRules = () => h("div", { class: "stack" },
            Object.entries(RELAY_RULE_LABELS).map(([key, label]) => checkbox(draft.relayRules[key], label, false,
                (v) => {
                    draft.relayRules[key] = v;
                })));

        const start = () => {
            const problems = validateSettings(draft, assets);
            if (problems.length > 0) {
                clear(errorBox);
                errorBox.append(h("ul", {}, problems.map((p) => h("li", { text: p }))));
                errorBox.hidden = false;
                errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
                return;
            }
            done(normalizeSettings(draft));
        };

        render();
        return root;
    });
}

export function validateSettings(settings, assets) {
    const problems = [];
    const imageCount = settings.useImages ? assets.images.length : 0;
    const videoCount = settings.useVideos ? assets.videos.length : 0;
    if (imageCount + videoCount === 0) {
        problems.push("使用できるフィールドがありません。assets/images/ または assets/videos/ に素材を置き、種類を有効にしてください。");
    }
    const names = settings.mode === "memory"
        ? settings.players.map((p) => p.name.trim())
        : settings.teams.flatMap((t) => t.members.map((m) => m.name.trim()));
    if (names.some((n) => n === "")) {
        problems.push("名前が空のプレイヤーがいます。");
    }
    if (new Set(names).size !== names.length) {
        problems.push("プレイヤー名が重複しています。");
    }
    if (settings.mode === "relay") {
        const teamNames = settings.teams.map((t) => t.name.trim());
        if (teamNames.some((n) => n === "")) {
            problems.push("チーム名が空のチームがあります。");
        }
        if (new Set(teamNames).size !== teamNames.length) {
            problems.push("チーム名が重複しています。");
        }
        if (settings.rounds % 2 !== 0) {
            problems.push("伝達モードのラウンド数は偶数にしてください（役割を均等にするため）。");
        }
    }
    const checks = [
        ["ラウンド数", settings.rounds, LIMITS.rounds],
        ["記憶時間", settings.revealSeconds, LIMITS.revealSeconds],
        ["観察時間", settings.observeSeconds, LIMITS.observeSeconds],
        ["探索時間", settings.searchSeconds, LIMITS.searchSeconds],
        ["採点の甘さ k", settings.scoringK, LIMITS.scoringK],
    ];
    for (const [label, value, range] of checks) {
        if (!Number.isFinite(value) || value < range.min || value > range.max) {
            problems.push(`${label}は ${range.min}〜${range.max} の範囲で指定してください。`);
        }
    }
    return problems;
}

function normalizeSettings(draft) {
    const settings = structuredClone(draft);
    settings.players.forEach((p) => {
        p.name = p.name.trim();
    });
    settings.teams.forEach((t) => {
        t.name = t.name.trim();
        t.members.forEach((m) => {
            m.name = m.name.trim();
        });
    });
    return settings;
}

function section(title, body) {
    return h("section", { class: "card" }, h("h2", { text: title }), body);
}

function radio(name, value, checked, label, description, onSelect) {
    return h("label", { class: `choice${checked ? " selected" : ""}` },
        h("input", { type: "radio", name, value, checked, onchange: onSelect }),
        h("span", { class: "choice-body" }, h("strong", { text: label }), h("small", { text: description })));
}

function checkbox(checked, label, disabled, onChange) {
    return h("label", { class: `check${disabled ? " disabled" : ""}` },
        h("input", { type: "checkbox", checked: checked && !disabled, disabled, onchange: (e) => onChange(e.target.checked) }),
        h("span", { text: label }));
}

function numberField(label, value, min, max, step, onChange, hint = null) {
    return h("label", { class: "field" },
        h("span", { text: label }),
        h("input", { type: "number", value: String(value), min: String(min), max: String(max), step: String(step),
            oninput: (e) => onChange(e.target.valueAsNumber) }),
        hint ? h("small", { class: "hint", text: hint }) : null);
}

// ---- 進行画面 -----------------------------------------------------------

export function showLoading(container, message) {
    clear(container);
    container.appendChild(h("div", { class: "page center" },
        h("div", { class: "spinner", "aria-hidden": "true" }),
        h("p", { text: message })));
}

/** 端末の受け渡し画面。ホットシート方式なので、他の人が画面を見ないよう促す。 */
export function showHandoff(container, signal, { heading, name, message, buttonLabel = "準備OK" }) {
    return screen(container, signal, ({ done }) => h("div", { class: "page center handoff" },
        h("div", { class: "handoff-heading", text: heading }),
        h("div", { class: "handoff-name", text: name }),
        h("p", { class: "handoff-message", text: message }),
        h("button", { class: "button primary large", type: "button", text: buttonLabel, onclick: () => done() })));
}

/**
 * お題の提示（記憶モード）。中間グレー背景で表示し、背景による見え方の変化（色対比）を抑える。
 */
export function showReveal(container, signal, { lin, seconds, title }) {
    return screen(container, signal, ({ done, onCleanup }) => {
        const timer = h("div", { class: "reveal-timer", text: formatSeconds(seconds) });
        const countdown = new Countdown(seconds, (r) => {
            timer.textContent = formatSeconds(r);
        }, () => done());
        onCleanup(() => countdown.stop());
        queueMicrotask(() => countdown.start());
        return h("div", { class: "reveal", style: { backgroundColor: UI.revealBackground } },
            h("div", { class: "reveal-title", text: title }),
            swatch(linearToCss(lin), { size: "reveal", title: "お題の色" }),
            timer,
            h("button", { class: "button", type: "button", text: "覚えた（探索を開始）", onclick: () => done() }));
    });
}

/** 伝える人の観察画面（伝達モード）。メモは探す人の画面に表示する。 */
export function showObserve(container, signal, { lin, seconds, title, rules }) {
    return screen(container, signal, ({ done, onCleanup }) => {
        const memo = h("textarea", { class: "memo-input", rows: 3, maxlength: String(LIMITS.memoLength),
            placeholder: "探す人に見せるメモ（任意）" });
        const finish = () => done(memo.value.trim());
        const timer = h("div", { class: "reveal-timer", text: formatSeconds(seconds) });
        const countdown = new Countdown(seconds, (r) => {
            timer.textContent = formatSeconds(r);
        }, finish);
        onCleanup(() => countdown.stop());
        queueMicrotask(() => countdown.start());
        return h("div", { class: "reveal", style: { backgroundColor: UI.revealBackground } },
            h("div", { class: "reveal-title", text: title }),
            swatch(linearToCss(lin), { size: "reveal", title: "お題の色" }),
            timer,
            h("div", { class: "observe-panel" },
                rules.length > 0 ? h("ul", { class: "rule-list" }, rules.map((r) => h("li", { text: r }))) : null,
                memo,
                h("button", { class: "button primary", type: "button", text: "完了（探す人に交代）", onclick: finish })));
    });
}

// ---- 結果画面 -----------------------------------------------------------

/** サムネイルに位置マーカーを描いたキャンバスを作る。 */
function markedThumbnail(thumbnail, x, y, caption) {
    const canvas = document.createElement("canvas");
    canvas.width = thumbnail.canvas.width;
    canvas.height = thumbnail.canvas.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(thumbnail.canvas, 0, 0);
    const cx = (x + 0.5) * thumbnail.scale;
    const cy = (y + 0.5) * thumbnail.scale;
    const radius = Math.max(6, canvas.width / 60);
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    canvas.className = "thumb";
    return h("figure", { class: "thumb-figure" }, canvas, h("figcaption", { text: caption }));
}

function formatDeltaE(deltaE) {
    return deltaE === null ? "—" : deltaE.toFixed(2);
}

function timeCaption(time) {
    return time === null ? "" : `（${time.toFixed(2)} 秒）`;
}

export function showRoundResults(container, signal, { game, round, roundIndex, totalRounds, standingsRows }) {
    const isLast = roundIndex + 1 >= totalRounds;
    const relay = game.settings.mode === "relay";
    return screen(container, signal, ({ done }) => {
        const sorted = [...round.results].sort((a, b) => b.score - a.score);
        const cards = sorted.map((result) => {
            const { target, selection, turn } = result;
            const targetThumb = round.prepared.frameThumbnails[target.frameIndex];
            return h("article", { class: `result-card grade-${result.grade.id}` },
                h("header", { class: "result-header" },
                    h("div", {},
                        h("div", { class: "result-name", text: turn.entrantName }),
                        relay ? h("div", { class: "muted", text: `伝える人: ${turn.describer.name} → 探す人: ${turn.searcher.name}` }) : null),
                    h("div", { class: "result-score" },
                        h("div", { class: "grade", text: result.grade.label }),
                        h("div", { class: "points", text: `${result.score.toFixed(1)} 点` }))),
                h("div", { class: "compare" },
                    h("div", { class: "compare-item" }, h("div", { class: "label", text: "お題" }),
                        swatch(linearToCss(target.lin), { size: "xl", title: "お題の色" }),
                        h("code", { text: linearToHex(target.lin) })),
                    h("div", { class: "compare-item" }, h("div", { class: "label", text: "選んだ色" }),
                        selection
                            ? swatch(linearToCss(selection.lin), { size: "xl", title: "選んだ色" })
                            : h("div", { class: "swatch swatch-xl empty", text: "未選択" }),
                        h("code", { text: selection ? linearToHex(selection.lin) : "—" })),
                    h("div", { class: "compare-item metric" }, h("div", { class: "label", text: "ΔE00" }),
                        h("div", { class: "metric-value", text: formatDeltaE(result.deltaE) }),
                        turn.searcher.vision !== "normal"
                            ? h("small", { class: "muted", text: `${VISION_TYPES[turn.searcher.vision]}で判定` })
                            : null)),
                relay && result.memo ? h("div", { class: "memo-box" }, h("div", { class: "label", text: "メモ" }),
                    h("div", { class: "memo-text", text: result.memo })) : null,
                h("div", { class: "thumbs" },
                    markedThumbnail(targetThumb, target.x, target.y, `お題の場所${timeCaption(target.time)}`),
                    selection
                        ? markedThumbnail(selection.thumbnail, selection.x, selection.y,
                            `選んだ場所${timeCaption(selection.frameTime)}`)
                        : null));
        });

        return h("div", { class: "page results" },
            h("h1", { text: `ラウンド ${roundIndex + 1} / ${totalRounds} の結果` }),
            h("p", { class: "muted", text: `フィールド: ${round.prepared.asset.name}` }),
            h("div", { class: "result-list" }, cards),
            h("section", { class: "card" }, h("h2", { text: "現在の順位" }), standingsTable(standingsRows)),
            h("div", { class: "actions" },
                h("button", { class: "button primary", type: "button", text: isLast ? "最終結果へ" : "次のラウンドへ",
                    onclick: () => done() })));
    });
}

function standingsTable(rows) {
    return h("table", { class: "standings" },
        h("thead", {}, h("tr", {}, ["順位", "名前", "合計点", "平均 ΔE00"].map((t) => h("th", { text: t })))),
        h("tbody", {}, rows.map((row) => h("tr", { class: row.rank === 1 ? "top" : "" },
            h("td", { text: String(row.rank) }),
            h("td", { text: row.entrant.name }),
            h("td", { text: row.total.toFixed(1) }),
            h("td", { text: row.averageDeltaE === null ? "—" : row.averageDeltaE.toFixed(2) })))));
}

/** @returns {Promise<"replay" | "setup">} */
export function showFinal(container, { standingsRows }) {
    return screen(container, null, ({ done }) => {
        const winners = standingsRows.filter((r) => r.rank === 1).map((r) => r.entrant.name);
        return h("div", { class: "page results" },
            h("h1", { text: "最終結果" }),
            h("p", { class: "winner", text: winners.length > 1 ? `引き分け: ${winners.join("、")}` : `優勝: ${winners[0]}` }),
            h("section", { class: "card" }, standingsTable(standingsRows)),
            h("div", { class: "actions" },
                h("button", { class: "button", type: "button", text: "設定に戻る", onclick: () => done("setup") }),
                h("button", { class: "button primary", type: "button", text: "同じ設定でもう一度",
                    onclick: () => done("replay") })));
    });
}

export function showError(container, { title, message, buttonLabel = "設定に戻る" }) {
    return screen(container, null, ({ done }) => h("div", { class: "page center" },
        h("h1", { text: title }),
        h("p", { class: "error-text", text: message }),
        h("button", { class: "button primary", type: "button", text: buttonLabel, onclick: () => done() })));
}
