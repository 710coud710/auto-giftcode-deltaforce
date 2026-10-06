/**
 * Delta Force Auto Gift Code Extension - Popup Script
 * Quản lý giao diện, kết nối với trang Delta Force, điều khiển tiến trình tự động.
 */

const extAPI = (typeof chrome !== "undefined" && chrome.runtime) ? chrome : (typeof browser !== "undefined" ? browser : window.browser);

// State của popup
const state = {
    allCodes: [],
    remainingCodes: [],
    completedCodes: [],
    currentTabFilter: "active", // 'active' | 'completed' | 'all'
    searchQuery: "",
    delaySec: 1.0,
    isRunning: false,
    isPaused: false,
    currentCode: "",
    currentIndex: 0,
    successCount: 0,
    failCount: 0,
    activeTabId: null,
    isConnected: false
};

// Storage helpers
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
// KHỞI TẠO & LOAD DỮ LIỆU
// ==========================================

async function loadCodes() {
    try {
        const data = await storageGet(["codes", "completedCodes", "delaySec"]);
        if (typeof data.delaySec === "number") {
            state.delaySec = data.delaySec;
            const delayInput = document.getElementById("delayInput");
            if (delayInput) delayInput.value = state.delaySec;
        }

        let codes = data.codes;
        let completed = data.completedCodes || [];

        // Nếu chưa có trong storage thì tải từ file config.json
        if (!codes || !Array.isArray(codes) || codes.length === 0) {
            codes = await fetchConfigCodes();
            await storageSet({ codes: codes, completedCodes: [] });
            completed = [];
        }

        state.remainingCodes = codes;
        state.completedCodes = completed;
        // Tổng hợp allCodes
        const setAll = new Set([...codes, ...completed]);
        state.allCodes = Array.from(setAll);

        updateStatsUI();
        renderCodeList();
    } catch (err) {
        console.error("Lỗi khi load codes:", err);
    }
}

async function fetchConfigCodes() {
    try {
        const url = extAPI.runtime.getURL("config.json");
        const res = await fetch(url);
        if (!res.ok) throw new Error("Không thể đọc config.json");
        const json = await res.json();
        return Array.isArray(json.codes) ? json.codes : [];
    } catch (err) {
        console.error("Lỗi fetch config.json:", err);
        return [];
    }
}

async function reloadFromConfig() {
    if (!confirm("Bạn có muốn nạp lại toàn bộ mã từ config.json và xóa lịch sử đã đổi không?")) {
        return;
    }

    const configCodes = await fetchConfigCodes();
    state.remainingCodes = [...configCodes];
    state.completedCodes = [];
    state.allCodes = [...configCodes];

    await storageSet({
        codes: state.remainingCodes,
        completedCodes: []
    });

    state.currentIndex = 0;
    state.successCount = 0;
    state.failCount = 0;
    state.isRunning = false;
    state.isPaused = false;

    updateStatsUI();
    renderCodeList();
    showStatusMessage("Đã nạp lại toàn bộ mã từ config.json!");
}

// ==========================================
// KẾT NỐI VỚI ACTIVE TAB
// ==========================================

async function initTabConnection() {
    const connPill = document.getElementById("connectionStatus");
    const connText = document.getElementById("connectionText");

    try {
        const tabs = await extAPI.tabs.query({ active: true, currentWindow: true });
        if (!tabs || tabs.length === 0) {
            setOfflineState("Không tìm thấy tab");
            return;
        }

        const tab = tabs[0];
        state.activeTabId = tab.id;

        // Thử ping content script
        let pingOk = false;
        try {
            const res = await extAPI.tabs.sendMessage(tab.id, { action: "ping" });
            if (res && res.status === "ok") pingOk = true;
        } catch (_) {}

        // Nếu content script chưa được inject, thử inject bằng scripting API
        if (!pingOk && extAPI.scripting?.executeScript) {
            try {
                await extAPI.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ["content.js"]
                });
                // Thử ping lại
                const res = await extAPI.tabs.sendMessage(tab.id, { action: "ping" });
                if (res && res.status === "ok") pingOk = true;
            } catch (injectErr) {
                console.warn("Không thể tự inject content script:", injectErr);
            }
        }

        if (pingOk) {
            state.isConnected = true;
            connPill.className = "connection-pill online";
            connText.textContent = "Đã kết nối trang";

            // Lấy trạng thái hiện tại từ content script (nếu đang chạy ngầm)
            syncStatusFromContentScript();
        } else {
            setOfflineState("Chưa mở trang Delta Force");
        }
    } catch (err) {
        console.error("Lỗi init connection:", err);
        setOfflineState("Lỗi kết nối");
    }
}

