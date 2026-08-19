"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpeechService = void 0;
/**
 * Speech synthesis service.
 *
 * Uses OpenRouter's `/api/v1/audio/speech` endpoint (Fish Audio s2.1) to turn
 * a short, emotion-tagged voice script into an MP3 file. The voice ID is
 * currently shared across all characters (per-product default); per-character
 * voice IDs can be swapped in later.
 */
const OPENROUTER_SPEECH_ENDPOINT = 'https://openrouter.ai/api/v1/audio/speech';
const SPEECH_MODEL = 'fish-audio/s2.1-pro-free:free';
const DEFAULT_VOICE_ID = '8fdcb77230554e1ab160e2361bff4296';
class SpeechService {
    /**
     * The OpenRouter key lives in the .env as OPENROUTER_API_KEY. A numbered
     * fallback (OPENROUTER_API_KEY1) is honoured in case the key was added with
     * a suffix.
     */
    static getApiKey() {
        return process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY1 || '';
    }
    static isConfigured() {
        return !!this.getApiKey();
    }
    /**
     * Synthesize speech for the given text.
     *
     * @param input.text   The emotion-tagged TTS script, e.g.
     *                     "[soft voice] Hey... [playful] Miss me?"
     * @param input.voice  Fish voice ID; defaults to the shared character voice.
     * @param input.speed  Speech rate (0.6 – 1.5).
     */
    static async generateSpeech(input) {
        const apiKey = this.getApiKey();
        if (!apiKey) {
            throw new Error('OPENROUTER_API_KEY not configured');
        }
        const response = await fetch(OPENROUTER_SPEECH_ENDPOINT, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: SPEECH_MODEL,
                input: input.text,
                voice: input.voice || DEFAULT_VOICE_ID,
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
        return { audioBase64: buffer.toString('base64'), mimeType: contentType };
    }
}
exports.SpeechService = SpeechService;
