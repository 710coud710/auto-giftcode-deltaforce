/**
 * Delta Force Auto Gift Code Extension - Content Script
 * Tự động nhập code, click đổi, tự động đóng popup thành công (X) và delay giữa các lần.
 */

(() => {
    // Tránh inject trùng lặp
    if (window.__DELTA_FORCE_AUTO_INJECTED__) {
        return;
    }
    window.__DELTA_FORCE_AUTO_INJECTED__ = true;

    const extAPI = (typeof chrome !== "undefined" && chrome.runtime) ? chrome : (typeof browser !== "undefined" ? browser : window.browser);

    // State
    const state = {
        isRunning: false,
        isPaused: false,
        currentIndex: 0,
        codes: [],
        delayMs: 1000,
        successCount: 0,
        failCount: 0,
        total: 0,
        currentCode: "",
        lastStatus: "Sẵn sàng"
    };

    // Helper: Sleep
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Helper: Storage safe getter & setter
    function storageGet(keys) {
        return new Promise((resolve) => {
            if (extAPI?.storage?.local) {
                extAPI.storage.local.get(keys, (res) => resolve(res || {}));
            } else {
                resolve({});
            }
        });
    }

    function storageSet(items) {
        return new Promise((resolve) => {
            if (extAPI?.storage?.local) {
                extAPI.storage.local.set(items, () => resolve());
            } else {
                resolve();
            }
        });
    }

    // ==========================================
    // DOM SELECTORS
    // ==========================================

    /**
     * Tìm ô input nhập code:
     * Ưu tiên <input class="spr exc-input" type="text">
     */
    function findCodeInput() {
        return (
            document.querySelector("input.spr.exc-input") ||
            document.querySelector("input.exc-input") ||
            document.querySelector('input[class*="exc-input"]') ||
            document.querySelector('input[placeholder*="CDK" i]') ||
            document.querySelector('input[name*="cdk" i]') ||
            document.querySelector('input[id*="cdk" i]')
        );
    }

    /**
     * Tìm nút bấm Đổi:
     * Ưu tiên <a href="javascript:void(0);" class="spr btn-exchange" data-lang="lang10">Đổi</a>
     */
    function findExchangeButton() {
        return (
            document.querySelector("a.spr.btn-exchange") ||
            document.querySelector("a.btn-exchange") ||
            document.querySelector(".spr.btn-exchange") ||
            document.querySelector(".btn-exchange") ||
            document.querySelector('a[data-lang="lang10"]') ||
            Array.from(document.querySelectorAll("a, button")).find((el) => {
                const text = el.textContent.trim().toLowerCase();
                return text === "đổi" || text === "redeem" || text === "exchange";
            })
        );
    }

    /**
     * Tìm nút đóng modal (X):
     * Ưu tiên <a href="javascript:void(0);" class="btn-close"><i class="spr btn-close-i"></i></a>
     */
    function findCloseButton() {
        const candidates = document.querySelectorAll(
            'a.btn-close, .btn-close, .btn-close-i, [class*="btn-close"], [class*="close-btn"], .pop-close, .dialog-close'
        );

        for (const el of candidates) {
            const btn = el.closest("a") || el.closest("button") || el;
            if (isElementVisible(btn)) {
                return btn;
            }
        }
        return null;
    }

    /**
     * Kiểm tra element có hiển thị trên màn hình không
     */
    function isElementVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
            (rect.width > 0 || rect.height > 0) &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0"
        );
    }

    /**
     * Gán giá trị vào input và kích hoạt đầy đủ các event
     */
    function setInputValue(input, val) {
        if (!input) return;
        input.focus();

        // Setter gốc tránh bị override bởi framework (React/Vue)
        const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value"
        )?.set;

        if (nativeSetter) {
            nativeSetter.call(input, val);
        } else {
            input.value = val;
        }

        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    /**
     * Click phần tử mượt mà
     */
    function clickElement(el) {
        if (!el) return;
        el.scrollIntoView?.({ behavior: "smooth", block: "center" });
        el.focus?.();
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        el.click();
    }

    // ==========================================
    // FLOATING HUD OVERLAY (Hiển thị trực tiếp trên web)
    // ==========================================

    let hudElement = null;

    function createHUD() {
        if (hudElement) return;

        hudElement = document.createElement("div");
        hudElement.id = "df-auto-hud";
        hudElement.innerHTML = `
            <div class="df-hud-header">
                <div class="df-hud-title">
                    <span class="df-hud-badge">🎯 AUTO CDK</span>
                    <span id="df-hud-counter">0/0</span>
                </div>
                <div class="df-hud-actions">
                    <button id="df-hud-toggle-btn" title="Thu gọn">−</button>
                    <button id="df-hud-close-btn" title="Đóng HUD">×</button>
                </div>
            </div>
            <div class="df-hud-body" id="df-hud-body">
                <div class="df-hud-code-box">
                    <span class="df-hud-label">MÃ HIỆN TẠI:</span>
                    <span class="df-hud-code" id="df-hud-code">---</span>
                </div>
                <div class="df-hud-status" id="df-hud-status">Sẵn sàng</div>
                <div class="df-hud-progress-bg">
                    <div class="df-hud-progress-bar" id="df-hud-bar" style="width: 0%"></div>
                </div>
                <div class="df-hud-stats">
                    <span class="df-hud-stat-success">✅ Thành công: <b id="df-hud-success">0</b></span>
                    <span class="df-hud-stat-fail">❌ Bỏ qua/Lỗi: <b id="df-hud-fail">0</b></span>
                </div>
                <div class="df-hud-controls">
                    <button id="df-hud-pause-btn" class="df-btn df-btn-warning">⏸ Tạm dừng</button>
                    <button id="df-hud-stop-btn" class="df-btn df-btn-danger">⏹ Dừng lại</button>
                </div>
            </div>
        `;

        // Inject styles
        const style = document.createElement("style");
        style.id = "df-auto-hud-style";
        style.textContent = `
            #df-auto-hud {
                position: fixed;
                bottom: 24px;
                right: 24px;
                width: 320px;
                background: rgba(15, 18, 25, 0.95);
                backdrop-filter: blur(12px);
                border: 1px solid rgba(0, 229, 255, 0.35);
                border-radius: 12px;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6), 0 0 15px rgba(0, 229, 255, 0.15);
                color: #e6edf3;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 13px;
                z-index: 99999999;
                transition: transform 0.2s ease, opacity 0.2s ease;
                user-select: none;
            }
            .df-hud-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 14px;
                background: rgba(24, 29, 39, 0.9);
                border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 12px 12px 0 0;
            }
            .df-hud-title {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .df-hud-badge {
                font-size: 11px;
                font-weight: 700;
                letter-spacing: 0.5px;
                color: #00e5ff;
                text-shadow: 0 0 8px rgba(0, 229, 255, 0.5);
            }
            #df-hud-counter {
                color: #8b949e;
                font-size: 11px;
                font-weight: 600;
            }
            .df-hud-actions button {
                background: transparent;
                border: none;
                color: #8b949e;
                font-size: 16px;
                cursor: pointer;
                padding: 0 4px;
                line-height: 1;
            }
            .df-hud-actions button:hover {
                color: #ffffff;
            }
            .df-hud-body {
                padding: 14px;
                display: flex;
                flex-direction: column;
                gap: 10px;
            }
            .df-hud-code-box {
                background: rgba(0, 0, 0, 0.4);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 6px;
                padding: 8px 10px;
                display: flex;
                flex-direction: column;
                gap: 2px;
            }
            .df-hud-label {
                font-size: 10px;
                color: #8b949e;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .df-hud-code {
                font-family: "Cascadia Code", "Consolas", monospace;
                font-size: 14px;
                font-weight: 700;
                color: #ffb703;
                word-break: break-all;
            }
            .df-hud-status {
                font-size: 12px;
                color: #58a6ff;
                min-height: 18px;
            }
            .df-hud-progress-bg {
                width: 100%;
                height: 6px;
                background: rgba(255, 255, 255, 0.1);
                border-radius: 3px;
                overflow: hidden;
            }
            .df-hud-progress-bar {
                height: 100%;
                background: linear-gradient(90deg, #00e5ff, #38ef7d);
                transition: width 0.3s ease;
            }
            .df-hud-stats {
                display: flex;
                justify-content: space-between;
                font-size: 11px;
            }
            .df-hud-stat-success { color: #38ef7d; }
            .df-hud-stat-fail { color: #ff5252; }
            .df-hud-controls {
                display: flex;
                gap: 8px;
                margin-top: 4px;
            }
            .df-btn {
                flex: 1;
                padding: 7px 10px;
                border: none;
                border-radius: 6px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                transition: opacity 0.2s, transform 0.1s;
            }
            .df-btn:hover { opacity: 0.88; }
            .df-btn:active { transform: scale(0.98); }
            .df-btn-warning {
                background: #ffb703;
                color: #121212;
            }
            .df-btn-danger {
                background: #e9282f;
                color: #ffffff;
            }
            .df-hud-minimized .df-hud-body {
                display: none;
            }
        `;

        document.head.appendChild(style);
        document.body.appendChild(hudElement);

        // Bind events
        document.getElementById("df-hud-toggle-btn")?.addEventListener("click", () => {
            hudElement.classList.toggle("df-hud-minimized");
            const btn = document.getElementById("df-hud-toggle-btn");
            btn.textContent = hudElement.classList.contains("df-hud-minimized") ? "+" : "−";
        });

        document.getElementById("df-hud-close-btn")?.addEventListener("click", () => {
            hudElement.style.display = "none";
        });

        document.getElementById("df-hud-pause-btn")?.addEventListener("click", () => {
            if (state.isPaused) {
                resumeAuto();
            } else {
                pauseAuto();
            }
        });

        document.getElementById("df-hud-stop-btn")?.addEventListener("click", () => {
            stopAuto();
        });
    }

    function updateHUD() {
        if (!hudElement) createHUD();
        hudElement.style.display = "block";

        const counterEl = document.getElementById("df-hud-counter");
        const codeEl = document.getElementById("df-hud-code");
        const statusEl = document.getElementById("df-hud-status");
        const barEl = document.getElementById("df-hud-bar");
        const successEl = document.getElementById("df-hud-success");
        const failEl = document.getElementById("df-hud-fail");
        const pauseBtn = document.getElementById("df-hud-pause-btn");

        if (counterEl) counterEl.textContent = `${state.currentIndex}/${state.total}`;
        if (codeEl) codeEl.textContent = state.currentCode || "---";
        if (statusEl) statusEl.textContent = state.lastStatus;
        if (successEl) successEl.textContent = state.successCount;
        if (failEl) failEl.textContent = state.failCount;

        if (barEl) {
            const pct = state.total > 0 ? Math.round((state.currentIndex / state.total) * 100) : 0;
            barEl.style.width = `${pct}%`;
        }

        if (pauseBtn) {
            pauseBtn.textContent = state.isPaused ? "▶ Tiếp tục" : "⏸ Tạm dừng";
        }
    }

    function broadcastState() {
        updateHUD();
        try {
            extAPI.runtime?.sendMessage({
                action: "statusChanged",
                state: {
                    isRunning: state.isRunning,
                    isPaused: state.isPaused,
                    currentIndex: state.currentIndex,
                    total: state.total,
                    currentCode: state.currentCode,
                    successCount: state.successCount,
                    failCount: state.failCount,
                    lastStatus: state.lastStatus,
                    remainingCodes: state.codes.slice(state.currentIndex)
                }
            }).catch?.(() => {});
        } catch (_) {}
    }

    // ==========================================
    // AUTO REDEEM CORE LOOP
    // ==========================================

    async function startAuto(codes, delayMs = 1000) {
        if (state.isRunning) return;

        state.isRunning = true;
        state.isPaused = false;
        state.codes = Array.isArray(codes) ? [...codes] : [];
        state.total = state.codes.length;
        state.currentIndex = 0;
        state.successCount = 0;
        state.failCount = 0;
        state.delayMs = Math.max(500, delayMs || 1000);
        state.lastStatus = "Bắt đầu tự động nhập...";

        createHUD();
        broadcastState();

        console.log(`[Delta Force Auto] Bắt đầu chạy ${state.total} mã, delay ${state.delayMs}ms`);

        for (let i = 0; i < state.codes.length; i++) {
            if (!state.isRunning) break;

            while (state.isPaused) {
                state.lastStatus = "Đang tạm dừng...";
                broadcastState();
                await sleep(400);
                if (!state.isRunning) break;
            }
            if (!state.isRunning) break;

            state.currentIndex = i + 1;
            const code = state.codes[i];
            state.currentCode = code;

            state.lastStatus = `Đang nhập mã [${i + 1}/${state.total}]: ${code}`;
            broadcastState();

            // 1. Tìm ô nhập <input class="spr exc-input" type="text">
            const input = findCodeInput();
            if (!input) {
                state.lastStatus = "❌ Không tìm thấy ô nhập code (.exc-input)! Dừng lại.";
                state.failCount++;
                broadcastState();
                console.error("[Delta Force Auto] Không tìm thấy ô input");
                break;
            }

            // Xóa nội dung ô nhập trước khi gõ code mới
            setInputValue(input, "");
            await sleep(150);

            // Điền code vào input
            setInputValue(input, code);
            await sleep(250);

            // 2. Tìm nút Đổi <a class="spr btn-exchange" data-lang="lang10">Đổi</a>
            const btnExchange = findExchangeButton();
            if (!btnExchange) {
                state.lastStatus = "❌ Không tìm thấy nút Đổi (.btn-exchange)! Dừng lại.";
                state.failCount++;
                broadcastState();
                console.error("[Delta Force Auto] Không tìm thấy nút Đổi");
                break;
            }

            // Bấm nút Đổi
            state.lastStatus = `Đã bấm Đổi cho mã: ${code}, đang chờ phản hồi...`;
            broadcastState();
            clickElement(btnExchange);

            // 3. Đợi phản hồi và kiểm tra nút X: <a class="btn-close"><i class="spr btn-close-i"></i></a>
            // Chờ tối đa 1.5 giây để modal xuất hiện
            let closeBtn = null;
            const waitModalStart = Date.now();

            while (Date.now() - waitModalStart < 1500) {
                closeBtn = findCloseButton();
                if (closeBtn) break;
                await sleep(120);
            }

            let wasSuccess = false;

            if (closeBtn) {
                // Kiểm tra nội dung modal xem có phải thông báo lỗi không
                const modal = closeBtn.closest('.pop, .dialog, .modal, .popup, [class*="pop"], [class*="dialog"]') || document.body;
                const modalText = (modal.innerText || "").toLowerCase();

                const hasErrorText = /thất bại|không hợp lệ|đã sử dụng|đã nhận|đã hết hạn|hết hạn|sai mã|invalid|expired|already|error|fail|chưa bắt đầu/i.test(modalText);
                const hasSuccessText = /thành công|chúc mừng|nhận quà|vật phẩm|quà tặng|hòm thư|success|congratulat|redeemed/i.test(modalText);

                if (!hasErrorText || hasSuccessText) {
                    // Thành công!
                    wasSuccess = true;
                    state.successCount++;
                    state.lastStatus = `✅ Mã [${code}] ĐỔI THÀNH CÔNG! Đang bấm X để đóng...`;
                    broadcastState();

                    // Ấn nút X để thoát
                    await sleep(200);
                    clickElement(closeBtn);

                    // Xóa ô input sau khi thành công theo đúng yêu cầu
                    setInputValue(input, "");

                    // Xóa mã thành công khỏi danh sách storage để không chạy lại
                    await removeCodeFromStorage(code);
                } else {
                    // Modal hiển thị lỗi (ví dụ mã đã dùng / hết hạn)
                    state.failCount++;
                    state.lastStatus = `⚠️ Mã [${code}] lỗi/đã dùng. Đang đóng popup...`;
                    broadcastState();

                    // Bấm X đóng popup lỗi để không bị che màn hình
                    await sleep(200);
                    clickElement(closeBtn);
                    setInputValue(input, "");
                }
            } else {
                // Không tìm thấy nút X (ví dụ toast tự tắt hoặc không hiện modal) - "không thì thôi"
                state.failCount++;
                state.lastStatus = `⚠️ Mã [${code}] không có modal X. Bỏ qua.`;
                setInputValue(input, "");
                broadcastState();
            }

            // 4. Delay 1s giữa các lần theo yêu cầu
            if (i < state.codes.length - 1 && state.isRunning) {
                state.lastStatus += ` (Đợi ${Math.round(state.delayMs / 1000)}s...)`;
                broadcastState();
                await sleep(state.delayMs);
            }
        }

        // Hoàn tất
        state.isRunning = false;
        state.isPaused = false;
        state.lastStatus = `🎉 Hoàn tất! Thành công: ${state.successCount} | Lỗi/Bỏ qua: ${state.failCount}`;
        broadcastState();
        console.log(`[Delta Force Auto] Hoàn tất toàn bộ mã. Thành công: ${state.successCount}, Thất bại: ${state.failCount}`);
    }

    /**
     * Xóa code thành công khỏi chrome.storage.local
     */
    async function removeCodeFromStorage(successCode) {
        try {
            const data = await storageGet(["codes", "completedCodes"]);
            const currentCodes = data.codes || [];
            const completedCodes = data.completedCodes || [];

            const filtered = currentCodes.filter((c) => c !== successCode);
            if (!completedCodes.includes(successCode)) {
                completedCodes.push(successCode);
            }

            await storageSet({
                codes: filtered,
                completedCodes: completedCodes
            });
        } catch (err) {
            console.error("[Delta Force Auto] Lỗi cập nhật storage:", err);
        }
    }

    function pauseAuto() {
        if (!state.isRunning) return;
        state.isPaused = true;
        state.lastStatus = "Tạm dừng";
        broadcastState();
    }

    function resumeAuto() {
        if (!state.isRunning) return;
        state.isPaused = false;
        state.lastStatus = "Đang tiếp tục...";
        broadcastState();
    }

    function stopAuto() {
        state.isRunning = false;
        state.isPaused = false;
        state.lastStatus = "Đã dừng";
        broadcastState();
    }

    /**
     * Nhập lẻ 1 mã duy nhất
     */
    async function fillSingleCode(code) {
        const input = findCodeInput();
        if (!input) {
            alert("Không tìm thấy ô nhập CDK (<input class='spr exc-input'>). Vui lòng kiểm tra trang web.");
            return false;
        }

        setInputValue(input, code);
        const btnExchange = findExchangeButton();
        if (btnExchange) {
            clickElement(btnExchange);

            // Chờ nút X nếu có
            await sleep(1000);
            const closeBtn = findCloseButton();
            if (closeBtn) {
                clickElement(closeBtn);
                setInputValue(input, "");
            }
        }
        return true;
    }

    // ==========================================
    // EXTENSION MESSAGE LISTENER
    // ==========================================

    extAPI.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
        if (!message || !message.action) return;

        switch (message.action) {
            case "ping":
                sendResponse({ status: "ok", url: window.location.href });
                break;

            case "getStatus":
                sendResponse({
                    state: {
                        isRunning: state.isRunning,
                        isPaused: state.isPaused,
                        currentIndex: state.currentIndex,
                        total: state.total,
                        currentCode: state.currentCode,
                        successCount: state.successCount,
                        failCount: state.failCount,
                        lastStatus: state.lastStatus,
                        remainingCodes: state.codes.slice(state.currentIndex)
                    }
                });
                break;

            case "startAuto":
                startAuto(message.codes, message.delayMs || 1000);
                sendResponse({ status: "started" });
                break;

            case "pauseAuto":
                pauseAuto();
                sendResponse({ status: "paused" });
                break;

            case "resumeAuto":
                resumeAuto();
                sendResponse({ status: "resumed" });
                break;

            case "stopAuto":
                stopAuto();
                sendResponse({ status: "stopped" });
                break;

            case "fillCode":
                fillSingleCode(message.code).then((ok) => {
                    sendResponse({ status: ok ? "ok" : "fail" });
                });
                return true; // Keep channel open for async response

            default:
                break;
        }
    });

    console.log("[Delta Force Auto Code] Content script đã sẵn sàng.");
})();