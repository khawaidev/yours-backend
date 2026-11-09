#!/usr/bin/env node
/**
 * Local API test harness for the deAPI image/video services.
 *
 * Run with:
 *   node api-test-server.js
 *
 * Then open http://127.0.0.1:5099
 *
 * This file is intentionally standalone and local-only. It reads credentials
 * from yours-backend/.env and never sends them to the browser.
 */

'use strict';

const http = require('node:http');
const path = require('node:path');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

require('dotenv').config({ path: path.resolve(__dirname, '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config();

const PORT = Number(process.env.API_TEST_PORT || 5099);
const HOST = process.env.API_TEST_HOST || '127.0.0.1';
const HTML_FILE = path.resolve(__dirname, 'api-test.html');
const BODY_LIMIT = 40 * 1024 * 1024;
const JOB_TTL_MS = 45 * 60 * 1000;

const DEAPI_BASE = 'https://api.deapi.ai';
const DEAPI_IMAGE_EDIT_URL = `${DEAPI_BASE}/api/v2/images/edits`;
const DEAPI_VIDEO_URL = `${DEAPI_BASE}/api/v2/videos/animations`;
const DEAPI_JOB_URL = `${DEAPI_BASE}/api/v2/jobs`;
const DEAPI_MODELS_URL = `${DEAPI_BASE}/api/v2/models`;

const DEAPI_IMAGE_MODEL = 'QwenImageEdit_Plus_NF4';
const DEAPI_FLUX_MODEL = 'Flux_2_Klein_4B_BF16';
const DEAPI_VIDEO_MODEL = 'MiniMaxH3_33B_Turbo_INT8';
const DEAPI_LTX_VIDEO_MODEL = 'Ltx2_5_22B_Dist_INT8';
const VIDEO_FPS = 24;

const VIDEO_SECONDS_MIN = 3;
const VIDEO_SECONDS_MAX = 10;

const SERVICES = new Set(['deapi-image', 'deapi-flux', 'deapi-video', 'deapi-video-ltx']);

// ---------------------------------------------------------------------------
// deAPI credentials
// ---------------------------------------------------------------------------

function getDeApiKeys() {
  const keys = [];
  if (process.env.DEAPI_API_KEY) {
    keys.push({ label: 'DEAPI_API_KEY', key: process.env.DEAPI_API_KEY });
  }
  for (let i = 1; i <= 50; i += 1) {
    const key = process.env[`DEAPI_API_KEY${i}`];
    if (key) keys.push({ label: `DEAPI_API_KEY${i}`, key });
  }
  return keys;
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return `${key.slice(0, 2)}…${key.slice(-2)}`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function resolveDeApiKey(index) {
  const keys = getDeApiKeys();
  const chosen = Number.isInteger(index) && index >= 0 && index < keys.length ? keys[index] : keys[0];
  if (!chosen) {
    const err = new Error('No deAPI key found in .env (expected DEAPI_API_KEY or DEAPI_API_KEY1..50).');
    err.statusCode = 400;
    throw err;
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Job registry
// ---------------------------------------------------------------------------

/** @type {Map<string, any>} */
const jobs = new Map();

function createJob(service, meta = {}) {
  const id = crypto.randomUUID();
  const job = {
    id,
    service,
    status: 'queued',
    progress: null,
    message: 'Queued',
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    elapsedMs: 0,
    model: meta.model || null,
    requestId: null,
    projectId: null,
    result: null,
    error: null,
    logs: [],
    resultUrl: null,
    seed: null,
    requestedSize: null,
    requestedDuration: null,
  };
  jobs.set(id, job);
  return job;
}

function updateJob(job, patch) {
  Object.assign(job, patch);
  if (job.finishedAt) job.elapsedMs = job.finishedAt - (job.startedAt || job.createdAt);
  else job.elapsedMs = Date.now() - (job.startedAt || job.createdAt);
}

function logJob(job, message) {
  const line = `${new Date().toISOString().slice(11, 23)}  ${message}`;
  job.logs.push(line);
  if (job.logs.length > 60) job.logs.shift();
  console.log(`[${job.service}:${job.id.slice(0, 8)}] ${message}`);
}

function failJob(job, error) {
  const normalized = normalizeError(error);
  updateJob(job, {
    status: 'error',
    finishedAt: Date.now(),
    message: normalized.message,
    error: normalized,
  });
  logJob(job, `FAILED: ${normalized.message}`);
}

function cleanupJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}
setInterval(cleanupJobs, 5 * 60 * 1000).unref();

function publicJob(job) {
  return {
    id: job.id,
    service: job.service,
    status: job.status,
    progress: job.progress,
    message: job.message,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs: job.elapsedMs,
    model: job.model,
    keyLabel: job.keyLabel || null,
    seed: job.seed ?? null,
    requestedSize: job.requestedSize || null,
    requestedDuration: job.requestedDuration || null,
    requestId: job.requestId,
    projectId: job.projectId,
    result: job.result,
    error: job.error,
    logs: job.logs,
    mediaUrl: job.resultUrl ? `/api-test/jobs/${job.id}/media` : null,
  };
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function normalizeError(error) {
  if (!error) return { message: 'Unknown error' };
  const out = {
    message: error.message || String(error),
    name: error.name || 'Error',
  };
  if (error.statusCode) out.status = error.statusCode;
  if (error.code) out.code = error.code;
  if (error.details !== undefined) out.details = error.details;
  if (error.raw !== undefined) out.raw = error.raw;
  if (error.cause?.message) out.cause = error.cause.message;
  return out;
}

async function readResponseBody(response) {
  const text = await response.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { text, json };
}

async function apiErrorFromResponse(prefix, response) {
  const { text, json } = await readResponseBody(response);
  const fieldErrors = json?.errors && typeof json.errors === 'object'
    ? Object.entries(json.errors)
        .map(([field, value]) => `${field}: ${Array.isArray(value) ? value.join(', ') : value}`)
        .join('; ')
    : '';
  const baseMessage =
    (json && (json.message || json.error || json.error_message)) ||
    text ||
    `${response.status} ${response.statusText}`;
  const message = fieldErrors ? `${baseMessage} (${fieldErrors})` : baseMessage;
  const err = new Error(`${prefix} ${response.status}: ${message}`);
  err.statusCode = response.status;
  err.code = json?.code;
  err.details = json || text;
  err.raw = text;
  return err;
}

// ---------------------------------------------------------------------------
// deAPI
// ---------------------------------------------------------------------------

let deApiModelsCache = { at: 0, models: null };

async function loadDeApiModels(key) {
  if (deApiModelsCache.models && Date.now() - deApiModelsCache.at < 5 * 60 * 1000) {
    return deApiModelsCache.models;
  }
  const response = await fetch(DEAPI_MODELS_URL, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw await apiErrorFromResponse('deAPI models', response);
  const json = await response.json();
  const models = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  deApiModelsCache = { at: Date.now(), models };
  return models;
}

function dataUrlToBlob(dataUrl, fallbackName) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    const err = new Error('Invalid image payload. Upload an image in the test UI.');
    err.statusCode = 400;
    throw err;
  }
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) {
    const err = new Error('Unsupported image payload (expected a base64 data URL).');
    err.statusCode = 400;
    throw err;
  }
  const mimeType = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) {
    const err = new Error('Uploaded image is empty.');
    err.statusCode = 400;
    throw err;
  }
  if (buffer.length > 10 * 1024 * 1024) {
    const err = new Error(`Uploaded image is ${(buffer.length / 1024 / 1024).toFixed(1)} MB; the limit is 10 MB.`);
    err.statusCode = 400;
    throw err;
  }
  const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
  return {
    blob: new Blob([buffer], { type: mimeType }),
    filename: typeof fallbackName === 'string' && fallbackName ? fallbackName : `input.${ext}`,
    size: buffer.length,
    mimeType,
  };
}

function appendFormValue(form, name, value) {
  if (value === undefined || value === null || value === '') return;
  form.append(name, String(value));
}

async function submitDeApiImageJob(job, params, key, model, options = {}) {
  const image = dataUrlToBlob(params.image, params.imageName || 'input.png');

  const form = new FormData();
  form.append('prompt', String(params.prompt || '').trim());
  form.append('model', model);
  form.append('image', image.blob, image.filename);

  if (options.negativePrompt) appendFormValue(form, 'negative_prompt', params.negativePrompt);
  appendFormValue(form, 'seed', params.seed);
  appendFormValue(form, 'width', params.width);
  appendFormValue(form, 'height', params.height);
  appendFormValue(form, 'steps', params.steps);
  if (options.guidance) appendFormValue(form, 'guidance', params.guidance);
  if (options.quality) appendFormValue(form, 'quality', params.quality);
  if (options.enhancePrompt && params.enhancePrompt === true) form.append('enhance_prompt', 'true');

  logJob(
    job,
    `Submitting ${model} (${image.mimeType}, ${image.size} bytes) at ${params.width || '?'}×${params.height || '?'} · steps=${params.steps ?? '?'} · seed=${params.seed ?? '?'}`
  );
  const submitStarted = Date.now();
  const response = await fetch(DEAPI_IMAGE_EDIT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    body: form,
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) throw await apiErrorFromResponse('deAPI image edit submit', response);

  const { json, text } = await readResponseBody(response);
  const requestId = json?.data?.request_id || json?.request_id;
  if (!requestId) {
    const err = new Error(`deAPI did not return a request_id. Response: ${text.slice(0, 1200)}`);
    err.details = json || text;
    throw err;
  }
  updateJob(job, { requestId });
  logJob(job, `Accepted in ${Date.now() - submitStarted}ms. request_id=${requestId}`);

  const data = await pollDeApiJob(job, key, requestId, 'image');
  return { url: extractResultUrl(data), raw: data };
}

async function submitDeApiImage(job, params, key) {
  return submitDeApiImageJob(job, params, key, DEAPI_IMAGE_MODEL, {
    negativePrompt: true,
    guidance: true,
    quality: true,
    enhancePrompt: true,
  });
}

async function submitDeApiFlux(job, params, key) {
  return submitDeApiImageJob(job, params, key, DEAPI_FLUX_MODEL, {});
}

async function submitDeApiVideoJob(job, params, key, model, options = {}) {
  const image = dataUrlToBlob(params.image, params.imageName || 'first-frame.png');
  const seconds = Number(params.seconds);
  const fps = VIDEO_FPS;
  const frames = Math.round(seconds * fps);

  const form = new FormData();
  form.append('prompt', String(params.prompt || '').trim());
  form.append('model', model);
  form.append('first_frame_image', image.blob, image.filename);

  if (options.negativePrompt) appendFormValue(form, 'negative_prompt', params.negativePrompt);
  appendFormValue(form, 'width', params.width);
  appendFormValue(form, 'height', params.height);
  form.append('frames', String(frames));
  form.append('fps', String(fps));
  appendFormValue(form, 'seed', params.seed);
  // These are accepted but dropped by some models; only send when requested.
  if (options.steps) appendFormValue(form, 'steps', params.steps);
  if (options.guidance) appendFormValue(form, 'guidance', params.guidance);

  updateJob(job, { requestedDuration: `${seconds}s · ${frames} frames @ ${fps} fps` });
  logJob(
    job,
    `Submitting ${model} image-to-video (${image.mimeType}, ${image.size} bytes) · ${seconds}s = ${frames} frames @ ${fps} fps · ${params.width || '?'}×${params.height || '?'}`
  );
  const submitStarted = Date.now();
  const response = await fetch(DEAPI_VIDEO_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    body: form,
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) throw await apiErrorFromResponse('deAPI video submit', response);

  const { json, text } = await readResponseBody(response);
  const requestId = json?.data?.request_id || json?.request_id;
  if (!requestId) {
    const err = new Error(`deAPI did not return a request_id. Response: ${text.slice(0, 1200)}`);
    err.details = json || text;
    throw err;
  }
  updateJob(job, { requestId });
  logJob(job, `Accepted in ${Date.now() - submitStarted}ms. request_id=${requestId}`);

  const data = await pollDeApiJob(job, key, requestId, 'video');
  return { url: extractResultUrl(data), raw: data };
}

async function submitDeApiVideo(job, params, key) {
  return submitDeApiVideoJob(job, params, key, DEAPI_VIDEO_MODEL, {
    negativePrompt: true,
    steps: true,
    guidance: true,
  });
}

async function submitDeApiLtxVideo(job, params, key) {
  return submitDeApiVideoJob(job, params, key, DEAPI_LTX_VIDEO_MODEL, {});
}

function extractResultUrl(data) {
  if (!data) return null;
  const direct = [
    data.result_url,
    data.resultUrl,
    data.result?.url,
    data.output?.url,
    data.image?.url,
    data.video?.url,
    data.url,
    typeof data.result === 'string' ? data.result : null,
    typeof data.output === 'string' ? data.output : null,
    typeof data.image === 'string' ? data.image : null,
    typeof data.video === 'string' ? data.video : null,
    Array.isArray(data.results_alt_formats) ? data.results_alt_formats[0]?.url : null,
    Array.isArray(data.results) ? (typeof data.results[0] === 'string' ? data.results[0] : data.results[0]?.url) : null,
    Array.isArray(data.images) ? (typeof data.images[0] === 'string' ? data.images[0] : data.images[0]?.url) : null,
    Array.isArray(data.videos) ? (typeof data.videos[0] === 'string' ? data.videos[0] : data.videos[0]?.url) : null,
  ].filter(Boolean);
  return direct[0] || null;
}

function extractJobError(data) {
  if (!data) return null;
  const message = data.error_message || data.error_reason || data.error?.message || data.error || data.message;
  if (!message) return null;
  return typeof message === 'string' ? message : JSON.stringify(message);
}

async function pollDeApiJob(job, key, requestId, kind) {
  const started = Date.now();
  const timeoutMs = kind === 'video' ? 20 * 60 * 1000 : 10 * 60 * 1000;
  let lastStatus = '';
  let consecutiveErrors = 0;

  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 2500));

    let response;
    try {
      response = await fetch(`${DEAPI_JOB_URL}/${encodeURIComponent(requestId)}`, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      consecutiveErrors += 1;
      logJob(job, `Poll network error (${consecutiveErrors}): ${err.message}`);
      if (consecutiveErrors >= 6) throw err;
      continue;
    }

    const { json, text } = await readResponseBody(response);

    if (!response.ok) {
      // Retry transient server errors; surface auth/validation immediately.
      if (response.status >= 500 || response.status === 429) {
        consecutiveErrors += 1;
        logJob(job, `Poll HTTP ${response.status} (retry ${consecutiveErrors})`);
        if (consecutiveErrors >= 8) throw await apiErrorFromResponse('deAPI job poll', response);
        continue;
      }
      throw await apiErrorFromResponse('deAPI job poll', response);
    }

    consecutiveErrors = 0;
    const data = json?.data || json || {};
    const status = String(data.status || '').toLowerCase();
    const progress = typeof data.progress === 'number' ? data.progress : null;

    if (status !== lastStatus) {
      lastStatus = status;
      logJob(job, `Status: ${status || '(none)'}${progress != null ? ` · ${progress}%` : ''}`);
    }

    updateJob(job, {
      status: ['done', 'completed', 'succeeded', 'success'].includes(status) ? 'running' : 'running',
      progress: progress != null ? Math.max(0, Math.min(100, progress)) : job.progress,
      message:
        progress != null
          ? `deAPI job ${status || 'processing'} · ${progress}%`
          : `deAPI job ${status || 'processing'}`,
    });

    if (['done', 'completed', 'succeeded', 'success'].includes(status)) {
      const url = extractResultUrl(data);
      if (!url) {
        const err = new Error(`deAPI job finished without a result URL. Raw: ${text.slice(0, 1500)}`);
        err.details = json || text;
        throw err;
      }
      updateJob(job, { progress: 100, message: 'Job complete' });
      return data;
    }

    if (['error', 'failed', 'cancelled', 'canceled'].includes(status)) {
      const reason = extractJobError(data) || status;
      const err = new Error(`deAPI job ${status}: ${reason}`);
      err.details = json || text;
      err.raw = text;
      throw err;
    }
  }

  throw new Error(`deAPI job timed out after ${Math.round(timeoutMs / 60000)} minutes while polling ${requestId}.`);
}

// ---------------------------------------------------------------------------
// Job runner
// ---------------------------------------------------------------------------

const RUNNERS = {
  'deapi-image': submitDeApiImage,
  'deapi-flux': submitDeApiFlux,
  'deapi-video': submitDeApiVideo,
  'deapi-video-ltx': submitDeApiLtxVideo,
};

async function runJob(job, params) {
  updateJob(job, { status: 'running', startedAt: Date.now(), message: 'Starting…' });
  try {
    const runner = RUNNERS[job.service];
    if (params.seed === '' || params.seed === null || params.seed === undefined) {
      params.seed = Math.floor(Math.random() * 4294967295);
      logJob(job, `No seed supplied; using random seed ${params.seed}`);
    }
    const resolved = resolveDeApiKey(params.keyIndex);
    const key = resolved.key;
    updateJob(job, { keyLabel: resolved.label });
    logJob(job, `Using ${resolved.label} (${maskKey(key)})`);
    if (params.width && params.height) {
      updateJob(job, { requestedSize: `${params.width}×${params.height}` });
    }
    if (params.seed !== '' && params.seed !== null && params.seed !== undefined) {
      updateJob(job, { seed: Number(params.seed) });
    }
    const result = await runner(job, params, key);
    updateJob(job, {
      status: 'done',
      finishedAt: Date.now(),
      progress: 100,
      message: 'Completed',
      resultUrl: result.url,
      result: {
        type: job.service.startsWith('deapi-video') ? 'video' : 'image',
        url: result.url,
        raw: result.raw ?? null,
      },
    });
    logJob(job, 'DONE');
  } catch (err) {
    failJob(job, err);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        const err = new Error(`Request body too large (limit ${Math.round(BODY_LIMIT / 1024 / 1024)} MB).`);
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        const err = new Error('Request body is not valid JSON.');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sanitizeParams(service, params) {
  const clean = { ...params };
  if (!clean.prompt || !String(clean.prompt).trim()) {
    const err = new Error('Missing required field: prompt');
    err.statusCode = 400;
    throw err;
  }
  if (!clean.image) {
    const err = new Error('Missing required input image.');
    err.statusCode = 400;
    throw err;
  }
  if (clean.seed !== '' && clean.seed != null) {
    const seed = Number(clean.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
      const err = new Error('Seed must be an integer between 0 and 4294967295.');
      err.statusCode = 400;
      throw err;
    }
    clean.seed = seed;
  }
  if (service === 'deapi-video' || service === 'deapi-video-ltx') {
    const seconds = Number(clean.seconds);
    if (!Number.isInteger(seconds) || seconds < VIDEO_SECONDS_MIN || seconds > VIDEO_SECONDS_MAX) {
      const err = new Error(`Duration must be a whole number of seconds between ${VIDEO_SECONDS_MIN} and ${VIDEO_SECONDS_MAX}.`);
      err.statusCode = 400;
      throw err;
    }
    clean.seconds = seconds;
    delete clean.frames;
    delete clean.fps;
  }
  return clean;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'GET' && (pathname === '/' || pathname === '/api-test' || pathname === '/api-test/')) {
    const html = await fsp.readFile(HTML_FILE, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(html),
    });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && pathname === '/api-test/status') {
    const deapiKeys = getDeApiKeys();
    sendJson(res, 200, {
      ok: true,
      deapi: {
        configured: deapiKeys.length > 0,
        keys: deapiKeys.map((item, index) => ({
          index,
          label: item.label,
          masked: maskKey(item.key),
        })),
        imageModel: DEAPI_IMAGE_MODEL,
        fluxModel: DEAPI_FLUX_MODEL,
        videoModel: DEAPI_VIDEO_MODEL,
        ltxVideoModel: DEAPI_LTX_VIDEO_MODEL,
      },
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api-test/deapi/models') {
    const model = url.searchParams.get('model') || '';
    const keyEntry = resolveDeApiKey(Number(url.searchParams.get('keyIndex') ?? 0));
    const models = await loadDeApiModels(keyEntry.key);
    if (!model) {
      sendJson(res, 200, { ok: true, count: models.length, models: models.map((m) => m.slug) });
      return;
    }
    const found = models.find((m) => m.slug === model || m.id === model || m.name === model);
    if (!found) {
      sendJson(res, 404, {
        ok: false,
        message: `Model not found in the live deAPI catalogue: ${model}`,
        available: models.map((m) => m.slug),
      });
      return;
    }
    sendJson(res, 200, { ok: true, keyLabel: keyEntry.label, model: found });
    return;
  }

  if (req.method === 'POST' && pathname === '/api-test/jobs') {
    const body = await readJsonBody(req);
    const service = body.service;
    if (!SERVICES.has(service)) {
      sendJson(res, 400, { ok: false, message: `Unknown service: ${service}` });
      return;
    }
    const params = sanitizeParams(service, body.params || {});
    const model =
      service === 'deapi-image'
        ? DEAPI_IMAGE_MODEL
        : service === 'deapi-flux'
          ? DEAPI_FLUX_MODEL
          : service === 'deapi-video-ltx'
            ? DEAPI_LTX_VIDEO_MODEL
            : DEAPI_VIDEO_MODEL;
    const job = createJob(service, { model });
    const keyEntry = resolveDeApiKey(params.keyIndex);
    updateJob(job, { keyLabel: keyEntry.label });
    // Run in the background so the UI can poll status.
    setImmediate(() => runJob(job, params));
    sendJson(res, 202, { ok: true, job: publicJob(job) });
    return;
  }

  const mediaMatch = /^\/api-test\/jobs\/([^/]+)\/media$/.exec(pathname);
  if (req.method === 'GET' && mediaMatch) {
    const job = jobs.get(mediaMatch[1]);
    if (!job) {
      sendJson(res, 404, { ok: false, message: 'Job not found or expired.' });
      return;
    }
    if (!job.resultUrl) {
      sendJson(res, 409, { ok: false, message: 'Job has no result yet.' });
      return;
    }

    const upstream = await fetch(job.resultUrl, { signal: AbortSignal.timeout(180000) });
    if (!upstream.ok || !upstream.body) {
      sendJson(res, 502, {
        ok: false,
        message: `Could not fetch the result from the provider (${upstream.status} ${upstream.statusText}).`,
        resultUrl: job.resultUrl,
      });
      return;
    }

    const contentType = upstream.headers.get('content-type') || (job.result?.type === 'video' ? 'video/mp4' : 'image/png');
    const extension = contentType.includes('mp4')
      ? 'mp4'
      : contentType.includes('webm')
        ? 'webm'
        : contentType.includes('jpeg')
          ? 'jpg'
          : contentType.includes('webp')
            ? 'webp'
            : 'png';
    const headers = {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    };
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) headers['Content-Length'] = contentLength;
    if (url.searchParams.get('download') === '1') {
      headers['Content-Disposition'] = `attachment; filename="${job.service}-${job.id.slice(0, 8)}.${extension}"`;
    }
    res.writeHead(200, headers);
    Readable.fromWeb(upstream.body).pipe(res);
    return;
  }

  const jobMatch = /^\/api-test\/jobs\/([^/]+)$/.exec(pathname);
  if (req.method === 'GET' && jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) {
      sendJson(res, 404, { ok: false, message: 'Job not found or expired.' });
      return;
    }
    sendJson(res, 200, { ok: true, job: publicJob(job) });
    return;
  }

  sendJson(res, 404, { ok: false, message: `Not found: ${req.method} ${pathname}` });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('Unhandled request error:', err);
    if (!res.headersSent) sendJson(res, err.statusCode || 500, { ok: false, ...normalizeError(err) });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Yours API test harness');
  console.log(`  → http://${HOST}:${PORT}`);
  console.log('');
  console.log(`  deAPI keys: ${getDeApiKeys().length} configured`);
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set API_TEST_PORT to another port.`);
    process.exit(1);
  }
  throw err;
});
