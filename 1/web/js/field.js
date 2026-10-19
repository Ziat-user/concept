// 探索フィールド（静止画・動画）の読み込みと、ラウンド準備（お題色の選定）。

import { SAMPLING, UI } from "./config.js";
import { TargetCollector } from "./sampler.js";

const MEDIA_TIMEOUT_MS = 20000;

export function abortError() {
    return new DOMException("ゲームが中断されました", "AbortError");
}

export function isAbortError(error) {
    return error instanceof DOMException && error.name === "AbortError";
}

export function throwIfAborted(signal) {
    if (signal && signal.aborted) {
        throw abortError();
    }
}

/** 読み取り用の 2D コンテキストを持つキャンバスを作る。 */
export function createReadableCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
    if (context === null) {
        throw new Error("Canvas 2D コンテキストを取得できません。");
    }
    return { canvas, context };
}

/** 長辺が maxSize 以下になるよう縮小したサムネイルを作る。 */
export function createThumbnail(source, width, height, maxSize = UI.thumbnailMaxSize) {
    const scale = Math.min(1, maxSize / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, width, height, 0, 0, w, h);
    return { canvas, scale: w / width };
}

/**
 * イベント待ち。errorEvent が来た場合やタイムアウト時は reject する。
 */
function waitForEvent(target, eventName, { errorEvent = "error", timeoutMs = MEDIA_TIMEOUT_MS, describe }) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer);
            target.removeEventListener(eventName, onEvent);
            target.removeEventListener(errorEvent, onError);
        };
        const onEvent = () => {
            cleanup();
            resolve();
        };
        const onError = () => {
            cleanup();
            reject(new Error(`${describe}に失敗しました。`));
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`${describe}がタイムアウトしました。`));
        }, timeoutMs);
        target.addEventListener(eventName, onEvent);
        target.addEventListener(errorEvent, onError);
    });
}

export async function loadImage(url) {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    try {
        await image.decode();
    } catch {
        throw new Error(`画像を読み込めません: ${decodeURIComponent(url)}`);
    }
    if (image.naturalWidth === 0 || image.naturalHeight === 0) {
        throw new Error(`画像のサイズが不正です: ${decodeURIComponent(url)}`);
    }
    return image;
}

/** 1 本の動画を扱う。探索画面ではプレイヤーごとに新しいインスタンスを作る。 */
export class VideoSource {
    constructor(url) {
        this.url = url;
        this.video = document.createElement("video");
        this.video.muted = true;
        this.video.playsInline = true;
        this.video.preload = "auto";
        this.video.disablePictureInPicture = true;
    }

    async load() {
        const loaded = waitForEvent(this.video, "loadeddata", { describe: `動画の読み込み（${decodeURIComponent(this.url)}）` });
        this.video.src = this.url;
        await loaded;
        if (!Number.isFinite(this.video.duration) || this.video.duration <= 0) {
            throw new Error(`動画の長さを取得できません: ${decodeURIComponent(this.url)}`);
        }
        if (this.video.videoWidth === 0 || this.video.videoHeight === 0) {
            throw new Error(`映像トラックがありません: ${decodeURIComponent(this.url)}`);
        }
    }

    get width() {
        return this.video.videoWidth;
    }

    get height() {
        return this.video.videoHeight;
    }

    get duration() {
        return this.video.duration;
    }

    async seek(time) {
        const clamped = Math.min(Math.max(time, 0), this.duration);
        if (!this.video.seeking && Math.abs(this.video.currentTime - clamped) < 1e-6) {
            return;
        }
        const seeked = waitForEvent(this.video, "seeked", { describe: "動画のシーク" });
        this.video.currentTime = clamped;
        await seeked;
    }

    dispose() {
        this.video.pause();
        this.video.removeAttribute("src");
        this.video.load();
    }
}

/**
 * ラウンドの準備。フィールドを読み込み、お題色を選ぶ。
 * @returns {Promise<{ asset, image: HTMLImageElement | null, width, height, targets, frameThumbnails }>}
 */
export async function prepareRound(asset, targetCount, signal, rng = Math.random) {
    const frameCount = asset.kind === "video" ? SAMPLING.videoPoolFrames : 1;
    const collector = new TargetCollector({
        radius: SAMPLING.radius,
        referenceSamplesPerFrame: Math.ceil(SAMPLING.referenceSampleBudget / frameCount),
        candidatesPerFrame: Math.max(targetCount * 4, Math.ceil(SAMPLING.candidateBudget / frameCount)),
        maxNonUniformity: SAMPLING.maxNonUniformity,
        minLightness: SAMPLING.minLightness,
        maxLightness: SAMPLING.maxLightness,
    }, rng);
    const frameThumbnails = [];
    let image = null;
    let width;
    let height;

    if (asset.kind === "image") {
        image = await loadImage(asset.url);
        throwIfAborted(signal);
        width = image.naturalWidth;
        height = image.naturalHeight;
        const { canvas, context } = createReadableCanvas(width, height);
        context.drawImage(image, 0, 0);
        collector.addFrame(context.getImageData(0, 0, width, height), 0, null);
        frameThumbnails.push(createThumbnail(canvas, width, height));
    } else {
        const source = new VideoSource(asset.url);
        try {
            await source.load();
            throwIfAborted(signal);
            width = source.width;
            height = source.height;
            const { canvas, context } = createReadableCanvas(width, height);
            for (let i = 0; i < frameCount; i++) {
                // 最初と最後のフレーム（黒画面になりやすい）を避けて等間隔に取る。
                const time = source.duration * (i + 0.5) / frameCount;
                await source.seek(time);
                throwIfAborted(signal);
                context.drawImage(source.video, 0, 0, width, height);
                collector.addFrame(context.getImageData(0, 0, width, height), i, source.video.currentTime);
                frameThumbnails.push(createThumbnail(canvas, width, height));
                // 重い処理の合間に描画を返し、ローディング表示を固まらせない。
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        } finally {
            source.dispose();
        }
    }

    throwIfAborted(signal);
    const targets = collector.pickTargets(targetCount, {
        easeThreshold: SAMPLING.easeThreshold,
        minSeparation: SAMPLING.minTargetSeparation,
    });
    return { asset, image, width, height, targets, frameThumbnails };
}

/**
 * ラウンドごとのフィールド選択。固定指定がなければ、全素材を一巡するまで重複させない。
 */
export class AssetRotation {
    constructor(assets, fixedUrl, rng = Math.random) {
        this.assets = [...assets];
        this.fixedUrl = fixedUrl;
        this.rng = rng;
        this.bag = [];
        this.failed = new Set();
    }

    get available() {
        return this.assets.filter((a) => !this.failed.has(a.url));
    }

    next() {
        const available = this.available;
        if (available.length === 0) {
            return null;
        }
        if (this.fixedUrl) {
            return available.find((a) => a.url === this.fixedUrl) ?? null;
        }
        this.bag = this.bag.filter((a) => !this.failed.has(a.url));
        if (this.bag.length === 0) {
            this.bag = [...available];
            for (let i = this.bag.length - 1; i > 0; i--) {
                const j = Math.floor(this.rng() * (i + 1));
                [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
            }
        }
        return this.bag.pop();
    }

    markFailed(asset) {
        this.failed.add(asset.url);
    }
}
