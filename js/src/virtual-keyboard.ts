// A toggleable on-screen key bar for mobile/touch use. Supplies special keys
// (Esc, Tab, arrows, ~, |, ...) and sticky Ctrl/Alt/Shift modifiers that
// transform the next character typed on the device's native keyboard. Mirrors
// the floating-UI pattern in theme-picker.ts (injected style + body-appended
// DOM). Renders only on touch devices; open/closed state persists.

import { GoTTYXterm } from "./xterm";
import { encodeChar, encodeSpecial, Modifiers } from "./key-encoder";

const STORAGE_OPEN = "gotty-vkb-open";

type KeyDef =
    | { label: string; type: "mod"; mod: keyof Modifiers }
    | { label: string; type: "special"; name: string }
    | { label: string; type: "char"; char: string }
    | { label: string; type: "action"; action: "copy" | "paste" };

const KEYS: KeyDef[] = [
    { label: "Ctrl", type: "mod", mod: "ctrl" },
    { label: "Alt", type: "mod", mod: "alt" },
    { label: "Shift", type: "mod", mod: "shift" },
    { label: "Esc", type: "special", name: "Esc" },
    { label: "Tab", type: "special", name: "Tab" },
    { label: "~", type: "char", char: "~" },
    { label: "/", type: "char", char: "/" },
    { label: "|", type: "char", char: "|" },
    { label: "-", type: "char", char: "-" },
    { label: "←", type: "special", name: "Left" },
    { label: "↑", type: "special", name: "Up" },
    { label: "↓", type: "special", name: "Down" },
    { label: "→", type: "special", name: "Right" },
    { label: "Home", type: "special", name: "Home" },
    { label: "End", type: "special", name: "End" },
    { label: "PgUp", type: "special", name: "PgUp" },
    { label: "PgDn", type: "special", name: "PgDn" },
    { label: "Copy", type: "action", action: "copy" },
    { label: "Paste", type: "action", action: "paste" },
];

class VirtualKeyboard {
    private term: GoTTYXterm;
    private mods: Modifiers = { ctrl: false, alt: false, shift: false };
    private modButtons = new Map<keyof Modifiers, HTMLButtonElement>();
    private bar: HTMLElement;
    private toggleBtn: HTMLButtonElement;

    constructor(term: GoTTYXterm) {
        this.term = term;
        this.injectStyles();
        this.bar = this.buildBar();
        this.toggleBtn = this.buildToggle();
        document.body.appendChild(this.bar);
        document.body.appendChild(this.toggleBtn);
        this.term.setInputTransformer((input) => this.transformInput(input));
        if (localStorage.getItem(STORAGE_OPEN) === "1") {
            this.open();
        }
    }

    // Called from GoTTYXterm.onData: if a modifier is armed, transform the
    // single next character and clear the armed state.
    private transformInput(input: string): string {
        if (!this.anyArmed()) {
            return input;
        }
        if (input.length !== 1) {
            this.clearMods();
            return input;
        }
        const out = encodeChar(input, this.mods);
        this.clearMods();
        return out;
    }

    private anyArmed(): boolean {
        return this.mods.ctrl || this.mods.alt || this.mods.shift;
    }

    private clearMods(): void {
        this.mods = { ctrl: false, alt: false, shift: false };
        this.modButtons.forEach((b) => b.classList.remove("armed"));
    }

    private toggleMod(mod: keyof Modifiers): void {
        this.mods[mod] = !this.mods[mod];
        this.modButtons.get(mod)!.classList.toggle("armed", this.mods[mod]);
        this.term.focus();
    }

    private sendSpecial(name: string): void {
        this.term.sendString(encodeSpecial(name, this.mods));
        this.clearMods();
        this.term.focus();
    }

    private sendChar(ch: string): void {
        this.term.sendString(encodeChar(ch, this.mods));
        this.clearMods();
        this.term.focus();
    }

    private async copy(): Promise<void> {
        const sel = this.term.getSelection();
        if (sel && navigator.clipboard) {
            try {
                await navigator.clipboard.writeText(sel);
                this.term.showMessage("Copied", 1000);
            } catch (e) {
                console.warn("clipboard write failed", e);
            }
        }
        this.clearMods();
        this.term.focus();
    }

