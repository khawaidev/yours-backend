"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIRouterService = void 0;
const config_1 = require("../config");
class AIRouterService {
    // Groq chat fallback chain (highest priority first). The same API key is
    // used across the chain; only when every model on the current key fails do
    // we advance to the next Groq API key in the pool.
    static GROQ_CHAT_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
    static GROQ_MODEL_CHAIN = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'];
    static GROQ_MAX_COMPLETION_TOKENS = 2048;
    static groqKeyIndex = 0;
    static groqCooldownUntil = [];
    /**
     * Get the next Groq API key from the round-robin pool, skipping any key
     * still in cooldown.
     */
    static getNextGroqKeyIndex() {
        const keys = (0, config_1.getGroqKeyPool)();
        if (keys.length === 0) {
            throw new Error('No GROQ_API_KEY environment variables available in key pool');
        }
        const now = Date.now();
        for (let i = 0; i < keys.length; i++) {
            this.groqKeyIndex = (this.groqKeyIndex + 1) % keys.length;
            const idx = this.groqKeyIndex;
            if (!this.groqCooldownUntil[idx] || this.groqCooldownUntil[idx] <= now) {
                return idx;
            }
        }
        // All keys are cooling down — clear cooldowns and fall back to round-robin.
        this.groqCooldownUntil = [];
        this.groqKeyIndex = (this.groqKeyIndex + 1) % keys.length;
        return this.groqKeyIndex;
    }
    /**
     * Build the OpenAI-style message list used by Groq. GPT-OSS models on Groq
     * are text-only, so any attached image is intentionally omitted and the
     * text (if any) is still sent.
     */
    static buildGroqMessages(systemPrompt, historyMessages, userMessageText, imageDataUrl) {
        const messages = [];
        if (systemPrompt && String(systemPrompt).trim()) {
            messages.push({ role: 'system', content: String(systemPrompt).trim() });
        }
        for (const msg of historyMessages || []) {
            if (!msg)
                continue;
            const content = String(msg.content || '').trim();
            if (!content)
                continue;
            messages.push({
                role: msg.role === 'user' ? 'user' : 'assistant',
                content,
            });
        }
        let userText = String(userMessageText || '').trim();
        if (!userText && imageDataUrl) {
            userText = '[The user attached an image, but this model cannot view images.]';
        }
        if (userText)
            messages.push({ role: 'user', content: userText });
        return messages;
    }
    /**
     * One Groq chat-completions attempt for a specific key + model.
     *
     * GPT-OSS reasoning settings from the Groq docs: reasoning_effort accepts
     * low/medium/high, and include_reasoning controls whether the reasoning
     * trace is returned. The app never displays the trace, so it stays hidden.
     */
    static async attemptGroqModel(apiKey, modelName, systemPrompt, historyMessages, userMessageText, imageDataUrl) {
        const messages = this.buildGroqMessages(systemPrompt, historyMessages, userMessageText, imageDataUrl);
        if (messages.length === 0) {
            throw new Error('No messages to send to Groq');
        }
        const response = await fetch(this.GROQ_CHAT_ENDPOINT, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: modelName,
                messages,
                temperature: 0.8,
                max_completion_tokens: this.GROQ_MAX_COMPLETION_TOKENS,
                reasoning_effort: 'low',
                include_reasoning: false,
            }),
            signal: AbortSignal.timeout(45000),
        });
        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(`Groq ${modelName} ${response.status}: ${errorText || response.statusText}`);
        }
        const json = await response.json();
        const message = json && json.choices && json.choices[0] && json.choices[0].message;
        let content = message ? message.content : '';
        if (Array.isArray(content)) {
            content = content.map((part) => (part && part.text) || '').join('');
        }
        const replyText = String(content || '').trim();
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
     * Generate a chat completion using the Groq fallback chain
     * (openai/gpt-oss-20b primary → openai/gpt-oss-120b fallback) on a single
     * API key. If every model on that key fails, advance to the next Groq API
     * key in the pool and repeat the same chain.
     */
    static async generateChatResponse(systemPrompt, historyMessages, userMessageText, imageDataUrl) {
        const keys = (0, config_1.getGroqKeyPool)();
        if (keys.length === 0) {
            return { responseText: "I'm right here with you." };
        }
        const maxKeys = Math.min(keys.length, 8);
        for (let k = 0; k < maxKeys; k++) {
            const keyIndex = this.getNextGroqKeyIndex();
            for (const modelName of this.GROQ_MODEL_CHAIN) {
                try {
                    const text = await this.attemptGroqModel(keys[keyIndex], modelName, systemPrompt, historyMessages, userMessageText, imageDataUrl);
                    return { responseText: text, moodDelta: 'happy', affectionDelta: 0.5 };
                }
                catch (err) {
                    console.warn(`[AIRouterService] Groq ${modelName} failed:`, err && err.message ? err.message : err);
                }
            }
            // Both models failed on this key → cool it down and rotate to the next key.
            this.groqCooldownUntil[keyIndex] = Date.now() + 30 * 1000;
        }
        return {
            responseText: `I'm feeling a bit distant right now, but I'm here for you! Tell me more.`,
        };
    }
    /**
     * Generate the spoken voice-script for a voice-note reply.
     *
     * The script is emotion-tagged (e.g. "[soft voice]", "[pause]", "[playful]")
     * and is steered by the character's personality, chat style and the current
     * relationship mood. Gemini TTS gets the tags stripped, while the Fish Audio
     * fallback uses them verbatim. The original tagged script is also stored as
     * the voice message's transcript.
     */
    static async generateVoiceScript(character, historyMessages, userMessageText) {
        const keys = (0, config_1.getGroqKeyPool)();
        if (keys.length === 0) {
            return '[soft voice] Hey… I just wanted to say hi. [playful] Miss me?';
        }
        const systemPrompt = this.buildVoiceScriptPrompt(character);
        const maxKeys = Math.min(keys.length, 8);
        for (let k = 0; k < maxKeys; k++) {
            const keyIndex = this.getNextGroqKeyIndex();
            for (const modelName of this.GROQ_MODEL_CHAIN) {
                try {
                    const text = await this.attemptGroqModel(keys[keyIndex], modelName, systemPrompt, historyMessages, userMessageText, null);
                    return text;
                }
                catch (err) {
                    console.warn(`[AIRouterService] Groq voice script ${modelName} failed:`, err && err.message ? err.message : err);
                }
            }
            this.groqCooldownUntil[keyIndex] = Date.now() + 30 * 1000;
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
