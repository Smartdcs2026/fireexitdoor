/************************************************************
 * api.js
 * ฟังก์ชันกลางสำหรับเรียก Cloudflare Worker API
 ************************************************************/

(function () {
  'use strict';

  const CONFIG = window.APP_CONFIG || {};
  const API_BASE = CONFIG.API_BASE || '';

  if (!API_BASE) {
    console.error('ไม่พบ APP_CONFIG.API_BASE');
  }

  function buildUrl(path, params) {
    const base = API_BASE.replace(/\/+$/, '');
    const url = new URL(base + path);

    if (params && typeof params === 'object') {
      Object.keys(params).forEach((key) => {
        const value = params[key];

        if (value !== undefined && value !== null && String(value).trim() !== '') {
          url.searchParams.set(key, value);
        }
      });
    }

    return url.toString();
  }

  async function requestJson(path, options) {
    const opts = options || {};
    const url = buildUrl(path, opts.params);

    const fetchOptions = {
      method: opts.method || 'GET',
      headers: {
        'Accept': 'application/json'
      }
    };

    if (opts.body) {
      fetchOptions.headers['Content-Type'] = 'application/json; charset=utf-8';
      fetchOptions.body = JSON.stringify(opts.body);
    }

    const res = await fetch(url, fetchOptions);
    const text = await res.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error('API ไม่ได้ส่ง JSON กลับมา: ' + text.slice(0, 300));
    }

    if (!res.ok || data.ok === false) {
      throw new Error(data.message || 'เกิดข้อผิดพลาดจาก API');
    }

    return data;
  }

  function downloadFile(path, params) {
    const url = buildUrl(path, params);
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function getHealth() {
    return requestJson('/api/health');
  }

  function getOptions() {
    return requestJson('/api/options');
  }

  function getDoors() {
    return requestJson('/api/doors');
  }

  function getChecklist() {
    return requestJson('/api/checklist');
  }

  function getDailyStatus(date) {
    return requestJson('/api/daily-status', {
      params: { date }
    });
  }

  function getLatest(doorId) {
    return requestJson('/api/latest', {
      params: { doorId }
    });
  }

  function getHistory(doorId, limit) {
    return requestJson('/api/history', {
      params: {
        doorId,
        limit: limit || 20
      }
    });
  }

  function getMonthlyReport(doorId, month) {
    return requestJson('/api/monthly-report', {
      params: { doorId, month }
    });
  }

  function getMonthlyReportAll(month) {
    return requestJson('/api/monthly-report-all', {
      params: { month }
    });
  }

  function saveInspection(payload) {
    return requestJson('/api/save', {
      method: 'POST',
      body: payload
    });
  }

  function exportCsv(month) {
    downloadFile('/api/export-csv', { month });
  }

  function exportExcel(month) {
    downloadFile('/api/export-excel', { month });
  }

  window.FireExitAPI = {
    buildUrl,
    requestJson,
    downloadFile,

    getHealth,
    getOptions,
    getDoors,
    getChecklist,
    getDailyStatus,
    getLatest,
    getHistory,
    getMonthlyReport,
    getMonthlyReportAll,
    saveInspection,
    exportCsv,
    exportExcel
  };
})();
