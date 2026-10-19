// 探索画面。フィールド表示、ルーペ、3x3 平均の色取得、選び直し、制限時間を扱う。

import { linearToCss } from "./color.js";
import { SAMPLING, UI } from "./config.js";
import { clear, formatSeconds, h, swatch } from "./dom.js";
import { abortError, createReadableCanvas, createThumbnail, VideoSource } from "./field.js";
import { averageLinearAt } from "./sampler.js";
import { Countdown } from "./timer.js";

const RADIUS = SAMPLING.radius;

/**
 * @typedef {object} Selection
 * @property {number} x 元画像上の x 座標（ピクセル）
 * @property {number} y 元画像上の y 座標（ピクセル）
 * @property {number[]} lin 3x3 平均色（線形 sRGB）
 * @property {number | null} frameTime 動画のフレーム時刻（静止画は null）
 * @property {{ canvas: HTMLCanvasElement, scale: number }} thumbnail 結果表示用
 */

export class SearchView {
    /**
     * @param {object} options
     * @param {object} options.prepared prepareRound の戻り値
     * @param {number} options.seconds 制限時間
     * @param {AbortSignal} options.signal
     * @param {string} options.title
     * @param {string} options.subtitle
     * @param {string} [options.memo] 伝達モードのメモ
     * @param {string[]} [options.rules] 伝達モードのルール表示
     */
    constructor(options) {
        this.options = options;
        this.prepared = options.prepared;
        this.isVideo = options.prepared.asset.kind === "video";
        this.width = options.prepared.width;
        this.height = options.prepared.height;

        this.imageData = null;
        this.frameTime = null;
        this.paused = true;
        this.hover = null;
        this.selection = null;
        this.frameThumbnail = null;
        this.video = null;
        this.rafHandle = 0;
        this.seekDragging = false;
        this.done = false;
        this.disposers = [];
    }

