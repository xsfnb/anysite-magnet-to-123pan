// ==UserScript==
// @name         AnySite Magnet to 123pan
// @namespace    https://github.com/xsfnb/anysite-magnet-to-123pan
// @version      2.5.1
// @description  自动识别页面磁力链接并一键离线下载到 123 云盘；下载完成后自动去掉单集文件夹，并按番剧名归类到同一个文件夹
// @author       xsfnb（原始作者 Nagisa）
// @homepageURL  https://github.com/xsfnb/anysite-magnet-to-123pan
// @supportURL   https://github.com/xsfnb/anysite-magnet-to-123pan/issues
// @match        *://*/*
// @noframes
// @connect      api.123278.com
// @connect      yun.123pan.cn
// @connect      www.123pan.cn
// @icon         https://www.google.com/s2/favicons?sz=64&domain=yun.123pan.cn
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @license MIT
// @note 2.5.1
// @note   - 脚本头部（namespace / author / homepageURL）指向本仓库，补充 README 与出处说明
// @note   - 原始版本：https://greasyfork.org/zh-CN/scripts/573781-anysite-magnet-to-123pan （MIT，作者 Nagisa）
// @note 2.5.0-clean.1
// @note   - 新增「按番剧归类」：下载完成后把单集文件移进「番剧名」文件夹（没有就自动建，有就直接复用）
// @note   - 番剧名识别借鉴 guangya-magnet-cloud-add：去掉 [组名]/[1080P] 等标签，截断到集数标记，兼容 SxxExx / EP07 / 第7话 / [07] / 独立 07
// @note   - 处理方式可在菜单里切换：按番剧归类（默认）/ 仅去掉文件夹 / 不处理
// @note   - 「🧹 整理当前目录」升级为同剧归类：单集文件夹 + 已经散落的文件都会归到对应番剧文件夹
// @note   - 上一版：MutationObserver 注入、Token 自动同步、提交串行化、接口多路径回退
// ==/UserScript==

