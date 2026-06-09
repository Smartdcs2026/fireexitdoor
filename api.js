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

    const res = await fetch(url, fetchOptions);
    const text = await res.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error('API ไม่ได้ส่ง JSON กลับมา: ' + text.slice(0, 300));
    }

    if (!res.ok || data.ok === false) {
      throw new Error(data.message || data.error || 'เกิดข้อผิดพลาดจาก API');
    }

    return data;
  }

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

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json, application/octet-stream, */*'
    }
  });

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
    detail: 'ระบบกำลังสร้างไฟล์ Excel กรุณารอสักครู่...'
  });

  if (contentType.includes('application/json') || contentType.includes('text/plain')) {
    const text = await res.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error('Export API ไม่ได้ส่ง JSON หรือไฟล์กลับมา: ' + text.slice(0, 300));
    }

    if (!data || data.ok === false) {
      throw new Error((data && (data.message || data.error)) || 'ส่งออกไฟล์ไม่สำเร็จ');
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
function formatBytes(bytes) {
  const n = Number(bytes || 0);

  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;

  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
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
  /************************************************************
   * API Functions
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
    return requestJson('/api/save', {
      method: 'POST',
      body: payload
    });
  }

  async function exportCsv(month) {
    if (!month) {
      throw new Error('กรุณาระบุเดือนสำหรับ Export CSV');
    }

    return requestFile(
      '/api/export-csv',
      { month },
      `FireExitDoor_Report_${month}.csv`,
      'text/csv;charset=utf-8'
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
   * Expose API
   ************************************************************/

  window.FireExitAPI = {
  buildUrl,
  requestJson,
  requestFile,
  downloadBase64File,
  downloadBlob,

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


