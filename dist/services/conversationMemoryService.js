"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationMemoryService = void 0;
const crypto_1 = require("crypto");
const generative_ai_1 = require("@google/generative-ai");
const config_1 = require("../config");
const embeddingService_1 = require("./embeddingService");
const qdrantService_1 = require("./qdrantService");
const conversationStorageService_1 = require("./conversationStorageService");
/**
 * Converts a batch of recent messages into a compact structured memory and
 * persists it (embedding + compact payload) into Qdrant.
 *
 * R2 remains the source of truth for the complete conversation; only the
 * semantic summary is stored in Qdrant.
 */
class ConversationMemoryService {
    static generationModel = 'gemma-4-31b-it';
    /**
     * Build a clean semantic text representation for embedding. We embed prose,
     * not the raw JSON structure.
     */
    static buildMemoryText(memory) {
        const parts = [];
        if (memory.summary)
            parts.push(memory.summary);
        if (memory.facts?.length)
            parts.push(...memory.facts);
        if (memory.goals?.length)
            parts.push(`Goals: ${memory.goals.join('; ')}.`);
        if (memory.preferences?.length)
            parts.push(`Preferences: ${memory.preferences.join('; ')}.`);
        return parts.join('\n');
    }
    /**
     * Generate a structured summary from a batch of messages using the existing
     * Gemini generation model. Returns null if generation fails.
     */
    static async generateSummary(messages) {
        const keys = (0, config_1.getGeminiKeyPool)();
        if (keys.length === 0)
            return null;
        const transcript = messages
            .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
            .join('\n');
        const prompt = `You are a memory curator for an AI companion app. From the chat excerpt below, produce a compact, structured memory that would help future conversations. Focus on stable facts, user goals, preferences, and unresolved questions. Do NOT merely compress the transcript.

Return JSON ONLY in this exact shape:
{
  "summary": "one or two concise sentences capturing the important context",
  "facts": ["list of 0-5 short factual statements about the user"],
  "goals": ["list of 0-5 user goals/intentions"],
  "preferences": ["list of 0-5 user preferences/tastes"],
  "open_questions": ["list of 0-3 questions left open"]
}

CHAT EXCERPT:
${transcript}`;
        // Cap the number of keys tried so a slow or malformed response can never
        // stall a chat request for long. Each key also gets a hard timeout.
        const maxKeys = Math.min(keys.length, 4);
        for (let i = 0; i < maxKeys; i++) {
            try {
                const ai = new generative_ai_1.GoogleGenerativeAI(keys[i]);
                const model = ai.getGenerativeModel({
                    model: this.generationModel,
                    generationConfig: { responseMimeType: 'application/json' },
                });
                const result = await model.generateContent(prompt, { timeout: 30000 });
                const candidate = result.response.candidates?.[0];
                const parts = (candidate && candidate.content && candidate.content.parts) || [];
                const text = parts
                    .filter((p) => !p.thought)
                    .map((p) => p.text || '')
                    .join('');
                const parsed = this.extractJson(text);
                if (!parsed || typeof parsed.summary !== 'string')
                    continue;
                return {
                    summary: parsed.summary,
                    facts: Array.isArray(parsed.facts) ? parsed.facts : [],
                    goals: Array.isArray(parsed.goals) ? parsed.goals : [],
                    preferences: Array.isArray(parsed.preferences) ? parsed.preferences : [],
                    open_questions: Array.isArray(parsed.open_questions) ? parsed.open_questions : [],
                };
            }
            catch {
                // try next key
            }
        }
        return null;
    }
    /**
     * Models sometimes prefix or suffix the JSON with reasoning text (or emit
     * thought parts). Extract the first balanced JSON object from the text.
     */
    static extractJson(text) {
        if (!text)
            return null;
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start === -1 || end === -1 || end <= start)
            return null;
        const candidate = text.slice(start, end + 1);
        try {
            return JSON.parse(candidate);
        }
        catch {
            return null;
        }
    }
    /**
     * Summarize a batch of messages, embed the result, and upsert into Qdrant.
     * Returns the created/updated memory point, or null if generation failed.
     */
    static async createMemoryFromMessages(userId, conversationId, characterId, messages) {
        const summary = await this.generateSummary(messages);
        if (!summary)
            return null;
        const memoryText = this.buildMemoryText(summary);
        const embedding = await embeddingService_1.EmbeddingService.embedText(memoryText);
        const id = (0, crypto_1.randomUUID)();
        const now = new Date().toISOString();
        const payload = {
            user_id: userId,
            conversation_id: conversationId,
            character_id: characterId,
            type: 'conversation_memory',
            summary: summary.summary,
            facts: summary.facts,
            goals: summary.goals,
            preferences: summary.preferences,
            created_at: now,
            updated_at: now,
            embedding_model: embedding.model,
            embedding_dimension: embedding.dimension,
        };
        await qdrantService_1.QdrantService.upsertMemory({ id, vector: embedding.vector, payload });
        return { id, summary: summary.summary };
    }
    /**
     * Retrieve semantically relevant memories for a user. Always scoped to the
     * authenticated user and filtered by a minimum similarity score.
     */
    static async retrieveRelevantMemories(userId, queryText, options = {}) {
        const limit = options.limit ?? config_1.memoryConfig.retrievalLimit;
        const minimumScore = options.minimumScore ?? config_1.memoryConfig.minimumScore;
        if (!qdrantService_1.QdrantService.isConfigured())
            return [];
        const embedding = await embeddingService_1.EmbeddingService.embedText(queryText);
        const hits = await qdrantService_1.QdrantService.queryMemories(userId, embedding.vector, limit, minimumScore);
        return hits
            .filter((h) => h.score >= minimumScore)
            .map((h) => ({ id: h.id, score: h.score, summary: h.payload.summary }));
    }
    /**
     * Deduplication: search the user's recent memories; if a highly similar one
     * exists, treat it as the same memory (upsert will overwrite the point).
     * For a first implementation we keep this simple: before creating a new
     * memory we check for near-identical summaries and skip if found.
     */
    static async hasNearDuplicate(userId, summaryText) {
        if (!qdrantService_1.QdrantService.isConfigured())
            return false;
        try {
            const embedding = await embeddingService_1.EmbeddingService.embedText(summaryText);
            const hits = await qdrantService_1.QdrantService.queryMemories(userId, embedding.vector, 1, 0.95);
            return hits.length > 0 && hits[0].score >= 0.95;
        }
        catch {
            return false;
        }
    }
    /**
     * Background memory update. Called after a new message exchange; checks
     * whether enough new messages have accumulated and, if so, summarizes the
     * recent window, embeds it, and upserts a Qdrant memory. Never throws — all
     * failures are logged and swallowed so chat is never broken by memory work.
     */
    static async maybeSummarizeConversation(userId, conversationId, characterId, meta) {
        try {
            const currentMeta = meta || await conversationStorageService_1.ConversationStorageService.getMetadata(userId, conversationId);
            const processed = currentMeta.summarizedThrough || 0;
            const pending = currentMeta.messageCount - processed;
            if (pending < config_1.memoryConfig.summaryMessageThreshold)
                return;
            const windowMessages = await conversationStorageService_1.ConversationStorageService.readRecentMessages(userId, conversationId, config_1.memoryConfig.summaryMessageThreshold);
            // Keep them in chronological order for the summary.
            const chronological = windowMessages.reverse();
            if (chronological.length === 0)
                return;
            const summary = await this.generateSummary(chronological);
            if (!summary)
                return;
            const memoryText = this.buildMemoryText(summary);
            if (await this.hasNearDuplicate(userId, memoryText)) {
                // Highly similar memory already exists — just advance the watermark.
                await conversationStorageService_1.ConversationStorageService.saveMetadata({
                    ...currentMeta,
                    summarizedThrough: currentMeta.messageCount,
                });
                return;
            }
            const embedding = await embeddingService_1.EmbeddingService.embedText(memoryText);
            const id = (0, crypto_1.randomUUID)();
            const now = new Date().toISOString();
            const payload = {
                user_id: userId,
                conversation_id: conversationId,
                character_id: characterId,
                type: 'conversation_memory',
                summary: summary.summary,
                facts: summary.facts,
                goals: summary.goals,
                preferences: summary.preferences,
                created_at: now,
                updated_at: now,
                embedding_model: embedding.model,
                embedding_dimension: embedding.dimension,
            };
            await qdrantService_1.QdrantService.upsertMemory({ id, vector: embedding.vector, payload });
            // Advance the watermark only after a successful persist.
            await conversationStorageService_1.ConversationStorageService.saveMetadata({
                ...currentMeta,
                summarizedThrough: currentMeta.messageCount,
            });
        }
        catch (err) {
            console.error('[memory] background summarization failed:', err?.message || err);
        }
    }
}
exports.ConversationMemoryService = ConversationMemoryService;