function setOfflineState(text) {
    state.isConnected = false;
    const connPill = document.getElementById("connectionStatus");
    const connText = document.getElementById("connectionText");
    if (connPill) connPill.className = "connection-pill offline";
    if (connText) connText.textContent = text;
}

async function syncStatusFromContentScript() {
    if (!state.activeTabId) return;

    try {
        const res = await extAPI.tabs.sendMessage(state.activeTabId, { action: "getStatus" });
        if (res && res.state) {
            applyRunningState(res.state);
        }
    } catch (_) {}
}

function applyRunningState(s) {
    state.isRunning = s.isRunning;
    state.isPaused = s.isPaused;
    state.currentCode = s.currentCode || "";
    state.currentIndex = s.currentIndex || 0;
    state.successCount = s.successCount || 0;
    state.failCount = s.failCount || 0;

    const currentStatusText = document.getElementById("currentStatusText");
    if (currentStatusText && s.lastStatus) {
        currentStatusText.textContent = s.lastStatus;
    }

    updateControlsUI();
    updateStatsUI();
    renderCodeList();
}

// Lắng nghe cập nhật từ content script gửi về
extAPI.runtime?.onMessage?.addListener((msg) => {
    if (msg && msg.action === "statusChanged" && msg.state) {
        applyRunningState(msg.state);
        // Tải lại storage để đồng bộ danh sách mã đã xóa
        loadCodes();
    }
});

// ==========================================
// ĐIỀU KHIỂN TIẾN TRÌNH AUTO
// ==========================================

async function handleStart() {
    if (!state.isConnected) {
        alert("Vui lòng mở trang đổi quà Delta Force (playdeltaforce.com hoặc garena) và tải lại trang trước khi bắt đầu.");
        return;
    }

    if (state.remainingCodes.length === 0) {
        alert("Không còn mã nào trong danh sách! Hãy bấm 'Nạp lại config' hoặc thêm mã mới.");
        return;
    }

    const delayInput = document.getElementById("delayInput");
    const delaySec = parseFloat(delayInput?.value) || 1.0;
    state.delaySec = Math.max(0.5, delaySec);
    await storageSet({ delaySec: state.delaySec });

    try {
        state.isRunning = true;
        state.isPaused = false;
        updateControlsUI();
        showStatusMessage("Đang bắt đầu nhập tự động...");

        await extAPI.tabs.sendMessage(state.activeTabId, {
            action: "startAuto",
            codes: state.remainingCodes,
            delayMs: Math.round(state.delaySec * 1000)
        });
    } catch (err) {
        console.error("Lỗi khi gửi startAuto:", err);
        showStatusMessage("Lỗi kết nối tab. Vui lòng tải lại trang web.");
        state.isRunning = false;
        updateControlsUI();
    }
}

async function handlePause() {
    if (!state.activeTabId) return;

    try {
        if (state.isPaused) {
            await extAPI.tabs.sendMessage(state.activeTabId, { action: "resumeAuto" });
            state.isPaused = false;
            showStatusMessage("Đang tiếp tục...");
        } else {
            await extAPI.tabs.sendMessage(state.activeTabId, { action: "pauseAuto" });
            state.isPaused = true;
            showStatusMessage("Đã tạm dừng.");
        }
        updateControlsUI();
    } catch (err) {
        console.error("Lỗi pause/resume:", err);
    }
}

