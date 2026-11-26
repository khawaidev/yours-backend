"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpeechService = void 0;
/**
 * Speech synthesis service.
 *
 * Primary path: Gemini TTS (`gemini-3.8-flash-tts` → `gemini-3.8-flash-lite-tts`)
 * using the Gemini API key pool. If both models fail on a key, the next Gemini
 * key is tried. Only after every Gemini key/model has failed do we fall back to
 * OpenRouter's `/api/v1/audio/speech` endpoint (Fish Audio s2.1).
 */
const config_1 = require("../config");
const GEMINI_TTS_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_TTS_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'];
const GEMINI_TTS_VOICES = ['Kore', 'Zephyr', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Sulafat'];
const GEMINI_FEMALE_VOICES = ['Kore', 'Aoede', 'Leda', 'Sulafat', 'Zephyr'];
const GEMINI_DEFAULT_VOICE = 'Kore';
const OPENROUTER_SPEECH_ENDPOINT = 'https://openrouter.ai/api/v1/audio/speech';
const SPEECH_MODEL = 'fish-audio/s2.1-pro-free:free';
const DEFAULT_VOICE_ID = '8fdcb77230554e1ab160e2361bff4296';
/**
 * Gemini TTS returns raw 16-bit PCM. Wrap it in a WAV container so browsers can
 * play the result directly.
 */
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
    if (!match)
        return fallback;
    const rate = Number(match[1]);
    return Number.isFinite(rate) && rate > 0 ? rate : fallback;
}
/**
 * Gemini TTS reads text literally, so Fish-style stage directions such as
 * "[soft voice]" or "[pause]" must be removed before synthesis.
 */
function sanitizeForGemini(text) {
    return String(text || '')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function hashString(value) {
    let hash = 0;
    const str = String(value || '');
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}
class SpeechService {
    static getGeminiKeys() {
        return (0, config_1.getGeminiKeyPool)();
    }
    static getOpenRouterKeys() {
        const keys = [];
        if (process.env.OPENROUTER_API_KEY)
            keys.push(process.env.OPENROUTER_API_KEY);
        for (let i = 1; i <= 50; i++) {
            const key = process.env[`OPENROUTER_API_KEY${i}`];
            if (key)
                keys.push(key);
        }
        return keys;
    }
    static isConfigured() {
        return this.getGeminiKeys().length > 0 || this.getOpenRouterKeys().length > 0;
    }
    /**
     * Pick a Gemini voice name. A character may already store a Gemini voice
     * name; otherwise its Fish voice ID is hashed to a stable female voice so
     * each character keeps a consistent voice across turns.
     */
    static resolveGeminiVoice(voice) {
        const requested = String(voice || '').trim();
        if (GEMINI_TTS_VOICES.includes(requested))
            return requested;
        if (!requested)
            return GEMINI_DEFAULT_VOICE;
        return GEMINI_FEMALE_VOICES[hashString(requested) % GEMINI_FEMALE_VOICES.length];
    }
    static resolveFishVoice(voice) {
        const requested = String(voice || '').trim();
        return /^[a-f0-9]{32}$/i.test(requested) ? requested : DEFAULT_VOICE_ID;
    }
    static async synthesizeWithGemini(apiKey, model, input) {
        const voiceName = this.resolveGeminiVoice(input.voice);
        const text = sanitizeForGemini(input.text);
        if (!text) {
            throw new Error('Gemini TTS text is empty');
        }
        const endpoint = `${GEMINI_TTS_BASE}/models/${encodeURIComponent(model)}:generateContent`;
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey,
            },
            body: JSON.stringify({
                contents: [{ parts: [{ text }] }],
                generationConfig: {
                    responseModalities: ['AUDIO'],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: { voiceName },
                        },
                    },
                },
            }),
            signal: AbortSignal.timeout(90000),
        });
        if (!response.ok) {
            const error = await response.text().catch(() => '');
            throw new Error(`Gemini TTS ${model} error ${response.status}: ${error}`);
        }
        const json = await response.json();
        const candidate = json && json.candidates && json.candidates[0];
        const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
            ? candidate.content.parts
            : [];
        const audioPart = parts.find((part) => part && part.inlineData && part.inlineData.data);
        if (!audioPart) {
            throw new Error(`Gemini TTS ${model} returned no audio`);
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
            audioBase64: audioBuffer.toString('base64'),
            mimeType,
            provider: 'gemini',
            model,
            voiceId: voiceName,
        };
    }
    static async synthesizeWithOpenRouter(apiKey, input) {
        const voice = this.resolveFishVoice(input.voice);
        const response = await fetch(OPENROUTER_SPEECH_ENDPOINT, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: SPEECH_MODEL,
                input: input.text,
                voice,
                response_format: 'mp3',
                speed: input.speed ?? 1.0,
                temperature: 0.7,
                top_p: 0.7,
                repetition_penalty: 1.2,
            }),
            signal: AbortSignal.timeout(90000),
        });
        if (!response.ok) {
            const error = await response.text().catch(() => '');
            throw new Error(`Fish TTS error ${response.status}: ${error}`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get('content-type') || 'audio/mpeg';
        return {
            audioBase64: buffer.toString('base64'),
            mimeType: contentType,
            provider: 'openrouter',
            model: SPEECH_MODEL,
            voiceId: voice,
        };
    }
    /**
     * Synthesize speech for the given text.
     *
     * @param input.text   The emotion-tagged TTS script, e.g.
     *                     "[soft voice] Hey... [playful] Miss me?"
     * @param input.voice  Character voice. A Gemini voice name is used directly;
     *                     a 32-char Fish Audio ID is used for the fallback.
     * @param input.speed  Speech rate (0.6 – 1.5).
     */
    static async generateSpeech(input) {
        const errors = [];
        const geminiKeys = this.getGeminiKeys();
        const maxGeminiKeys = Math.min(geminiKeys.length, 8);
        for (let k = 0; k < maxGeminiKeys; k++) {
            for (const model of GEMINI_TTS_MODELS) {
                try {
                    return await this.synthesizeWithGemini(geminiKeys[k], model, input);
                }
                catch (err) {
                    const message = err && err.message ? err.message : String(err);
                    errors.push(`key ${k + 1} / ${model}: ${message}`);
                    console.warn(`[SpeechService] ${message}`);
                }
            }
        }
        const openRouterKeys = this.getOpenRouterKeys();
        const maxOpenRouterKeys = Math.min(openRouterKeys.length, 8);
        for (let k = 0; k < maxOpenRouterKeys; k++) {
            try {
                return await this.synthesizeWithOpenRouter(openRouterKeys[k], input);
            }
            catch (err) {
                const message = err && err.message ? err.message : String(err);
                errors.push(`OpenRouter key ${k + 1}: ${message}`);
                console.warn(`[SpeechService] ${message}`);
            }
        }
        throw new Error(`Speech synthesis failed on every provider${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    }
}
exports.SpeechService = SpeechService;