    /** @returns {Promise<Selection | null>} 時間切れ時は最後の選択（なければ null） */
    run(container) {
        return new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
            if (this.options.signal.aborted) {
                reject(abortError());
                return;
            }
            const onAbort = () => this.fail(abortError());
            this.options.signal.addEventListener("abort", onAbort, { once: true });
            this.disposers.push(() => this.options.signal.removeEventListener("abort", onAbort));

            this.build(container);
            this.initializeMedia().then(() => {
                if (this.done) {
                    return;
                }
                this.status.textContent = "";
                this.countdown = new Countdown(this.options.seconds,
                    (remaining) => this.updateTimer(remaining),
                    () => this.finish()).start();
            }).catch((error) => this.fail(error));
        });
    }

    // ---- 構築 ---------------------------------------------------------

    build(container) {
        const { canvas, context } = createReadableCanvas(this.width, this.height);
        this.fieldCanvas = canvas;
        this.fieldContext = context;
        this.fieldCanvas.className = "field-canvas";
        this.overlay = h("canvas", { class: "field-overlay", "aria-hidden": "true" });
        this.stage = h("div", { class: "field-stage" }, this.fieldCanvas, this.overlay);
        this.fieldArea = h("div", { class: "field-area" }, this.stage);

        const loupeCell = Math.max(1, Math.floor(UI.loupeDisplaySize * devicePixelRatio / UI.loupeSourceSize));
        this.loupeCell = loupeCell;
        this.loupe = h("canvas", { class: "loupe", width: loupeCell * UI.loupeSourceSize,
            height: loupeCell * UI.loupeSourceSize, "aria-label": "ルーペ" });
        this.loupe.style.width = `${UI.loupeDisplaySize}px`;
        this.loupe.style.height = `${UI.loupeDisplaySize}px`;

        this.timer = h("div", { class: "timer", text: formatSeconds(this.options.seconds) });
        this.status = h("div", { class: "search-status", text: "フィールドを読み込んでいます…" });
        this.hoverSwatch = swatch("transparent", { size: "lg", title: "カーソル位置の色" });
        this.selectedSwatch = swatch("transparent", { size: "lg", title: "選択中の色" });
        this.selectedNote = h("div", { class: "readout-note", text: "未選択" });
        this.confirmButton = h("button", { class: "button primary block", type: "button", disabled: true,
            text: "この色で決定（Enter）", onclick: () => this.confirm() });

        const memo = this.options.memo
            ? h("div", { class: "memo-box" }, h("div", { class: "label", text: "伝える人からのメモ" }),
                h("div", { class: "memo-text", text: this.options.memo }))
            : null;
        const rules = this.options.rules && this.options.rules.length > 0
            ? h("ul", { class: "rule-list compact" }, this.options.rules.map((r) => h("li", { text: r })))
            : null;

        const side = h("aside", { class: "search-side" },
            h("div", { class: "turn-info" },
                h("div", { class: "turn-title", text: this.options.title }),
                h("div", { class: "turn-subtitle", text: this.options.subtitle })),
            this.timer,
            memo,
            rules,
            h("div", { class: "loupe-wrap" }, this.loupe),
            h("div", { class: "readouts" },
                h("div", { class: "readout" }, h("div", { class: "label", text: "カーソル位置" }), this.hoverSwatch),
                h("div", { class: "readout" }, h("div", { class: "label", text: "選択中" }), this.selectedSwatch,
                    this.selectedNote)),
            this.confirmButton,
            h("div", { class: "help" },
                h("div", { text: "クリック: 3x3 平均の色を選択（時間内は何度でも選び直し可）" }),
                h("div", { text: "矢印キー: 選択位置を 1px 移動（Shift で 10px）" }),
                this.isVideo ? h("div", { text: "Space: 再生/一時停止　, / .: コマ送り（一時停止中のみ選択可）" }) : null,
                h("div", { text: "時間切れの場合は最後に選んだ色で提出されます" })));

        const main = h("div", { class: "search-main" }, this.status, this.fieldArea,
            this.isVideo ? this.buildVideoControls() : null);
        this.root = h("div", { class: "search" }, main, side);
        clear(container);
        container.appendChild(this.root);

        this.listen(this.fieldCanvas, "pointermove", (e) => this.onPointerMove(e));
        this.listen(this.fieldCanvas, "pointerleave", () => this.setHover(null));
        this.listen(this.fieldCanvas, "pointerdown", (e) => this.onPointerDown(e));
        this.listen(window, "keydown", (e) => this.onKeyDown(e));

        const observer = new ResizeObserver(() => this.layout());
        observer.observe(this.fieldArea);
        this.disposers.push(() => observer.disconnect());
        this.drawLoupe();
    }

    buildVideoControls() {
        const noFocus = (e) => e.preventDefault(); // Space キーがボタンに奪われないようにする
        this.playButton = h("button", { class: "button", type: "button", text: "再生", onmousedown: noFocus,
            onclick: () => this.togglePlay() });
        const stepBack = h("button", { class: "button", type: "button", text: "◀ 1コマ", onmousedown: noFocus,
            onclick: () => this.stepFrame(-1) });
        const stepForward = h("button", { class: "button", type: "button", text: "1コマ ▶", onmousedown: noFocus,
            onclick: () => this.stepFrame(1) });
        this.seekBar = h("input", { class: "seek", type: "range", min: "0", max: "1", step: "0.001", value: "0",
            "aria-label": "再生位置" });
        this.timeText = h("span", { class: "time-text", text: "0.00 / 0.00" });
        this.rateSelect = h("select", { "aria-label": "再生速度" },
            UI.playbackRates.map((rate) => h("option", { value: String(rate), text: `${rate}x`, selected: rate === 1 })));
        this.listen(this.seekBar, "pointerdown", () => {
            this.seekDragging = true;
        });
        this.listen(window, "pointerup", () => {
            this.seekDragging = false;
        });
        this.listen(this.seekBar, "input", () => {
            if (this.video) {
                this.video.video.pause();
                this.video.video.currentTime = Number(this.seekBar.value);
            }
        });
        this.listen(this.rateSelect, "change", () => {
            if (this.video) {
                this.video.video.playbackRate = Number(this.rateSelect.value);
            }
        });
        return h("div", { class: "video-controls" }, this.playButton, stepBack, stepForward, this.seekBar,
            this.timeText, h("label", { class: "rate" }, "速度 ", this.rateSelect));
    }

    async initializeMedia() {
        if (!this.isVideo) {
            this.fieldContext.drawImage(this.prepared.image, 0, 0);
            this.imageData = this.fieldContext.getImageData(0, 0, this.width, this.height);
            this.layout();
            return;
        }
        this.video = new VideoSource(this.prepared.asset.url);
        this.disposers.push(() => this.video.dispose());
        await this.video.load();
        if (this.done) {
            return;
        }
        if (this.video.width !== this.width || this.video.height !== this.height) {
            throw new Error("動画の解像度が準備時と異なります。");
        }
        const v = this.video.video;
        this.seekBar.max = String(v.duration);
        this.listen(v, "play", () => this.onPlay());
        this.listen(v, "pause", () => this.onPause());
        this.listen(v, "seeking", () => {
            this.imageData = null;
        });
        this.listen(v, "seeked", () => {
            if (v.paused) {
                this.refreshFrame();
            }
        });
        this.listen(v, "ended", () => this.onPause());
        await this.video.seek(0);
        this.refreshFrame();
        this.layout();
    }

    listen(target, type, handler) {
        target.addEventListener(type, handler);
        this.disposers.push(() => target.removeEventListener(type, handler));
    }

    // ---- 表示 ---------------------------------------------------------

    layout() {
        const area = this.fieldArea.getBoundingClientRect();
        if (area.width <= 0 || area.height <= 0) {
            return;
        }
        const scale = Math.min(area.width / this.width, area.height / this.height);
        const cssWidth = Math.max(1, Math.floor(this.width * scale));
        const cssHeight = Math.max(1, Math.floor(this.height * scale));
        this.stage.style.width = `${cssWidth}px`;
        this.stage.style.height = `${cssHeight}px`;
        this.overlay.width = Math.round(cssWidth * devicePixelRatio);
        this.overlay.height = Math.round(cssHeight * devicePixelRatio);
        this.drawOverlay();
    }

    drawOverlay() {
        const ctx = this.overlay.getContext("2d");
        ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
        if (!this.selectionVisible()) {
            return;
        }
        const sx = this.overlay.width / this.width;
        const sy = this.overlay.height / this.height;
        const cx = (this.selection.x + 0.5) * sx;
        const cy = (this.selection.y + 0.5) * sy;
        const ring = 12 * devicePixelRatio;
        ctx.lineWidth = 4 * devicePixelRatio;
        ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
        ctx.beginPath();
        ctx.arc(cx, cy, ring, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 2 * devicePixelRatio;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
        // 3x3 範囲が十分大きく表示されている場合のみ枠を描く
        const boxW = (RADIUS * 2 + 1) * sx;
        if (boxW >= 6) {
            ctx.strokeRect((this.selection.x - RADIUS) * sx, (this.selection.y - RADIUS) * sy, boxW,
                (RADIUS * 2 + 1) * sy);
        }
    }

    selectionVisible() {
        if (this.selection === null) {
            return false;
        }
        return !this.isVideo || (this.paused && this.imageData !== null && this.selection.frameTime === this.frameTime);
    }

    drawLoupe() {
        const ctx = this.loupe.getContext("2d");
        const n = UI.loupeSourceSize;
        const cell = this.loupeCell;
        const size = cell * n;
        ctx.fillStyle = UI.revealBackground;
        ctx.fillRect(0, 0, size, size);

        const focus = this.hover ?? (this.selectionVisible() ? this.selection : null);
        if (focus === null || this.imageData === null) {
            return;
        }
        const half = (n - 1) / 2;
        const sx = focus.x - half;
        const sy = focus.y - half;
        const x0 = Math.max(0, sx);
        const y0 = Math.max(0, sy);
        const x1 = Math.min(this.width, sx + n);
        const y1 = Math.min(this.height, sy + n);
        if (x1 > x0 && y1 > y0) {
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(this.fieldCanvas, x0, y0, x1 - x0, y1 - y0,
                (x0 - sx) * cell, (y0 - sy) * cell, (x1 - x0) * cell, (y1 - y0) * cell);
        }
        if (cell >= 6) {
            ctx.strokeStyle = "rgba(0, 0, 0, 0.18)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let i = 1; i < n; i++) {
                ctx.moveTo(i * cell + 0.5, 0);
                ctx.lineTo(i * cell + 0.5, size);
                ctx.moveTo(0, i * cell + 0.5);
                ctx.lineTo(size, i * cell + 0.5);
            }
            ctx.stroke();
        }
        const boxX = (half - RADIUS) * cell;
        const boxSize = (RADIUS * 2 + 1) * cell;
        ctx.lineWidth = 4;
        ctx.strokeStyle = "rgba(0, 0, 0, 0.9)";
        ctx.strokeRect(boxX, boxX, boxSize, boxSize);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#ffffff";
        ctx.strokeRect(boxX, boxX, boxSize, boxSize);
    }

    updateTimer(remaining) {
        this.timer.textContent = formatSeconds(remaining);
        this.timer.classList.toggle("warn", remaining <= UI.warnSeconds);
    }

    updateReadouts() {
        if (this.hover !== null && this.imageData !== null) {
            const lin = averageLinearAt(this.imageData, this.hover.x, this.hover.y, RADIUS);
            this.hoverSwatch.style.backgroundColor = linearToCss(lin);
        } else {
            this.hoverSwatch.style.backgroundColor = "transparent";
        }
        if (this.selection !== null) {
            this.selectedSwatch.style.backgroundColor = linearToCss(this.selection.lin);
            this.selectedNote.textContent = this.isVideo
                ? `${this.selection.frameTime.toFixed(2)} 秒のフレームで選択${this.selectionVisible() ? "" : "（別フレームを表示中）"}`
                : `(${this.selection.x}, ${this.selection.y})`;
        }
        this.confirmButton.disabled = this.selection === null;
    }

    // ---- 動画 ---------------------------------------------------------

    togglePlay() {
        if (!this.video) {
            return;
        }
        const v = this.video.video;
        if (v.paused) {
            if (v.ended) {
                v.currentTime = 0;
            }
            v.play().catch((error) => this.status.textContent = `再生できません: ${error.message}`);
        } else {
            v.pause();
        }
    }

    stepFrame(direction) {
        if (!this.video) {
            return;
        }
        const v = this.video.video;
        v.pause();
        v.currentTime = Math.min(Math.max(v.currentTime + direction * UI.videoFrameStep, 0), v.duration);
    }

    onPlay() {
        this.paused = false;
        this.imageData = null;
        this.hover = null;
        this.playButton.textContent = "一時停止";
        const loop = () => {
            if (this.done || this.paused) {
                return;
            }
            this.fieldContext.drawImage(this.video.video, 0, 0, this.width, this.height);
            this.updateTimeUi();
            this.rafHandle = requestAnimationFrame(loop);
        };
        this.rafHandle = requestAnimationFrame(loop);
        this.drawOverlay();
        this.drawLoupe();
        this.updateReadouts();
    }

    onPause() {
        if (this.done) {
            return;
        }
        this.paused = true;
        cancelAnimationFrame(this.rafHandle);
        this.playButton.textContent = "再生";
        if (!this.video.video.seeking) {
            this.refreshFrame();
        }
    }

    /** 一時停止中のフレームを描画し、ピクセルを読み取れる状態にする。 */
    refreshFrame() {
        if (this.done) {
            return;
        }
        const v = this.video.video;
        this.fieldContext.drawImage(v, 0, 0, this.width, this.height);
        this.imageData = this.fieldContext.getImageData(0, 0, this.width, this.height);
        this.frameTime = v.currentTime;
        this.frameThumbnail = null;
        this.updateTimeUi();
        this.drawOverlay();
        this.drawLoupe();
        this.updateReadouts();
    }

    updateTimeUi() {
        const v = this.video.video;
        if (!this.seekDragging) {
            this.seekBar.value = String(v.currentTime);
        }
        this.timeText.textContent = `${v.currentTime.toFixed(2)} / ${v.duration.toFixed(2)}`;
    }

    // ---- 入力 ---------------------------------------------------------

    toSourcePoint(event) {
        const rect = this.fieldCanvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return null;
        }
        const x = Math.floor((event.clientX - rect.left) / rect.width * this.width);
        const y = Math.floor((event.clientY - rect.top) / rect.height * this.height);
        return {
            x: Math.min(Math.max(x, 0), this.width - 1),
            y: Math.min(Math.max(y, 0), this.height - 1),
        };
    }

    setHover(point) {
        this.hover = this.imageData !== null ? point : null;
        this.drawLoupe();
        this.updateReadouts();
    }

    onPointerMove(event) {
        this.setHover(this.toSourcePoint(event));
    }

    onPointerDown(event) {
        if (event.button !== 0) {
            return;
        }
        const point = this.toSourcePoint(event);
        if (point !== null) {
            this.select(point.x, point.y);
        }
    }

    onKeyDown(event) {
        const target = event.target;
        if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
            || (target instanceof HTMLInputElement && target.type !== "range")) {
            return;
        }
        const isRange = target instanceof HTMLInputElement;
        const step = event.shiftKey ? 10 : 1;
        switch (event.key) {
        case "ArrowLeft":
        case "ArrowRight":
        case "ArrowUp":
        case "ArrowDown": {
            if (isRange || this.selection === null || !this.selectionVisible()) {
                return;
            }
            event.preventDefault();
            const dx = event.key === "ArrowLeft" ? -step : (event.key === "ArrowRight" ? step : 0);
            const dy = event.key === "ArrowUp" ? -step : (event.key === "ArrowDown" ? step : 0);
            this.select(this.selection.x + dx, this.selection.y + dy);
            break;
        }
        case "Enter":
            event.preventDefault();
            this.confirm();
            break;
        case " ":
            if (this.isVideo) {
                event.preventDefault();
                this.togglePlay();
            }
            break;
        case ",":
            if (this.isVideo) {
                this.stepFrame(-1);
            }
            break;
        case ".":
            if (this.isVideo) {
                this.stepFrame(1);
            }
            break;
        default:
            break;
        }
    }

    select(x, y) {
        if (this.imageData === null || !this.paused || this.done) {
            return;
        }
        const cx = Math.min(Math.max(x, 0), this.width - 1);
        const cy = Math.min(Math.max(y, 0), this.height - 1);
        if (this.frameThumbnail === null) {
            this.frameThumbnail = createThumbnail(this.fieldCanvas, this.width, this.height);
        }
        this.selection = {
            x: cx,
            y: cy,
            lin: averageLinearAt(this.imageData, cx, cy, RADIUS),
            frameTime: this.isVideo ? this.frameTime : null,
            thumbnail: this.frameThumbnail,
        };
        this.drawOverlay();
        this.drawLoupe();
        this.updateReadouts();
    }

    confirm() {
        if (this.selection !== null) {
            this.finish();
        }
    }

    // ---- 終了 ---------------------------------------------------------

    finish() {
        if (this.done) {
            return;
        }
        const selection = this.selection;
        this.dispose();
        this.resolve(selection);
    }

    fail(error) {
        if (this.done) {
            return;
        }
        this.dispose();
        this.reject(error);
    }

    dispose() {
        this.done = true;
        if (this.countdown) {
            this.countdown.stop();
        }
        cancelAnimationFrame(this.rafHandle);
        for (const dispose of this.disposers.splice(0).reverse()) {
            dispose();
        }
    }
}