async function handleStop() {
    if (!state.activeTabId) return;

    try {
        await extAPI.tabs.sendMessage(state.activeTabId, { action: "stopAuto" });
        state.isRunning = false;
        state.isPaused = false;
        showStatusMessage("Đã dừng tiến trình.");
        updateControlsUI();
        loadCodes();
    } catch (err) {
        console.error("Lỗi stop:", err);
    }
}

async function handleUseSingleCode(code) {
    if (!state.isConnected) {
        alert("Vui lòng mở trang đổi code Delta Force trước.");
        return;
    }

    showStatusMessage(`Đang điền mã: ${code}...`);
    try {
        await extAPI.tabs.sendMessage(state.activeTabId, {
            action: "fillCode",
            code: code
        });
    } catch (err) {
        console.error("Lỗi fillCode:", err);
    }
}

// ==========================================
// UI UPDATES
// ==========================================

function updateControlsUI() {
    const startBtn = document.getElementById("startBtn");
    const startBtnText = document.getElementById("startBtnText");
    const pauseBtn = document.getElementById("pauseBtn");
    const stopBtn = document.getElementById("stopBtn");

    if (state.isRunning) {
        startBtn.disabled = true;
        startBtnText.textContent = "ĐANG CHẠY TỰ ĐỘNG...";
        pauseBtn.disabled = false;
        stopBtn.disabled = false;

        pauseBtn.innerHTML = state.isPaused
            ? '<span class="btn-icon">▶</span> Tiếp tục'
            : '<span class="btn-icon">⏸</span> Tạm dừng';
    } else {
        startBtn.disabled = false;
        startBtnText.textContent = "BẮT ĐẦU TỰ ĐỘNG NHẬP";
        pauseBtn.disabled = true;
        stopBtn.disabled = true;
        pauseBtn.innerHTML = '<span class="btn-icon">⏸</span> Tạm dừng';
    }
}

function updateStatsUI() {
    const total = state.allCodes.length;
    const remaining = state.remainingCodes.length;
    const success = state.completedCodes.length || state.successCount;
    const failed = state.failCount;

    document.getElementById("statTotal").textContent = total;
    document.getElementById("statSuccess").textContent = success;
    document.getElementById("statRemaining").textContent = remaining;
    document.getElementById("statFailed").textContent = failed;

    document.getElementById("tabActiveCount").textContent = remaining;
    document.getElementById("tabCompletedCount").textContent = state.completedCodes.length;
    document.getElementById("tabAllCount").textContent = total;

    // Progress bar
    const bar = document.getElementById("progressBar");
    const percentEl = document.getElementById("progressPercent");
    const countEl = document.getElementById("progressCount");

    if (total > 0) {
        const completedCount = total - remaining;
        const pct = Math.min(100, Math.round((completedCount / total) * 100));
        bar.style.width = `${pct}%`;
        percentEl.textContent = `${pct}%`;
        countEl.textContent = `${completedCount} / ${total} mã`;
    } else {
        bar.style.width = "0%";
        percentEl.textContent = "0%";
        countEl.textContent = "0 / 0 mã";
    }
}

function showStatusMessage(text) {
    const el = document.getElementById("currentStatusText");
    if (el) el.textContent = text;
}

// ==========================================
// RENDER DANH SÁCH MÃ
// ==========================================

