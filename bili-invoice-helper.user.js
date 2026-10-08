// ==UserScript==
// @name         B站游戏开票助手
// @namespace    https://github.com/dawn-lc/bili-invoice-helper
// @version      1.4.1
// @description  批量申请 B 站游戏发票，支持游戏选择、扫描、逐单提交、开票记录、总金额统计
// @author       dawn-lc
// @match        https://game.bilibili.com/kf/invoice/*
// @icon         https://www.bilibili.com/favicon.ico
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==
(function () {
  "use strict";
  // ============ 常量 ============
  const BASE = "https://game.bilibili.com";
  const PAGE_SIZE = 50;
  const QUERY_DELAY = 150;
  const QUERY_RETRIES = 2;
  const REQUEST_TIMEOUT = 30000;
  const CREATE_DELAY = 1000;
  const RECORD_PAGE_SIZE = 10;
  const SUM_PAGE_SIZE = 50;
  const STATUS_TODO = "未申请";
  const MIN_START_DATE = "2019-01-01";
  const LS_KEY = "bili_invoice_helper_v2";
  const DEFAULT_GAME = { id: 97, name: "碧蓝航线" };
  const headers = {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
  };
  function sleep(ms, signal) {
    if (signal?.aborted) {
      return Promise.reject(new DOMException("请求已取消", "AbortError"));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new DOMException("请求已取消", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  function formatError(error) {
    if (!error) return "未知错误";
    if (error.name === "AbortError") return "请求已取消";
    return error.message || String(error);
  }
  function moneyToCents(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }
  function formatMoney(cents) {
    return `¥${(cents / 100).toFixed(2)}`;
  }
  // ============ 本地记忆 ============
  function loadCfg() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY)) || {};
    } catch {
      return {};
    }
  }
  function saveCfg(cfg) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(cfg));
    } catch { }
  }
  const _cfg = loadCfg();
  // ============ 状态 ============
  const state = {
    orders: new Map(),
    selected: new Set(),
    scanning: false,
    invoicing: false,
    stopFlag: false,
    requestController: null,
    recordDirty: true,
    // 不再填默认值，用户必须自行填写
    invoiceTitle: _cfg.title || "",
    invoiceEmail: _cfg.email || "",
    game: _cfg.game || { ...DEFAULT_GAME },
    gameList: [],
    recordList: [],
    recordPage: 1,
    recordTotal: 0,
    view: "invoice",
  };
  // ============ 工具 ============
  function fmtDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function enumerateMonths(startYM, endYM) {
    const [sy, sm] = startYM.split("-").map(Number);
    const [ey, em] = endYM.split("-").map(Number);
    const out = [];
    let y = sy;
    let m = sm;
    while (y < ey || (y === ey && m <= em)) {
      out.push(`${y}-${String(m).padStart(2, "0")}`);
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
    return out;
  }
  function isValidEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  }
  function payMonthOf(date) {
    const match = /^(\d{4})-(\d{2})/.exec(String(date ?? ""));
    return match ? `${match[1]}-${match[2]}` : "";
  }
  // ============ API ============
  async function apiFetch(path, body, { signal, retries = 0 } = {}) {
    let attempt = 0;
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("请求已取消", "AbortError");
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, REQUEST_TIMEOUT);
      const onAbort = () => controller.abort();
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        const res = await fetch(`${BASE}${path}`, {
          credentials: "include",
          headers,
          referrer: `${BASE}/kf/invoice/`,
          method: "POST",
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await res.text();
        if (!res.ok) {
          throw new Error(
            `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
          );
        }
        try {
          return JSON.parse(text);
        } catch {
          const preview = text.replace(/\s+/g, " ").slice(0, 80);
          throw new Error(`响应不是 JSON：${preview || "空响应"}`);
        }
      } catch (e) {
        if (signal?.aborted) {
          throw new DOMException("请求已取消", "AbortError");
        }
        if (controller.signal.aborted && attempt < retries) {
          attempt++;
          await sleep(500 * 2 ** (attempt - 1), signal);
          continue;
        }
        if (attempt < retries && e.name !== "AbortError") {
          attempt++;
          await sleep(500 * 2 ** (attempt - 1), signal);
          continue;
        }
        if (controller.signal.aborted) {
          throw new Error(`请求超时（${REQUEST_TIMEOUT / 1000}s）`);
        }
        throw e;
      } finally {
        clearTimeout(timeout);
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
      }
    }
  }
  async function apiQuery(payMonth, pageNo, signal) {
    return apiFetch(
      "/api/invoice/order/query",
      {
        game_base_id: state.game.id,
        pay_month: payMonth,
        page_no: pageNo,
        page_size: PAGE_SIZE,
      },
      {
        signal,
        retries: QUERY_RETRIES,
      },
    );
  }
  async function apiCreate(order, title, email, signal) {
    return apiFetch(
      "/api/invoice/create",
      {
        game_base_id: state.game.id,
        enterprise_type: 0,
        title,
        taxpayer_no: "",
        address: "",
        phone: "",
        bank_address: "",
        bank_account: "",
        email,
        order_details: [
          {
            order_no: order.order_no,
            pay_date: order.pay_date,
          },
        ],
      },
      {
        signal,
      },
    );
  }
  async function apiGameList(signal) {
    return apiFetch(
      "/api/invoice/all/game/query",
      {},
      {
        signal,
        retries: QUERY_RETRIES,
      },
    );
  }
  async function apiRecordQuery(pageNo, pageSize, signal) {
    return apiFetch(
      "/api/invoice/record/query",
      {
        page_no: pageNo,
        page_size: pageSize,
      },
      {
        signal,
        retries: QUERY_RETRIES,
      },
    );
  }
  // ============ 注入 UI ============
  const host = document.createElement("div");
  host.id = "bili-invoice-helper";
  document.body.appendChild(host);
  const shadow = host.attachShadow({
    mode: "open",
  });
  const style = document.createElement("style");
  style.textContent = `
* { box-sizing: border-box; margin: 0; padding: 0; }
.float-btn {
  position: fixed;
  right: 24px;
  bottom: 24px;
  background: linear-gradient(135deg, #00aeec, #0088cc);
  color: #fff;
  padding: 12px 20px;
  border-radius: 24px;
  cursor: pointer;
  user-select: none;
  box-shadow: 0 6px 20px rgba(0, 174, 236, 0.4);
  font-size: 14px;
  font-weight: 600;
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  z-index: 2147483647;
  transition: transform 0.15s, box-shadow 0.15s;
}
.float-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0,174,236,0.55);
}
.panel {
  position: fixed;
  right: 24px;
  bottom: 80px;
  width: 460px;
  max-height: 82vh;
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.18);
  z-index: 2147483646;
  display: flex;
  flex-direction: column;
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  color: #333;
  overflow: hidden;
}
.panel.hidden {
  display: none !important;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: linear-gradient(135deg, #00aeec, #0088cc);
  color: #fff;
}
.header .title {
  font-weight: 600;
  font-size: 15px;
}
.header .close {
  cursor: pointer;
  font-size: 22px;
  line-height: 1;
  padding: 0 4px;
  opacity: 0.85;
}
.header .close:hover {
  opacity: 1;
}
.tabs {
  display: flex;
  background: #f5f7fa;
  border-bottom: 1px solid #e8e8e8;
}
.tabs .tab {
  flex: 1;
  text-align: center;
  padding: 10px;
  cursor: pointer;
  font-size: 13px;
  color: #666;
  border-bottom: 2px solid transparent;
  transition: all 0.15s;
}
.tabs .tab:hover {
  color: #00aeec;
}
.tabs .tab.active {
  color: #00aeec;
  border-bottom-color: #00aeec;
  font-weight: 600;
  background: #fff;
}
.body {
  padding: 16px 18px;
  overflow-y: auto;
  flex: 1;
}
.body::-webkit-scrollbar {
  width: 6px;
}
.body::-webkit-scrollbar-thumb {
  background: #ccc;
  border-radius: 3px;
}
.section {
  margin-bottom: 16px;
}
.section-title {
  font-weight: 600;
  font-size: 12px;
  color: #888;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.section-title .link-group a {
  color: #00aeec;
  cursor: pointer;
  font-weight: normal;
  margin-left: 10px;
  font-size: 11px;
  letter-spacing: 0;
}
.section-title .link-group a:hover {
  text-decoration: underline;
}
.section-title .required-tip {
  color: #ff4d4f;
  font-weight: normal;
  font-size: 11px;
  letter-spacing: 0;
}
.form-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.form-row label {
  width: 62px;
  color: #666;
  font-size: 12px;
  flex-shrink: 0;
}
.form-row label.required::before {
  content: "*";
  color: #ff4d4f;
  margin-right: 3px;
}
.form-row input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid #e0e0e0;
  border-radius: 7px;
  font-size: 13px;
  outline: none;
  font-family: inherit;
  color: #333;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.form-row input:focus {
  border-color: #00aeec;
  box-shadow: 0 0 0 3px rgba(0,174,236,0.1);
}
.form-row input.invalid {
  border-color: #ff4d4f;
  box-shadow: 0 0 0 3px rgba(255,77,79,0.1);
}
.game-select {
  position: relative;
}
.game-select .game-input {
  width: 100%;
  padding: 8px 32px 8px 12px;
  border: 1px solid #e0e0e0;
  border-radius: 7px;
  font-size: 13px;
  outline: none;
  font-family: inherit;
  cursor: pointer;
  background: #fff;
  color: #333;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
}
.game-select .game-input:focus {
  border-color: #00aeec;
  box-shadow: 0 0 0 3px rgba(0,174,236,0.1);
}
.game-select .arrow {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: #999;
  font-size: 10px;
  pointer-events: none;
}
.game-dropdown {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 4px);
  max-height: 240px;
  overflow-y: auto;
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 7px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.12);
  z-index: 10;
}
.game-dropdown::-webkit-scrollbar {
  width: 6px;
}
.game-dropdown::-webkit-scrollbar-thumb {
  background: #ccc;
  border-radius: 3px;
}
.game-option {
  padding: 8px 12px;
  cursor: pointer;
  font-size: 12px;
  border-bottom: 1px solid #f5f5f5;
}
.game-option:last-child {
  border-bottom: none;
}
.game-option:hover,
.game-option.focused {
  background: #f0f5ff;
}
.game-option.selected {
  background: #e6f7ff;
  color: #0096cc;
  font-weight: 600;
}
.game-option .gid {
  color: #999;
  font-size: 11px;
  margin-left: 6px;
}
button {
  padding: 11px 16px;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}
