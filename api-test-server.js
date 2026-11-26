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

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_TEXT_MODELS = [
  'gemma-4-31b-it',
  'gemma-4-26b-a4b-it',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
];
// Thinking levels exposed for the two Gemma 4 text models on the API test page.
// The app's real messaging path does not set this yet — test harness only.
const GEMMA_THINKING_LEVELS = ['minimal', 'high'];
const GEMMA_DEFAULT_THINKING_LEVEL = 'minimal';

function isGemmaModel(model) {
  return /^gemma/i.test(String(model || '').trim());
}
const GEMINI_TTS_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'];
const GEMINI_TTS_VOICES = ['Kore', 'Zephyr', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Sulafat'];

const OPENROUTER_SPEECH_URL = 'https://openrouter.ai/api/v1/audio/speech';
const OPENROUTER_TTS_MODEL = 'fish-audio/s2.1-pro-free:free';
const OPENROUTER_DEFAULT_VOICE = '8fdcb77230554e1ab160e2361bff4296';

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_SPEECH_URL = 'https://api.groq.com/openai/v1/audio/speech';
const GROQ_CHAT_MODEL = 'qwen/qwen3.8-27b';
// Per-model generation settings from https://console.groq.com/docs/reasoning
// and the individual model pages (checked 2026-11-26).
const GROQ_CHAT_MODELS = [
  {
    id: 'qwen/qwen3.8-27b',
    label: 'Qwen 3.8 27B (vision + text)',
    vision: true,
    maxOutput: 16384,
    reasoningEfforts: ['none', 'default', 'low', 'medium', 'high'],
    defaultReasoningEffort: 'none',
    reasoningFormats: ['hidden', 'parsed', 'raw'],
    defaultReasoningFormat: 'hidden',
  },
  {
    id: 'openai/gpt-oss-20b',
    label: 'GPT-OSS 20B (text)',
    vision: false,
    maxOutput: 65536,
    reasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    reasoningFormats: null, // GPT-OSS uses include_reasoning instead of reasoning_format
    defaultReasoningFormat: 'hidden',
  },
  {
    id: 'openai/gpt-oss-120b',
    label: 'GPT-OSS 120B (text)',
    vision: false,
    maxOutput: 65536,
    reasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    reasoningFormats: null,
    defaultReasoningFormat: 'hidden',
  },
  {
    id: 'llama-3.1-8b-instant',
    label: 'Llama 3.1 8B Instant (text)',
    vision: false,
    maxOutput: 131072,
    reasoningEfforts: null, // not a reasoning model
    defaultReasoningEffort: null,
    reasoningFormats: null,
    defaultReasoningFormat: null,
  },
];
const GROQ_TTS_MODEL = 'canopylabs/orpheus-v1-english';
const GROQ_TTS_VOICES = ['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy'];

const CLOD_CHAT_URL = 'https://api.clod.io/v1/chat/completions';
const CLOD_CHAT_MODELS = ['clod/qwen3p5-9b', 'clod/gemma-4-31b-it'];

const SERVICES = new Set(['deapi-image', 'deapi-flux', 'deapi-video', 'deapi-video-ltx']);

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function collectNumberedKeys(baseName) {
  const keys = [];
  if (process.env[baseName]) {
    keys.push({ label: baseName, key: process.env[baseName] });
  }
  for (let i = 1; i <= 50; i += 1) {
    const label = `${baseName}${i}`;
    const key = process.env[label];
    if (key) keys.push({ label, key });
  }
  return keys;
}

function getDeApiKeys() {
  return collectNumberedKeys('DEAPI_API_KEY');
}

function getGeminiKeys() {
  return collectNumberedKeys('GEMINI_API_KEY');
}

function getOpenRouterKeys() {
  return collectNumberedKeys('OPENROUTER_API_KEY');
}

function getGroqKeys() {
  const keys = [];
  if (process.env.GROQ_API_KEY) {
    keys.push({ label: 'GROQ_API_KEY', key: process.env.GROQ_API_KEY });
  }
  for (let i = 1; i <= 50; i += 1) {
    const label = `GROQ_API_KEY${i}`;
    const typoLabel = `GROQ_APO_KEY${i}`;
    if (process.env[label]) keys.push({ label, key: process.env[label] });
    else if (process.env[typoLabel]) keys.push({ label: typoLabel, key: process.env[typoLabel] });
  }
  return keys;
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return `${key.slice(0, 2)}…${key.slice(-2)}`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function resolveKeyFromPool(keys, index, errorMessage) {
  const parsed = Number(index);
  const chosen = Number.isInteger(parsed) && parsed >= 0 && parsed < keys.length ? keys[parsed] : keys[0];
  if (!chosen) {
    const err = new Error(errorMessage);
    err.statusCode = 400;
    throw err;
  }
  return chosen;
}

function resolveDeApiKey(index) {
  return resolveKeyFromPool(
    getDeApiKeys(),
    index,
    'No deAPI key found in .env (expected DEAPI_API_KEY or DEAPI_API_KEY1..50).'
  );
}

function resolveGeminiKey(index) {
  return resolveKeyFromPool(
    getGeminiKeys(),
    index,
    'No Gemini key found in .env (expected GEMINI_API_KEY or GEMINI_API_KEY1..50).'
  );
}

function resolveOpenRouterKey(index) {
  return resolveKeyFromPool(
    getOpenRouterKeys(),
    index,
    'No OpenRouter key found in .env (expected OPENROUTER_API_KEY or OPENROUTER_API_KEY1..50).'
  );
}

function resolveGroqKey(index) {
  return resolveKeyFromPool(
    getGroqKeys(),
    index,
    'No Groq key found in .env (expected GROQ_API_KEY or GROQ_API_KEY1..50).'
  );
}

function getClodKeys() {
  return collectNumberedKeys('CLOD_API_KEY');
}

function resolveClodKey(index) {
  return resolveKeyFromPool(
    getClodKeys(),
    index,
    'No Clod key found in .env (expected CLOD_API_KEY or CLOD_API_KEY1..50).'
  );
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
// Gemini Text & TTS + OpenRouter TTS
// ---------------------------------------------------------------------------

function pcmToWavBuffer(pcmBuffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

function parseSampleRateFromMime(mimeType, fallback = 24000) {
  const match = /rate=(\d+)/i.exec(String(mimeType || ''));
  if (!match) return fallback;
  const rate = Number(match[1]);
  return Number.isFinite(rate) && rate > 0 ? rate : fallback;
}

async function handleGeminiChat(body) {
  const keyEntry = resolveGeminiKey(body.keyIndex);
  const model = String(body.model || GEMINI_TEXT_MODELS[0]).trim();
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const messages = rawMessages
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({
      role: m.role === 'model' || m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  while (messages.length > 0 && messages[0].role !== 'user') {
    messages.shift();
  }
  if (messages.length === 0) {
    const err = new Error('Enter a message first.');
    err.statusCode = 400;
    throw err;
  }

  const payload = { contents: messages };
  if (typeof body.systemPrompt === 'string' && body.systemPrompt.trim()) {
    payload.systemInstruction = { parts: [{ text: body.systemPrompt.trim() }] };
  }
  if (body.temperature !== '' && body.temperature != null) {
    const temp = Number(body.temperature);
    if (Number.isFinite(temp) && temp >= 0 && temp <= 2) {
      payload.generationConfig = { temperature: temp };
    }
  }

  // Gemma 4 thinking control (test harness only). Defaults to "minimal" so the
  // role/system prompt is followed closely; "high" can be selected explicitly.
  const requestedThinkingLevel = String(body.thinkingLevel || '').trim().toLowerCase();
  const thinkingLevel = isGemmaModel(model)
    ? (GEMMA_THINKING_LEVELS.includes(requestedThinkingLevel)
      ? requestedThinkingLevel
      : GEMMA_DEFAULT_THINKING_LEVEL)
    : null;
  if (thinkingLevel) {
    payload.generationConfig = {
      ...(payload.generationConfig || {}),
      thinkingConfig: { thinkingLevel },
    };
  }

  const endpoint = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  const startedAt = performance.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': keyEntry.key,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  });
  const responseTimeMs = Math.round(performance.now() - startedAt);
  const { json, text } = await readResponseBody(response);

  if (!response.ok) {
    const errMsg = json?.error?.message || text || `${response.status} ${response.statusText}`;
    return {
      statusCode: response.status,
      payload: {
        ok: false,
        message: `Gemini ${response.status}: ${errMsg}`,
        status: response.status,
        keyLabel: keyEntry.label,
        model,
        thinkingLevel,
        responseTimeMs,
        details: json || text,
      },
    };
  }

  const candidate = json?.candidates?.[0];
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const replyText = parts
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim();
  const thoughtText = parts
    .filter((p) => p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim();

  return {
    statusCode: 200,
    payload: {
      ok: true,
      keyLabel: keyEntry.label,
      model,
      thinkingLevel,
      responseTimeMs,
      replyText: replyText || '(empty response)',
      thoughtText: thoughtText || null,
      finishReason: candidate?.finishReason || null,
      usageMetadata: json?.usageMetadata || null,
      raw: json,
    },
  };
}

async function handleGeminiTts(body) {
  const keyEntry = resolveGeminiKey(body.keyIndex);
  const model = String(body.model || GEMINI_TTS_MODELS[0]).trim();
  const text = String(body.text || '').trim();
  const voiceName = String(body.voiceName || GEMINI_TTS_VOICES[0]).trim();

  if (!text) {
    const err = new Error('Missing required field: text');
    err.statusCode = 400;
    throw err;
  }

  const endpoint = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  const payload = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  };

  const startedAt = performance.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': keyEntry.key,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90000),
  });
  const responseTimeMs = Math.round(performance.now() - startedAt);
  const { json, text: rawText } = await readResponseBody(response);

  if (!response.ok) {
    const errMsg = json?.error?.message || rawText || `${response.status} ${response.statusText}`;
    return {
      statusCode: response.status,
      payload: {
        ok: false,
        message: `Gemini TTS ${response.status}: ${errMsg}`,
        status: response.status,
        keyLabel: keyEntry.label,
        model,
        voiceName,
        responseTimeMs,
        details: json || rawText,
      },
    };
  }

  const candidate = json?.candidates?.[0];
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const audioPart = parts.find((p) => p?.inlineData?.data);
  if (!audioPart) {
    return {
      statusCode: 502,
      payload: {
        ok: false,
        message: 'Gemini TTS succeeded without returning inlineData audio.',
        keyLabel: keyEntry.label,
        model,
        voiceName,
        responseTimeMs,
        details: json || rawText,
      },
    };
  }

  const rawMimeType = String(audioPart.inlineData.mimeType || 'audio/L16;codec=pcm;rate=24000');
  let audioBuffer = Buffer.from(audioPart.inlineData.data, 'base64');
  let mimeType = rawMimeType.split(';')[0].trim().toLowerCase();

  if (mimeType === 'audio/l16' || mimeType === 'audio/pcm' || mimeType === 'audio/raw') {
    const sampleRate = parseSampleRateFromMime(rawMimeType, 24000);
    audioBuffer = pcmToWavBuffer(audioBuffer, sampleRate, 1, 16);
    mimeType = 'audio/wav';
  }

  return {
    statusCode: 200,
    payload: {
      ok: true,
      keyLabel: keyEntry.label,
      model,
      voiceName,
      responseTimeMs,
      mimeType,
      rawMimeType,
      byteLength: audioBuffer.length,
      audioDataUrl: `data:${mimeType};base64,${audioBuffer.toString('base64')}`,
      usageMetadata: json?.usageMetadata || null,
    },
  };
}

async function handleOpenRouterTts(body) {
  const keyEntry = resolveOpenRouterKey(body.keyIndex);
  const model = String(body.model || OPENROUTER_TTS_MODEL).trim();
  const text = String(body.text || '').trim();
  const voice = String(body.voice || OPENROUTER_DEFAULT_VOICE).trim();
  const speed = body.speed !== '' && body.speed != null ? Number(body.speed) : 1.0;
  const temperature = body.temperature !== '' && body.temperature != null ? Number(body.temperature) : 0.7;
  const topP = body.top_p !== '' && body.top_p != null ? Number(body.top_p) : 0.7;
  const repetitionPenalty =
    body.repetition_penalty !== '' && body.repetition_penalty != null ? Number(body.repetition_penalty) : 1.2;

  if (!text) {
    const err = new Error('Missing required field: text');
    err.statusCode = 400;
    throw err;
  }

  const startedAt = performance.now();
  const response = await fetch(OPENROUTER_SPEECH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${keyEntry.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: text,
      voice,
      response_format: 'mp3',
      speed,
      temperature,
      top_p: topP,
      repetition_penalty: repetitionPenalty,
    }),
    signal: AbortSignal.timeout(90000),
  });

  if (!response.ok) {
    const responseTimeMs = Math.round(performance.now() - startedAt);
    const { json, text: rawText } = await readResponseBody(response);
    const errMsg = json?.error?.message || json?.message || rawText || `${response.status} ${response.statusText}`;
    return {
      statusCode: response.status,
      payload: {
        ok: false,
        message: `OpenRouter TTS ${response.status}: ${errMsg}`,
        status: response.status,
        keyLabel: keyEntry.label,
        model,
        voice,
        responseTimeMs,
        details: json || rawText,
      },
    };
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  const responseTimeMs = Math.round(performance.now() - startedAt);
  const mimeType = (response.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim();

  return {
    statusCode: 200,
    payload: {
      ok: true,
      keyLabel: keyEntry.label,
      model,
      voice,
      responseTimeMs,
      mimeType,
      byteLength: audioBuffer.length,
      audioDataUrl: `data:${mimeType};base64,${audioBuffer.toString('base64')}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Groq Chat (Qwen 3.8 27B Vision+Text) & Orpheus TTS
// ---------------------------------------------------------------------------

/**
 * CLōD reasoning default: "none" for Qwen, "low" for Gemma/other models.
 * Groq uses the per-model GROQ_CHAT_MODELS config above instead.
 */
function defaultReasoningEffort(model) {
  return /qwen/i.test(String(model || '')) ? 'none' : 'low';
}

async function handleGroqChat(body) {
  const keyEntry = resolveGroqKey(body.keyIndex);
  const model = String(body.model || GROQ_CHAT_MODEL).trim();
  const modelConfig = GROQ_CHAT_MODELS.find((m) => m.id === model);
  if (!modelConfig) {
    const err = new Error(`Unsupported Groq chat model: ${model}`);
    err.statusCode = 400;
    throw err;
  }

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const apiMessages = [];
  const warnings = [];
  let omittedImages = 0;

  if (typeof body.systemPrompt === 'string' && body.systemPrompt.trim()) {
    apiMessages.push({ role: 'system', content: body.systemPrompt.trim() });
  }

  for (const m of rawMessages) {
    if (!m) continue;
    const role = m.role === 'model' || m.role === 'assistant' ? 'assistant' : 'user';
    const text = typeof m.content === 'string' ? m.content.trim() : '';
    const image = typeof m.image === 'string' && m.image.startsWith('data:image/') ? m.image : null;
    if (!text && !image) continue;

    if (role === 'user' && image && modelConfig.vision) {
      const content = [];
      if (text) content.push({ type: 'text', text });
      content.push({ type: 'image_url', image_url: { url: image } });
      apiMessages.push({ role: 'user', content });
    } else if (role === 'user' && image && !modelConfig.vision) {
      omittedImages += 1;
      apiMessages.push({
        role: 'user',
        content: text || `[image omitted: ${model} does not support image input]`,
      });
    } else if (text) {
      apiMessages.push({ role, content: text });
    }
  }

  if (omittedImages > 0) {
    warnings.push(`${model} does not support image input; ${omittedImages} image(s) omitted.`);
  }

  if (!apiMessages.some((m) => m.role === 'user')) {
    const err = new Error('Enter a message or attach an image first.');
    err.statusCode = 400;
    throw err;
  }

  const payload = { model, messages: apiMessages };
  if (body.temperature !== '' && body.temperature != null) {
    const temp = Number(body.temperature);
    if (Number.isFinite(temp) && temp >= 0 && temp <= 2) payload.temperature = temp;
  }
  if (body.maxTokens !== '' && body.maxTokens != null) {
    let maxTokens = Number(body.maxTokens);
    if (Number.isInteger(maxTokens) && maxTokens > 0) {
      if (maxTokens > modelConfig.maxOutput) {
        warnings.push(`max_completion_tokens capped at ${modelConfig.maxOutput} for ${model}.`);
        maxTokens = modelConfig.maxOutput;
      }
      payload.max_completion_tokens = maxTokens;
    }
  }

  // Per-model reasoning settings (Groq docs checked 2026-11-26):
  // - qwen/qwen3.8-27b: reasoning_effort none/default/low/medium/high + reasoning_format
  // - openai/gpt-oss-20b & 120b: reasoning_effort low/medium/high + include_reasoning
  //   (reasoning_format is not supported by GPT-OSS)
  // - llama-3.1-8b-instant: not a reasoning model, so no reasoning parameters
  let reasoningEffort = null;
  let reasoningFormat = null;
  let includeReasoning = null;
  if (modelConfig.reasoningEfforts) {
    const requestedEffort = String(body.reasoningEffort || '').trim();
    reasoningEffort = modelConfig.reasoningEfforts.includes(requestedEffort)
      ? requestedEffort
      : modelConfig.defaultReasoningEffort;
    payload.reasoning_effort = reasoningEffort;

    const requestedFormat = String(body.reasoningFormat || '').trim();
    if (modelConfig.reasoningFormats) {
      if (reasoningEffort !== 'none') {
        reasoningFormat = modelConfig.reasoningFormats.includes(requestedFormat)
          ? requestedFormat
          : modelConfig.defaultReasoningFormat;
        payload.reasoning_format = reasoningFormat;
      }
    } else {
      // GPT-OSS uses include_reasoning; map the UI trace choice onto it.
      const traceChoice = requestedFormat || modelConfig.defaultReasoningFormat || 'hidden';
      includeReasoning = traceChoice !== 'hidden';
      payload.include_reasoning = includeReasoning;
    }
  }

  const startedAt = performance.now();
  const response = await fetch(GROQ_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${keyEntry.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90000),
  });
  const responseTimeMs = Math.round(performance.now() - startedAt);
  const { json, text: rawText } = await readResponseBody(response);

  if (!response.ok) {
    const errMsg = json?.error?.message || json?.message || rawText || `${response.status} ${response.statusText}`;
    return {
      statusCode: response.status,
      payload: {
        ok: false,
        message: `Groq ${response.status}: ${errMsg}`,
        status: response.status,
        keyLabel: keyEntry.label,
        model,
        reasoningEffort,
        reasoningFormat,
        includeReasoning,
        warning: warnings.length ? warnings.join(' ') : null,
        responseTimeMs,
        details: json || rawText,
      },
    };
  }

  const choice = json?.choices?.[0];
  const replyText = String(choice?.message?.content || '').trim();
  const reasoningText = choice?.message?.reasoning
    ? String(choice.message.reasoning).trim()
    : null;
  return {
    statusCode: 200,
    payload: {
      ok: true,
      keyLabel: keyEntry.label,
      model: json?.model || model,
      responseTimeMs,
      replyText: replyText || '(empty response)',
      reasoningText: reasoningText || null,
      reasoningEffort,
      reasoningFormat,
      includeReasoning,
      warning: warnings.length ? warnings.join(' ') : null,
      finishReason: choice?.finish_reason || null,
      usageMetadata: json?.usage
        ? { totalTokenCount: json.usage.total_tokens, ...json.usage }
        : null,
      raw: json,
    },
  };
}

async function handleGroqTts(body) {
  const keyEntry = resolveGroqKey(body.keyIndex);
  const model = String(body.model || GROQ_TTS_MODEL).trim();
  const text = String(body.text || '').trim();
  const voice = String(body.voice || GROQ_TTS_VOICES[0]).trim();
  const responseFormat = String(body.response_format || 'wav').trim();

  if (!text) {
    const err = new Error('Missing required field: text');
    err.statusCode = 400;
    throw err;
  }

  const startedAt = performance.now();
  const response = await fetch(GROQ_SPEECH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${keyEntry.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: text,
      voice,
      response_format: responseFormat,
    }),
    signal: AbortSignal.timeout(90000),
  });

  if (!response.ok) {
    const responseTimeMs = Math.round(performance.now() - startedAt);
    const { json, text: rawText } = await readResponseBody(response);
    const errMsg = json?.error?.message || json?.message || rawText || `${response.status} ${response.statusText}`;
    return {
      statusCode: response.status,
      payload: {
        ok: false,
        message: `Groq TTS ${response.status}: ${errMsg}`,
        status: response.status,
        keyLabel: keyEntry.label,
        model,
        voice,
        responseTimeMs,
        details: json || rawText,
      },
    };
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  const responseTimeMs = Math.round(performance.now() - startedAt);
  const mimeType = (response.headers.get('content-type') || 'audio/wav').split(';')[0].trim();

  return {
    statusCode: 200,
    payload: {
      ok: true,
      keyLabel: keyEntry.label,
      model,
      voice,
      responseTimeMs,
      mimeType,
      byteLength: audioBuffer.length,
      audioDataUrl: `data:${mimeType};base64,${audioBuffer.toString('base64')}`,
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Send a CLōD chat request. CLōD is OpenAI-compatible, but not every gateway
 * accepts the optional reasoning_effort field; if it rejects that one field,
 * retry once without it instead of failing the whole test.
 */
async function fetchClodChat(payload, key) {
  const send = (body) =>
    fetch(CLOD_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });

  const response = await send(payload);
  if (response.status !== 400 || !payload.reasoning_effort) return response;

  const probe = response.clone();
  const { json, text } = await readResponseBody(probe);
  const message = `${json?.error?.message || ''} ${json?.message || ''} ${text}`.toLowerCase();
  if (!/reasoning[_ ]effort/.test(message)) return response;

  const retryPayload = { ...payload };
  delete retryPayload.reasoning_effort;
  return send(retryPayload);
}

async function handleClodChat(body) {
  const keyEntry = resolveClodKey(body.keyIndex);
  const model = String(body.model || CLOD_CHAT_MODELS[0]).trim();
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const apiMessages = [];

  if (typeof body.systemPrompt === 'string' && body.systemPrompt.trim()) {
    apiMessages.push({ role: 'system', content: body.systemPrompt.trim() });
  }

  for (const m of rawMessages) {
    if (!m) continue;
    const role = m.role === 'model' || m.role === 'assistant' ? 'assistant' : 'user';
    const text = typeof m.content === 'string' ? m.content.trim() : '';
    const image = typeof m.image === 'string' && m.image.startsWith('data:image/') ? m.image : null;
    if (!text && !image) continue;

    if (role === 'user' && image) {
      const content = [];
      if (text) content.push({ type: 'text', text });
      content.push({ type: 'image_url', image_url: { url: image } });
      apiMessages.push({ role: 'user', content });
    } else if (text) {
      apiMessages.push({ role, content: text });
    }
  }

  if (!apiMessages.some((m) => m.role === 'user')) {
    const err = new Error('Enter a message or attach an image first.');
    err.statusCode = 400;
    throw err;
  }

  const payload = { model, messages: apiMessages };
  if (body.temperature !== '' && body.temperature != null) {
    const temp = Number(body.temperature);
    if (Number.isFinite(temp) && temp >= 0 && temp <= 2) payload.temperature = temp;
  }
  if (body.maxTokens !== '' && body.maxTokens != null) {
    const maxTokens = Number(body.maxTokens);
    if (Number.isInteger(maxTokens) && maxTokens > 0) payload.max_completion_tokens = maxTokens;
  }

  // CLōD routes Qwen 3.5 / Gemma 4 models that support reasoning. Leaving
  // thinking on makes Qwen drift away from the role/system prompt, so use the
  // same default as the Groq docs: "none" for Qwen, "low" for the others.
  const reasoningEffort = String(body.reasoningEffort || defaultReasoningEffort(model)).trim();
  payload.reasoning_effort = reasoningEffort;

  const startedAt = performance.now();
  const response = await fetchClodChat(payload, keyEntry.key);
  const responseTimeMs = Math.round(performance.now() - startedAt);
  const { json, text: rawText } = await readResponseBody(response);

  if (!response.ok) {
    const errMsg = json?.error?.message || json?.message || rawText || `${response.status} ${response.statusText}`;
    return {
      statusCode: response.status,
      payload: {
        ok: false,
        message: `Clod ${response.status}: ${errMsg}`,
        status: response.status,
        keyLabel: keyEntry.label,
        model,
        responseTimeMs,
        details: json || rawText,
      },
    };
  }

  const choice = json?.choices?.[0];
  const replyText = String(choice?.message?.content || '').trim();
  return {
    statusCode: 200,
    payload: {
      ok: true,
      keyLabel: keyEntry.label,
      model: json?.model || model,
      responseTimeMs,
      replyText: replyText || '(empty response)',
      reasoningEffort,
      finishReason: choice?.finish_reason || null,
      usageMetadata: json?.usage
        ? { totalTokenCount: json.usage.total_tokens, ...json.usage }
        : null,
      raw: json,
    },
  };
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
    const geminiKeys = getGeminiKeys();
    const openrouterKeys = getOpenRouterKeys();
    const groqKeys = getGroqKeys();
    const clodKeys = getClodKeys();
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
      gemini: {
        configured: geminiKeys.length > 0,
        keys: geminiKeys.map((item, index) => ({
          index,
          label: item.label,
          masked: maskKey(item.key),
        })),
        textModels: GEMINI_TEXT_MODELS,
        ttsModels: GEMINI_TTS_MODELS,
        ttsVoices: GEMINI_TTS_VOICES,
      },
      openrouter: {
        configured: openrouterKeys.length > 0,
        keys: openrouterKeys.map((item, index) => ({
          index,
          label: item.label,
          masked: maskKey(item.key),
        })),
        ttsModel: OPENROUTER_TTS_MODEL,
        defaultVoiceId: OPENROUTER_DEFAULT_VOICE,
      },
      groq: {
        configured: groqKeys.length > 0,
        keys: groqKeys.map((item, index) => ({
          index,
          label: item.label,
          masked: maskKey(item.key),
        })),
        chatModel: GROQ_CHAT_MODEL,
        chatModels: GROQ_CHAT_MODELS,
        ttsModel: GROQ_TTS_MODEL,
        ttsVoices: GROQ_TTS_VOICES,
      },
      clod: {
        configured: clodKeys.length > 0,
        keys: clodKeys.map((item, index) => ({
          index,
          label: item.label,
          masked: maskKey(item.key),
        })),
        chatModels: CLOD_CHAT_MODELS,
      },
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api-test/gemini/chat') {
    const body = await readJsonBody(req);
    const result = await handleGeminiChat(body);
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (req.method === 'POST' && pathname === '/api-test/tts/gemini') {
    const body = await readJsonBody(req);
    const result = await handleGeminiTts(body);
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (req.method === 'POST' && pathname === '/api-test/tts/openrouter') {
    const body = await readJsonBody(req);
    const result = await handleOpenRouterTts(body);
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (req.method === 'POST' && pathname === '/api-test/groq/chat') {
    const body = await readJsonBody(req);
    const result = await handleGroqChat(body);
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (req.method === 'POST' && pathname === '/api-test/tts/groq') {
    const body = await readJsonBody(req);
    const result = await handleGroqTts(body);
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (req.method === 'POST' && pathname === '/api-test/clod/chat') {
    const body = await readJsonBody(req);
    const result = await handleClodChat(body);
    sendJson(res, result.statusCode, result.payload);
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
  console.log(`  deAPI keys:      ${getDeApiKeys().length} configured`);
  console.log(`  Gemini keys:     ${getGeminiKeys().length} configured`);
  console.log(`  OpenRouter keys: ${getOpenRouterKeys().length} configured`);
  console.log(`  Groq keys:       ${getGroqKeys().length} configured`);
  console.log(`  Clod keys:       ${getClodKeys().length} configured`);
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set API_TEST_PORT to another port.`);
    process.exit(1);
  }
  throw err;
});