(function () {
    'use strict';

    /* ============================================================
     * 0. 常量
     * ============================================================ */
    const API = 'https://api.123278.com';
    const API_WEB = 'https://www.123pan.cn';
    const API_YUN = 'https://yun.123pan.cn';
    const HOME = 'https://yun.123pan.cn/';

    const KEY = {
        token: '123_token',
        mode: '123_post_mode',          // series=按番剧归类 / flat=只去掉文件夹 / off=不处理
        flatten: '123_flatten_enabled', // 旧版开关，仅用于迁移
        queue: '123_flatten_queue',
        recent: '123_recent',
        debug: '123_debug',
    };

    const HOST = location.hostname;
    const PATH = location.pathname;
    const IS_123PAGE = /(^|\.)123pan\.(cn|com)$/i.test(HOST);

    const VIDEO_RE = /\.(mkv|mp4|avi|rmvb|wmv|mov|m4v|ts|m2ts|flv|webm|iso|mpg|mpeg|3gp)$/i;
    const QUEUE_TTL = 48 * 3600 * 1000;   // 待整理任务最长保留 48 小时
    const TASK_SUCCESS = 2;
    const TASK_FAILED = 1;

    /* ============================================================
     * 1. 小工具
     * ============================================================ */
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function log() {
        if (!GM_getValue(KEY.debug, false)) return;
        try { console.log('%c[123pan]', 'color:#667eea;font-weight:bold', ...arguments); } catch (e) {}
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    function clip(s, n) {
        s = String(s == null ? '' : s);
        n = n || 36;
        return s.length > n ? s.slice(0, n) + '…' : s;
    }

    function fmtSize(bytes) {
        const n = Number(bytes) || 0;
        if (n <= 0) return '';
        const u = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0, v = n;
        while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
        return (v >= 100 ? v.toFixed(0) : v.toFixed(i ? 2 : 0)) + u[i];
    }

    function normName(s) {
        return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    }

    // 文件夹名比对：允许 "(1)" 后缀、首尾空白、以及互相包含（内容还会二次校验）
    function nameMatch(a, b) {
        const x = normName(a), y = normName(b);
        if (!x || !y) return false;
        if (x === y) return true;
        const strip = (s) => s.replace(/\s*\(\d+\)$/, '').replace(/[.。]$/, '');
        if (strip(x) === strip(y)) return true;
        if (x.length >= 8 && y.length >= 8 && (x.indexOf(y) !== -1 || y.indexOf(x) !== -1)) return true;
        return false;
    }

    /* ============================================================
     * 2. 样式 / Toast
     * ============================================================ */
    const ICONS = {
        cloud: '<svg viewBox="0 0 24 24"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>',
        check: '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
    };

    const style = document.createElement('style');
    style.textContent = `
    .btn-123-save {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        margin-left: 6px !important;
        padding: 2px 8px !important;
        font-size: 12px !important;
        font-weight: 600 !important;
        color: #fff !important;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%) !important;
        border: none !important;
        border-radius: 4px !important;
        cursor: pointer !important;
        text-decoration: none !important;
        vertical-align: middle !important;
        line-height: 1.5 !important;
        box-shadow: 0 2px 4px rgba(102, 126, 234, 0.3) !important;
        transition: transform .15s ease, box-shadow .15s ease, filter .15s ease !important;
        white-space: nowrap !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
    }
    .btn-123-save:hover { transform: translateY(-1px) !important; box-shadow: 0 4px 8px rgba(102,126,234,.5) !important; filter: brightness(1.15) !important; }
    .btn-123-save:active { transform: translateY(0) !important; }
    .btn-123-save[disabled] { background: #95a5a6 !important; background-image: none !important; cursor: not-allowed !important; opacity: .75 !important; transform: none !important; box-shadow: none !important; }
    .btn-123-save.ok { background: #00b894 !important; background-image: none !important; }
    .btn-123-icon { margin-right: 4px; }

    #one23-float-container {
        position: fixed; bottom: 80px; right: 40px; z-index: 2147483000;
        display: flex; flex-direction: column; align-items: center; gap: 10px;
        transition: opacity .4s ease, transform .4s ease;
    }
    #one23-float-container.hiding { opacity: 0; transform: translateY(20px); pointer-events: none; }
    #btn-123-token-update, #btn-123-clean {
        width: 56px; height: 56px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; border: 1px solid rgba(255,255,255,.18);
        box-shadow: 0 8px 32px 0 rgba(31,38,135,.37);
        transition: transform .25s, background .25s;
        user-select: none;
    }
    #btn-123-token-update { background: rgba(52,152,219,.88); backdrop-filter: blur(5px); color: #fff; }
    #btn-123-token-update:hover { transform: scale(1.08); background: rgba(41,128,185,.95); }
    #btn-123-token-update.success { background: #2ecc71 !important; cursor: default; }
    #btn-123-clean { background: rgba(155,89,182,.85); backdrop-filter: blur(5px); color: #fff; font-size: 26px; }
    #btn-123-clean:hover { transform: scale(1.08); background: rgba(142,68,173,.95); }
    #btn-123-close {
        width: 24px; height: 24px; background: rgba(0,0,0,.3); color: #fff;
        border-radius: 50%; display: flex; align-items: center; justify-content: center;
        cursor: pointer; font-size: 14px; line-height: 1; opacity: .6; transition: all .2s;
    }
    #btn-123-close:hover { background: rgba(231,76,60,.85); opacity: 1; transform: scale(1.1); }
    .fab-icon svg { width: 28px; height: 28px; fill: #fff; }

    #one23-toast {
        position: fixed; top: 15%; left: 50%; transform: translateX(-50%) scale(.94);
        max-width: min(520px, 86vw);
        padding: 11px 20px; background: rgba(33,37,41,.92); backdrop-filter: blur(4px);
        color: #fff; border-radius: 12px; z-index: 2147483647;
        font: 500 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        opacity: 0; visibility: hidden; transition: opacity .25s, transform .25s, visibility .25s;
        pointer-events: none; box-shadow: 0 10px 30px rgba(0,0,0,.25);
        word-break: break-all; text-align: left;
    }
    #one23-toast.show { opacity: 1; visibility: visible; transform: translateX(-50%) scale(1); pointer-events: auto; }
    #one23-toast a { color: #7fd3ff; text-decoration: underline; }
    `;

    function mountStyle() {
        (document.head || document.documentElement).appendChild(style);
    }

    let toastEl = null;
    let toastTimer = 0;

    function showToast(html, duration) {
        if (!document.body) { setTimeout(function () { showToast(html, duration); }, 200); return; }
        if (!toastEl || !document.documentElement.contains(toastEl)) {
            toastEl = document.createElement('div');
            toastEl.id = 'one23-toast';
            document.body.appendChild(toastEl);
        }
        toastEl.innerHTML = html;
        toastEl.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toastEl && toastEl.classList.remove('show'); }, duration || 3000);
    }

    /* ============================================================
     * 3. Token
     * ============================================================ */
    function getToken() {
        const t = GM_getValue(KEY.token, '');
        return typeof t === 'string' ? t.replace(/^Bearer\s+/i, '').trim() : '';
    }

    // 从 123 云盘页面 localStorage 里尽量挖出登录 Token
    function readTokenFromPage() {
        const clean = function (v) { return String(v || '').replace(/^Bearer\s+/i, '').trim(); };
        try {
            const direct = ['authorToken', 'token', 'access_token', 'Authorization', 'authorization'];
            for (const k of direct) {
                const v = clean(localStorage.getItem(k));
                if (v && v.length > 50) return v;
            }
            for (const k of ['userInfo', 'userinfo', 'USER_INFO', 'user']) {
                try {
                    const o = JSON.parse(localStorage.getItem(k) || 'null');
                    if (!o) continue;
                    for (const f of ['token', 'authorToken', 'Token', 'accessToken', 'access_token']) {
                        const v = clean(o[f]);
                        if (v && v.length > 50) return v;
                    }
                } catch (e) {}
            }
            // 兜底：扫描形似 JWT 且 key 名相关的项
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i) || '';
                if (!/token|auth|user/i.test(k)) continue;
                const v = clean(localStorage.getItem(k));
                if (v && v.length > 60 && v.split('.').length === 3) return v;
            }
        } catch (e) {}
        return '';
    }

    /* ============================================================
     * 4. 接口层
     * ============================================================ */
    function ApiError(kind, message) {
        const e = new Error(message || kind);
        e.kind = kind;
        return e;
    }

    function api(method, path, data, base) {
        return new Promise(function (resolve, reject) {
            const token = getToken();
            if (!token) return reject(ApiError('NO_TOKEN', '还没有 123 云盘登录 Token'));

            let url = (base || API) + path;
            let payload;
            if (method === 'GET') {
                if (data) {
                    const qs = new URLSearchParams();
                    Object.keys(data).forEach(function (k) {
                        const v = data[k];
                        if (v !== undefined && v !== null) qs.append(k, String(v));
                    });
                    const s = qs.toString();
                    if (s) url += (url.indexOf('?') === -1 ? '?' : '&') + s;
                }
            } else if (data !== undefined) {
                payload = JSON.stringify(data);
            }

            log('→', method, url, data);

            GM_xmlhttpRequest({
                method: method,
                url: url,
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'App-Version': '3',
                    'platform': 'web',
                    'Content-Type': 'application/json;charset=UTF-8',
                    'Origin': 'https://yun.123pan.cn',
                    'Referer': 'https://yun.123pan.cn/'
                },
                data: payload,
                timeout: 30000,
                onload: function (res) {
                    log('←', res.status, url, String(res.responseText || '').slice(0, 500));
                    let json = null;
                    try { json = JSON.parse(res.responseText); } catch (e) {}
                    if (res.status === 401 || (json && json.code === 401)) {
                        return reject(ApiError('TOKEN_EXPIRED', '123 云盘登录状态已失效'));
                    }
                    if (!json) return reject(ApiError('BAD_RESPONSE', '接口返回异常（HTTP ' + res.status + '）'));
                    resolve(json);
                },
                onerror: function () { reject(ApiError('NETWORK', '网络请求失败')); },
                ontimeout: function () { reject(ApiError('NETWORK', '网络请求超时')); }
            });
        });
    }

    async function apiOk(method, path, data, fallbackMsg) {
        const r = await api(method, path, data);
        if (!r || r.code !== 0) throw ApiError('BIZ', (r && r.message) || fallbackMsg || '请求失败');
        return r;
    }

    /**
     * 123 的文件接口在不同域名/前缀下都能通（/b/api、/a/api、/api），
     * 这里按顺序试，记住第一次成功的组合，之后优先用它。
     */
    const EP = {
        list: [
            [API, '/b/api/file/list/new'],
            [API, '/api/file/list/new'],
            [API_YUN, '/b/api/file/list/new'],
            [API_YUN, '/api/file/list/new']
        ],
        info: [
            [API, '/b/api/file/info'],
            [API, '/api/file/info'],
            [API_YUN, '/b/api/file/info']
        ],
        move: [
            [API, '/b/api/file/mod_pid'],
            [API_YUN, '/b/api/file/mod_pid'],
            [API_WEB, '/b/api/file/mod_pid']
        ],
        trash: [
            [API, '/b/api/file/trash'],
            [API, '/a/api/file/trash'],
            [API_YUN, '/b/api/file/trash'],
            [API_YUN, '/a/api/file/trash']
        ],
        mkdir: [
            [API, '/b/api/file/upload_request'],
            [API, '/a/api/file/upload_request'],
            [API_YUN, '/b/api/file/upload_request'],
            [API_YUN, '/a/api/file/upload_request']
        ]
    };

    const epCache = {};

    async function callAny(kind, method, data, fallbackMsg) {
        const all = EP[kind] || [];
        const cached = epCache[kind];
        const attempts = cached
            ? [cached].concat(all.filter(function (a) { return a !== cached; }))
            : all;

        let lastErr = null;
        for (const a of attempts) {
            let r = null, err = null;
            try {
                r = await api(method, a[1], data, a[0]);
            } catch (e) {
                err = e;
            }
            if (err) {
                if (err.kind === 'NO_TOKEN' || err.kind === 'TOKEN_EXPIRED') throw err;
                lastErr = err;
                log('接口不通，换备用地址', kind, a, err.kind);
                continue;
            }
            if (r && (r.code === 0 || r.code === 5007)) {
                epCache[kind] = a;
                return r;
            }
            if (r && (r.code === 404 || r.code === 500 || r.code === 4040)) {
                lastErr = ApiError('BIZ', r.message || fallbackMsg);
                continue;
            }
            throw ApiError('BIZ', (r && r.message) || fallbackMsg || '请求失败');
        }
        throw lastErr || ApiError('BIZ', fallbackMsg || '请求失败');
    }

    /* ---------- 离线下载 ---------- */

    async function resolveMagnet(magnet) {
        const r = await api('POST', '/b/api/v2/offline_download/task/resolve', { urls: magnet });
        if (!r || r.code !== 0) throw ApiError('RESOLVE', (r && r.message) || '磁力解析失败');
        const list = (r.data && r.data.list) || [];
        const info = list[0];
        if (!info) throw ApiError('RESOLVE', '解析结果为空');
        const result = info.result === undefined || info.result === null ? 0 : Number(info.result);
        const errCode = info.err_code === undefined || info.err_code === null ? 0 : Number(info.err_code);
        if (result !== 0 || errCode !== 0) {
            throw ApiError('RESOLVE', info.err_msg || ('解析失败（code ' + (errCode || result) + '）'));
        }
        return info;
    }

    async function submitTask(info) {
        const ids = (info.files || [])
            .map(function (f) { return f && f.id; })
            .filter(function (id) { return id !== undefined && id !== null; });
        if (!ids.length) throw ApiError('SUBMIT', '没有解析到可下载的文件');

        const r = await api('POST', '/b/api/v2/offline_download/task/submit', {
            resource_list: [{ resource_id: info.id, select_file_id: ids }]
        });
        if (!r || r.code !== 0) throw ApiError('SUBMIT', (r && r.message) || '提交离线任务失败');

        const task = ((r.data && r.data.task_list) || [])[0];
        if (!task) throw ApiError('SUBMIT', '提交离线任务失败（无任务号）');
        if (Number(task.result || 0) !== 0) throw ApiError('SUBMIT', '提交离线任务失败（result ' + task.result + '）');
        return { taskId: String(task.task_id), fileIds: ids };
    }

    async function fetchOfflineTasks() {
        const r = await apiOk('POST', '/b/api/offline_download/task/list', {
            current_page: 1,
            page_size: 100,
            status_arr: [0, 1, 2, 3, 4]
        }, '查询离线任务失败');
        return (r.data && r.data.list) || [];
    }

    /* ---------- 文件管理 ---------- */

    // 123 的文件接口新老字段大小写不太统一，这里统一成一种形状
    function pickField(obj, keys, dflt) {
        if (!obj) return dflt;
        for (let i = 0; i < keys.length; i++) {
            const v = obj[keys[i]];
            if (v !== undefined && v !== null && v !== '') return v;
        }
        return dflt;
    }

    function normFileItem(it) {
        if (!it || typeof it !== 'object') return null;
        const typeRaw = pickField(it, ['Type', 'type', 'FileType', 'fileType'], 0);
        let type = Number(typeRaw);
        if (!isFinite(type)) {
            type = String(typeRaw).toLowerCase().indexOf('folder') !== -1 ? 1 : 0;
        }
        return {
            FileId: Number(pickField(it, ['FileId', 'fileId', 'id'], 0)) || 0,
            FileName: String(pickField(it, ['FileName', 'fileName', 'name'], '')),
            Type: type,
            Size: Number(pickField(it, ['Size', 'size', 'FileSize', 'fileSize'], 0)) || 0,
            ParentFileId: Number(pickField(it, ['ParentFileId', 'parentFileId', 'parentId'], 0)) || 0,
            CreateAt: Number(pickField(it, ['CreateAt', 'createAt', 'createTime'], 0)) || 0
        };
    }

    function normList(list) {
        return (Array.isArray(list) ? list : []).map(normFileItem).filter(function (x) { return !!x; });
    }

    async function listDir(parentId) {
        const pid = String(parentId == null ? 0 : parentId);
        const out = [];
        let next = 0;

        // 目录条目可能很多，翻几页，避免“同名番剧文件夹在第 2 页”时重复新建
        for (let page = 1; page <= 3; page++) {
            const r = await callAny('list', 'GET', {
                driveId: 0,
                limit: 100,
                next: next,
                orderBy: 'file_id',
                orderDirection: 'desc',
                parentFileId: pid,
                trashed: 'false',
                SearchData: '',
                Page: page,
                OnlyLookAbnormalFile: 0
            }, '读取目录失败');

            if (r.code === 5007) break;
            const batch = normList(r.data && r.data.InfoList);
            out.push.apply(out, batch);
            if (batch.length < 100) break;

            const rawNext = r.data && (r.data.Next != null ? r.data.Next : r.data.next);
            const marker = Number(rawNext);
            if (!isFinite(marker) || marker <= 0) break;  // -1 / 0 = 没有下一页
            next = marker;
        }
        return out;
    }

    async function searchFiles(keyword) {
        if (!keyword) return [];
        try {
            const r = await callAny('list', 'GET', {
                driveId: 0,
                limit: 50,
                next: 0,
                parentFileId: '0',
                trashed: 'false',
                SearchData: keyword,
                Page: 1,
                OnlyLookAbnormalFile: 0
            }, '搜索失败');
            if (r.code === 5007) return [];
            return normList(r.data && r.data.InfoList);
        } catch (e) {
            if (e && (e.kind === 'NO_TOKEN' || e.kind === 'TOKEN_EXPIRED')) throw e;
            log('搜索失败', e);
            return [];
        }
    }

    async function getFileInfo(ids) {
        if (!ids || !ids.length) return [];
        const r = await callAny('info', 'POST', { fileIdList: ids.map(Number) }, '读取文件信息失败');
        return normList(r.data && (r.data.infoList || r.data.InfoList));
    }

    async function moveFiles(fileIds, parentId) {
        await callAny('move', 'POST', {
            fileIdList: fileIds.map(function (id) { return { FileId: Number(id) }; }),
            parentFileId: Number(parentId || 0)
        }, '移动文件失败');
    }

    async function trashFiles(fileIds) {
        const ids = fileIds.map(function (id) { return { FileId: Number(id) }; });
        try {
            await callAny('trash', 'POST', {
                RequestSource: null,
                driveId: 0,
                event: 'intoRecycle',
                fileTrashInfoList: ids,
                operatePlace: 1,
                operation: true
            }, '删除文件夹失败');
        } catch (e) {
            if (e && (e.kind === 'NO_TOKEN' || e.kind === 'TOKEN_EXPIRED')) throw e;
            log('回收站接口重试（精简参数）', e);
            await callAny('trash', 'POST', {
                driveId: 0,
                fileTrashInfoList: ids,
                operation: true
            }, '删除文件夹失败');
        }
    }

    /* ---------- 文件夹：查重 / 新建 ---------- */

    async function createFolder(parentId, name) {
        const pid = Number(parentId || 0);
        const full = {
            driveId: 0,
            etag: '',
            fileName: name,
            parentFileId: pid,
            size: 0,
            type: 1,
            duplicate: 1,
            NotReuse: true,
            event: 'newCreateFolder',
            operateType: 1
        };
        let r = null;
        try {
            r = await callAny('mkdir', 'POST', full, '创建文件夹失败');
        } catch (e) {
            if (e && (e.kind === 'NO_TOKEN' || e.kind === 'TOKEN_EXPIRED')) throw e;
            log('建目录精简参数重试', e);
            r = await callAny('mkdir', 'POST', {
                driveId: 0, etag: '', fileName: name, parentFileId: pid, size: 0, type: 1, duplicate: 1
            }, '创建文件夹失败');
        }

        const info = (r && r.data && (r.data.Info || r.data.info)) || {};
        const fid = Number(pickField(info, ['FileId', 'fileId', 'id'], 0));
        if (fid > 0) return fid;

        // 接口没回 ID 就回查一次
        const kids = await listDir(pid);
        const hit = kids.filter(function (k) {
            return Number(k.Type) === 1 && k.FileName === name;
        })[0];
        if (hit) return hit.FileId;
        throw ApiError('BIZ', '创建文件夹失败：' + name);
    }

    // 有同名文件夹就复用，没有就建一个
    async function ensureFolder(parentId, name) {
        const pid = Number(parentId || 0);
        const kids = await listDir(pid);
        const hit = kids.filter(function (k) {
            return Number(k.Type) === 1 && k.FileName === name;
        })[0];
        if (hit) return hit.FileId;

        const id = await createFolder(pid, name);
        log('新建番剧文件夹', name, '→', id);
        return id;
    }

    /* ============================================================
     * 5. 番剧名识别 + 单集去文件夹 / 归类
     * ============================================================ */

    function getMode() {
        const m = GM_getValue(KEY.mode, '');
        if (m === 'series' || m === 'flat' || m === 'off') return m;
        // 从旧版「单集自动去文件夹」开关迁移
        const legacy = GM_getValue(KEY.flatten, true);
        return legacy === false ? 'off' : 'series';
    }

    function setMode(mode) {
        GM_setValue(KEY.mode, mode);
        GM_setValue(KEY.flatten, mode !== 'off'); // 兼容旧版读取处
    }

    function flattenEnabled() {
        return getMode() !== 'off';
    }

    function organizeEnabled() {
        return getMode() === 'series';
    }

    /* ---------- 番剧名识别（借鉴 guangya-magnet-cloud-add 的思路） ---------- */

    // Windows / 123 都能用的目录名
    function sanitizeDirName(name) {
        let text = String(name == null ? '' : name)
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
            .replace(/\s+/g, ' ')
            .replace(/[. ]+$/, '')
            .trim();
        if (text.length > 100) text = text.slice(0, 100).trim();
        return text;
    }

    const BRACKET_SEG = /[\[【]([^\]】]*)[\]】]/g;
    const QUALITY_SEG = /^(?:\d{3,4}[pi]|\d{3,4}x\d{3,4}|4k|8k|web-?dl|webrip|bdrip|blu-?ray|bd|hevc|h\.?26[45]|x26[45]|avc|aac|flac|ac3|eac3|opus|10bit|8bit|hi10p?|chs|cht|gb|big5|jpsc|jptc|简体|繁体|简日|繁日|简繁|内封|内嵌|外挂|合集|mp4|mkv|ass|sc|tc)$/i;

    // 集数标记：SxxExx / EP07 / 第7话 / [07] / 独立 07
    function findEpisodeMarker(raw) {
        const s = String(raw || '');
        let best = null;
        const consider = function (idx) {
            if (idx < 0) return;
            if (!best || idx < best.index) best = { index: idx };
        };
        let m;
        const bracketNum = /[\[【]\s*(\d{1,3})(?:v\d+)?\s*[\]】]/g;
        while ((m = bracketNum.exec(s))) consider(m.index);
        const se = /\bS\d{1,2}\s*E\d{1,4}\b/gi;
        while ((m = se.exec(s))) consider(m.index);
        const ep = /\bEP?\s*\d{1,4}\b/gi;
        while ((m = ep.exec(s))) consider(m.index);
        const cn = /第\s*\d{1,4}\s*[话話集回]/g;
        while ((m = cn.exec(s))) consider(m.index);
        const bare = /(^|[\s._\-–—])(\d{1,3})(?:v\d+)?(?=$|[\s._\-–—\[\]【】()（）])/g;
        while ((m = bare.exec(s))) consider(m.index + m[1].length);
        return best;
    }

    function cleanTagSegment(text) {
        const t = String(text || '').replace(/\s+/g, ' ').trim();
        if (!t) return '';
        if (/^\d{1,4}(?:v\d+)?$/.test(t)) return '';   // [07]
        if (QUALITY_SEG.test(t)) return '';             // [1080P] [WEB-DL]
        return t;
    }

    // 从种子名 / 文件名里拆出「番剧名」以及是否单集
    function detectSeries(rawName) {
        const raw = String(rawName || '').replace(/\.[A-Za-z0-9]{1,8}$/, '');
        const marker = findEpisodeMarker(raw);
        const head = marker ? raw.slice(0, marker.index) : raw;

        // 优先用方括号之外的文字
        let plain = head.replace(BRACKET_SEG, ' ');
        plain = plain.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
        plain = plain.replace(/^[\s\-–—_.]+|[\s\-–—_.]+$/g, '').trim();
        if (plain.length >= 2) return { name: sanitizeDirName(plain), hasEpisode: !!marker };

        // 整段都被方括号包住时（[组][番名][01] 这种），从括号段里挑
        BRACKET_SEG.lastIndex = 0;
        const segs = [];
        let m;
        while ((m = BRACKET_SEG.exec(head))) {
            const t = cleanTagSegment(m[1]);
            if (t) segs.push(t);
        }
        if (!segs.length) return { name: '', hasEpisode: !!marker };
        const parts = segs.length > 1 ? segs.slice(1) : segs;  // 第一段通常是字幕组
        const name = sanitizeDirName(parts.join(' '));
        return { name: name.length >= 2 ? name : '', hasEpisode: !!marker };
    }

    // 该文件名对应的番剧文件夹名；不是单集（电影、合集包）就返回空，保持平铺
    function seriesDirName(rawName) {
        const info = detectSeries(rawName);
        if (!info.hasEpisode || !info.name) return '';
        let name = info.name;
        const m = /\bS(\d{1,2})\s*E\d{1,4}\b/i.exec(String(rawName || ''));
        if (m && Number(m[1]) >= 2) {
            const tag = 'S' + String(Number(m[1])).padStart(2, '0');
            if (!new RegExp('(^|\\s)' + tag + '(\\s|$)', 'i').test(name)) name += ' ' + tag;
        }
        return sanitizeDirName(name);
    }

    function jobFromResolve(info, taskId) {
        const files = Array.isArray(info.files) ? info.files : [];
        const leaves = files.filter(function (f) { return f && Number(f.file_type) === 0; });
        const leaf = leaves.length === 1 ? leaves[0] : null;
        return {
            taskId: String(taskId),
            name: String(info.name || (leaf && leaf.name) || ''),
            totalSize: Number(info.size || 0),
            leafName: leaf ? String(leaf.name || '') : '',
            leafSize: leaf ? Number(leaf.size || 0) : 0,
            createdAt: Date.now(),
            retries: 0,
            misses: 0
        };
    }

    function loadQueue() {
        try {
            const v = JSON.parse(GM_getValue(KEY.queue, '[]'));
            return Array.isArray(v) ? v : [];
        } catch (e) { return []; }
    }

    function saveQueue(q) {
        GM_setValue(KEY.queue, JSON.stringify((q || []).slice(-30)));
    }

    function enqueueFlatten(job) {
        const q = loadQueue().filter(function (j) { return String(j.taskId) !== String(job.taskId); });
        q.push(job);
        saveQueue(q);
        log('已加入待整理队列', job);
    }

    // 判断一个文件夹是否“单集”：没有子文件夹、文件不多、最多一个视频
    // strict=true 用于“按时间猜”的兜底候选，必须能证实文件属于本任务才允许拆
    function flattenable(kids, job, strict) {
        if (!Array.isArray(kids) || !kids.length) return false;
        if (kids.some(function (k) { return Number(k.Type) === 1; })) return false;
        const files = kids.filter(function (k) { return Number(k.Type) === 0; });
        if (!files.length || files.length > 3) return false;
        const videos = files.filter(function (f) { return VIDEO_RE.test(f.FileName || ''); });
        if (videos.length > 1) return false;
        if (!job) return true;
        const nameHit = files.some(function (f) { return job.leafName && f.FileName === job.leafName; });
        const sizeHit = job.totalSize > 0 && files.some(function (f) { return Number(f.Size) === job.totalSize; });
        if (nameHit || sizeHit) return true;
        if (strict) return false;
        return files.length === 1;
    }

    function fileMatchesJob(f, job) {
        const name = String(f.FileName || '');
        if (job.leafName && name === job.leafName) return true;
        if (job.totalSize > 0 && Number(f.Size) === job.totalSize) return true;
        if (job.name && nameMatch(name, job.name)) return true;
        return false;
    }

    let btDirCache = { at: 0, ids: [] };

    // 123 的离线下载默认落在「来自: BT磁力下载」这类目录里，这里把它找出来作为兜底
    async function offlineDirs() {
        if (btDirCache.ids.length && Date.now() - btDirCache.at < 10 * 60 * 1000) return btDirCache.ids;
        const ids = [];
        const push = function (it) {
            if (it && Number(it.Type) === 1 && ids.indexOf(it.FileId) === -1) ids.push(it.FileId);
        };
        for (const kw of ['BT磁力下载', '离线下载']) {
            try {
                const items = await searchFiles(kw);
                items.forEach(push);
            } catch (e) {}
        }
        if (!ids.length) {
            try {
                const root = await listDir(0);
                root.forEach(function (it) {
                    if (/磁力|离线|BT/i.test(it.FileName || '')) push(it);
                });
            } catch (e) {}
        }
        btDirCache = { at: Date.now(), ids: ids };
        return ids;
    }

    /**
     * 尝试把一个已下载完成的单集任务“解包”。
     * 返回 'done'（已整理）/ 'noop'（多集，不动）/ 'retry'（还没找到，稍后再试）
     */
    async function flattenJob(job) {
        const candidates = [];
        let items = [];
        let fromSearch = true;

        try { items = await searchFiles(job.name); } catch (e) { log('搜索失败', e); }
        if (!items.length) {
            fromSearch = false;
            try { items = await listDir(0); } catch (e) {}
        }

        // 已经是散装文件
        if (items.some(function (it) {
            return Number(it.Type) === 0 && fileMatchesJob(it, job) && Number(it.ParentFileId || 0) === 0;
        })) return 'done';

        // 1) 搜索命中的同名文件夹
        items.forEach(function (it) {
            if (Number(it.Type) === 1 && nameMatch(it.FileName, job.name)) {
                candidates.push({
                    id: it.FileId,
                    parent: Number(it.ParentFileId || 0),
                    size: Number(it.Size || 0),
                    src: fromSearch ? 'search' : 'root',
                    strict: false
                });
            }
        });

        // 2) 搜索命中文件夹里的文件 → 用父目录当候选
        if (!candidates.length) {
            const inner = items.find(function (it) {
                return Number(it.Type) === 0 && fileMatchesJob(it, job) && Number(it.ParentFileId || 0) > 0;
            });
            if (inner) {
                candidates.push({ id: Number(inner.ParentFileId), parent: 0, size: 0, needInfo: true, src: 'inner', strict: false });
            }
        }

        // 3) 兜底：在离线下载目录里按名字/时间找（必须能核实文件归属，见下面的 strict）
        if (!candidates.length) {
            const dirs = await offlineDirs();
            for (const d of dirs) {
                let listing = [];
                try { listing = await listDir(d); } catch (e) { continue; }
                listing.forEach(function (it) {
                    if (Number(it.Type) !== 1) return;
                    const byName = nameMatch(it.FileName, job.name);
                    const byTime = it.CreateAt && Number(it.CreateAt) * 1000 >= job.createdAt - 5 * 60 * 1000;
                    if (byName || byTime) {
                        candidates.push({
                            id: it.FileId,
                            parent: Number(it.ParentFileId || d),
                            size: Number(it.Size || 0),
                            src: 'bt',
                            strict: true
                        });
                    }
                });
            }
            if (candidates.length > 8) candidates.length = 8;
        }

        if (!candidates.length) return 'retry';

        let sawChildren = false;

        for (const c of candidates) {
            let kids = [];
            try { kids = await listDir(c.id); } catch (e) { continue; }
            if (kids.length) sawChildren = true;

            // 按时间猜的候选：文件夹总大小必须和任务大小一致，避免拆错同时下载的别的任务
            if (c.strict && c.size > 0 && job.totalSize > 0 && c.size !== job.totalSize) {
                log('大小不符，跳过候选', c.id, c.size, job.totalSize);
                continue;
            }
            if (!flattenable(kids, job, c.strict)) continue;

            let parent = c.parent;
            // 父目录未知（例如搜索命中的结果不带 ParentFileId）时查一下，避免把文件挪到错误的位置
            if (!parent && (c.needInfo || c.src !== 'root')) {
                try {
                    const info = await getFileInfo([c.id]);
                    const p = Number((info[0] && info[0].ParentFileId) || 0);
                    if (c.needInfo || p) parent = p;
                } catch (e) { log('读取父目录失败', e); }
            }

            const files = kids.filter(function (k) { return Number(k.Type) === 0; });

            // 归类：优先放进「番剧名」文件夹（没有就建），失败则退回原来的平铺
            let target = parent;
            let seriesName = '';
            if (organizeEnabled()) {
                seriesName = seriesDirName(job.name || (kids[0] && kids[0].FileName) || '');
                if (seriesName) {
                    try {
                        target = await ensureFolder(parent, seriesName);
                    } catch (e) {
                        log('创建番剧文件夹失败，退回平铺', e);
                        seriesName = '';
                        target = parent;
                    }
                }
            }

            try {
                await moveFiles(files.map(function (f) { return f.FileId; }), target);
            } catch (e) { log('移出文件失败', e); continue; }

            try { await trashFiles([c.id]); } catch (e) { log('删除空文件夹失败（不影响文件）', e); }
            job.seriesName = seriesName;
            log('已整理', job.name, '→', target, seriesName);
            return 'done';
        }

        return sawChildren ? 'noop' : 'retry';
    }

    let queueBusy = false;
    let taskListFails = 0;

    async function processQueue(quiet) {
        if (queueBusy) return;
        if (!flattenEnabled()) {
            if (loadQueue().length) saveQueue([]);
            return;
        }
        const queue = loadQueue();
        if (!queue.length) return;
        if (!getToken()) return;

        queueBusy = true;
        try {
            const tasks = await fetchOfflineTasks();
            taskListFails = 0;
            const map = new Map(tasks.map(function (t) { return [String(t.task_id), t]; }));
            const now = Date.now();
            const keep = [];

            for (const job of queue) {
                if (!job || !job.taskId) continue;
                if (now - Number(job.createdAt || 0) > QUEUE_TTL) continue;

                const t = map.get(String(job.taskId));
                if (!t) {
                    job.misses = (job.misses || 0) + 1;
                    if (job.misses <= 30) keep.push(job);
                    continue;
                }

                const status = Number(t.status);
                if (status === TASK_FAILED) {
                    if (!quiet) showToast('❌ 离线下载失败：' + esc(clip(job.name || ('#' + job.taskId), 30)), 4200);
                    continue;
                }
                if (status === TASK_SUCCESS) {
                    let r = 'retry';
                    try {
                        r = await flattenJob(job);
                        job.errs = 0;
                    } catch (e) {
                        log('整理异常', e);
                        job.errs = (job.errs || 0) + 1;
                        if (job.errs === 3) {
                            showToast(
                                '⚠️ 自动去文件夹没成功：' + esc((e && (e.message || e.kind)) || '接口异常') +
                                '<br><small>文件仍在云盘里，可在脚本菜单开启调试日志排查</small>',
                                6000
                            );
                        }
                    }
                    if (r === 'done') {
                        showToast(
                            job.seriesName
                                ? '📚 已归类到「' + esc(clip(job.seriesName, 24)) + '」<br><small>' + esc(clip(job.name || '', 34)) + '</small>'
                                : '🧹 已去掉单集文件夹：' + esc(clip(job.name || ('#' + job.taskId), 30)),
                            4200
                        );
                        continue;
                    }
                    if (r === 'retry') {
                        job.retries = (job.retries || 0) + 1;
                        if (job.retries <= 20) keep.push(job);
                        continue;
                    }
                    continue; // noop：多集任务，保持文件夹
                }
                keep.push(job); // 仍在下载/排队
            }

            saveQueue(keep);
        } catch (e) {
            log('处理待整理队列失败', e);
            taskListFails++;
            if (taskListFails === 3) {
                showToast('⚠️ 查询离线任务失败：' + esc((e && (e.message || e.kind)) || '接口异常'), 5000);
            }
        } finally {
            queueBusy = false;
        }
    }

    let queueTicker = null;

    function stopQueueTicker() {
        if (queueTicker) { clearInterval(queueTicker); queueTicker = null; }
    }

    function ensureQueueTicker() {
        if (queueTicker) return;
        const tick = function () {
            if (!loadQueue().length) { stopQueueTicker(); return; }
            if (document.hidden) return;
            processQueue(false);
        };
        queueTicker = setInterval(tick, 45000);
        setTimeout(tick, 6000);
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden && loadQueue().length) processQueue(false);
        });
    }

    /* ============================================================
     * 6. 手动整理：把当前 123 目录里的单集归到「番剧名」文件夹
     * ============================================================ */
    async function runCleanup() {
        if (!getToken()) {
            showToast('❌ 还没有 123 云盘登录状态，请先打开 123 云盘页面同步', 4200);
            return;
        }
        const dirId = currentDirId();
        showToast('⏳ 正在扫描当前目录…', 4000);

        let items = [];
        try { items = await listDir(dirId); } catch (e) {
            showToast('❌ ' + esc(e.message || '读取目录失败'), 4200);
            return;
        }

        const folders = items.filter(function (it) { return Number(it.Type) === 1; });
        const files = items.filter(function (it) { return Number(it.Type) === 0; });
        const withSeries = organizeEnabled();

        // 1) 单集文件夹
        const limited = folders.slice(0, 80);
        const folderPlans = [];
        for (let i = 0; i < limited.length; i++) {
            const f = limited[i];
            let kids = [];
            try { kids = await listDir(f.FileId); } catch (e) { continue; }
            if (!flattenable(kids, null)) continue;
            folderPlans.push({
                folder: f,
                kids: kids,
                series: withSeries
                    ? seriesDirName(f.FileName || (kids[0] && kids[0].FileName) || '')
                    : ''
            });
            if (i % 10 === 9) {
                showToast('⏳ 扫描中 ' + (i + 1) + '/' + limited.length, 1500);
                await sleep(300);
            }
        }

        // 2) 已经散落在目录里的剧集文件：同一部剧 ≥2 集才单独建文件夹
        const looseGroups = new Map();
        if (withSeries) {
            files.forEach(function (f) {
                if (!VIDEO_RE.test(f.FileName || '')) return;
                const s = seriesDirName(f.FileName || '');
                if (!s) return;
                if (!looseGroups.has(s)) looseGroups.set(s, []);
                looseGroups.get(s).push(f);
            });
            Array.from(looseGroups.keys()).forEach(function (k) {
                if (looseGroups.get(k).length < 2) looseGroups.delete(k);
            });
        }

        if (!folderPlans.length && !looseGroups.size) {
            showToast(withSeries ? '当前目录里没有可归类的单集' : '当前目录里没有可整理的单集文件夹');
            return;
        }

        const seriesSet = new Set();
        folderPlans.forEach(function (p) { if (p.series) seriesSet.add(p.series); });
        looseGroups.forEach(function (v, k) { seriesSet.add(k); });

        const total = folderPlans.length + looseGroups.size;
        const summary = [];
        if (folderPlans.length) summary.push('· ' + folderPlans.length + ' 个单集文件夹');
        if (looseGroups.size) summary.push('· ' + looseGroups.size + ' 组散装剧集文件');
        if (withSeries) summary.push('→ 归入 ' + seriesSet.size + ' 个番剧文件夹（没有的自动新建）');

        const ok = confirm(
            '在「当前目录」里发现：\n' + summary.join('\n') + '\n\n' +
            (withSeries
                ? '会把文件移进对应番剧文件夹，并删除搬空的原文件夹（文件不会删除）。\n'
                : '会把文件移到当前目录，并删除搬空的原文件夹（文件不会删除）。\n') +
            (folders.length > limited.length ? '\n注意：目录文件夹较多，只扫描前 80 个。\n' : '') +
            '\n继续？'
        );
        if (!ok) return;

        let done = 0, fileCount = 0;

        async function moveInto(series, ids) {
            let target = dirId;
            if (series) target = await ensureFolder(dirId, series);
            await moveFiles(ids, target);
            fileCount += ids.length;
            return target;
        }

        for (const p of folderPlans) {
            try {
                await moveInto(p.series, p.kids.map(function (k) { return k.FileId; }));
                try { await trashFiles([p.folder.FileId]); } catch (e) { log('删除空文件夹失败', e); }
                done++;
                showToast(
                    '📚 归类中 ' + done + '/' + total + '<br>' +
                    esc(clip(p.series || p.folder.FileName, 40)),
                    2000
                );
                await sleep(450);
            } catch (e) {
                log('归类失败', p.folder && p.folder.FileName, e);
            }
        }

        // 散装文件：连同同名字幕一起移走
        for (const [series, list] of looseGroups) {
            const ids = new Set();
            list.forEach(function (v) {
                ids.add(v.FileId);
                const base = String(v.FileName || '').replace(/\.[^.]+$/, '');
                files.forEach(function (f) {
                    if (VIDEO_RE.test(f.FileName || '')) return;
                    if (String(f.FileName || '').replace(/\.[^.]+$/, '') === base) ids.add(f.FileId);
                });
            });
            try {
                await moveInto(series, Array.from(ids));
                done++;
                showToast('📚 归类中 ' + done + '/' + total + '<br>' + esc(clip(series, 40)), 2000);
                await sleep(450);
            } catch (e) {
                log('归类散装文件失败', series, e);
            }
        }

        showToast(
            '✅ 归类完成：' + done + ' 组，' + fileCount + ' 个文件' +
            (withSeries ? '，刷新页面即可看到' : ''),
            5000
        );
    }

    function currentDirId() {
        let v = '';
        try {
            v = new URLSearchParams(location.search).get('homeFilePath') || '';
            if (!v && location.hash) {
                const m = /homeFilePath=(\d+)/.exec(location.hash);
                if (m) v = m[1];
            }
        } catch (e) {}
        const n = Number(v || 0);
        return Number.isFinite(n) ? n : 0;
    }

    /* ============================================================
     * 7. 123 云盘页面：Token 自动同步 + 悬浮按钮
     * ============================================================ */
    function autoSyncToken(silent) {
        const t = readTokenFromPage();
        if (!t) return false;
        if (getToken() !== t) {
            GM_setValue(KEY.token, t);
            log('Token 已自动同步');
            if (!silent) showToast('✅ 已自动同步 123 云盘登录状态', 2600);
        } else if (!silent) {
            showToast('✅ 登录状态已是最新', 2200);
        }
        return true;
    }

    function buildFloatUI() {
        if (document.getElementById('one23-float-container')) return;

        const box = document.createElement('div');
        box.id = 'one23-float-container';

        const ball = document.createElement('div');
        ball.id = 'btn-123-token-update';
        ball.title = '同步 123 云盘登录状态给转存按钮';
        ball.innerHTML = '<span class="fab-icon">' + ICONS.cloud + '</span>';

        const clean = document.createElement('div');
        clean.id = 'btn-123-clean';
        clean.title = '同剧归类：把当前目录的单集文件夹 / 散装文件归到「番剧名」文件夹';
        clean.textContent = '📚';

        const close = document.createElement('div');
        close.id = 'btn-123-close';
        close.title = '关闭悬浮按钮';
        close.textContent = '×';

        box.appendChild(ball);
        if (PATH === '/') box.appendChild(clean);   // 只在文件管理页给“整理本目录”按钮
        box.appendChild(close);
        (document.body || document.documentElement).appendChild(box);

        const markOk = function () {
            ball.classList.add('success');
            ball.innerHTML = '<span class="fab-icon">' + ICONS.check + '</span>';
        };
        const markIdle = function () {
            ball.classList.remove('success');
            ball.innerHTML = '<span class="fab-icon">' + ICONS.cloud + '</span>';
        };

        close.onclick = function (e) {
            if (e) e.stopPropagation();
            box.classList.add('hiding');
            setTimeout(function () { box.remove(); }, 400);
        };

        ball.onclick = function () {
            if (autoSyncToken(false)) {
                markOk();
                setTimeout(markIdle, 4000);
            } else {
                showToast('❌ 未检测到登录状态，请先登录 123 云盘');
            }
        };

        clean.onclick = function () {
            runCleanup().catch(function (e) {
                showToast('❌ ' + esc(e.message || '整理失败'), 4200);
            });
        };

        // 页面加载时静默同步（123 的登录态可能稍晚才写进 localStorage，这里重试几次）
        (function trySync(tries) {
            const before = getToken();
            if (autoSyncToken(true)) {
                if (getToken() !== before) showToast('✅ 已自动同步 123 云盘登录状态', 2600);
                markOk();
                setTimeout(markIdle, 4000);
                return;
            }
            if (tries > 0) setTimeout(function () { trySync(tries - 1); }, 2000);
        })(6);
    }

    /* ============================================================
     * 8. 磁力链接按钮注入
     * ============================================================ */
    function hashMagnet(magnet) {
        const m = /xt=urn:btih:([a-z0-9]+)/i.exec(magnet);
        if (m) return m[1].toLowerCase();
        let h = 0;
        const s = magnet.slice(0, 800);
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        return 'h' + (h >>> 0).toString(36);
    }

    function recentMap() {
        try {
            const v = JSON.parse(GM_getValue(KEY.recent, '{}'));
            return v && typeof v === 'object' ? v : {};
        } catch (e) { return {}; }
    }

    function markRecent(hash, name) {
        const m = recentMap();
        const now = Date.now();
        m[hash] = { name: String(name || ''), at: now };
        Object.keys(m).forEach(function (k) {
            if (now - Number((m[k] && m[k].at) || 0) > 3 * 86400000) delete m[k];
        });
        GM_setValue(KEY.recent, JSON.stringify(m));
    }

    function seenRecently(hash) {
        const e = recentMap()[hash];
        if (e && Date.now() - Number(e.at || 0) < 86400000) return e;
        return null;
    }

    function askAuth() {
        const ok = confirm(
            '需要 123 云盘登录状态。\n\n' +
            '点击【确定】打开 123 云盘，登录后本脚本会自动同步 Token，再回来点一次即可。'
        );
        if (ok) GM_openInTab(HOME, { active: true });
    }

    function handleError(e) {
        const kind = e && e.kind;
        if (kind === 'NO_TOKEN') {
            showToast('❌ 还没有 123 云盘登录状态', 4000);
            askAuth();
            return;
        }
        if (kind === 'TOKEN_EXPIRED') {
            showToast('⚠️ 123 云盘登录已失效，请重新同步', 4500);
            askAuth();
            return;
        }
        if (kind === 'CANCEL') return;
        showToast('❌ ' + esc((e && (e.message || e.kind)) || '未知错误'), 4500);
    }

    // 提交串行化：避免一次点很多按钮时把接口打爆
    let submitChain = Promise.resolve();
    function queueSubmit(fn) {
        const result = submitChain.then(fn, fn);
        submitChain = result.then(function () { return sleep(1200); }, function () { return sleep(1200); });
        return result;
    }

    async function handleSave(magnet, btn, ev) {
        if (ev) { ev.preventDefault(); ev.stopPropagation(); }
        if (btn.dataset.busy === '1') return;

        const original = btn.innerHTML;
        const setState = function (icon, text) {
            btn.innerHTML = '<span class="btn-123-icon">' + icon + '</span> ' + text;
        };

        btn.dataset.busy = '1';
        btn.disabled = true;

        try {
            const hash = hashMagnet(magnet);
            const recent = seenRecently(hash);
            if (recent) {
                const again = confirm(
                    '这个磁力最近已经提交过了' +
                    (recent.name ? '：\n「' + clip(recent.name, 40) + '」' : '') +
                    '\n\n还要再提交一次吗？'
                );
                if (!again) throw ApiError('CANCEL', '已取消');
            }

            setState('⏳', '解析…');
            const info = await resolveMagnet(magnet);

            setState('🚀', '提交…');
            const result = await queueSubmit(function () { return submitTask(info); });

            markRecent(hash, info.name);

            const mode = getMode();
            if (mode !== 'off' && result.taskId) {
                enqueueFlatten(jobFromResolve(info, result.taskId));
                ensureQueueTicker();
            }

            setState('✅', '已提交');
            btn.classList.add('ok');
            showToast(
                '🎉 已提交离线下载' + (info.size ? '（' + fmtSize(info.size) + '）' : '') +
                (mode === 'series'
                    ? '<br><small>下载完成后会按番剧名归类到同一个文件夹</small>'
                    : mode === 'flat'
                        ? '<br><small>下载完成后会去掉单集的外层文件夹</small>'
                        : ''),
                4200
            );

            setTimeout(function () {
                btn.innerHTML = original;
                btn.classList.remove('ok');
                btn.disabled = false;
                btn.dataset.busy = '';
            }, 4000);
            return;
        } catch (e) {
            btn.innerHTML = original;
            btn.disabled = false;
            btn.dataset.busy = '';
            handleError(e);
        }
    }

    function createButton(magnet) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-123-save';
        btn.title = '用 123 云盘离线下载这个磁力';
        btn.innerHTML = '<span class="btn-123-icon">💾</span> 转存123盘';
        btn.addEventListener('click', function (ev) {
            handleSave(magnet, btn, ev);
        });
        return btn;
    }

    function attachButton(el, magnet) {
        if (!el || el.nodeType !== 1) return;
        if (!magnet || !/^magnet:/i.test(String(magnet).trim())) return;
        const parent = el.parentNode;
        if (!parent) return;
        // 已经注入过（按钮紧跟在链接后面）；页面重渲染后元素会被重建，这里能重新补上
        const next = el.nextElementSibling;
        if (next && next.classList && next.classList.contains('btn-123-save')) return;
        const btn = createButton(String(magnet).trim());
        try {
            el.insertAdjacentElement('afterend', btn);
        } catch (e) {
            try { parent.insertBefore(btn, el.nextSibling); } catch (e2) {}
        }
    }

    function scan(root) {
        const scope = (root && root.nodeType === 1) ? root : document;
        try {
            if (scope.matches && scope.matches('a[href^="magnet:"]')) {
                attachButton(scope, scope.getAttribute('href'));
            }
            if (scope.matches && scope.matches('[data-clipboard-text^="magnet:"]')) {
                const isMagnetAnchor = scope.tagName === 'A' &&
                    String(scope.getAttribute('href') || '').toLowerCase().indexOf('magnet:') === 0;
                if (!isMagnetAnchor) attachButton(scope, scope.getAttribute('data-clipboard-text'));
            }
            if (!scope.querySelectorAll) return;

            scope.querySelectorAll('a[href^="magnet:"]').forEach(function (a) {
                attachButton(a, a.getAttribute('href'));
            });
            scope.querySelectorAll('[data-clipboard-text^="magnet:"]').forEach(function (el) {
                if (el.tagName === 'A' && String(el.getAttribute('href') || '').toLowerCase().indexOf('magnet:') === 0) return;
                attachButton(el, el.getAttribute('data-clipboard-text'));
            });
        } catch (e) {
            log('扫描页面失败', e);
        }
    }

    let pending = new Set();
    let flushTimer = 0;

    function observe() {
        const target = document.documentElement;
        if (!target) return;

        const obs = new MutationObserver(function (muts) {
            for (const m of muts) {
                if (m.type === 'childList') {
                    m.addedNodes.forEach(function (n) { if (n.nodeType === 1) pending.add(n); });
                } else if (m.type === 'attributes' && m.target && m.target.nodeType === 1) {
                    pending.add(m.target);
                }
            }
            if (!pending.size) return;
            clearTimeout(flushTimer);
            flushTimer = setTimeout(function () {
                const nodes = Array.from(pending);
                pending.clear();
                nodes.forEach(scan);
            }, 200);
        });

        obs.observe(target, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['href', 'data-clipboard-text']
        });
    }

    /* ============================================================
     * 9. 菜单
     * ============================================================ */
    const MODE_LABEL = {
        series: '📚 按番剧归类',
        flat: '🧹 仅去掉文件夹',
        off: '⛔ 不处理'
    };

    function registerMenus() {
        if (typeof GM_registerMenuCommand !== 'function') return;

        GM_registerMenuCommand('完成后处理方式：' + (MODE_LABEL[getMode()] || MODE_LABEL.series) + '（点击切换）', function () {
            const order = ['series', 'flat', 'off'];
            const cur = getMode();
            const next = order[(order.indexOf(cur) + 1) % order.length];
            setMode(next);
            if (next === 'off') saveQueue([]);
            showToast(
                '已切换为「' + MODE_LABEL[next] + '」' +
                (next === 'series'
                    ? '<br><small>单集下载完成后自动归到同名番剧文件夹</small>'
                    : next === 'flat'
                        ? '<br><small>只把文件移出单集文件夹，不建番剧文件夹</small>'
                        : '<br><small>保持 123 默认的文件夹结构</small>'),
                3600
            );
        });

        GM_registerMenuCommand('📚 同剧归类（当前 123 目录）', function () {
            if (IS_123PAGE) {
                runCleanup().catch(function (e) { showToast('❌ ' + esc(e.message || '整理失败')); });
            } else {
                GM_openInTab(HOME, { active: true });
                showToast('已在 123 云盘打开，进入要整理的目录后再点 🧹', 4200);
            }
        });

        GM_registerMenuCommand('⏱ 立即检查待整理任务（' + loadQueue().length + ' 个）', function () {
            showToast('正在检查…', 1500);
            processQueue(false);
        });

        GM_registerMenuCommand('🗑 清空待整理队列', function () {
            saveQueue([]);
            showToast('已清空待整理队列');
        });

        GM_registerMenuCommand('🐞 调试日志：' + (GM_getValue(KEY.debug, false) ? '开' : '关'), function () {
            const next = !GM_getValue(KEY.debug, false);
            GM_setValue(KEY.debug, next);
            showToast(next ? '调试日志已开启（F12 控制台查看 [123pan]）' : '调试日志已关闭');
        });

        GM_registerMenuCommand('🔑 打开 123 云盘（自动同步登录状态）', function () {
            GM_openInTab(HOME, { active: true });
        });
    }

    /* ============================================================
     * 10. 启动
     * ============================================================ */
    function init() {
        mountStyle();
        registerMenus();

        if (IS_123PAGE) {
            // 123 云盘页面：只做 Token 同步 / 整理按钮，不注入磁力按钮
            if (PATH === '/' || location.hash) {
                setTimeout(buildFloatUI, 800);
            }
            if (loadQueue().length) ensureQueueTicker();
            return;
        }

        scan(document);
        observe();
        if (loadQueue().length) ensureQueueTicker();
        log('脚本已启动', location.href);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