function renderCodeList() {
    const container = document.getElementById("codeList");
    if (!container) return;

    let displayList = [];
    if (state.currentTabFilter === "active") {
        displayList = state.remainingCodes.map((code) => ({ code, isDone: false }));
    } else if (state.currentTabFilter === "completed") {
        displayList = state.completedCodes.map((code) => ({ code, isDone: true }));
    } else {
        displayList = state.allCodes.map((code) => ({
            code,
            isDone: state.completedCodes.includes(code)
        }));
    }

    // Lọc theo tìm kiếm
    if (state.searchQuery.trim()) {
        const q = state.searchQuery.trim().toLowerCase();
        displayList = displayList.filter((item) => item.code.toLowerCase().includes(q));
    }

    container.innerHTML = "";

    if (displayList.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-list";
        empty.textContent = "Không có mã nào phù hợp";
        container.appendChild(empty);
        return;
    }

    displayList.forEach((item, idx) => {
        const row = document.createElement("div");
        row.className = `code-item ${item.isDone ? "completed" : ""}`;
        if (state.isRunning && item.code === state.currentCode) {
            row.classList.add("active-running");
        }

        const badgeHtml = item.isDone
            ? '<span class="code-badge badge-done">✓ Đã đổi</span>'
            : (state.isRunning && item.code === state.currentCode
                ? '<span class="code-badge badge-running">⚡ Đang nhập</span>'
                : '<span class="code-badge badge-pending">Chờ</span>');

        row.innerHTML = `
            <div class="code-left">
                <span class="code-idx">${idx + 1}</span>
                <span class="code-text">${escapeHtml(item.code)}</span>
                ${badgeHtml}
            </div>
            <div class="code-actions">
                <button class="btn-mini btn-use" title="Nhập thủ công mã này">Dùng</button>
                <button class="btn-mini btn-del" title="Xóa mã khỏi danh sách">✕</button>
            </div>
        `;

        row.querySelector(".btn-use").addEventListener("click", () => {
            handleUseSingleCode(item.code);
        });

        row.querySelector(".btn-del").addEventListener("click", () => {
            deleteCode(item.code);
        });

        container.appendChild(row);
    });
}

async function deleteCode(codeToDelete) {
    state.remainingCodes = state.remainingCodes.filter((c) => c !== codeToDelete);
    state.completedCodes = state.completedCodes.filter((c) => c !== codeToDelete);
    state.allCodes = state.allCodes.filter((c) => c !== codeToDelete);

    await storageSet({
        codes: state.remainingCodes,
        completedCodes: state.completedCodes
    });

    updateStatsUI();
    renderCodeList();
}

async function addNewCode() {
    const input = document.getElementById("newCodeInput");
    const code = input?.value.trim();
    if (!code) return;

    if (!state.allCodes.includes(code)) {
        state.remainingCodes.unshift(code);
        state.allCodes.unshift(code);

        await storageSet({
            codes: state.remainingCodes
        });

        updateStatsUI();
        renderCodeList();
        showStatusMessage(`Đã thêm mã: ${code}`);
    } else {
        alert("Mã này đã có trong danh sách!");
    }

    if (input) input.value = "";
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

// ==========================================
// EVENT LISTENERS
// ==========================================

document.addEventListener("DOMContentLoaded", () => {
    loadCodes();
    initTabConnection();

    // Controls
    document.getElementById("startBtn")?.addEventListener("click", handleStart);
    document.getElementById("pauseBtn")?.addEventListener("click", handlePause);
    document.getElementById("stopBtn")?.addEventListener("click", handleStop);
    document.getElementById("reloadConfigBtn")?.addEventListener("click", reloadFromConfig);

    // Settings
    document.getElementById("delayInput")?.addEventListener("change", async (e) => {
        const val = parseFloat(e.target.value) || 1.0;
        state.delaySec = Math.max(0.5, val);
        await storageSet({ delaySec: state.delaySec });
    });

    // Tabs filter
    document.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
            e.currentTarget.classList.add("active");
            state.currentTabFilter = e.currentTarget.getAttribute("data-tab");
            renderCodeList();
        });
    });

    // Search
    document.getElementById("searchCode")?.addEventListener("input", (e) => {
        state.searchQuery = e.target.value;
        renderCodeList();
    });

    // Add code
    document.getElementById("addCodeBtn")?.addEventListener("click", addNewCode);
    document.getElementById("newCodeInput")?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addNewCode();
    });
});