    private async paste(): Promise<void> {
        if (navigator.clipboard) {
            try {
                const t = await navigator.clipboard.readText();
                if (t) {
                    this.term.sendString(t);
                }
            } catch (e) {
                console.warn("clipboard read failed", e);
            }
        }
        this.clearMods();
        this.term.focus();
    }

    private open(): void {
        document.body.classList.add("gotty-vkb-open");
        localStorage.setItem(STORAGE_OPEN, "1");
        this.term.fit();
    }

    private close(): void {
        document.body.classList.remove("gotty-vkb-open");
        localStorage.setItem(STORAGE_OPEN, "0");
        this.term.fit();
    }

    private toggle(): void {
        document.body.classList.contains("gotty-vkb-open") ? this.close() : this.open();
    }

    private buildToggle(): HTMLButtonElement {
        const b = document.createElement("button");
        b.id = "gotty-vkb-btn";
        b.textContent = "⌨";
        b.setAttribute("aria-label", "Toggle virtual keyboard");
        b.addEventListener("click", (e) => {
            e.stopPropagation();
            this.toggle();
        });
        return b;
    }

    private buildBar(): HTMLElement {
        const bar = document.createElement("div");
        bar.id = "gotty-vkb-bar";
        for (const key of KEYS) {
            const btn = document.createElement("button");
            btn.className = "gotty-vkb-key";
            btn.textContent = key.label;
            // Keep xterm's textarea focused so the soft keyboard stays open
            // and armed modifiers can transform the next typed character.
            btn.addEventListener("mousedown", (e) => e.preventDefault());
            btn.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
            btn.addEventListener("click", (e) => {
                e.preventDefault();
                switch (key.type) {
                    case "mod":
                        this.toggleMod(key.mod);
                        break;
                    case "special":
                        this.sendSpecial(key.name);
                        break;
                    case "char":
                        this.sendChar(key.char);
                        break;
                    case "action":
                        key.action === "copy" ? this.copy() : this.paste();
                        break;
                }
            });
            if (key.type === "mod") {
                this.modButtons.set(key.mod, btn);
            }
            bar.appendChild(btn);
        }
        return bar;
    }

    private injectStyles(): void {
        const style = document.createElement("style");
        style.textContent = `
:root { --gotty-vkb-h: 46px; }
#gotty-vkb-btn {
    position: fixed;
    bottom: 12px;
    left: 12px;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: none;
    background: rgba(0,0,0,0.55);
    color: #fff;
    font-size: 18px;
    cursor: pointer;
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(4px);
    line-height: 1;
    transition: background 0.2s, bottom 0.2s;
}
#gotty-vkb-btn:hover { background: rgba(0,0,0,0.75); }
body.gotty-vkb-open #gotty-vkb-btn { bottom: calc(var(--gotty-vkb-h) + 14px); }
#gotty-vkb-bar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    height: var(--gotty-vkb-h);
    z-index: 9998;
    display: none;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    box-sizing: border-box;
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    background: rgba(20,20,20,0.95);
    backdrop-filter: blur(8px);
    border-top: 1px solid rgba(255,255,255,0.12);
}
body.gotty-vkb-open #gotty-vkb-bar { display: flex; }
body.gotty-vkb-open #terminal { height: calc(100% - var(--gotty-vkb-h)); }
#gotty-vkb-bar::-webkit-scrollbar { height: 0; }
.gotty-vkb-key {
    flex: 0 0 auto;
    min-width: 38px;
    height: 36px;
    padding: 0 10px;
    border: 1px solid rgba(255,255,255,0.18);
    border-radius: 6px;
    background: rgba(255,255,255,0.08);
    color: #fff;
    font-size: 14px;
    font-family: monospace;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
    touch-action: manipulation;
}
.gotty-vkb-key:active { background: rgba(255,255,255,0.22); }
.gotty-vkb-key.armed {
    background: #2563eb;
    border-color: #2563eb;
}
`;
        document.head.appendChild(style);
    }
}

function isTouchDevice(): boolean {
    // Opt-in override for non-touch devices (compact keyboards without Esc,
    // and for testing): set localStorage["gotty-vkb-force"] = "1".
    if (localStorage.getItem("gotty-vkb-force") === "1") {
        return true;
    }
    return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

export function initVirtualKeyboard(term: GoTTYXterm): void {
    if (!isTouchDevice()) {
        return;
    }
    new VirtualKeyboard(term);
}
