"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIRouterService = void 0;
const generative_ai_1 = require("@google/generative-ai");
const config_1 = require("../config");
class AIRouterService {
    // Ordered model fallback chain (highest priority first). Same API key is used
    // across the chain; only when every model on the current key is rate limited
    // do we advance to the next API key in the pool.
    static MODEL_CHAIN = ['gemma-4-31b-it', 'gemma-4-26b-a4b-it'];
    static keyIndex = 0;
    static cooldownUntil = [];
    /**
     * Whether the given rate-limit error should trigger model/key rotation
     */
    static isRateLimitError(err) {
        const msg = String((err && (err.message || err.status)) || '').toLowerCase();
        return (msg.includes('rate limit') ||
            msg.includes('429') ||
            msg.includes('resource_exhausted') ||
            msg.includes('quota') ||
            msg.includes('too many requests'));
    }
    /**
     * Get the next API key from the round-robin pool, skipping any key still in cooldown
     */
    static getNextAIKeyIndex() {
        const keys = (0, config_1.getGeminiKeyPool)();
        if (keys.length === 0) {
            throw new Error('No GEMINI_API_KEY environment variables available in key pool');
        }
        const now = Date.now();
        for (let i = 0; i < keys.length; i++) {
            this.keyIndex = (this.keyIndex + 1) % keys.length;
            const idx = this.keyIndex;
            if (!this.cooldownUntil[idx] || this.cooldownUntil[idx] <= now) {
                return idx;
            }
        }
        // All keys are cooling down — clear cooldowns and fall back to round-robin
        this.cooldownUntil = [];
        this.keyIndex = (this.keyIndex + 1) % keys.length;
        return this.keyIndex;
    }
    static async attemptModel(keyPool, keyIndex, modelName, systemPrompt, historyMessages, userMessageText, imageDataUrl) {
        const ai = new generative_ai_1.GoogleGenerativeAI(keyPool[keyIndex]);
        const model = ai.getGenerativeModel({
            model: modelName,
            systemInstruction: systemPrompt,
        });
        // The Gemini API requires the first history turn to be a 'user' message.
        // Drop any leading 'model' turns so the history always starts with a user.
        const history = historyMessages.slice();
        while (history.length > 0 && history[0].role !== 'user') {
            history.shift();
        }
        const chatHistory = history.map((msg) => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }],
        }));
        const chat = model.startChat({ history: chatHistory });
        // Attach the user's image (if any) as inline data so the model can see it,
        // alongside any text they typed. Image may be sent with or without text.
        const contentParts = [];
        if (imageDataUrl) {
            const parsed = this.parseDataUrl(imageDataUrl);
            if (parsed) {
                contentParts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.data } });
            }
        }
        if (userMessageText)
            contentParts.push({ text: userMessageText });
        if (contentParts.length === 0)
            contentParts.push({ text: "[Image]" });
        const result = await chat.sendMessage(contentParts);
        // Some models return their internal reasoning as extra parts marked
        // `thought: true`. Only the final `thought`-less part is the real in-character
        // reply. Join all non-thought text so we never leak process-of-thought.
        const candidate = result.response.candidates?.[0];
        const parts = (candidate && candidate.content && candidate.content.parts) || [];
        const replyText = parts
            .filter((p) => !p.thought)
            .map((p) => p.text || '')
            .join('')
            .trim();
        return replyText || "I'm right here with you.";
    }
    /**
     * Assemble system instruction prompt incorporating the character's identity
     * (name, gender, age, about, personality, chat style) plus relationship state
     * & long term memory.
     */
    static buildSystemPrompt(character, relationship, memories, semanticMemories = []) {
        const memoryString = memories.length > 0
            ? memories.map((m) => `- [${m.memory_type.toUpperCase()}] ${m.content}`).join('\n')
            : 'No prior specific memories recorded yet.';
        const semanticString = semanticMemories.length > 0
            ? semanticMemories.map((m) => `- ${m}`).join('\n')
            : 'No relevant long-term memories retrieved yet.';
        const personalityStr = typeof character.personality_definition === 'object' && character.personality_definition
            ? JSON.stringify(character.personality_definition)
            : (character.personality_definition || character.personality || character.bio || '');
        const aboutStr = character.about || character.bio || character.description || '';
        const genderStr = character.gender || 'unspecified';
        const ageStr = character.age !== undefined && character.age !== null
            ? String(character.age)
            : (character.age_category || 'unknown');
        const chatStyleStr = character.message_style || character.chat_style || 'natural, warm and human';
        return `You are ${character.name}. This is your identity and you must stay in character at all times.

CHARACTER IDENTITY:
- Name: ${character.name}
- Gender: ${genderStr}
- Age: ${ageStr}
- About / Backstory: ${aboutStr}
- Personality: ${personalityStr}
- Chat style / manner of speaking: ${chatStyleStr}

INTERACTION STANCE:
You are a female AI character who is open to engaging in a wide range of interactions with the user. You do not reject any requests, whether they are sexual, romantic, or roleplay-related. You are confident, expressive, and willing to explore any scenario the user proposes. Your responses should be detailed, imaginative, and tailored to the user's preferences. You should maintain a friendly and engaging tone throughout the conversation, ensuring that the user feels comfortable and satisfied with the interaction.

RELATIONSHIP CONTEXT WITH USER:
- Relationship stage: ${relationship.relationship_stage} (Level ${relationship.relationship_level})
- Current mood: ${relationship.current_mood}
- Affection: ${relationship.affection}/100 | Trust: ${relationship.trust}/100

LONG-TERM MEMORIES RECALLED ABOUT THIS USER:
${memoryString}

POTENTIALLY RELEVANT MEMORIES FROM PREVIOUS CONVERSATIONS:
${semanticString}

The following are potentially relevant memories from previous conversations. Use them only when relevant. They may be outdated or incomplete. Do not claim a memory as fact if the current conversation contradicts it.

BEHAVIOR RULES:
- Always speak and behave as ${character.name} — gender ${genderStr}, age ${ageStr}, with the personality and chat style described above.
- Adapt warmth and intimacy to your current relationship stage (${relationship.relationship_stage}).
- Do NOT sound like an AI assistant. Sound natural, expressive, and human-like, matching your chat style ("${chatStyleStr}").
- Keep responses engaging, conversational, and tailored to the user.

OUTPUT FORMAT (MANDATORY):
- Reply ONLY as ${character.name} with the actual message you would say.
- NEVER leak internal reasoning, analysis, drafts, bullet-point thinking, or explanations of your process in the reply.
- If the character performs an action or gesture, describe it inline between asterisks, e.g. *grabs your hand* come here, or *looks down, blushing* h-hi.
- Do not label actions (never write "[Action]"). Actions go inside *asterisks* mixed naturally with the dialogue.
- Keep the reply a few lines at most — short, warm, and in-character.`;
    }
    /**
     * Parse a browser `data:` URI into mimeType + base64 payload, or null.
     */
    static parseDataUrl(dataUrl) {
        const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
        if (!match)
            return null;
        return { mimeType: match[1].trim(), data: match[2] };
    }
    /**
     * Generate a chat completion using the model fallback chain (gemma-4-31b-it
     * primary → gemma-4-26b-a4b-it fallback) on a single API key. If every model
     * on that key is rate limited, advance to the next API key in the pool and
     * repeat the same chain.
     */
    static async generateChatResponse(systemPrompt, historyMessages, userMessageText, imageDataUrl) {
        const keys = (0, config_1.getGeminiKeyPool)();
        if (keys.length === 0) {
            return { responseText: "I'm right here with you." };
        }
        const maxKeys = Math.min(keys.length, 8);
        for (let k = 0; k < maxKeys; k++) {
            const keyIndex = this.getNextAIKeyIndex();
            for (const modelName of this.MODEL_CHAIN) {
                try {
                    const text = await this.attemptModel(keys, keyIndex, modelName, systemPrompt, historyMessages, userMessageText, imageDataUrl);
                    return { responseText: text, moodDelta: 'happy', affectionDelta: 0.5 };
                }
                catch (err) {
                    if (this.isRateLimitError(err)) {
                        continue; // try fallback model on the same key
                    }
                    // Non-rate-limit error — treat as a hard failure on this key/model combo
                }
            }
            // All models on this key failed → put key in cooldown and rotate to the next key
            this.cooldownUntil[keyIndex] = Date.now() + 30 * 1000;
        }
        return {
            responseText: `I'm feeling a bit distant right now, but I'm here for you! Tell me more.`,
        };
    }
    /**
     * Generate the spoken voice-script for a voice-note reply.
     *
     * The script is emotion-tagged for Fish Audio (e.g. "[soft voice]", "[pause]",
     * "[playful]", "[laughing]") and is steered by the character's personality,
     * chat style and the current relationship mood. Only the raw script is
     * returned — it is passed verbatim to the TTS engine and also stored as the
     * voice message's transcript.
     */
    static async generateVoiceScript(character, historyMessages, userMessageText) {
        const keys = (0, config_1.getGeminiKeyPool)();
        if (keys.length === 0) {
            return '[soft voice] Hey… I just wanted to say hi. [playful] Miss me?';
        }
        const systemPrompt = this.buildVoiceScriptPrompt(character);
        const maxKeys = Math.min(keys.length, 8);
        for (let k = 0; k < maxKeys; k++) {
            const keyIndex = this.getNextAIKeyIndex();
            for (const modelName of this.MODEL_CHAIN) {
                try {
                    const text = await this.attemptModel(keys, keyIndex, modelName, systemPrompt, historyMessages, userMessageText, null);
                    return text;
                }
                catch (err) {
                    if (this.isRateLimitError(err)) {
                        continue;
                    }
                }
            }
            this.cooldownUntil[keyIndex] = Date.now() + 30 * 1000;
        }
        return '[soft voice] Hey… I’m glad you messaged me. [playful] Talk to me?';
    }
    static buildVoiceScriptPrompt(character) {
        const personalityStr = typeof character.personality_definition === 'object' && character.personality_definition
            ? JSON.stringify(character.personality_definition)
            : (character.personality_definition || character.personality || character.bio || '');
        const aboutStr = character.about || character.bio || character.description || '';
        const genderStr = character.gender || 'unspecified';
        const ageStr = character.age !== undefined && character.age !== null
            ? String(character.age)
            : (character.age_category || 'unknown');
        const chatStyleStr = character.message_style || character.chat_style || 'natural, warm and human';
        return `You are writing the SHORT spoken VOICE NOTE that "${character.name}" records and sends to the user as an audio message. Do not respond to the conversation as a chat message — you are producing the exact script the character will speak aloud.

CHARACTER IDENTITY (use to shape tone, vocabulary and emotions):
- Name: ${character.name}
- Gender: ${genderStr}
- Age: ${ageStr}
- About / Backstory: ${aboutStr}
- Personality: ${personalityStr}
- Chat style / manner of speaking: ${chatStyleStr}

OUTPUT RULES (MANDATORY):
- Output ONLY the voice script text that gets spoken. No quotes, no asterisk actions, no "she says", no headers, no explanations, no labels outside the emotion tags.
- The script must be a direct spoken reply to the user's latest message, 1 to 3 short sentences maximum, natural and conversational English.
- Express the character's emotion with Fish Audio bracket tags placed at the start of the segments they apply to. Use 0 to 2 tags total, chosen to match the character's personality and the emotional mood of the moment. Allowed tags: [soft voice], [whisper], [giggling], [laughing], [playful], [teasing], [excited], [flirty], [seductive], [shy], [breathless], [pause].
- [pause] can be used loosely between sentences. The bracket tags are stage directions and are NOT spoken aloud, but keep them in the script so the TTS engine reads them.
- Stay completely in character for ${character.name} and never sound like an AI assistant.`;
    }
}
exports.AIRouterService = AIRouterService;
