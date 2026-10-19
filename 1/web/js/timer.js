// 締め切り時刻ベースのカウントダウン。setInterval の遅延が累積しない。

const TICK_MS = 100;

export class Countdown {
    /**
     * @param {number} seconds
     * @param {(remainingSeconds: number) => void} onTick
     * @param {() => void} onExpire
     */
    constructor(seconds, onTick, onExpire) {
        this.deadline = performance.now() + seconds * 1000;
        this.onTick = onTick;
        this.onExpire = onExpire;
        this.handle = null;
        this.finished = false;
    }

    start() {
        this.tick();
        if (!this.finished) {
            this.handle = setInterval(() => this.tick(), TICK_MS);
        }
        return this;
    }

    remaining() {
        return Math.max(0, (this.deadline - performance.now()) / 1000);
    }

    tick() {
        if (this.finished) {
            return;
        }
        const remaining = this.remaining();
        this.onTick(remaining);
        if (remaining <= 0) {
            this.stop();
            this.onExpire();
        }
    }

    stop() {
        this.finished = true;
        if (this.handle !== null) {
            clearInterval(this.handle);
            this.handle = null;
        }
    }
}
