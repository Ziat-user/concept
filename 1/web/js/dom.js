// 小さな DOM ヘルパー。ユーザー入力（名前・メモ）は必ず textContent 経由で挿入する。

/**
 * 要素を作る。
 * attrs: class / text / style(object) / dataset(object) / on<Event>(関数) / その他は属性またはプロパティ。
 */
export function h(tag, attrs = {}, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) {
            continue;
        }
        if (key === "class") {
            element.className = value;
        } else if (key === "text") {
            element.textContent = value;
        } else if (key === "style") {
            Object.assign(element.style, value);
        } else if (key === "dataset") {
            Object.assign(element.dataset, value);
        } else if (key.startsWith("on") && typeof value === "function") {
            element.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key in element && typeof value !== "string") {
            element[key] = value;
        } else if (value === true) {
            element.setAttribute(key, "");
        } else {
            element.setAttribute(key, String(value));
        }
    }
    appendChildren(element, children);
    return element;
}

function appendChildren(element, children) {
    for (const child of children) {
        if (child === undefined || child === null || child === false) {
            continue;
        }
        if (Array.isArray(child)) {
            appendChildren(element, child);
        } else if (child instanceof Node) {
            element.appendChild(child);
        } else {
            element.appendChild(document.createTextNode(String(child)));
        }
    }
}

export function clear(element) {
    while (element.firstChild) {
        element.removeChild(element.firstChild);
    }
}

/** 色見本。title はアクセシビリティ用。 */
export function swatch(css, { size = "md", title } = {}) {
    return h("div", { class: `swatch swatch-${size}`, style: { backgroundColor: css }, title, role: "img",
        "aria-label": title ?? "色見本" });
}

export function formatSeconds(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : String(s);
}
