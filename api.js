/************************************************************
 * api.js
 * ฟังก์ชันกลางสำหรับเรียก Cloudflare Worker API
 *
 * - ตรวจสอบ API_BASE
 * - รองรับ Timeout
 * - แสดงข้อผิดพลาดจาก Worker / Apps Script
 * - ตรวจสอบข้อมูลก่อนบันทึก
 * - ไม่ส่ง POST ซ้ำอัตโนมัติ ป้องกันข้อมูลซ้ำ
 * - รองรับ Export CSV / Excel
 * - รองรับ Export Excel แบบ Job
 * - รองรับ Debug Worker / Apps Script
 ************************************************************/

(function () {
  'use strict';

  const CONFIG = window.APP_CONFIG || {};
  const API_BASE = String(CONFIG.API_BASE || '').trim();

  const DEFAULT_TIMEOUT_MS = 60000;
  const SAVE_TIMEOUT_MS = 70000;
  const DEBUG_TIMEOUT_MS = 30000;

  const MAX_SAVE_PAYLOAD_BYTES = 4 * 1024 * 1024;
  const MAX_EVIDENCE_IMAGE_BYTES = 2 * 1024 * 1024;

  const API_VERSION = 'api-js-fire-exit-v3';

  if (!API_BASE) {
    console.error('[FireExitAPI] ไม่พบ APP_CONFIG.API_BASE');
  } else {
    console.info('[FireExitAPI] API Base:', API_BASE);
    console.info('[FireExitAPI] Version:', API_VERSION);
  }

  /************************************************************
   * URL / REQUEST HELPERS
   ************************************************************/

  function validateApiBase() {
    if (!API_BASE) {
      throw new Error(
        'ไม่พบ APP_CONFIG.API_BASE กรุณาตรวจสอบไฟล์ config.js'
      );
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(API_BASE);
    } catch (error) {
      throw new Error(
        'APP_CONFIG.API_BASE ไม่ใช่ URL ที่ถูกต้อง: ' + API_BASE
      );
    }

    if (
      parsedUrl.protocol !== 'https:' &&
      parsedUrl.protocol !== 'http:'
    ) {
      throw new Error(
        'APP_CONFIG.API_BASE ต้องขึ้นต้นด้วย https:// หรือ http://'
      );
    }

    return true;
  }

  function buildUrl(path, params) {
    validateApiBase();

    const base = API_BASE.replace(/\/+$/, '');
    const rawPath = String(path || '').trim();

    const cleanPath = rawPath.startsWith('/')
      ? rawPath
      : '/' + rawPath;

    const url = new URL(base + cleanPath);

    if (params && typeof params === 'object') {
      Object.keys(params).forEach(function (key) {
        const value = params[key];

        if (
          value !== undefined &&
          value !== null &&
          String(value).trim() !== ''
        ) {
          url.searchParams.set(key, String(value));
        }
      });
    }

    return url.toString();
  }

  async function requestJson(path, options) {
    const opts = options || {};
    const method = String(opts.method || 'GET').toUpperCase();
    const url = buildUrl(path, opts.params);
    const timeoutMs = Number(
      opts.timeoutMs || DEFAULT_TIMEOUT_MS
    );

    const fetchOptions = {
      method: method,
      cache: 'no-store',
      headers: {
        Accept: 'application/json'
      }
    };

    if (
      opts.headers &&
      typeof opts.headers === 'object'
    ) {
      Object.assign(
        fetchOptions.headers,
        opts.headers
      );
    }

    if (
      opts.body !== undefined &&
      opts.body !== null
    ) {
      fetchOptions.headers['Content-Type'] =
        'application/json; charset=utf-8';

      fetchOptions.body =
        JSON.stringify(opts.body);
    }

    const startedAt = Date.now();

    let response;

    try {
      response = await fetchWithTimeout(
        url,
        fetchOptions,
        timeoutMs
      );
    } catch (error) {
      const elapsedMs =
        Date.now() - startedAt;

      console.error(
        '[FireExitAPI] Network request failed',
        {
          method: method,
          url: url,
          path: path,
          elapsedMs: elapsedMs,
          errorName: error && error.name,
          errorMessage: error && error.message,
          error: error
        }
      );

      throw createNetworkError(error, {
        method: method,
        url: url,
        path: path,
        elapsedMs: elapsedMs
      });
    }

    const elapsedMs =
      Date.now() - startedAt;

    const responseText =
      await safeReadResponseText(response);

    let data = {};

    if (responseText) {
      try {
        data = JSON.parse(responseText);
      } catch (error) {
        console.error(
          '[FireExitAPI] Invalid JSON response',
          {
            method: method,
            url: url,
            path: path,
            status: response.status,
            contentType:
              response.headers.get(
                'content-type'
              ) || '',
            elapsedMs: elapsedMs,
            response:
              responseText.slice(0, 1000)
          }
        );

        throw new Error(
          [
            'API ไม่ได้ส่ง JSON กลับมา',
            'HTTP ' +
              (response.status || '-'),
            'ปลายทาง: ' + path,
            responseText
              ? 'ข้อมูลตอบกลับ: ' +
                responseText.slice(0, 500)
              : 'ไม่มีข้อมูลตอบกลับ'
          ].join('\n')
        );
      }
    }

    if (
      !response.ok ||
      data.ok === false
    ) {
      const message =
        extractApiErrorMessage(
          data,
          response.status
        );

      const error =
        new Error(message);

      error.name = 'ApiResponseError';
      error.status = response.status;
      error.statusText =
        response.statusText;
      error.url = url;
      error.path = path;
      error.method = method;
      error.elapsedMs = elapsedMs;
      error.responseData = data;

      console.error(
        '[FireExitAPI] API returned error',
        {
          method: method,
          url: url,
          path: path,
          status: response.status,
          statusText:
            response.statusText,
          elapsedMs: elapsedMs,
          data: data
        }
      );

      throw error;
    }

    console.info(
      '[FireExitAPI] Request success',
      {
        method: method,
        path: path,
        status: response.status,
        elapsedMs: elapsedMs
      }
    );

    return data;
  }

  async function fetchWithTimeout(
    url,
    options,
    timeoutMs
  ) {
    const controller =
      new AbortController();

    const timeout = Math.max(
      1000,
      Number(
        timeoutMs || DEFAULT_TIMEOUT_MS
      )
    );

    let timedOut = false;

    const timer = setTimeout(
      function () {
        timedOut = true;

        try {
          controller.abort();
        } catch (error) {
          console.warn(
            '[FireExitAPI] Abort failed',
            error
          );
        }
      },
      timeout
    );

    try {
      return await fetch(url, {
        ...(options || {}),
        signal: controller.signal
      });
    } catch (error) {
      const name = String(
        error && error.name || ''
      ).toLowerCase();

      const message = String(
        error && error.message ||
        error ||
        ''
      ).toLowerCase();

      if (
        timedOut ||
        name === 'aborterror' ||
        message.includes('abort')
      ) {
        const timeoutError =
          new Error(
            'เชื่อมต่อระบบนานเกินเวลาที่กำหนด'
          );

        timeoutError.name =
          'RequestTimeoutError';

        timeoutError.timeoutMs =
          timeout;

        throw timeoutError;
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function safeReadResponseText(
    response
  ) {
    try {
      return await response.text();
    } catch (error) {
      console.error(
        '[FireExitAPI] อ่านข้อมูลตอบกลับไม่สำเร็จ',
        error
      );

      return '';
    }
  }

  function createNetworkError(
    error,
    context
  ) {
    const ctx = context || {};

    const name = String(
      error && error.name || ''
    ).toLowerCase();

    const rawMessage = String(
      error && error.message ||
      error ||
      ''
    );

    const lowerMessage =
      rawMessage.toLowerCase();

    let userMessage = '';

    if (
      name === 'requesttimeouterror' ||
      name === 'aborterror' ||
      lowerMessage.includes('นานเกิน') ||
      lowerMessage.includes('timeout') ||
      lowerMessage.includes('abort')
    ) {
      userMessage =
        'เชื่อมต่อระบบนานเกินไป อาจเกิดจาก Apps Script ใช้เวลาประมวลผลนาน หรือสัญญาณอินเทอร์เน็ตไม่เสถียร';
    } else if (
      lowerMessage.includes(
        'failed to fetch'
      ) ||
      lowerMessage.includes(
        'networkerror'
      ) ||
      lowerMessage.includes(
        'network error'
      ) ||
      lowerMessage.includes(
        'load failed'
      )
    ) {
      userMessage =
        'เบราว์เซอร์เชื่อมต่อ Cloudflare Worker ไม่สำเร็จ อาจเกิดจากอินเทอร์เน็ต CORS หรือ URL ของ Worker ไม่ถูกต้อง';
    } else {
      userMessage =
        rawMessage ||
        'เชื่อมต่อ Worker/API ไม่สำเร็จ';
    }

    const nextError =
      new Error(userMessage);

    nextError.name =
      'ApiNetworkError';

    nextError.originalError =
      error;

    nextError.url =
      ctx.url || '';

    nextError.path =
      ctx.path || '';

    nextError.method =
      ctx.method || '';

    nextError.elapsedMs =
      ctx.elapsedMs || 0;

    return nextError;
  }

  function extractApiErrorMessage(
    data,
    status
  ) {
    if (!data) {
      return (
        'เกิดข้อผิดพลาดจาก API (HTTP ' +
        (status || '-') +
        ')'
      );
    }

    const candidates = [
      data.message,
      data.error,
      data.detail,
      data.reason,
      data.data &&
        data.data.message,
      data.data &&
        data.data.error,
      data.data &&
        data.data.detail,
      data.gasResponse &&
        data.gasResponse.message,
      data.gasResponse &&
        data.gasResponse.error
    ];

    for (
      let index = 0;
      index < candidates.length;
      index++
    ) {
      const text =
        cleanText(candidates[index]);

      if (text) {
        return text;
      }
    }

    if (data.raw) {
      return (
        'API ส่งข้อมูลผิดรูปแบบ: ' +
        String(data.raw).slice(0, 500)
      );
    }

    return (
      'เกิดข้อผิดพลาดจาก API (HTTP ' +
      (status || '-') +
      ')'
    );
  }

  /************************************************************
   * TEXT / SIZE HELPERS
   ************************************************************/

  function cleanText(value) {
    if (
      value === null ||
      value === undefined
    ) {
      return '';
    }

    return String(value).trim();
  }

  function getTextByteSize(text) {
    try {
      return new TextEncoder()
        .encode(String(text || ''))
        .length;
    } catch (error) {
      return String(text || '').length;
    }
  }

  function getPayloadSizeBytes(
    payload
  ) {
    try {
      return getTextByteSize(
        JSON.stringify(payload || {})
      );
    } catch (error) {
      return 0;
    }
  }

  function estimateBase64Bytes(
    base64Text
  ) {
    let text =
      cleanText(base64Text);

    if (text.includes(',')) {
      text = text.split(',').pop();
    }

    text = text.replace(/\s/g, '');

    if (!text) {
      return 0;
    }

    const padding =
      text.endsWith('==')
        ? 2
        : text.endsWith('=')
          ? 1
          : 0;

    return Math.max(
      0,
      Math.floor(
        (text.length * 3) / 4
      ) - padding
    );
  }

  function formatBytes(bytes) {
    const value =
      Number(bytes || 0);

    if (value < 1024) {
      return value + ' B';
    }

    if (
      value <
      1024 * 1024
    ) {
      return (
        (value / 1024).toFixed(1) +
        ' KB'
      );
    }

    return (
      (
        value /
        1024 /
        1024
      ).toFixed(2) +
      ' MB'
    );
  }

  /************************************************************
   * SAVE PAYLOAD
   ************************************************************/

  function normalizeInspectSource(
    value
  ) {
    const text =
      cleanText(value).toLowerCase();

    if (
      text === 'qr' ||
      text === 'qrcode' ||
      text === 'qr_code'
    ) {
      return 'qr';
    }

    if (
      text === 'home' ||
      text === 'index' ||
      text === 'dashboard'
    ) {
      return 'home';
    }

    if (text === 'manual') {
      return 'manual';
    }

    return text || 'manual';
  }

  function getGpsStatusForPayload(
    gps
  ) {
    if (
      !gps ||
      !cleanText(gps.lat) ||
      !cleanText(gps.lng)
    ) {
      return 'GPS_UNAVAILABLE';
    }

    const accuracy =
      Number(gps.accuracy || 0);

    if (
      Number.isFinite(accuracy) &&
      accuracy > 100
    ) {
      return 'GPS_LOW_ACCURACY';
    }

    return 'GPS_OK';
  }

  function createClientRequestId() {
    const randomPart =
      Math.random()
        .toString(36)
        .slice(2, 10)
        .toUpperCase();

    return [
      'FE',
      Date.now(),
      randomPart
    ].join('-');
  }

  function normalizeSavePayload(
    payload
  ) {
    const source =
      payload &&
      typeof payload === 'object'
        ? payload
        : {};

    const next = {
      ...source
    };

    next.doorId =
      cleanText(source.doorId);

    next.location =
      cleanText(source.location);

    next.sealNo =
      cleanText(source.sealNo);

    next.inspector =
      cleanText(source.inspector);

    next.device = cleanText(
      source.device ||
      (
        typeof navigator !== 'undefined'
          ? navigator.userAgent
          : ''
      )
    );

    next.inspectSource =
      normalizeInspectSource(
        source.inspectSource ||
        source.source ||
        source.formSource ||
        ''
      );

    next.clientRequestId =
      cleanText(
        source.clientRequestId
      ) ||
      createClientRequestId();

    const sourceGps =
      source.gps &&
      typeof source.gps === 'object'
        ? source.gps
        : {};

    next.gps = {
      lat: cleanText(
        sourceGps.lat
      ),
      lng: cleanText(
        sourceGps.lng
      ),
      accuracy: cleanText(
        sourceGps.accuracy
      ),
      timestamp: cleanText(
        sourceGps.timestamp
      ),
      status:
        getGpsStatusForPayload(
          sourceGps
        )
    };

    const sourceEvidence =
      source.evidenceImage &&
      typeof source.evidenceImage ===
        'object'
        ? source.evidenceImage
        : {};

    next.evidenceImage = {
      base64: cleanText(
        sourceEvidence.base64
      ),
      mimeType:
        cleanText(
          sourceEvidence.mimeType
        ) ||
        'image/jpeg',
      filename:
        cleanText(
          sourceEvidence.filename
        ) ||
        (
          'fire_exit_evidence_' +
          Date.now() +
          '.jpg'
        )
    };

    next.items =
      Array.isArray(source.items)
        ? source.items.map(
            function (item, index) {
              const row =
                item &&
                typeof item === 'object'
                  ? item
                  : {};

              const no =
                row.no || index + 1;

              const value =
                cleanText(row.value);

              const detail =
                cleanText(row.detail);

              const isAbnormal =
                row.isAbnormal === true ||
                value === 'ผิดปกติ';

              let finalText =
                cleanText(
                  row.finalText
                );

              if (!finalText) {
                finalText = value;

                if (
                  isAbnormal &&
                  detail
                ) {
                  finalText +=
                    ' - ' + detail;
                }
              }

              return {
                no: no,
                title:
                  cleanText(row.title),
                value: value,
                detail: detail,
                finalText:
                  finalText,
                isAbnormal:
                  isAbnormal
              };
            }
          )
        : [];

    return next;
  }

  function validateSavePayload(
    payload
  ) {
    if (
      !payload ||
      typeof payload !== 'object'
    ) {
      throw new Error(
        'ไม่พบข้อมูลสำหรับบันทึก'
      );
    }

    const missing = [];

    const doorId =
      cleanText(payload.doorId);

    const inspector =
      cleanText(payload.inspector);

    const sealNo =
      cleanText(payload.sealNo);

    if (!doorId) {
      missing.push(
        'หมายเลขประตูหนีไฟ'
      );
    }

    if (!inspector) {
      missing.push(
        'ชื่อผู้บันทึก'
      );
    }

    if (!sealNo) {
      missing.push(
        'หมายเลขซีล'
      );
    }

    if (missing.length) {
      throw new Error(
        'กรุณากรอกข้อมูลให้ครบ:\n- ' +
        missing.join('\n- ')
      );
    }

    if (
      !/^[0-9]+$/.test(sealNo)
    ) {
      throw new Error(
        'หมายเลขซีลต้องเป็นตัวเลขเท่านั้น'
      );
    }

    const gps =
      payload.gps || {};

    if (
      !cleanText(gps.lat) ||
      !cleanText(gps.lng)
    ) {
      throw new Error(
        'กรุณาเปิด GPS และอนุญาตตำแหน่งก่อนบันทึก'
      );
    }

    const lat =
      Number(gps.lat);

    const lng =
      Number(gps.lng);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng)
    ) {
      throw new Error(
        'ข้อมูล GPS ไม่ถูกต้อง กรุณากดเปิด GPS ใหม่อีกครั้ง'
      );
    }

    if (
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      throw new Error(
        'ค่าพิกัด GPS ผิดรูปแบบ กรุณากดเปิด GPS ใหม่อีกครั้ง'
      );
    }

    payload.gps.status =
      getGpsStatusForPayload(gps);

    const evidence =
      payload.evidenceImage || {};

    const evidenceBase64 =
      cleanText(
        evidence.base64
      );

    if (!evidenceBase64) {
      throw new Error(
        'กรุณาถ่ายภาพหลักฐาน QR Code / ประตู / หมายเลขซีล อย่างน้อย 1 ภาพก่อนบันทึก'
      );
    }

    if (
      !evidenceBase64.startsWith(
        'data:image/'
      )
    ) {
      throw new Error(
        'รูปแบบภาพหลักฐานไม่ถูกต้อง กรุณาถ่ายภาพใหม่'
      );
    }

    const imageBytes =
      estimateBase64Bytes(
        evidenceBase64
      );

    if (
      imageBytes >
      MAX_EVIDENCE_IMAGE_BYTES
    ) {
      throw new Error(
        'ภาพหลักฐานใหญ่เกินไป (' +
        formatBytes(imageBytes) +
        ') กรุณาถ่ายภาพใหม่หรือบีบอัดภาพให้ต่ำกว่า ' +
        formatBytes(
          MAX_EVIDENCE_IMAGE_BYTES
        )
      );
    }

    if (
      !Array.isArray(payload.items) ||
      !payload.items.length
    ) {
      throw new Error(
        'ไม่พบรายการตรวจ กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง'
      );
    }

    const incomplete = [];
    const abnormalWithoutDetail = [];

    payload.items.forEach(
      function (item, index) {
        const no =
          item && item.no
            ? item.no
            : index + 1;

        const title =
          cleanText(
            item && item.title
          ) ||
          'ข้อ ' + no;

        const value =
          cleanText(
            item && item.value
          );

        const isAbnormal =
          !!(
            item &&
            item.isAbnormal
          ) ||
          value === 'ผิดปกติ';

        if (!value) {
          incomplete.push(
            no + '. ' + title
          );
        }

        if (
          isAbnormal &&
          !cleanText(
            item && item.detail
          )
        ) {
          abnormalWithoutDetail.push(
            no + '. ' + title
          );
        }
      }
    );

    if (incomplete.length) {
      throw new Error(
        'กรุณาเลือกผลตรวจให้ครบทุกข้อ:\n- ' +
        incomplete
          .slice(0, 10)
          .join('\n- ')
      );
    }

    if (
      abnormalWithoutDetail.length
    ) {
      throw new Error(
        'รายการที่ผิดปกติต้องกรอกรายละเอียด:\n- ' +
        abnormalWithoutDetail
          .slice(0, 10)
          .join('\n- ')
      );
    }

    const payloadSize =
      getPayloadSizeBytes(payload);

    if (
      payloadSize >
      MAX_SAVE_PAYLOAD_BYTES
    ) {
      throw new Error(
        'ข้อมูลที่ส่งใหญ่เกินไป (' +
        formatBytes(payloadSize) +
        ') กรุณาถ่ายภาพใหม่หรือบีบอัดภาพให้เล็กลง'
      );
    }

    return {
      ok: true,
      payloadSize: payloadSize,
      imageSize: imageBytes
    };
  }

  /************************************************************
   * FILE REQUEST
   ************************************************************/

  async function requestFile(
    path,
    params,
    fallbackFilename,
    fallbackMimeType,
    onProgress
  ) {
    const reportProgress =
      typeof onProgress === 'function'
        ? onProgress
        : function () {};

    const url =
      buildUrl(path, params);

    reportProgress({
      step: 'connecting',
      percent: 5,
      title:
        'กำลังเชื่อมต่อระบบ',
      detail:
        'กำลังส่งคำขอไปยังระบบรายงาน...'
    });

    let response;

    try {
      response =
        await fetchWithTimeout(
          url,
          {
            method: 'GET',
            cache: 'no-store',
            headers: {
              Accept:
                'application/json, application/octet-stream, */*'
            }
          },
          DEFAULT_TIMEOUT_MS
        );
    } catch (error) {
      throw createNetworkError(
        error,
        {
          method: 'GET',
          url: url,
          path: path
        }
      );
    }

    const contentType =
      response.headers.get(
        'content-type'
      ) || '';

    const contentLength =
      Number(
        response.headers.get(
          'content-length'
        ) || 0
      );

    if (!response.ok) {
      const errorText =
        await safeReadResponseText(
          response
        );

      let errorData = null;

      try {
        errorData =
          JSON.parse(errorText);
      } catch (error) {}

      throw new Error(
        errorData
          ? extractApiErrorMessage(
              errorData,
              response.status
            )
          : (
              errorText.slice(0, 500) ||
              (
                'ส่งออกไฟล์ไม่สำเร็จ HTTP ' +
                response.status
              )
            )
      );
    }

    reportProgress({
      step: 'preparing',
      percent: 15,
      title: 'กำลังสร้างไฟล์',
      detail:
        'ระบบกำลังสร้างไฟล์ กรุณารอสักครู่...'
    });

    if (
      contentType.includes(
        'application/json'
      ) ||
      contentType.includes(
        'text/plain'
      )
    ) {
      const text =
        await safeReadResponseText(
          response
        );

      let data;

      try {
        data = JSON.parse(text);
      } catch (error) {
        throw new Error(
          'Export API ไม่ได้ส่ง JSON หรือไฟล์กลับมา: ' +
          text.slice(0, 300)
        );
      }

      if (
        !data ||
        data.ok === false
      ) {
        throw new Error(
          extractApiErrorMessage(
            data,
            response.status
          )
        );
      }

      if (!data.base64) {
        throw new Error(
          'ไม่พบข้อมูล base64 สำหรับดาวน์โหลดไฟล์'
        );
      }

      reportProgress({
        step: 'converting',
        percent: 80,
        title:
          'กำลังเตรียมไฟล์ดาวน์โหลด',
        detail:
          'ได้รับข้อมูลไฟล์แล้ว กำลังแปลงเป็นไฟล์สำหรับดาวน์โหลด...'
      });

      const filename =
        data.filename ||
        fallbackFilename ||
        'download';

      const mimeType =
        data.mimeType ||
        fallbackMimeType ||
        'application/octet-stream';

      downloadBase64File(
        data.base64,
        filename,
        mimeType
      );

      reportProgress({
        step: 'done',
        percent: 100,
        title:
          'ดาวน์โหลดสำเร็จ',
        detail:
          'ดาวน์โหลดไฟล์ ' +
          filename +
          ' เรียบร้อยแล้ว'
      });

      return data;
    }

    const filename =
      getFilenameFromResponse(
        response
      ) ||
      fallbackFilename ||
      'download';

    let blob;

    if (
      response.body &&
      typeof response.body
        .getReader === 'function'
    ) {
      const reader =
        response.body.getReader();

      const chunks = [];
      let received = 0;

      while (true) {
        const read =
          await reader.read();

        if (read.done) {
          break;
        }

        chunks.push(read.value);
        received +=
          read.value.length;

        if (
          contentLength > 0
        ) {
          const percent =
            Math.min(
              95,
              Math.round(
                (
                  received /
                  contentLength
                ) * 75
              ) + 20
            );

          reportProgress({
            step: 'downloading',
            percent: percent,
            title:
              'กำลังดาวน์โหลดไฟล์',
            detail:
              'ดาวน์โหลดแล้ว ' +
              formatBytes(received) +
              ' จาก ' +
              formatBytes(
                contentLength
              )
          });
        } else {
          reportProgress({
            step: 'downloading',
            percent: 50,
            title:
              'กำลังดาวน์โหลดไฟล์',
            detail:
              'ดาวน์โหลดแล้ว ' +
              formatBytes(received)
          });
        }
      }

      blob = new Blob(
        chunks,
        {
          type:
            contentType ||
            fallbackMimeType ||
            'application/octet-stream'
        }
      );
    } else {
      blob =
        await response.blob();

      reportProgress({
        step: 'downloading',
        percent: 85,
        title:
          'กำลังดาวน์โหลดไฟล์',
        detail:
          'ได้รับไฟล์แล้ว ' +
          formatBytes(blob.size)
      });
    }

    if (
      !blob ||
      !blob.size
    ) {
      throw new Error(
        'ไฟล์ที่ส่งออกมีขนาดว่าง'
      );
    }

    reportProgress({
      step: 'saving',
      percent: 96,
      title: 'กำลังบันทึกไฟล์',
      detail:
        'กำลังเปิดหน้าต่างดาวน์โหลดไฟล์...'
    });

    downloadBlob(
      blob,
      filename
    );

    reportProgress({
      step: 'done',
      percent: 100,
      title:
        'ดาวน์โหลดสำเร็จ',
      detail:
        'ดาวน์โหลดไฟล์ ' +
        filename +
        ' เรียบร้อยแล้ว'
    });

    return {
      ok: true,
      filename: filename,
      mimeType:
        blob.type ||
        fallbackMimeType ||
        'application/octet-stream',
      size: blob.size
    };
  }

  function getFilenameFromResponse(
    response
  ) {
    const disposition =
      response.headers.get(
        'content-disposition'
      ) || '';

    const utf8Match =
      disposition.match(
        /filename\*=UTF-8''([^;]+)/i
      );

    if (
      utf8Match &&
      utf8Match[1]
    ) {
      try {
        return decodeURIComponent(
          utf8Match[1]
            .replace(/"/g, '')
            .trim()
        );
      } catch (error) {
        return utf8Match[1]
          .replace(/"/g, '')
          .trim();
      }
    }

    const normalMatch =
      disposition.match(
        /filename="?([^";]+)"?/i
      );

    if (
      normalMatch &&
      normalMatch[1]
    ) {
      return normalMatch[1].trim();
    }

    return '';
  }

  /************************************************************
   * DOWNLOAD HELPERS
   ************************************************************/

  function downloadBase64File(
    base64,
    filename,
    mimeType
  ) {
    let cleanBase64 =
      String(base64 || '')
        .replace(/\s/g, '');

    if (
      cleanBase64.includes(',')
    ) {
      cleanBase64 =
        cleanBase64
          .split(',')
          .pop();
    }

    if (!cleanBase64) {
      throw new Error(
        'ไม่พบข้อมูลไฟล์สำหรับดาวน์โหลด'
      );
    }

    let byteCharacters;

    try {
      byteCharacters =
        atob(cleanBase64);
    } catch (error) {
      throw new Error(
        'base64 ของไฟล์ไม่ถูกต้อง'
      );
    }

    const byteArrays = [];

    for (
      let offset = 0;
      offset <
        byteCharacters.length;
      offset += 1024
    ) {
      const slice =
        byteCharacters.slice(
          offset,
          offset + 1024
        );

      const byteNumbers =
        new Array(slice.length);

      for (
        let index = 0;
        index < slice.length;
        index++
      ) {
        byteNumbers[index] =
          slice.charCodeAt(index);
      }

      byteArrays.push(
        new Uint8Array(
          byteNumbers
        )
      );
    }

    const blob =
      new Blob(
        byteArrays,
        {
          type:
            mimeType ||
            'application/octet-stream'
        }
      );

    downloadBlob(
      blob,
      filename || 'download'
    );
  }

  function downloadBlob(
    blob,
    filename
  ) {
    if (
      !blob ||
      !blob.size
    ) {
      throw new Error(
        'ไฟล์ที่ดาวน์โหลดมีขนาดว่าง'
      );
    }

    const objectUrl =
      URL.createObjectURL(blob);

    const anchor =
      document.createElement('a');

    anchor.href = objectUrl;
    anchor.download =
      filename || 'download';

    anchor.style.display =
      'none';

    document.body.appendChild(
      anchor
    );

    anchor.click();

    setTimeout(
      function () {
        URL.revokeObjectURL(
          objectUrl
        );

        anchor.remove();
      },
      1500
    );
  }

  function openDownloadUrl(url) {
    const cleanUrl =
      cleanText(url);

    if (!cleanUrl) {
      throw new Error(
        'ไม่พบลิงก์ดาวน์โหลดไฟล์'
      );
    }

    const anchor =
      document.createElement('a');

    anchor.href = cleanUrl;
    anchor.target = '_blank';

    anchor.rel =
      'noopener noreferrer';

    anchor.style.display =
      'none';

    document.body.appendChild(
      anchor
    );

    anchor.click();

    setTimeout(
      function () {
        anchor.remove();
      },
      500
    );
  }

  /************************************************************
   * DEBUG API
   ************************************************************/

  function testWorker() {
    return requestJson(
      '/api/save-test',
      {
        timeoutMs:
          DEBUG_TIMEOUT_MS
      }
    );
  }

  function debugGas() {
    return requestJson(
      '/api/debug-gas',
      {
        timeoutMs:
          DEBUG_TIMEOUT_MS
      }
    );
  }

  async function runConnectionDiagnostics() {
    const result = {
      ok: false,
      apiBase: API_BASE,
      apiVersion: API_VERSION,
      worker: null,
      gas: null,
      health: null,
      checkedAt:
        new Date().toISOString()
    };

    try {
      result.worker =
        await testWorker();
    } catch (error) {
      result.worker = {
        ok: false,
        message:
          error && error.message
            ? error.message
            : String(error)
      };

      return result;
    }

    try {
      result.gas =
        await debugGas();
    } catch (error) {
      result.gas = {
        ok: false,
        message:
          error && error.message
            ? error.message
            : String(error)
      };

      return result;
    }

    try {
      result.health =
        await getHealth();
    } catch (error) {
      result.health = {
        ok: false,
        message:
          error && error.message
            ? error.message
            : String(error)
      };

      return result;
    }

    result.ok =
      Boolean(
        result.worker &&
        result.worker.ok &&
        result.gas &&
        result.gas.ok &&
        result.health &&
        result.health.ok
      );

    return result;
  }

  /************************************************************
   * BASIC API
   ************************************************************/

  function getHealth() {
    return requestJson(
      '/api/health'
    );
  }

  function getOptions() {
    return requestJson(
      '/api/options'
    );
  }

  function getDoors() {
    return requestJson(
      '/api/doors'
    );
  }

  function getChecklist() {
    return requestJson(
      '/api/checklist'
    );
  }

  function getDailyStatus(date) {
    return requestJson(
      '/api/daily-status',
      {
        params: {
          date: date
        }
      }
    );
  }

  function getLatest(doorId) {
    return requestJson(
      '/api/latest',
      {
        params: {
          doorId: doorId
        }
      }
    );
  }

  function getHistory(
    doorId,
    limit
  ) {
    return requestJson(
      '/api/history',
      {
        params: {
          doorId: doorId,
          limit: limit || 20
        }
      }
    );
  }

  function getMonthlyReport(
    doorId,
    month
  ) {
    return requestJson(
      '/api/monthly-report',
      {
        params: {
          doorId: doorId,
          month: month
        }
      }
    );
  }

  function getMonthlyReportAll(
    month
  ) {
    return requestJson(
      '/api/monthly-report-all',
      {
        params: {
          month: month
        }
      }
    );
  }

  async function saveInspection(
    payload
  ) {
    const normalizedPayload =
      normalizeSavePayload(
        payload
      );

    const validation =
      validateSavePayload(
        normalizedPayload
      );

    console.info(
      '[FireExitAPI] Preparing save',
      {
        doorId:
          normalizedPayload.doorId,
        inspector:
          normalizedPayload.inspector,
        inspectSource:
          normalizedPayload.inspectSource,
        clientRequestId:
          normalizedPayload.clientRequestId,
        itemCount:
          normalizedPayload.items.length,
        payloadSize:
          validation.payloadSize,
        imageSize:
          validation.imageSize
      }
    );

    /*
     * ไม่ Retry POST อัตโนมัติ
     * ป้องกัน Apps Script บันทึกข้อมูลซ้ำ
     */
    return requestJson(
      '/api/save',
      {
        method: 'POST',
        body: normalizedPayload,
        timeoutMs:
          SAVE_TIMEOUT_MS,
        headers: {
          'X-Requested-With':
            'FireExitDoorInspection'
        }
      }
    );
  }

  /************************************************************
   * EVIDENCE CLEANUP
   ************************************************************/

  function cleanupEvidence() {
    return requestJson(
      '/api/cleanup-evidence',
      {
        timeoutMs:
          DEFAULT_TIMEOUT_MS
      }
    );
  }

  function setupEvidenceCleanupTrigger() {
    return requestJson(
      '/api/setup-evidence-cleanup-trigger',
      {
        timeoutMs:
          DEFAULT_TIMEOUT_MS
      }
    );
  }

  /************************************************************
   * EXPORT CSV / EXCEL
   ************************************************************/

  async function exportCsv(
    month,
    onProgress
  ) {
    if (!cleanText(month)) {
      throw new Error(
        'กรุณาระบุเดือนสำหรับ Export CSV'
      );
    }

    return requestFile(
      '/api/export-csv',
      {
        month: month
      },
      (
        'FireExitDoor_Report_' +
        month +
        '.csv'
      ),
      'text/csv;charset=utf-8',
      onProgress
    );
  }

  async function exportExcel(
    month,
    onProgress
  ) {
    if (!cleanText(month)) {
      throw new Error(
        'กรุณาระบุเดือนสำหรับ Export Excel'
      );
    }

    return requestFile(
      '/api/export-excel',
      {
        month: month
      },
      (
        'FireExitDoor_Report_' +
        month +
        '.xlsx'
      ),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      onProgress
    );
  }

  /************************************************************
   * EXPORT JOB
   ************************************************************/

  function startExportJob(month) {
    if (!cleanText(month)) {
      throw new Error(
        'กรุณาระบุเดือนสำหรับเริ่ม Export Job'
      );
    }

    return requestJson(
      '/api/export-job-start',
      {
        params: {
          month: month
        },
        timeoutMs:
          DEFAULT_TIMEOUT_MS
      }
    );
  }

  function getExportJobStatus(
    jobId
  ) {
    if (!cleanText(jobId)) {
      throw new Error(
        'กรุณาระบุ jobId สำหรับตรวจสถานะ Export'
      );
    }

    return requestJson(
      '/api/export-job-status',
      {
        params: {
          jobId: jobId
        },
        timeoutMs:
          DEFAULT_TIMEOUT_MS
      }
    );
  }

  function getExportJobDownload(
    jobId
  ) {
    if (!cleanText(jobId)) {
      throw new Error(
        'กรุณาระบุ jobId สำหรับดาวน์โหลดไฟล์'
      );
    }

    return requestJson(
      '/api/export-job-download',
      {
        params: {
          jobId: jobId
        },
        timeoutMs:
          DEFAULT_TIMEOUT_MS
      }
    );
  }

  function cancelExportJob(
    jobId
  ) {
    if (!cleanText(jobId)) {
      throw new Error(
        'กรุณาระบุ jobId สำหรับยกเลิก Export'
      );
    }

    return requestJson(
      '/api/export-job-cancel',
      {
        params: {
          jobId: jobId
        },
        timeoutMs:
          DEFAULT_TIMEOUT_MS
      }
    );
  }

  async function downloadExportJob(
    jobId
  ) {
    const data =
      await getExportJobDownload(
        jobId
      );

    if (
      !data ||
      !data.ok
    ) {
      throw new Error(
        data && data.message
          ? data.message
          : 'ยังไม่สามารถดาวน์โหลดไฟล์ได้'
      );
    }

    if (!data.downloadUrl) {
      throw new Error(
        'ไม่พบลิงก์ดาวน์โหลดไฟล์'
      );
    }

    openDownloadUrl(
      data.downloadUrl
    );

    return data;
  }

  /************************************************************
   * ERROR MESSAGE
   ************************************************************/

  function getUserFriendlyError(
    error
  ) {
    if (!error) {
      return (
        'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ'
      );
    }

    const message =
      cleanText(error.message) ||
      String(error);

    const details = [];

    if (error.status) {
      details.push(
        'HTTP ' + error.status
      );
    }

    if (error.path) {
      details.push(
        'ปลายทาง ' + error.path
      );
    }

    if (error.elapsedMs) {
      details.push(
        'ใช้เวลา ' +
        (
          error.elapsedMs /
          1000
        ).toFixed(1) +
        ' วินาที'
      );
    }

    if (!details.length) {
      return message;
    }

    return (
      message +
      '\n\nรายละเอียด: ' +
      details.join(' | ')
    );
  }

  /************************************************************
   * EXPOSE API
   ************************************************************/

  window.FireExitAPI = {
    version: API_VERSION,
    apiBase: API_BASE,

    buildUrl: buildUrl,
    requestJson: requestJson,
    requestFile: requestFile,

    normalizeSavePayload:
      normalizeSavePayload,

    validateSavePayload:
      validateSavePayload,

    getUserFriendlyError:
      getUserFriendlyError,

    downloadBase64File:
      downloadBase64File,

    downloadBlob:
      downloadBlob,

    openDownloadUrl:
      openDownloadUrl,

    formatBytes:
      formatBytes,

    getPayloadSizeBytes:
      getPayloadSizeBytes,

    estimateBase64Bytes:
      estimateBase64Bytes,

    testWorker:
      testWorker,

    debugGas:
      debugGas,

    runConnectionDiagnostics:
      runConnectionDiagnostics,

    getHealth:
      getHealth,

    getOptions:
      getOptions,

    getDoors:
      getDoors,

    getChecklist:
      getChecklist,

    getDailyStatus:
      getDailyStatus,

    getLatest:
      getLatest,

    getHistory:
      getHistory,

    getMonthlyReport:
      getMonthlyReport,

    getMonthlyReportAll:
      getMonthlyReportAll,

    saveInspection:
      saveInspection,

    cleanupEvidence:
      cleanupEvidence,

    setupEvidenceCleanupTrigger:
      setupEvidenceCleanupTrigger,

    exportCsv:
      exportCsv,

    exportExcel:
      exportExcel,

    startExportJob:
      startExportJob,

    getExportJobStatus:
      getExportJobStatus,

    getExportJobDownload:
      getExportJobDownload,

    cancelExportJob:
      cancelExportJob,

    downloadExportJob:
      downloadExportJob
  };

  /*
   * รองรับโค้ดเดิมที่เรียก window.API
   */
  window.API =
    window.FireExitAPI;

})();
