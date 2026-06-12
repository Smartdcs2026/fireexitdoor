/************************************************************
 * api.js
 * ฟังก์ชันกลางสำหรับเรียก Cloudflare Worker API
 ************************************************************/

(function () {
  'use strict';

  const CONFIG = window.APP_CONFIG || {};
  const API_BASE = CONFIG.API_BASE || '';

  const DEFAULT_TIMEOUT_MS = 60000;
  const SAVE_TIMEOUT_MS = 70000;
  const MAX_SAVE_PAYLOAD_BYTES = 4 * 1024 * 1024;

  if (!API_BASE) {
    console.error('ไม่พบ APP_CONFIG.API_BASE');
  }

  /************************************************************
   * URL / Request Helpers
   ************************************************************/

  function buildUrl(path, params) {
    const base = String(API_BASE || '').replace(/\/+$/, '');
    const cleanPath = String(path || '').startsWith('/')
      ? String(path || '')
      : '/' + String(path || '');

    const url = new URL(base + cleanPath);

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
    const timeoutMs = Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS);

    const fetchOptions = {
      method: opts.method || 'GET',
      headers: {
        Accept: 'application/json'
      }
    };

    if (opts.body) {
      fetchOptions.headers['Content-Type'] = 'application/json; charset=utf-8';
      fetchOptions.body = JSON.stringify(opts.body);
    }

    const res = await fetchWithTimeout(url, fetchOptions, timeoutMs);
    const text = await res.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error('API ไม่ได้ส่ง JSON กลับมา: ' + text.slice(0, 500));
    }

    if (!res.ok || data.ok === false) {
      throw new Error(extractApiErrorMessage(data, res.status));
    }

    return data;
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch (err) {}
  }, timeoutMs || DEFAULT_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...(options || {}),
      signal: controller.signal
    });

  } catch (err) {
    const name = String(err && err.name || '').toLowerCase();
    const message = String(err && err.message || err || '').toLowerCase();

    if (name === 'aborterror' || message.includes('abort')) {
      throw new Error('เชื่อมต่อระบบนานเกินไป กรุณารอสักครู่แล้วลองใหม่');
    }

    if (
      message.includes('failed to fetch') ||
      message.includes('network') ||
      message.includes('load failed')
    ) {
      throw new Error('เชื่อมต่อ Worker/API ไม่สำเร็จชั่วคราว กรุณาลองใหม่ หรือรอระบบ Export ทำงานต่อ');
    }

    throw new Error(err.message || 'เชื่อมต่อ API ไม่สำเร็จ');

  } finally {
    clearTimeout(timer);
  }
}

  function extractApiErrorMessage(data, status) {
    if (!data) {
      return `เกิดข้อผิดพลาดจาก API (${status || '-'})`;
    }

    if (data.message) return data.message;
    if (data.error) return data.error;

    if (data.data && data.data.message) return data.data.message;
    if (data.data && data.data.error) return data.data.error;

    if (data.raw) {
      return 'API ส่งข้อมูลผิดรูปแบบ: ' + String(data.raw).slice(0, 300);
    }

    return `เกิดข้อผิดพลาดจาก API (${status || '-'})`;
  }

  function getPayloadSizeBytes(payload) {
    try {
      return new TextEncoder().encode(JSON.stringify(payload || {})).length;
    } catch (err) {
      return 0;
    }
  }

  function validateSavePayload(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('ไม่พบข้อมูลสำหรับบันทึก');
    }

    if (!String(payload.doorId || '').trim()) {
      throw new Error('ไม่พบหมายเลขประตูหนีไฟ');
    }

    if (!String(payload.inspector || '').trim()) {
      throw new Error('ไม่พบชื่อผู้บันทึก');
    }

    if (!String(payload.sealNo || '').trim()) {
      throw new Error('ไม่พบหมายเลขซีล');
    }

    if (!Array.isArray(payload.items) || !payload.items.length) {
      throw new Error('ไม่พบรายการตรวจ');
    }

    const gps = payload.gps || {};

    if (!String(gps.lat || '').trim() || !String(gps.lng || '').trim()) {
      throw new Error('ไม่พบข้อมูล GPS กรุณาเปิด GPS ก่อนบันทึก');
    }

    const evidence = payload.evidenceImage || {};

    if (!String(evidence.base64 || '').trim()) {
      throw new Error('ไม่พบภาพหลักฐาน กรุณาถ่ายภาพก่อนบันทึก');
    }

    const size = getPayloadSizeBytes(payload);

    if (size > MAX_SAVE_PAYLOAD_BYTES) {
      throw new Error(`ข้อมูลที่ส่งใหญ่เกินไป (${formatBytes(size)}) กรุณาถ่ายภาพใหม่หรือบีบอัดภาพให้เล็กลง`);
    }

    return true;
  }

  /************************************************************
   * File Request Helper
   * ใช้กับ export-csv / export-excel แบบเดิม
   ************************************************************/

  async function requestFile(path, params, fallbackFilename, fallbackMimeType, onProgress) {
    const reportProgress = typeof onProgress === 'function'
      ? onProgress
      : function () {};

    const url = buildUrl(path, params);

    reportProgress({
      step: 'connecting',
      percent: 5,
      title: 'กำลังเชื่อมต่อระบบ',
      detail: 'กำลังส่งคำขอไปยังระบบรายงาน...'
    });

    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json, application/octet-stream, */*'
      }
    }, DEFAULT_TIMEOUT_MS);

    const contentType = res.headers.get('content-type') || '';
    const contentLength = Number(res.headers.get('content-length') || 0);

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(errorText.slice(0, 500) || 'ส่งออกไฟล์ไม่สำเร็จ');
    }

    reportProgress({
      step: 'preparing',
      percent: 15,
      title: 'กำลังสร้างไฟล์',
      detail: 'ระบบกำลังสร้างไฟล์ กรุณารอสักครู่...'
    });

    /*
     * กรณี Worker/GAS ส่ง JSON base64 กลับมา
     */
    if (contentType.includes('application/json') || contentType.includes('text/plain')) {
      const text = await res.text();

      let data;

      try {
        data = JSON.parse(text);
      } catch (err) {
        throw new Error('Export API ไม่ได้ส่ง JSON หรือไฟล์กลับมา: ' + text.slice(0, 300));
      }

      if (!data || data.ok === false) {
        throw new Error(extractApiErrorMessage(data, res.status) || 'ส่งออกไฟล์ไม่สำเร็จ');
      }

      if (!data.base64) {
        throw new Error('ไม่พบข้อมูล base64 สำหรับดาวน์โหลดไฟล์');
      }

      reportProgress({
        step: 'converting',
        percent: 80,
        title: 'กำลังเตรียมไฟล์ดาวน์โหลด',
        detail: 'ได้รับข้อมูลไฟล์แล้ว กำลังแปลงเป็นไฟล์สำหรับดาวน์โหลด...'
      });

      const filename = data.filename || fallbackFilename || 'download';
      const mimeType = data.mimeType || fallbackMimeType || 'application/octet-stream';

      downloadBase64File(data.base64, filename, mimeType);

      reportProgress({
        step: 'done',
        percent: 100,
        title: 'ดาวน์โหลดสำเร็จ',
        detail: `ดาวน์โหลดไฟล์ ${filename} เรียบร้อยแล้ว`
      });

      return data;
    }

    /*
     * กรณี Worker ส่งไฟล์จริงกลับมา
     */
    const filename = getFilenameFromResponse(res) || fallbackFilename || 'download';

    let blob;

    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;

      while (true) {
        const read = await reader.read();

        if (read.done) break;

        chunks.push(read.value);
        received += read.value.length;

        if (contentLength > 0) {
          const downloadPercent = Math.min(95, Math.round((received / contentLength) * 75) + 20);

          reportProgress({
            step: 'downloading',
            percent: downloadPercent,
            title: 'กำลังดาวน์โหลดไฟล์',
            detail: `ดาวน์โหลดแล้ว ${formatBytes(received)} จาก ${formatBytes(contentLength)}`
          });
        } else {
          reportProgress({
            step: 'downloading',
            percent: 50,
            title: 'กำลังดาวน์โหลดไฟล์',
            detail: `ดาวน์โหลดแล้ว ${formatBytes(received)}`
          });
        }
      }

      blob = new Blob(chunks, {
        type: contentType || fallbackMimeType || 'application/octet-stream'
      });

    } else {
      blob = await res.blob();

      reportProgress({
        step: 'downloading',
        percent: 85,
        title: 'กำลังดาวน์โหลดไฟล์',
        detail: `ได้รับไฟล์แล้ว ${formatBytes(blob.size)}`
      });
    }

    if (!blob || !blob.size) {
      throw new Error('ไฟล์ที่ส่งออกมีขนาดว่าง');
    }

    reportProgress({
      step: 'saving',
      percent: 96,
      title: 'กำลังบันทึกไฟล์',
      detail: 'กำลังเปิดหน้าต่างดาวน์โหลดไฟล์...'
    });

    downloadBlob(blob, filename);

    reportProgress({
      step: 'done',
      percent: 100,
      title: 'ดาวน์โหลดสำเร็จ',
      detail: `ดาวน์โหลดไฟล์ ${filename} เรียบร้อยแล้ว`
    });

    return {
      ok: true,
      filename,
      mimeType: blob.type || fallbackMimeType || 'application/octet-stream',
      size: blob.size
    };
  }

  function getFilenameFromResponse(res) {
    const disposition = res.headers.get('content-disposition') || '';

    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match && utf8Match[1]) {
      try {
        return decodeURIComponent(utf8Match[1].replace(/"/g, '').trim());
      } catch (err) {
        return utf8Match[1].replace(/"/g, '').trim();
      }
    }

    const normalMatch = disposition.match(/filename="?([^"]+)"?/i);
    if (normalMatch && normalMatch[1]) {
      return normalMatch[1].trim();
    }

    return '';
  }

  /************************************************************
   * Download Helpers
   ************************************************************/

  function downloadBase64File(base64, filename, mimeType) {
    const cleanBase64 = String(base64 || '').replace(/\s/g, '');

    if (!cleanBase64) {
      throw new Error('ไม่พบข้อมูลไฟล์สำหรับดาวน์โหลด');
    }

    let byteCharacters;

    try {
      byteCharacters = atob(cleanBase64);
    } catch (err) {
      throw new Error('base64 ของไฟล์ไม่ถูกต้อง');
    }

    const byteArrays = [];

    for (let offset = 0; offset < byteCharacters.length; offset += 1024) {
      const slice = byteCharacters.slice(offset, offset + 1024);
      const byteNumbers = new Array(slice.length);

      for (let i = 0; i < slice.length; i++) {
        byteNumbers[i] = slice.charCodeAt(i);
      }

      byteArrays.push(new Uint8Array(byteNumbers));
    }

    const blob = new Blob(byteArrays, {
      type: mimeType || 'application/octet-stream'
    });

    downloadBlob(blob, filename || 'download');
  }

  function downloadBlob(blob, filename) {
    if (!blob || !blob.size) {
      throw new Error('ไฟล์ที่ดาวน์โหลดมีขนาดว่าง');
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    a.href = url;
    a.download = filename || 'download';
    a.style.display = 'none';

    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  }

  function openDownloadUrl(url) {
    const cleanUrl = String(url || '').trim();

    if (!cleanUrl) {
      throw new Error('ไม่พบลิงก์ดาวน์โหลดไฟล์');
    }

    const a = document.createElement('a');
    a.href = cleanUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.display = 'none';

    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      a.remove();
    }, 500);
  }

  function formatBytes(bytes) {
    const n = Number(bytes || 0);

    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;

    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  /************************************************************
   * Basic API Functions
   ************************************************************/

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
    validateSavePayload(payload);

    return requestJson('/api/save', {
      method: 'POST',
      body: payload,
      timeoutMs: SAVE_TIMEOUT_MS
    });
  }

  /************************************************************
   * Evidence Cleanup API
   ************************************************************/

  function cleanupEvidence() {
    return requestJson('/api/cleanup-evidence', {
      timeoutMs: DEFAULT_TIMEOUT_MS
    });
  }

  function setupEvidenceCleanupTrigger() {
    return requestJson('/api/setup-evidence-cleanup-trigger', {
      timeoutMs: DEFAULT_TIMEOUT_MS
    });
  }

  /************************************************************
   * Export แบบเดิม
   ************************************************************/

  async function exportCsv(month, onProgress) {
    if (!month) {
      throw new Error('กรุณาระบุเดือนสำหรับ Export CSV');
    }

    return requestFile(
      '/api/export-csv',
      { month },
      `FireExitDoor_Report_${month}.csv`,
      'text/csv;charset=utf-8',
      onProgress
    );
  }

  async function exportExcel(month, onProgress) {
    if (!month) {
      throw new Error('กรุณาระบุเดือนสำหรับ Export Excel');
    }

    return requestFile(
      '/api/export-excel',
      { month },
      `FireExitDoor_Report_${month}.xlsx`,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      onProgress
    );
  }

  /************************************************************
   * Export Excel แบบ Job ใหม่
   ************************************************************/

  function startExportJob(month) {
    if (!month) {
      throw new Error('กรุณาระบุเดือนสำหรับเริ่ม Export Job');
    }

    return requestJson('/api/export-job-start', {
      params: { month },
      timeoutMs: DEFAULT_TIMEOUT_MS
    });
  }

  function getExportJobStatus(jobId) {
    if (!jobId) {
      throw new Error('กรุณาระบุ jobId สำหรับตรวจสถานะ Export');
    }

    return requestJson('/api/export-job-status', {
      params: { jobId },
      timeoutMs: DEFAULT_TIMEOUT_MS
    });
  }

  function getExportJobDownload(jobId) {
    if (!jobId) {
      throw new Error('กรุณาระบุ jobId สำหรับดาวน์โหลดไฟล์');
    }

    return requestJson('/api/export-job-download', {
      params: { jobId },
      timeoutMs: DEFAULT_TIMEOUT_MS
    });
  }

  function cancelExportJob(jobId) {
    if (!jobId) {
      throw new Error('กรุณาระบุ jobId สำหรับยกเลิก Export');
    }

    return requestJson('/api/export-job-cancel', {
      params: { jobId },
      timeoutMs: DEFAULT_TIMEOUT_MS
    });
  }

  async function downloadExportJob(jobId) {
    const data = await getExportJobDownload(jobId);

    if (!data || !data.ok) {
      throw new Error((data && data.message) || 'ยังไม่สามารถดาวน์โหลดไฟล์ได้');
    }

    if (!data.downloadUrl) {
      throw new Error('ไม่พบลิงก์ดาวน์โหลดไฟล์');
    }

    openDownloadUrl(data.downloadUrl);

    return data;
  }

  /************************************************************
   * Expose API
   ************************************************************/

  window.FireExitAPI = {
    buildUrl,
    requestJson,
    requestFile,

    downloadBase64File,
    downloadBlob,
    openDownloadUrl,
    formatBytes,
    getPayloadSizeBytes,

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

    cleanupEvidence,
    setupEvidenceCleanupTrigger,

    exportCsv,
    exportExcel,

    startExportJob,
    getExportJobStatus,
    getExportJobDownload,
    cancelExportJob,
    downloadExportJob
  };

  /*
   * alias เผื่อไฟล์ HTML เดิมเรียก window.API
   */
  window.API = window.FireExitAPI;
})();
