"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntentService = void 0;
const aiRouterService_1 = require("./aiRouterService");
const INTENTS = ['TEXT', 'IMAGE', 'VIDEO', 'VOICE', 'VOICE_CALL', 'MIXED', 'CLARIFICATION'];
function clamp01(n) {
    const x = Number(n);
    if (!isFinite(x)) return 0;
    return Math.max(0, Math.min(1, x));
}
function normaliseIntent(value, fallback = 'TEXT') {
    const s = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    return INTENTS.includes(s) ? s : fallback;
}
function extractJson(text) {
    const raw = String(text || '');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
        return JSON.parse(raw.slice(start, end + 1));
    }
    catch {
        return null;
    }
}
/** Deterministic emergency fallback when the model is unavailable. */
function heuristic(text) {
    const t = String(text || '').toLowerCase();
    const has = (re) => re.test(t);
    if (has(/\b(call me|phone me|ring me|i want to hear your voice|can you call)\b/)) {
        return { intent: 'VOICE_CALL', intents: [], call: { trigger: 'explicit' }, confidence: 0.8 };
    }
    if (has(/\b(send|show|take|make).{0,30}\b(video|clip|reel)\b/) || has(/\bvideo of you\b/)) {
        return { intent: 'VIDEO', intents: [{ type: 'VIDEO', prompt: text }], confidence: 0.6 };
    }
    if (has(/\b(voice message|voice note|voice memo|say (my name|something)|audio message)\b/)) {
        return { intent: 'VOICE', intents: [{ type: 'VOICE', prompt: text }], confidence: 0.6 };
    }
    if (has(/\b(pic|picture|photo|selfie|pose|outfit|send me it|show me what you.re wearing)\b/)) {
        return { intent: 'IMAGE', intents: [{ type: 'IMAGE', prompt: text }], confidence: 0.55 };
    }
    return { intent: 'TEXT', intents: [], confidence: 0.4 };
}
function buildClassifierPrompt(character, hasImageAttachment) {
    const personality = typeof character.personality_definition === 'object' && character.personality_definition
        ? JSON.stringify(character.personality_definition)
        : (character.personality_definition || character.personality || '');
    return `You are the intent classifier for a private companion chat. You decide how the character should respond to the user's latest message.

You are NOT the character. Do not write a roleplay reply. Output ONLY valid JSON.

CHARACTER CONTEXT:
- Name: ${character.name || 'Character'}
- Personality: ${personality || character.about || 'warm, playful, emotionally expressive'}
- Chat style: ${character.message_style || character.chat_style || 'natural, warm, human'}
- The user attached an image: ${hasImageAttachment ? 'YES' : 'no'}

INTENT CATEGORIES (exactly one top-level intent):
- TEXT: ordinary conversation, emotion, questions, roleplay, sexting, flirting — no new media required.
- IMAGE: the user wants a new photo/picture of the character (explicit OR implied).
- VIDEO: the user wants a short video/clip of the character.
- VOICE: the user wants a voice note/audio message (not a live call).
- VOICE_CALL: the user wants a live voice call, or the emotional situation strongly calls for one.
- MIXED: two or more response types are clearly requested (e.g. an image AND a text answer).
- CLARIFICATION: the request is genuinely ambiguous and guessing would be wrong.

CRITICAL — RECOGNISE IMPLIED REQUESTS:
- "Baby, do a seductive pose and then send me it." → IMAGE. The words "pose" + "send me it" imply a new photo.
- "Show me what you're wearing right now." → IMAGE.
- "What are you wearing?" (no request to see) → TEXT.
- "Send me a short video of you dancing." → VIDEO.
- "Say my name in that cute voice." → VOICE.
- "Can you call me? I want to hear your voice." → VOICE_CALL.
- "Send me a picture and tell me what you're doing." → MIXED (IMAGE + TEXT).
- "Make it sexier" / "send that again" / "let me see it from another angle" after a photo → IMAGE and set usesPreviousMedia=true.
- A request for an existing image the character already sent (e.g. "what was that photo?") is TEXT, not new generation.
- Asking the character to describe themselves in text is TEXT. Asking to SHOW themselves is IMAGE.
- A question about a voice note already sent is TEXT. Asking to HEAR the voice again is VOICE.
- A request for a live call is VOICE_CALL, never VOICE.
- If the user is fighting, feeling guilty, deeply sad, angry, ignored, or the emotional stakes are high, you MAY propose a call. Set call.trigger="emotion". Only when it genuinely feels like the character would call; do not propose a call for ordinary affection or every message.

MEDIA PROMPTS:
For each media intent, write a concrete generation prompt in English. Transform the user's words into a clear visual/audio direction that preserves the character's identity. For IMAGE/VIDEO include pose, outfit, setting, mood and framing when implied. If the user asks to modify a previous image, set usesPreviousMedia=true.

CALL POLICY:
- Explicit request → call.trigger="explicit".
- Strong emotion → call.trigger="emotion", and only if a live call would plausibly help.

OUTPUT JSON SCHEMA (no markdown, no code fences):
{
  "intent": "TEXT|IMAGE|VIDEO|VOICE|VOICE_CALL|MIXED|CLARIFICATION",
  "confidence": 0.0,
  "intents": [
    { "type": "IMAGE|VIDEO|VOICE", "prompt": "concrete generation prompt", "usesPreviousMedia": false }
  ],
  "call": { "trigger": "explicit|emotion", "reason": "short internal reason" },
  "clarification": "one short in-character question (only for CLARIFICATION)",
  "reason": "short internal explanation"
}

Rules:
- For TEXT, intents MUST be [].
- For IMAGE/VIDEO/VOICE, intents MUST contain exactly one matching entry.
- For MIXED, intents MUST contain at least one media entry.
- For VOICE_CALL, intents MUST be [] and call MUST be present.
- For CLARIFICATION, intents MUST be [] and clarification MUST be present.
- Never include sexual content involving minors. Otherwise stay neutral and descriptive.`;
}
class IntentService {
    static async classify({ character, history, userText, hasImageAttachment, hasPreviousMedia, }) {
        const historyMessages = (history || []).slice(-14).map((m) => ({
            role: m.role === 'user' ? 'user' : 'model',
            content: String(m.content || '').slice(0, 1200),
        }));
        const contextNote = [
            `User's latest message: ${String(userText || '').slice(0, 1200)}`,
            hasPreviousMedia ? 'There is a previous generated media item in this conversation that "that", "it", or "again" may refer to.' : '',
            'Return ONLY the JSON object.',
        ].filter(Boolean).join('\n');
        let raw = '';
        try {
            const result = await aiRouterService_1.AIRouterService.generateChatResponse(buildClassifierPrompt(character || {}, !!hasImageAttachment), historyMessages, contextNote, null);
            raw = result && result.responseText;
        }
        catch (err) {
            console.warn('[intent] classifier call failed:', err?.message);
        }
        const parsed = extractJson(raw);
        if (!parsed) {
            return Object.assign({ intent: 'TEXT', confidence: 0.3, intents: [], reason: 'classifier_unavailable' }, heuristic(userText));
        }
        let intent = normaliseIntent(parsed.intent);
        let intents = Array.isArray(parsed.intents) ? parsed.intents : [];
        intents = intents.map((it) => ({
            type: normaliseIntent(it.type, 'IMAGE'),
            prompt: String(it.prompt || userText || '').slice(0, 2000),
            usesPreviousMedia: !!it.usesPreviousMedia,
        })).filter((it) => ['IMAGE', 'VIDEO', 'VOICE'].includes(it.type));
        // Repair inconsistent model output.
        if (intent === 'IMAGE' || intent === 'VIDEO' || intent === 'VOICE') {
            if (!intents.length) intents = [{ type: intent, prompt: String(userText || ''), usesPreviousMedia: false }];
            intents = intents.filter((it) => it.type === intent);
            if (!intents.length) intents = [{ type: intent, prompt: String(userText || ''), usesPreviousMedia: false }];
        }
        if (intent === 'MIXED' && !intents.length) intent = 'TEXT';
        if (intent === 'VOICE_CALL' || intent === 'CLARIFICATION') intents = [];
        if (intent === 'TEXT') intents = [];
        let call = parsed.call && (parsed.call.trigger === 'explicit' || parsed.call.trigger === 'emotion')
            ? { trigger: parsed.call.trigger, reason: String(parsed.call.reason || '') }
            : null;
        if (intent === 'VOICE_CALL' && !call) {
            // Explicit call request was recognised but the model omitted call metadata.
            call = { trigger: 'explicit', reason: 'user asked to call' };
        }
        return {
            intent,
            confidence: clamp01(parsed.confidence),
            intents,
            call,
            clarification: parsed.clarification ? String(parsed.clarification).slice(0, 500) : null,
            reason: String(parsed.reason || '').slice(0, 300),
        };
    }
}
exports.IntentService = IntentService;