button.primary {
  background: #00aeec;
  color: #fff;
  width: 100%;
}
button.primary:hover:not(:disabled) {
  background: #0096cc;
}
button.primary:disabled {
  background: #ccc;
  cursor: not-allowed;
}
button.danger {
  background: #ff4d4f;
  color: #fff;
  width: 100%;
}
button.danger:hover {
  background: #e03d3f;
}
button.ghost {
  background: #fff;
  color: #00aeec;
  border: 1px solid #00aeec;
  width: 100%;
}
button.ghost:hover:not(:disabled) {
  background: #f0f9ff;
}
button.ghost:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.stats {
  display: flex;
  gap: 8px;
}
.stat-item {
  flex: 1;
  background: #f5f7fa;
  border-radius: 9px;
  padding: 10px 6px;
  text-align: center;
}
.stat-item b {
  display: block;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.2;
}
.stat-item b.blue {
  color: #00aeec;
}
.stat-item b.orange {
  color: #ff6b00;
}
.stat-item b.gray {
  color: #999;
}
.stat-item span {
  font-size: 11px;
  color: #888;
  margin-top: 2px;
  display: block;
}
.orders {
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid #eee;
  border-radius: 9px;
  background: #fafbfc;
}
.orders::-webkit-scrollbar {
  width: 6px;
}
.orders::-webkit-scrollbar-thumb {
  background: #ccc;
  border-radius: 3px;
}
.order-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-bottom: 1px solid #f0f0f0;
  font-size: 12px;
  transition: background 0.1s;
}
.order-row:last-child {
  border-bottom: none;
}
.order-row:hover {
  background: #f0f5ff;
}
.order-row.disabled {
  opacity: 0.45;
}
.order-row input[type=checkbox] {
  width: 15px;
  height: 15px;
  margin: 0;
  cursor: pointer;
  accent-color: #00aeec;
}
.order-row input[type=checkbox]:disabled {
  cursor: not-allowed;
}
.order-info {
  flex: 1;
  min-width: 0;
}
.order-no {
  font-family: "SF Mono", Consolas, monospace;
  font-size: 11px;
  color: #666;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.order-meta {
  display: flex;
  gap: 10px;
  margin-top: 3px;
  font-size: 11px;
  color: #999;
}
.order-amount {
  color: #ff6b00;
  font-weight: 600;
}
.badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}
.badge.todo {
  background: #e6f7ff;
  color: #0096cc;
}
.badge.done {
  background: #f0f0f0;
  color: #999;
}
.order-sum {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  margin-top: 8px;
  background: #e6f7ff;
  border-radius: 8px;
  font-size: 12px;
  color: #0077aa;
}
.order-sum b {
  font-size: 15px;
  color: #0088cc;
  font-family: "SF Mono", Consolas, monospace;
}
.record-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid #f0f0f0;
  font-size: 12px;
}
.record-row:last-child {
  border-bottom: none;
}
.record-info {
  flex: 1;
  min-width: 0;
}
.record-sn {
  font-family: "SF Mono", Consolas, monospace;
  font-size: 11px;
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.record-meta {
  display: flex;
  gap: 10px;
  margin-top: 3px;
  font-size: 11px;
  color: #999;
}
.record-amount {
  color: #ff6b00;
  font-weight: 600;
}
.record-status {
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
}
.record-status.s0 {
  background: #fff7e6;
  color: #d46b08;
}
.record-status.s1 {
  background: #e6f7ff;
  color: #0096cc;
}
.record-status.s2 {
  background: #f6ffed;
  color: #52c41a;
}
.record-status.s3 {
  background: #fff1f0;
  color: #cf1322;
}
.record-status.sX {
  background: #f0f0f0;
  color: #999;
}
.sum-box {
  background: linear-gradient(135deg, #fff7e6, #ffe7ba);
  border: 1px solid #ffd591;
  border-radius: 10px;
  padding: 16px 18px;
  text-align: center;
}
.sum-label {
  font-size: 12px;
  color: #ad6800;
  margin-bottom: 6px;
}
.sum-amount {
  font-size: 28px;
  font-weight: 700;
  color: #d46b08;
  font-family: "SF Mono", Consolas, monospace;
  line-height: 1.2;
}
.sum-meta {
  font-size: 11px;
  color: #ad6800;
  margin-top: 6px;
  opacity: 0.75;
  word-break: break-all;
}
.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 12px;
  font-size: 12px;
  color: #666;
}
.pagination button {
  padding: 6px 12px;
  font-size: 12px;
  background: #f5f7fa;
  color: #333;
  font-weight: normal;
}
.pagination button:hover:not(:disabled) {
  background: #e6f7ff;
  color: #00aeec;
}
.pagination button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.pagination .page-info {
  min-width: 80px;
  text-align: center;
}
.progress-bar {
  height: 6px;
  background: #f0f0f0;
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 6px;
}
.progress-inner {
  height: 100%;
  background: linear-gradient(90deg, #00aeec, #0088cc);
  width: 0%;
  transition: width 0.3s ease;
}
.progress-text {
  font-size: 11px;
  color: #666;
  text-align: center;
}
.log {
  max-height: 130px;
  overflow-y: auto;
  background: #1e1e1e;
  color: #ddd;
  border-radius: 9px;
  padding: 10px 12px;
  font-family: "SF Mono", Consolas, monospace;
  font-size: 11px;
  line-height: 1.6;
}
.log::-webkit-scrollbar {
  width: 6px;
}
.log::-webkit-scrollbar-thumb {
  background: #555;
  border-radius: 3px;
}
.log-entry {
  margin-bottom: 2px;
  word-break: break-all;
}
.log-entry.ok {
  color: #4caf50;
}
.log-entry.err {
  color: #ff6b6b;
}
.log-entry.info {
  color: #64b5f6;
}
.log-entry.warn {
  color: #ffb74d;
}
.hidden {
  display: none !important;
}
`;
  shadow.appendChild(style);
  const root = document.createElement("div");
  root.innerHTML = `
<div class="float-btn" id="toggleBtn">📄 开票助手</div>
<div class="panel hidden" id="panel">
  <div class="header">
    <span class="title">📄 B站游戏开票助手</span>
    <span class="close" id="closeBtn">×</span>
  </div>
  <div class="tabs">
    <div class="tab active" data-view="invoice">开票助手</div>
    <div class="tab" data-view="record">开票记录</div>
  </div>
  <div class="body">
    <!-- ========= 开票视图 ========= -->
    <div id="viewInvoice">
      <div class="section">
        <div class="section-title">
          发票信息
          <span class="required-tip">* 为必填</span>
        </div>
        <div class="form-row">
          <label class="required">抬头</label>
          <input
            id="invoiceTitle"
            placeholder="请填写发票抬头"
            autocomplete="off"
          >
        </div>
        <div class="form-row">
          <label class="required">邮箱</label>
          <input
            id="invoiceEmail"
            placeholder="接收发票的邮箱"
            autocomplete="off"
          >
        </div>
      </div>
      <div class="section">
        <div class="section-title">游戏</div>
        <div class="game-select">
          <input
            id="gameInput"
            class="game-input"
            placeholder="点击选择游戏"
            readonly
          >
          <span class="arrow">▼</span>
          <div
            class="game-dropdown hidden"
            id="gameDropdown"
          ></div>
        </div>
      </div>
      <div class="section">
        <div class="section-title">扫描范围</div>
        <div class="form-row">
          <label>起始</label>
          <input
            id="startDate"
            type="date"
            min="2019-01-01"
            value="2019-01-01"
          >
        </div>
        <div class="form-row">
          <label>结束</label>
          <input
            id="endDate"
            type="date"
          >
        </div>
      </div>
      <div class="section">
        <button class="primary" id="scanBtn">
          🔍 扫描订单
        </button>
      </div>
      <div class="section stats hidden" id="stats">
        <div class="stat-item">
          <b class="blue" id="statTotal">0</b>
          <span>全部订单</span>
        </div>
        <div class="stat-item">
          <b class="orange" id="statTodo">0</b>
          <span>可开票</span>
        </div>
        <div class="stat-item">
          <b class="gray" id="statDone">0</b>
          <span>不可开票</span>
        </div>
      </div>
      <div class="section hidden" id="ordersSection">
        <div class="section-title">
          订单列表
          <span class="link-group">
            <a id="selectTodo">只选可开票</a>
            <a id="selectNone">清空选择</a>
          </span>
        </div>
        <div class="orders" id="orders"></div>
        <div class="order-sum" id="orderSum">
          <span>选中合计</span>
          <b id="orderSumSelected">
            ¥0.00
          </b>
          <span id="orderSumBreakdown">
            可开票 ¥0.00 · 不可开票 ¥0.00
          </span>
        </div>
      </div>
      <div
        class="section hidden"
        id="progressSection"
      >
        <div class="progress-bar">
          <div
            class="progress-inner"
            id="progressInner"
          ></div>
        </div>
        <div
          class="progress-text"
          id="progressText"
        >
          准备中…
        </div>
      </div>
      <div class="section">
        <div class="section-title">
          运行日志
        </div>
        <div
          class="log"
          id="log"
        ></div>
      </div>
      <div
        class="section"
        style="margin-bottom:0"
      >
        <button
          class="primary"
          id="invoiceBtn"
          disabled
        >
          🎫 为选中的 0 个订单开票
        </button>
        <button
          class="danger hidden"
          id="stopBtn"
          style="margin-top:8px"
        >
          ⏹ 停止
        </button>
      </div>
    </div>
    <!-- ========= 记录视图 ========= -->
    <div
      id="viewRecord"
      class="hidden"
    >
      <div
        class="section"
        style="display:flex;gap:8px"
      >
        <button
          class="ghost"
          id="refreshRecordBtn"
          style="flex:1"
        >
          🔄 刷新记录
        </button>
        <button
          class="ghost"
          id="sumRecordBtn"
          style="flex:1"
        >
          💰 统计总金额
        </button>
      </div>
      <div
        class="section stats hidden"
        id="recordStats"
      >
        <div class="stat-item">
          <b
            class="blue"
            id="recordTotal"
          >
            0
          </b>
          <span>记录总数</span>
        </div>
        <div class="stat-item">
          <b
            class="orange"
            id="recordAmount"
          >
            0
          </b>
          <span>本页金额</span>
        </div>
      </div>
      <div
        class="section hidden"
        id="sumResult"
      >
        <div class="sum-box">
          <div class="sum-label">
            历史开票总金额
          </div>
          <div
            class="sum-amount"
            id="sumAmount"
          >
            ¥0.00
          </div>
          <div
            class="sum-meta"
            id="sumMeta"
          >
            -
          </div>
        </div>
      </div>
      <div class="section">
        <div class="section-title">
          历史记录
        </div>
        <div
          class="orders"
          id="recordList"
          style="max-height:300px"
        ></div>
      </div>
      <div
        class="pagination hidden"
        id="recordPager"
      >
        <button id="prevPage">
          ‹ 上一页
        </button>
        <span
          class="page-info"
          id="pageInfo"
        >
          1 / 1
        </span>
        <button id="nextPage">
          下一页 ›
        </button>
      </div>
    </div>
  </div>
</div>
`;
  shadow.appendChild(root);
  // ============ 元素引用 ============
  const $ = (id) => shadow.getElementById(id);
  const toggleBtn = $("toggleBtn");
  const panel = $("panel");
  const closeBtn = $("closeBtn");
  const tabs = shadow.querySelectorAll(".tab");
  const viewInvoice = $("viewInvoice");
  const viewRecord = $("viewRecord");
  const invoiceTitle = $("invoiceTitle");
  const invoiceEmail = $("invoiceEmail");
  const gameInput = $("gameInput");
  const gameDropdown = $("gameDropdown");
  const startDate = $("startDate");
  const endDate = $("endDate");
  const scanBtn = $("scanBtn");
  const statsEl = $("stats");
  const statTotal = $("statTotal");
  const statTodo = $("statTodo");
  const statDone = $("statDone");
  const ordersSection = $("ordersSection");
  const ordersEl = $("orders");
  const orderSum = $("orderSum");
  const orderSumSelected = $("orderSumSelected");
  const orderSumBreakdown = $("orderSumBreakdown");
  const selectTodo = $("selectTodo");
  const selectNone = $("selectNone");
  const progressSection = $("progressSection");
  const progressInner = $("progressInner");
  const progressText = $("progressText");
  const logEl = $("log");
  const invoiceBtn = $("invoiceBtn");
  const stopBtn = $("stopBtn");
  const refreshRecordBtn = $("refreshRecordBtn");
  const sumRecordBtn = $("sumRecordBtn");
  const recordStats = $("recordStats");
  const recordTotal = $("recordTotal");
  const recordAmount = $("recordAmount");
  const sumResult = $("sumResult");
  const sumAmount = $("sumAmount");
  const sumMeta = $("sumMeta");
  const recordList = $("recordList");
  const recordPager = $("recordPager");
  const prevPage = $("prevPage");
  const nextPage = $("nextPage");
  const pageInfo = $("pageInfo");
  // 初始化输入框
  invoiceTitle.value = state.invoiceTitle;
  invoiceEmail.value = state.invoiceEmail;
  endDate.value = fmtDate(new Date());
  gameInput.value = `${state.game.name} (${state.game.id})`;
  // 扫描范围约束：
  // 1) 起始日期不早于 2019-01-01（月份下限 2019-01），结束不晚于今天
  // 2) 保证起始 ≤ 结束，输入时自动钳制
  const CURRENT_DATE = fmtDate(new Date());
  function readRange() {
    let s = startDate.value || "";
    let e = endDate.value || "";
    if (s && s < MIN_START_DATE) {
      s = MIN_START_DATE;
      startDate.value = s;
    }
    if (s && s > CURRENT_DATE) {
      s = CURRENT_DATE;
      startDate.value = s;
    }
    if (e && e > CURRENT_DATE) {
      e = CURRENT_DATE;
      endDate.value = e;
    }
    if (s && e && s > e) {
      e = s;
      endDate.value = e;
    }
    return { sm: s ? payMonthOf(s) : "", em: e ? payMonthOf(e) : "" };
  }
  function syncRangeBounds() {
    startDate.min = MIN_START_DATE;
    startDate.max = CURRENT_DATE;
    endDate.max = CURRENT_DATE;
    endDate.min = startDate.value || MIN_START_DATE;
    readRange();
  }
  syncRangeBounds();
  startDate.oninput = syncRangeBounds;
  endDate.oninput = syncRangeBounds;
  // ============ 校验 & 保存 ============
  function validateTitle(silent = false) {
    const v = invoiceTitle.value.trim();
    const tooLong = v.length > 100;
    const ok = v.length > 0 && !tooLong;
    if (!silent) {
      invoiceTitle.classList.toggle("invalid", !ok);
      if (tooLong) {
        alert("抬头过长，请检查");
      }
    }
    return ok;
  }
  function validateEmail(silent = false) {
    const v = invoiceEmail.value.trim();
    const ok = isValidEmail(v);
    if (!silent) {
      invoiceEmail.classList.toggle("invalid", !ok);
    }
    return ok;
  }
  function validateAll(silent = false) {
    const t = validateTitle(silent);
    const e = validateEmail(silent);
    return t && e;
  }
  invoiceTitle.oninput = () => {
    if (invoiceTitle.classList.contains("invalid")) {
      validateTitle();
    }
  };
  invoiceEmail.oninput = () => {
    if (invoiceEmail.classList.contains("invalid")) {
      validateEmail();
    }
  };
  function persistInfo() {
    const title = invoiceTitle.value.trim();
    const email = invoiceEmail.value.trim();
    state.invoiceTitle = title;
    state.invoiceEmail = email;
    saveCfg({
      ...loadCfg(),
      title,
      email,
      game: state.game,
    });
  }
  // ============ 日志 & 进度 ============
  function log(msg, type = "info") {
    const t = new Date().toLocaleTimeString("zh-CN", {
      hour12: false,
    });
    const div = document.createElement("div");
    div.className = "log-entry " + type;
    div.textContent = `[${t}] ${msg}`;
    logEl.appendChild(div);
    while (logEl.children.length > 500) {
      logEl.firstElementChild.remove();
    }
    logEl.scrollTop = logEl.scrollHeight;
  }
  function setProgress(cur, total, text) {
    progressSection.classList.remove("hidden");
    progressInner.style.width = (total ? (cur / total) * 100 : 0) + "%";
    progressText.textContent = text || `${cur} / ${total}`;
  }
  // ============ 面板开合 ============
  toggleBtn.onclick = () => {
    panel.classList.toggle("hidden");
  };
  closeBtn.onclick = () => {
    panel.classList.add("hidden");
  };
  // ============ Tab 切换 ============
  tabs.forEach((tab) => {
    tab.onclick = () => {
      const view = tab.dataset.view;
      state.view = view;
      tabs.forEach((t) => {
        t.classList.toggle("active", t === tab);
      });
      viewInvoice.classList.toggle("hidden", view !== "invoice");
      viewRecord.classList.toggle("hidden", view !== "record");
      if (
        view === "record" &&
        (state.recordDirty || !state.recordList.length)
      ) {
        loadRecords(1);
      }
    };
  });
  // ============ 游戏选择器 ============
  let gameDropdownVisible = false;
  async function ensureGameList() {
    if (state.gameList.length) return;
    try {
      const r = await apiGameList();
      if (r.code !== 0) {
        log(`游戏列表获取失败: ${r.message || "未知错误"}`, "err");
        return;
      }
      state.gameList = (r.data?.results || []).slice().sort((a, b) => {
        if (a.game_base_id === 97) {
          return -1;
        }
        if (b.game_base_id === 97) {
          return 1;
        }
        return a.name.localeCompare(b.name, "zh-CN");
      });
    } catch (e) {
      log(`游戏列表请求异常: ${formatError(e)}`, "err");
    }
  }
  function renderGameDropdown(filter = "") {
    const kw = filter.trim().toLowerCase();
    const list = state.gameList
      .filter(
        (g) =>
          !kw ||
          String(g.name || "")
            .toLowerCase()
            .includes(kw) ||
          String(g.game_base_id).includes(kw),
      )
      .slice(0, 100);
    gameDropdown.innerHTML = "";
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "game-option";
      empty.style.color = "#999";
      empty.style.cursor = "default";
      empty.textContent = "无匹配游戏";
      gameDropdown.appendChild(empty);
      return;
    }
    for (const g of list) {
      const opt = document.createElement("div");
      opt.className =
        "game-option" + (g.game_base_id === state.game.id ? " selected" : "");
      const name = document.createElement("span");
      name.textContent = g.name || "未知游戏";
      const gid = document.createElement("span");
      gid.className = "gid";
      gid.textContent = `#${g.game_base_id}`;
      opt.append(name, gid);
      opt.onclick = () => {
        state.game = {
          id: g.game_base_id,
          name: g.name,
        };
        gameInput.value = `${g.name} (${g.game_base_id})`;
        saveCfg({
          ...loadCfg(),
          game: state.game,
        });
        hideGameDropdown();
        state.orders.clear();
        state.selected.clear();
        ordersEl.innerHTML = "";
        ordersSection.classList.add("hidden");
        statsEl.classList.add("hidden");
        progressSection.classList.add("hidden");
        updateInvoiceBtn();
      };
      gameDropdown.appendChild(opt);
    }
  }
  function showGameDropdown() {
    if (gameDropdownVisible) return;
    gameDropdownVisible = true;
    gameDropdown.classList.remove("hidden");
    if (!state.gameList.length) {
      gameDropdown.innerHTML =
        '<div class="game-option" style="color:#999">加载中…</div>';
      ensureGameList().then(() => {
        renderGameDropdown("");
      });
    } else {
      renderGameDropdown("");
    }
    gameInput.readOnly = false;
    gameInput.value = "";
    gameInput.placeholder = "输入游戏名或 ID 搜索…";
    gameInput.focus();
  }
  function hideGameDropdown() {
    if (!gameDropdownVisible) return;
    gameDropdownVisible = false;
    gameDropdown.classList.add("hidden");
    gameInput.readOnly = true;
    gameInput.value = `${state.game.name} (${state.game.id})`;
    gameInput.placeholder = "点击选择游戏";
  }
  gameInput.onclick = () => {
    if (gameDropdownVisible) {
      hideGameDropdown();
    } else {
      showGameDropdown();
    }
  };
  gameInput.oninput = () => {
    if (gameDropdownVisible) {
      renderGameDropdown(gameInput.value);
    }
  };
  gameInput.onkeydown = (e) => {
    if (e.key === "Escape") {
      hideGameDropdown();
    }
  };
  shadow.addEventListener("click", (e) => {
    if (gameDropdownVisible && !e.target.closest(".game-select")) {
      hideGameDropdown();
    }
  });
  // ============ 扫描 ============
  async function scan() {
    if (state.scanning || state.invoicing) {
      return;
    }
    if (!validateAll()) {
      alert(
        "请先填写完整的发票信息：\n" +
        "· 抬头（不能为空）\n" +
        "· 邮箱（格式如 name@example.com）",
      );
      if (!validateTitle(true)) {
        invoiceTitle.focus();
      } else {
        invoiceEmail.focus();
      }
      return;
    }
    const { sm, em } = readRange();
    if (!sm || !em) {
      alert("请选择扫描月份范围");
      return;
    }
    syncRangeBounds();
    persistInfo();
    state.orders.clear();
    state.selected.clear();
    state.scanning = true;
    state.stopFlag = false;
    const months = enumerateMonths(sm, em);
    scanBtn.disabled = true;
    scanBtn.textContent = "⏳ 正在扫描…";
    invoiceBtn.disabled = true;
    ordersEl.innerHTML = "";
    ordersSection.classList.add("hidden");
    statsEl.classList.add("hidden");
    progressSection.classList.remove("hidden");
    log(
      `开始扫描【${state.game.name}】${sm} ~ ${em}，共 ${months.length} 个月`,
    );
    const controller = new AbortController();
    state.requestController = controller;
    try {
      for (let i = 0; i < months.length; i++) {
        const m = months[i];
        let skipped = 0;
        setProgress(
          i,
          months.length,
          `扫描 ${m} … (${i + 1}/${months.length})`,
        );
        const first = await apiQuery(m, 1, controller.signal);
        if (first.code !== 0) {
          log(`[${m}] 查询失败: ${first.message || "未知错误"}`, "err");
          continue;
        }
        const total = Number(first.data?.total_count ?? 0) || 0;
        if (total === 0) {
          log(`[${m}] 0 单`);
          continue;
        }
        const totalPages = Math.ceil(total / PAGE_SIZE);
        const pages = [first.data?.results ?? []];
        let complete = true;
        for (let p = 2; p <= totalPages; p++) {
          await sleep(QUERY_DELAY, controller.signal);
          const r = await apiQuery(m, p, controller.signal);
          if (r.code !== 0) {
            complete = false;
            log(
              `[${m}] 第 ${p}/${totalPages} 页查询失败：${r.message || "未知错误"}`,
              "err",
            );
            break;
          }
          pages.push(r.data?.results ?? []);
        }
        if (!complete) {
          log(
            `[${m}] 本月扫描不完整，未导入已获取结果；可重新扫描该月份`,
            "warn",
          );
          continue;
        }
        for (const list of pages) {
          for (const o of list) {
            if (o && o.order_no && !state.orders.has(o.order_no)) {
              const om = payMonthOf(o.pay_date);
              if (om && (om < sm || om > em)) {
                skipped++;
                continue;
              }
              state.orders.set(o.order_no, o);
            }
          }
        }
        log(
          `[${m}] ${total} 单${skipped ? `，超出范围忽略 ${skipped}` : ""}，累计 ${state.orders.size}`,
        );
        await sleep(QUERY_DELAY, controller.signal);
      }
      setProgress(
        months.length,
        months.length,
        `扫描完成，共 ${state.orders.size} 单`,
      );
      log(`扫描完成，共 ${state.orders.size} 单`, "ok");
      renderOrders();
      selectTodoOrders();
    } catch (e) {
      if (e.name === "AbortError") {
        log("扫描请求已取消", "warn");
      } else {
        log("扫描出错: " + formatError(e), "err");
      }
    } finally {
      state.scanning = false;
      state.requestController = null;
      scanBtn.disabled = false;
      scanBtn.textContent = "🔍 扫描订单";
      updateInvoiceBtn();
    }
  }
  scanBtn.onclick = scan;
  // ============ 渲染订单 ============
  function renderOrders() {
    ordersEl.innerHTML = "";
    const all = [...state.orders.values()].sort((a, b) =>
      (b.pay_date || "").localeCompare(a.pay_date || ""),
    );
    for (const o of all) {
      const isTodo = o.invoice_status_name === STATUS_TODO;
      const row = document.createElement("div");
      row.className = "order-row" + (isTodo ? "" : " disabled");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.orderNo = o.order_no;
      cb.checked = state.selected.has(o.order_no);
      cb.disabled = !isTodo;
      cb.onchange = () => {
        if (cb.checked) {
          state.selected.add(o.order_no);
        } else {
          state.selected.delete(o.order_no);
        }
        updateInvoiceBtn();
      };
      const info = document.createElement("div");
      info.className = "order-info";
      const noDiv = document.createElement("div");
      noDiv.className = "order-no";
      noDiv.textContent = o.order_no;
      const metaDiv = document.createElement("div");
      metaDiv.className = "order-meta";
      const payDate = document.createElement("span");
      payDate.textContent = o.pay_date || "";
      const gameName = document.createElement("span");
      gameName.textContent = o.game_name || "";
      const amount = document.createElement("span");
      amount.className = "order-amount";
      amount.textContent = `¥${o.total_amount ?? "?"}`;
      metaDiv.append(payDate, gameName, amount);
      info.appendChild(noDiv);
      info.appendChild(metaDiv);
      const badge = document.createElement("span");
      badge.className = "badge " + (isTodo ? "todo" : "done");
      badge.textContent = o.invoice_status_name || "未知";
      row.appendChild(cb);
      row.appendChild(info);
      row.appendChild(badge);
      ordersEl.appendChild(row);
    }
    const todoCount = all.filter(
      (o) => o.invoice_status_name === STATUS_TODO,
    ).length;
    statTotal.textContent = all.length;
    statTodo.textContent = todoCount;
    statDone.textContent = all.length - todoCount;
    statsEl.classList.remove("hidden");
    ordersSection.classList.remove("hidden");
    updateInvoiceBtn();
  }
  // ============ 选择 ============
  function syncCheckboxes() {
    ordersEl.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.checked = state.selected.has(cb.dataset.orderNo);
    });
  }
  function selectTodoOrders() {
    state.selected.clear();
    for (const o of state.orders.values()) {
      if (o.invoice_status_name === STATUS_TODO) {
        state.selected.add(o.order_no);
      }
    }
    syncCheckboxes();
    updateInvoiceBtn();
  }
  function selectNoneOrders() {
    state.selected.clear();
    syncCheckboxes();
    updateInvoiceBtn();
  }
  selectTodo.onclick = selectTodoOrders;
  selectNone.onclick = selectNoneOrders;
  function updateInvoiceBtn() {
    const orderNos = [...state.selected];
    invoiceBtn.textContent = `🎫 为选中的 ${orderNos.length} 个订单开票`;
    invoiceBtn.disabled =
      orderNos.length === 0 || state.invoicing || state.scanning;
    let sel = 0;
    let todo = 0;
    let other = 0;
    for (const o of state.orders.values()) {
      const amt = moneyToCents(o.total_amount);
      if (o.invoice_status_name === STATUS_TODO) {
        todo += amt;
      } else {
        other += amt;
      }
      if (state.selected.has(o.order_no)) {
        sel += amt;
      }
    }
    orderSumSelected.textContent = formatMoney(sel);
    orderSumBreakdown.textContent = `可开票 ${formatMoney(todo)} · 不可开票 ${formatMoney(other)}`;
  }
  // ============ 逐单开票 ============
  async function runInvoice() {
    if (state.invoicing || state.scanning) {
      return;
    }
    if (!validateAll()) {
      alert("发票信息不完整或格式错误，请检查抬头和邮箱");
      if (!validateTitle(true)) {
        invoiceTitle.focus();
      } else {
        invoiceEmail.focus();
      }
      return;
    }
    const orderNos = [...state.selected];
    if (!orderNos.length) {
      return;
    }
    if (!confirm(`即将为 ${orderNos.length} 个订单申请开票，确定继续？`)) {
      return;
    }
    persistInfo();
    state.invoicing = true;
    state.stopFlag = false;
    invoiceBtn.disabled = true;
    scanBtn.disabled = true;
    stopBtn.classList.remove("hidden");
    progressSection.classList.remove("hidden");
    const orders = orderNos.map((no) => state.orders.get(no)).filter(Boolean);
    let ok = 0;
    let fail = 0;
    let okAmount = 0;
    log(`开始逐单开票，共 ${orders.length} 单`, "info");
    try {
      for (let i = 0; i < orders.length; i++) {
        if (state.stopFlag) {
          log("用户已停止", "warn");
          break;
        }
        const o = orders[i];
        setProgress(i, orders.length, `开票中 ${i + 1} / ${orders.length}`);
        const controller = new AbortController();
        state.requestController = controller;
        try {
          const json = await apiCreate(
            o,
            state.invoiceTitle,
            state.invoiceEmail,
            controller.signal,
          );
          if (json.code === 0) {
            ok++;
            okAmount += moneyToCents(o.total_amount);
            log(`✅ ${o.order_no} (${o.pay_date}) ¥${o.total_amount}`, "ok");
            state.selected.delete(o.order_no);
            o.invoice_status_name = "已申请";
            state.recordDirty = true;
          } else {
            fail++;
            log(
              `❌ ${o.order_no} [${json.code}] ${json.message || "未知错误"}`,
              "err",
            );
          }
        } catch (e) {
          if (state.stopFlag && e.name === "AbortError") {
            log("当前请求已取消", "warn");
            break;
          }
          fail++;
          log(`❌ ${o.order_no} 请求异常: ${formatError(e)}`, "err");
        } finally {
          if (state.requestController === controller) {
            state.requestController = null;
          }
        }
        if (!state.stopFlag && i < orders.length - 1) {
          await sleep(CREATE_DELAY);
        }
      }
    } catch (e) {
      if (e.name === "AbortError" && state.stopFlag) {
        log("用户已停止", "warn");
      } else {
        log(`开票流程异常：${formatError(e)}`, "err");
      }
    } finally {
      setProgress(
        orders.length,
        orders.length,
        `完成：成功 ${ok}，失败 ${fail}`,
      );
      log(
        `开票完成：成功 ${ok} 单（${formatMoney(okAmount)}），失败 ${fail} 单${state.stopFlag ? "（已停止）" : ""}`,
        fail ? "warn" : "ok",
      );
      state.invoicing = false;
      state.stopFlag = false;
      state.requestController = null;
      stopBtn.classList.add("hidden");
      scanBtn.disabled = false;
      renderOrders();
      updateInvoiceBtn();
    }
  }
  invoiceBtn.onclick = runInvoice;
  stopBtn.onclick = () => {
    if (!state.invoicing) {
      return;
    }
    state.stopFlag = true;
    state.requestController?.abort();
  };
  // ============ 开票记录 ============
  function setRecordMessage(message, type = "info") {
    recordList.innerHTML = "";
    const div = document.createElement("div");
    div.style.cssText = "padding:20px;text-align:center";
    div.style.color = type === "error" ? "#ff4d4f" : "#999";
    div.textContent = message;
    recordList.appendChild(div);
  }
  async function loadRecords(pageNo) {
    if (pageNo < 1 || state.invoicing) {
      return;
    }
    refreshRecordBtn.disabled = true;
    refreshRecordBtn.textContent = "⏳ 加载中…";
    recordStats.classList.add("hidden");
    recordPager.classList.add("hidden");
    sumResult.classList.add("hidden");
    setRecordMessage("加载中…");
    try {
      const r = await apiRecordQuery(pageNo, RECORD_PAGE_SIZE);
      if (r.code !== 0) {
        setRecordMessage(`加载失败：${r.message || "未知错误"}`, "error");
        return;
      }
      const total = Number(r.data?.total_count ?? 0) || 0;
      const results = r.data?.results ?? [];
      state.recordList = Array.isArray(results) ? results : [];
      state.recordPage = pageNo;
      state.recordTotal = total;
      state.recordDirty = false;
      renderRecords();
      renderPager();
    } catch (e) {
      setRecordMessage(`请求异常：${formatError(e)}`, "error");
    } finally {
      refreshRecordBtn.disabled = false;
      refreshRecordBtn.textContent = "🔄 刷新记录";
    }
  }
  function renderRecords() {
    recordList.innerHTML = "";
    if (!state.recordList.length) {
      setRecordMessage("暂无开票记录");
      recordStats.classList.add("hidden");
      return;
    }
    let sum = 0;
    for (const r of state.recordList) {
      sum += moneyToCents(r.total_full_amount);
      const row = document.createElement("div");
      row.className = "record-row";
      const info = document.createElement("div");
      info.className = "record-info";
      const snDiv = document.createElement("div");
      snDiv.className = "record-sn";
      snDiv.textContent = r.invoice_sn || "-";
      const metaDiv = document.createElement("div");
      metaDiv.className = "record-meta";
      const gameName = document.createElement("span");
      gameName.textContent = r.game_name || "";
      const amount = document.createElement("span");
      amount.className = "record-amount";
      amount.textContent = `¥${r.total_full_amount ?? "?"}`;
      metaDiv.append(gameName, amount);
      info.appendChild(snDiv);
      info.appendChild(metaDiv);
      const status = document.createElement("span");
      const statusCode = String(r.invoice_status ?? "X");
      const statusKey = /^[0-3]$/.test(statusCode) ? statusCode : "X";
      status.className = "record-status s" + statusKey;
      status.textContent = r.invoice_status_name || "未知";
      row.appendChild(info);
      row.appendChild(status);
      recordList.appendChild(row);
    }
    recordTotal.textContent = state.recordTotal;
    recordAmount.textContent = formatMoney(sum);
    recordStats.classList.remove("hidden");
  }
  function renderPager() {
    const totalPages = Math.max(
      1,
      Math.ceil(state.recordTotal / RECORD_PAGE_SIZE),
    );
    pageInfo.textContent = `${state.recordPage} / ${totalPages}`;
    prevPage.disabled = state.recordPage <= 1;
    nextPage.disabled = state.recordPage >= totalPages;
    recordPager.classList.toggle("hidden", totalPages <= 1);
  }
  refreshRecordBtn.onclick = () => loadRecords(1);
  prevPage.onclick = () => loadRecords(state.recordPage - 1);
  nextPage.onclick = () => loadRecords(state.recordPage + 1);
  // ============ 统计全部开票金额 ============
  async function sumAllRecords() {
    if (sumRecordBtn.disabled || state.invoicing) {
      return;
    }
    sumRecordBtn.disabled = true;
    sumRecordBtn.textContent = "⏳ 统计中…";
    sumResult.classList.add("hidden");
    let page = 1;
    let totalCount = 0;
    let totalAmount = 0;
    const statusStats = {};
    try {
      while (true) {
        const r = await apiRecordQuery(page, SUM_PAGE_SIZE);
        if (r.code !== 0) {
          throw new Error(r.message || "未知错误");
        }
        const results = Array.isArray(r.data?.results) ? r.data.results : [];
        totalCount = Number(r.data?.total_count ?? totalCount) || 0;
        for (const rec of results) {
          totalAmount += moneyToCents(rec.total_full_amount);
          const st = rec.invoice_status_name || "未知";
          statusStats[st] = (statusStats[st] || 0) + 1;
        }
        const doneByCount = page * SUM_PAGE_SIZE >= totalCount;
        if (
          results.length === 0 ||
          results.length < SUM_PAGE_SIZE ||
          doneByCount
        ) {
          break;
        }
        page++;
        sumMeta.textContent = `已统计第 ${page - 1} 页…`;
        await sleep(200);
      }
      sumAmount.textContent = formatMoney(totalAmount);
      const statusText = Object.entries(statusStats)
        .map(([k, v]) => `${k} ${v}`)
        .join(" · ");
      sumMeta.textContent =
        `共 ${totalCount} 条` + (statusText ? ` · ${statusText}` : "");
      sumResult.classList.remove("hidden");
      recordTotal.textContent = totalCount;
      recordStats.classList.remove("hidden");
    } catch (e) {
      sumAmount.textContent = "¥?";
      sumMeta.textContent = "统计失败：" + formatError(e);
      sumResult.classList.remove("hidden");
    } finally {
      sumRecordBtn.disabled = false;
      sumRecordBtn.textContent = "💰 统计总金额";
    }
  }
  sumRecordBtn.onclick = sumAllRecords;
  // ============ 首次提示 ============
  if (!state.invoiceTitle || !state.invoiceEmail) {
    log("首次使用：请先填写「抬头」和「邮箱」", "warn");
  } else {
    log("助手已就绪，请确认发票信息后点击「扫描订单」");
  }
})();
