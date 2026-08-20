"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmbeddingService = void 0;
const generative_ai_1 = require("@google/generative-ai");
const config_1 = require("../config");
// Embeddings are deterministic per input text, so results are memoized in
// memory. Each chat turn embeds the same query text 2-3x (semantic retrieval,
// duplicate check) and cached hits skip a paid Gemini call entirely.
const EMBED_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const EMBED_CACHE_MAX = 2000;
const embedCache = new Map();
class EmbeddingService {
    /**
     * Embed text using the configured Gemini embedding model.
     * Validates the returned vector dimension before returning it.
     */
    static async embedText(text) {
        const cached = embedCache.get(text);
        if (cached && Date.now() - cached.ts < EMBED_CACHE_TTL_MS) {
            return { vector: cached.vector, model: config_1.memoryConfig.embeddingModel, dimension: cached.vector.length };
        }
        const keys = (0, config_1.getGeminiKeyPool)();
        if (keys.length === 0) {
            throw new Error('No GEMINI_API_KEY environment variables available in key pool');
        }
        // Try each key; fall through on transient errors. Cap the number of keys
        // tried and give each call a hard timeout so slow/blocked keys can never
        // stall an inline chat request for long.
        let lastError = null;
        const maxKeys = Math.min(keys.length, 4);
        for (let i = 0; i < maxKeys; i++) {
            try {
                const ai = new generative_ai_1.GoogleGenerativeAI(keys[i]);
                const model = ai.getGenerativeModel({ model: config_1.memoryConfig.embeddingModel });
                const result = await model.embedContent({
                    content: { parts: [{ text }] },
                    outputDimensionality: config_1.memoryConfig.embeddingDimension,
                }, { timeout: 15000 });
                const vector = result.embedding?.values;
                if (!vector || !Array.isArray(vector) || vector.length === 0) {
                    throw new Error('Embedding response contained no values');
                }
                if (vector.length !== config_1.memoryConfig.embeddingDimension) {
                    throw new Error(`Embedding returned ${vector.length} dims but ${config_1.memoryConfig.embeddingDimension} expected`);
                }
                if (embedCache.size >= EMBED_CACHE_MAX) {
                    // Drop the oldest entry to keep memory bounded.
                    let oldestKey = null;
                    let oldestTs = Infinity;
                    for (const [k, v] of embedCache) {
                        if (v.ts < oldestTs) {
                            oldestTs = v.ts;
                            oldestKey = k;
                        }
                    }
                    if (oldestKey)
                        embedCache.delete(oldestKey);
                }
                embedCache.set(text, { ts: Date.now(), vector });
                return { vector, model: config_1.memoryConfig.embeddingModel, dimension: vector.length };
            }
            catch (err) {
                lastError = err;
            }
        }
        throw lastError || new Error('Embedding generation failed');
    }
}
exports.EmbeddingService = EmbeddingService;
