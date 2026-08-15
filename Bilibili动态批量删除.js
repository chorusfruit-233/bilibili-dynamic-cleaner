// ==UserScript==
// @name         B站动态批量删除工具
// @version      2.1.1
// @description  用于清除B站动态的脚本，可区分转发动态、文字动态、图片动态、投稿动态，并且可以输出删除日志及删除的动态内容（v2：适配B站新版 Polymer 接口，移除外部 CDN 依赖）
// @author       秦心桜
// @match        https://space.bilibili.com/*/dynamic
// @match        http://space.bilibili.com/*/dynamic
// @icon         https://raw.githubusercontent.com/the1812/Bilibili-Evolved/preview/images/logo-small.png
// @copyright    2024, HatanoKokosa (https://github.com/hatanokokosa)
// @license      GPL-3.0
// @grant        none
// ==/UserScript==
//直接使用了Bilibili-Evolved的图标（因为好看）

(function () {
    'use strict';

    const uid = window.location.pathname.split("/")[1];
    const logs = [];
    let deleteCount = 0;
    let matchCount = 0;
    let totalCount = 0;
    let isRunning = false;
    let stopRequested = false;

    function getCookie(name) {
        const row = document.cookie.split("; ").find(r => r.startsWith(name + "="));
        return row ? row.split("=")[1] : "";
    }
    const csrfToken = getCookie("bili_jct");

    // B站新版 Polymer 接口的动态类型为字符串枚举（旧版为数字 1/2/4/8）
    const DYNAMIC_TYPES = {
        FORWARD: "DYNAMIC_TYPE_FORWARD",   // 转发动态
        WORD: "DYNAMIC_TYPE_WORD",         // 文字动态
        DRAW: "DYNAMIC_TYPE_DRAW",         // 图片动态（图文）
        AV: "DYNAMIC_TYPE_AV",             // 投稿动态（视频投稿）
        SHORT: "DYNAMIC_TYPE_SHORT",       // 小视频
        COMMON_SQUARE: "DYNAMIC_TYPE_COMMON_SQUARE", // 普通动态（按文字处理）
    };
    const TYPE_LABELS = {
        [DYNAMIC_TYPES.FORWARD]: "转发",
        [DYNAMIC_TYPES.WORD]: "文字",
        [DYNAMIC_TYPES.DRAW]: "图片",
        [DYNAMIC_TYPES.AV]: "投稿",
    };

    const COMMON_HEADERS = {
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.bilibili.com/",
    };

    class Api {
        // 新版空间动态列表接口（旧版 space_history 已下线，返回 404）
        async spaceHistory(offset = "") {
            const url = "https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space" +
                `?host_mid=${encodeURIComponent(uid)}` +
                `&offset=${encodeURIComponent(offset)}` +
                "&timezone_offset=-480&platform=web";
            return this._request(url, { method: "GET" });
        }

        // 删除动态：优先新版接口，失败时回退旧版 rm_dynamic（兼容老动态）
        async removeDynamic(id) {
            let newRes = null;
            try {
                newRes = await this._request(
                    "https://api.bilibili.com/x/dynamic/feed/operate/remove" +
                    `?csrf=${encodeURIComponent(csrfToken)}&platform=web`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ dyn_id_str: String(id) }),
                    }
                );
                if (newRes.code === 0) return newRes;
            } catch (e) {
                console.warn("新版删除接口请求失败，回退旧版 rm_dynamic：", e);
            }
            try {
                const oldRes = await this._request(
                    "https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/rm_dynamic",
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/x-www-form-urlencoded" },
                        body: new URLSearchParams({
                            dynamic_id: id,
                            csrf_token: csrfToken,
                            csrf: csrfToken,
                        }).toString(),
                    }
                );
                if (oldRes.code === 0 || !newRes) return oldRes;
            } catch (e) {
                if (!newRes) throw new Error(`删除接口请求失败：${e.message}`);
                console.error("旧版删除接口请求失败：", e);
            }
            return newRes;
        }

        async _request(url, options = {}) {
            const { headers, ...rest } = options;
            const res = await fetch(url, {
                credentials: "include",
                headers: { ...COMMON_HEADERS, ...(headers || {}) },
                ...rest,
            });
            const text = await res.text();
            // 风控拦截时接口会返回 HTML 页面而不是 JSON
            if (!text || text.trim().startsWith("<")) {
                throw new Error(`接口返回非 JSON（HTTP ${res.status}），可能被风控拦截`);
            }
            try {
                return JSON.parse(text);
            } catch (e) {
                throw new Error("接口返回数据解析失败");
            }
        }

        sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }
    }

    const api = new Api();

    // 从新版 modules 结构中提取动态正文与转发的原动态内容
    function extractContent(item) {
        const dyn = item?.modules?.module_dynamic;
        let text = dyn?.desc?.text || "";
        if (!text && dyn?.major) {
            const m = dyn.major;
            text = m.opus?.summary?.text
                || m.archive?.title
                || m.article?.title
                || m.draw?.items?.[0]?.description
                || "";
        }
        let originText = "";
        const orig = item.orig;
        if (orig) {
            try {
                const od = orig.modules?.module_dynamic;
                const oText = od?.desc?.text
                    || od?.major?.opus?.summary?.text
                    || od?.major?.archive?.title
                    || od?.major?.article?.title
                    || "";
                const author = orig.modules?.module_author?.name || orig.user?.name || "未知用户";
                originText = `【转发的原动态 @${author}】${oText || "(无内容)"}`;
            } catch (e) {
                originText = "【原动态已失效或无法解析】";
            }
        }
        return { text: text || "(无文字内容)", origin: originText };
    }

    function isTargetType(item, type) {
        if (type === DYNAMIC_TYPES.FORWARD) {
            return item.type === DYNAMIC_TYPES.FORWARD || !!item.orig;
        }
        if (type === DYNAMIC_TYPES.WORD) {
            return item.type === DYNAMIC_TYPES.WORD || item.type === DYNAMIC_TYPES.COMMON_SQUARE;
        }
        if (type === DYNAMIC_TYPES.AV) {
            return item.type === DYNAMIC_TYPES.AV || item.type === DYNAMIC_TYPES.SHORT;
        }
        return item.type === type;
    }

    async function clearDynamicsByType(type) {
        if (isRunning) return;
        if (!csrfToken) {
            alert("未获取到 CSRF Token（bili_jct），请先登录B站账号！");
            return;
        }
        const loginUid = getCookie("DedeUserID");
        if (loginUid && String(uid) !== String(loginUid)) {
            alert(`当前页面是 UID ${uid} 的空间，但你登录的是 UID ${loginUid}。\n只能删除自己账号的动态，请先打开自己的空间动态页！`);
            return;
        }

        isRunning = true;
        stopRequested = false;
        deleteCount = 0;
        matchCount = 0;
        totalCount = 0;
        const seenIds = new Set();
        updateProgress(0, 0, 0);
        setButtonsDisabled(true);
        logPanel(`开始清理【${TYPE_LABELS[type] || type}】动态……`);

        const delay = parseInt(document.getElementById("delayInput").value, 10) || 800;
        let offset = "";
        let hasMore = true;
        let consecutiveErrors = 0;
        let aborted = false;

        try {
            while (hasMore && !stopRequested) {
                let data;
                try {
                    const res = await api.spaceHistory(offset);
                    if (res.code !== 0) {
                        throw new Error(res.message || `接口返回 code=${res.code}`);
                    }
                    data = res.data || {};
                    consecutiveErrors = 0;
                } catch (e) {
                    consecutiveErrors++;
                    logPanel(`获取动态列表失败（${consecutiveErrors}/3）：${e.message}`, true);
                    if (consecutiveErrors >= 3) {
                        aborted = true;
                        logPanel("连续获取列表失败，任务已中止。请确认已登录B站，稍后再试。", true);
                        break;
                    }
                    await api.sleep(2000 * consecutiveErrors);
                    continue;
                }

                const items = Array.isArray(data.items) ? data.items : [];
                if (items.length === 0) break;
                hasMore = !!data.has_more;

                for (const item of items) {
                    if (stopRequested) break;

                    const dynamicId = item.id_str;
                    // 删除过程中分页可能重叠返回同一动态，按 id 去重，避免重复扫描/重复删除导致计数与实际不符
                    if (!dynamicId || seenIds.has(dynamicId)) continue;
                    seenIds.add(dynamicId);
                    totalCount++;
                    updateProgress(deleteCount, matchCount, totalCount);

                    const { text, origin } = extractContent(item);
                    const content = origin ? `${text} ${origin}` : text;

                    if (!isTargetType(item, type)) continue;

                    matchCount++;
                    updateProgress(deleteCount, matchCount, totalCount);

                    try {
                        const result = await api.removeDynamic(dynamicId);
                        if (result.code === 0) {
                            deleteCount++;
                            logDeletion(dynamicId, "成功", type, content);
                            logPanel(`已删除 ${dynamicId}：${text.slice(0, 30)}`);
                        } else {
                            logDeletion(dynamicId, "失败", type, content);
                            logPanel(`删除失败 ${dynamicId}：${result.message || result.msg || `code=${result.code}`}`, true);
                        }
                    } catch (error) {
                        logDeletion(dynamicId, "出错", type, content);
                        logPanel(`删除出错 ${dynamicId}：${error.message}`, true);
                    }
                    updateProgress(deleteCount, matchCount, totalCount);
                    await api.sleep(delay);
                }

                // 游标没有前进说明分页到头或接口异常，停止翻页避免死循环/重复扫描
                const nextOffset = data.offset || "";
                if (!nextOffset || nextOffset === offset) {
                    hasMore = false;
                } else {
                    offset = nextOffset;
                }
                await api.sleep(500);
            }
        } finally {
            isRunning = false;
            setButtonsDisabled(false);
            if (stopRequested) {
                logPanel("已手动停止。", true);
            } else {
                logPanel(`清理${aborted ? "中止" : "完成"}：删除 ${deleteCount} / 匹配 ${matchCount} / 扫描 ${totalCount}。`);
            }
            const state = stopRequested ? "已停止" : (aborted ? "已中止" : "完成");
            alert(`清理${state}！共删除 ${deleteCount} 条，匹配 ${matchCount} 条，共扫描 ${totalCount} 条【${TYPE_LABELS[type] || type}】动态。`);
        }
    }

    function logDeletion(dynamicId, status, type, content) {
        const log = {
            dynamicId,
            status,
            type,
            content,
            time: new Date().toLocaleString(),
        };
        logs.push(log);
        console.table(log);
    }

    function exportLogs() {
        if (logs.length === 0) {
            alert("没有可导出的日志记录！");
            return;
        }
        const blob = new Blob([JSON.stringify(logs, null, 2)], { type: "application/json" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `deletion_logs_${Date.now()}.json`;
        link.click();
        alert("日志导出成功！");
    }

    function updateProgress(deleted, matched, scanned) {
        const progressBar = document.getElementById("progressBar");
        const deleteCountElem = document.getElementById("deleteCount");
        const matchCountElem = document.getElementById("matchCount");
        const totalCountElem = document.getElementById("totalCount");

        deleteCountElem.textContent = deleted;
        matchCountElem.textContent = matched;
        totalCountElem.textContent = scanned;
        // 进度条按“已删除 / 匹配到的目标动态”计算；没有匹配时为 0
        progressBar.style.width = matched ? `${(deleted / matched) * 100}%` : "0%";
    }

    function logPanel(msg, isError = false) {
        const box = document.getElementById("logBox");
        if (!box) return;
        const div = document.createElement("div");
        const time = new Date().toTimeString().slice(0, 8);
        div.textContent = `[${time}] ${msg}`;
        div.style.cssText = `font-size: 12px; margin: 2px 0; word-break: break-all; color: ${isError ? "#ff6b6b" : "#dcdde1"};`;
        box.prepend(div);
        while (box.children.length > 200) box.removeChild(box.lastChild);
    }

    function setButtonsDisabled(disabled) {
        const ids = ["clearAllButton", "clearTextButton", "clearImageButton", "clearVideoButton", "exportLogsButton"];
        ids.forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.disabled = disabled;
        });
        const stopBtn = document.getElementById("stopButton");
        if (stopBtn) stopBtn.disabled = !disabled;
    }

    function createControlPanel() {
        const panel = document.createElement("div");
        panel.style = `
            position: fixed; bottom: 30px; right: 30px;
            width: 280px; background: linear-gradient(135deg, #1e272e, #485460);
            color: #333; padding: 20px; border-radius: 12px;
            font-family: Arial, sans-serif; box-shadow: 0 8px 16px rgba(0,0,0,0.3);
            z-index: 99999;
        `;

        panel.innerHTML = `
            <div style="font-size: 18px; font-weight: bold; text-align: center; color: #eeeeee; margin-bottom: 15px;">
                动态批量删除工具
            </div>

            <button class="custom-button" id="clearAllButton">删除转发动态</button>
            <button class="custom-button" id="clearTextButton">删除文字动态</button>
            <button class="custom-button" id="clearImageButton">删除图片动态</button>
            <button class="custom-button" id="clearVideoButton">删除投稿动态（连带删视频！）</button>
            <button class="custom-button" id="exportLogsButton">导出清除日志及内容</button>
            <button class="custom-button" id="stopButton" style="background: rgba(255,80,80,0.35);" disabled>停止当前任务</button>

            <div style="margin-top: 15px; color: white; font-size: 14px;">
                删除间隔（毫秒）：<input id="delayInput" type="number" value="800" min="100"
                style="width: 80px; color: black; padding: 5px; border: 1px solid #ccc; border-radius: 5px; text-align: center;">
            </div>

            <div style="margin-top: 10px; color: white; font-size: 14px;">
                已删除：<span id="deleteCount" style="color: #ff6b6b;">0</span> /
                匹配：<span id="matchCount" style="color: #feca57;">0</span> /
                已扫描：<span id="totalCount" style="color: #1e90ff;">0</span>
            </div>

            <div style="margin-top: 8px; height: 10px; background: #ddd; border-radius: 5px; overflow: hidden;">
                <div id="progressBar" style="height: 100%; width: 0%; background: #76c7c0;"></div>
            </div>

            <div style="margin-top: 10px; color: white; font-size: 12px;">运行日志：</div>
            <div id="logBox" style="margin-top: 4px; height: 120px; overflow-y: auto; background: rgba(0,0,0,0.3); border-radius: 6px; padding: 6px 8px;"></div>
        `;

        document.body.appendChild(panel);

        const style = document.createElement("style");
        style.innerHTML = `
            .custom-button {
                width: 100%; margin-bottom: 10px; padding: 10px 0;
                background: rgba(255, 255, 255, 0.3);
                color: #f0f0f0; font-size: 15px;
                border: none; border-radius: 6px; cursor: pointer;
                transition: all 0.3s ease-in-out; font-weight: bold;
            }

            .custom-button:hover:not(:disabled) {
                background: rgba(255, 255, 255, 0.5);
                color: #eeeeee;
                transform: translateY(-2px);
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.2);
            }

            .custom-button:disabled {
                opacity: 0.45;
                cursor: not-allowed;
            }
        `;
        document.head.appendChild(style);

        // 事件监听（新版类型为字符串枚举）
        document.getElementById("clearAllButton").addEventListener("click", () => clearDynamicsByType(DYNAMIC_TYPES.FORWARD));
        document.getElementById("clearTextButton").addEventListener("click", () => clearDynamicsByType(DYNAMIC_TYPES.WORD));
        document.getElementById("clearImageButton").addEventListener("click", () => clearDynamicsByType(DYNAMIC_TYPES.DRAW));
        // 投稿动态与视频稿件在B站是绑定的：删除动态会连带删除视频本身，必须强提醒
        document.getElementById("clearVideoButton").addEventListener("click", () => {
            if (!confirm("⚠️ 重要提示：\nB站将「投稿动态」与「视频稿件」绑定，删除投稿动态会连带删除对应的视频投稿，且无法恢复！\n\n确定要删除投稿动态（含视频本身）吗？")) {
                return;
            }
            clearDynamicsByType(DYNAMIC_TYPES.AV);
        });
        document.getElementById("exportLogsButton").addEventListener("click", exportLogs);
        document.getElementById("stopButton").addEventListener("click", () => {
            stopRequested = true;
            logPanel("正在停止……（等待当前操作结束）", true);
        });
    }

    createControlPanel();
})();
