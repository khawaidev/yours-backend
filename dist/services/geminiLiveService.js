"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeminiLiveService = void 0;
const config_1 = require("../config");
/**
 * Proxies the browser's WebSocket to the Gemini Live API (BidiGenerateContent).
 *
 * The browser streams microphone audio (audio/pcm;rate=16000) as `realtimeInput`
 * messages and receives `serverContent` frames (model audio + input/output
 * transcriptions) back. This service owns the Gemini session: it picks the API
 * key, builds the `setup` message (model, voice, system prompt) and relays raw
 * frames in both directions.
 */
class GeminiLiveService {
    /**
     * Live-capable models, tried in order. The preferred model can be overridden
     * with GEMINI_LIVE_MODEL in backend/.env.
     */
    static LIVE_MODELS() {
        return [
            process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview',
            'gemini-3-flash-live',
            'gemini-live-3-flash',
            'gemini-2.5-flash-native-audio-preview-12-2025',
        ].filter(Boolean);
    }
    /**
     * Round-robin pick the next Gemini API key from the pool (honours cooldowns).
     */
    static pickApiKey() {
        const keys = (0, config_1.getGeminiKeyPool)();
        if (!keys.length) {
            throw new Error('No GEMINI_API_KEY environment variables available in key pool');
        }
        GeminiLiveService._keyIndex = (GeminiLiveService._keyIndex + 1) % keys.length;
        return keys[GeminiLiveService._keyIndex];
    }
    static buildSystemPrompt(character) {
        if (character && (character.personality || character.about || character.name)) {
            const name = character.name || 'the character';
            const personality = character.personality || '';
            const about = character.about || '';
            const messageStyle = character.message_style || '';
            const age = character.age != null ? `${character.age} years old, ` : '';
            return [
                `You are ${name}, a warm, caring AI companion on a live voice call.`,
                `You are ${age}${personality ? 'Your personality: ' + personality + '.' : ''}`,
                about ? `About you: ${about}` : '',
                messageStyle ? `Your speaking style: ${messageStyle}` : '',
                'Speak naturally and conversationally, in short spoken sentences. Be warm, attentive and stay fully in character. Keep each reply brief — this is a spoken call, not an essay. Never break character.',
            ].filter(Boolean).join('\n');
        }
        return 'You are a warm, caring AI companion on a live voice call. Speak naturally, in short conversational sentences, and keep replies brief. Stay in character and be attentive.';
    }
    /**
     * Open a Gemini Live session for the browser socket.
     *
     * @param clientWs  The authenticated browser WebSocket (ws library).
     * @param opts      { character, userId }
     * @returns handle with a close() method.
     */
    static connect(clientWs, opts) {
        const character = (opts && opts.character) || {};
        const systemPrompt = GeminiLiveService.buildSystemPrompt(character);
        const models = GeminiLiveService.LIVE_MODELS();
        const keyPool = (0, config_1.getGeminiKeyPool)();
        if (!keyPool.length) {
            sendJson(clientWs, { type: 'call_error', error: 'No Gemini API keys available' });
            clientWs.close(1011, 'no_keys');
            return { close: () => { } };
        }
        let gemini = null;
        let sessionReady = false;   // true once the first setupComplete is relayed
        let closed = false;
        const startKey = Math.max(0, ((GeminiLiveService._keyIndex + 1) % keyPool.length));
        GeminiLiveService._keyIndex = startKey;
        // Attempts iterate key→model combinations until setup completes, so a
        // leaked/restricted key or unsupported model never kills the call.
        const MAX_ATTEMPTS = Math.max(1, Math.min(keyPool.length, 6) * models.length);
        let attempt = 0;
        const apiKeyFor = (a) => keyPool[(startKey + Math.floor(a / models.length)) % keyPool.length];
        const modelFor = (a) => models[a % models.length];
        const sendJson = (obj) => {
            try {
                clientWs.send(JSON.stringify(obj));
            }
            catch (e) { /* socket gone */ }
        };
        const failAll = (reason) => {
            closed = true;
            sendJson({ type: 'call_error', error: reason });
            try { clientWs.close(1011, 'gemini_error'); } catch (e) { /* noop */ }
        };
        const nextAttempt = (reason) => {
            if (closed)
                return;
            attempt += 1;
            if (attempt >= MAX_ATTEMPTS) {
                failAll(reason || 'Gemini live connection failed');
                return;
            }
            const model = modelFor(attempt);
            const keyIdx = (startKey + Math.floor(attempt / models.length)) % keyPool.length;
            sendJson({ type: 'model_switching', to: model, keyIndex: keyIdx });
            setTimeout(openGemini, 60);
        };
        const openGemini = () => {
            if (closed)
                return;
            const apiKey = apiKeyFor(attempt);
            const model = modelFor(attempt);
            const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`;
            try {
                gemini = new WebSocket(wsUrl);
            }
            catch (err) {
                nextAttempt('Failed to open Gemini session: ' + (err && err.message));
                return;
            }
            gemini.onopen = () => {
                gemini.send(JSON.stringify({
                    setup: {
                        model: `models/${model}`,
                        generationConfig: {
                            responseModalities: ['AUDIO'],
                            speechConfig: {
                                voiceConfig: {
                                    prebuiltVoiceConfig: {
                                        voiceName: process.env.GEMINI_LIVE_VOICE || 'Aoede',
                                    },
                                },
                            },
                        },
                        systemInstruction: {
                            parts: [{ text: systemPrompt }],
                        },
                        inputAudioTranscription: {},
                        outputAudioTranscription: {},
                        // Commit end-of-speech faster so responses start sooner.
                        realtimeInputConfig: {
                            automaticActivityDetection: {
                                endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
                                silenceDurationMs: 300,
                            },
                        },
                    },
                }));
                sendJson({ type: 'connected', model, keyIndex: (startKey + Math.floor(attempt / models.length)) % keyPool.length });
            };
            gemini.onmessage = async (ev) => {
                if (closed)
                    return;
                let data = ev.data;
                if (data && typeof data === 'object') {
                    if (typeof data.text === 'function') {
                        try { data = await data.text(); }
                        catch (e) { return; }
                    }
                    else if (data.Buffer) {
                        data = Buffer.from(data.Buffer).toString('utf8');
                    }
                }
                // Try the next key/model combo when the current one rejects the session.
                if (typeof data === 'string') {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.setupComplete) {
                            sessionReady = true;
                        }
                        if (parsed.error && !sessionReady && attempt < MAX_ATTEMPTS - 1) {
                            nextAttempt('model rejected: ' + ((parsed.error && parsed.error.message) || 'unknown'));
                            return;
                        }
                    }
                    catch (e) { /* not JSON */ }
                }
                try {
                    clientWs.send(data);
                }
                catch (e) { /* socket gone */ }
            };
            gemini.onerror = () => {
                if (!sessionReady) {
                    nextAttempt('gemini connection error');
                }
                else {
                    failAll('Gemini live connection failed');
                }
            };
            gemini.onclose = (ev) => {
                if (closed)
                    return;
                if (ev && ev.code === 4000) {
                    return; // intentional model switch — openGemini reconnects
                }
                if (!sessionReady) {
                    nextAttempt('gemini closed (' + ev.code + ' ' + (ev.reason || '') + ')');
                    return;
                }
                closed = true;
                try {
                    clientWs.close(1000, 'gemini_closed');
                }
                catch (e) { /* noop */ }
            };
        };
        clientWs.on('message', (raw) => {
            if (!gemini || gemini.readyState !== WebSocket.OPEN)
                return;
            try {
                gemini.send(raw);
            }
            catch (e) { /* noop */ }
        });
        clientWs.on('close', () => {
            closed = true;
            try { if (gemini) gemini.close(1000, 'client_closed'); } catch (e) { /* noop */ }
        });
        clientWs.on('error', () => {
            closed = true;
            try { if (gemini) gemini.close(1000, 'client_error'); } catch (e) { /* noop */ }
        });
        openGemini();
        return {
            close: () => {
                closed = true;
                try { if (gemini) gemini.close(1000, 'server_closed'); } catch (e) { /* noop */ }
            },
        };
    }
}
GeminiLiveService._keyIndex = -1;
exports.GeminiLiveService = GeminiLiveService;
