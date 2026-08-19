"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QdrantService = void 0;
const js_client_rest_1 = require("@qdrant/js-client-rest");
const config_1 = require("../config");
class QdrantService {
    static client = null;
    /**
     * Get the shared Qdrant client. Throws if not configured.
     */
    static getClient() {
        if (this.client)
            return this.client;
        if (!config_1.CONFIG.QDRANT_URL || !config_1.CONFIG.QDRANT_API_KEY) {
            throw new Error('Qdrant is not configured (QDRANT_URL / QDRANT_API_KEY)');
        }
        this.client = new js_client_rest_1.QdrantClient({
            url: config_1.CONFIG.QDRANT_URL,
            apiKey: config_1.CONFIG.QDRANT_API_KEY,
            timeout: 15000,
        });
        return this.client;
    }
    static isConfigured() {
        return !!(config_1.CONFIG.QDRANT_URL && config_1.CONFIG.QDRANT_API_KEY);
    }
    /**
     * Verify the collection exists with the correct vector dimension.
     * Creates it if missing; throws loudly if dimension mismatches config.
     */
    static async ensureCollection() {
        const client = this.getClient();
        const name = config_1.memoryConfig.collectionName;
        const existing = await client.collectionExists(name);
        if (existing.exists) {
            const info = await client.getCollection(name);
            const vectors = info.config?.params?.vectors;
            const size = vectors && !Array.isArray(vectors) ? vectors.size : undefined;
            if (size !== undefined && size !== config_1.memoryConfig.embeddingDimension) {
                throw new Error(`Qdrant collection "${name}" has vector size ${size} but configured embedding dimension is ${config_1.memoryConfig.embeddingDimension}. Refusing to continue to avoid corrupting the vector space.`);
            }
        }
        else {
            await client.createCollection(name, {
                vectors: {
                    size: config_1.memoryConfig.embeddingDimension,
                    distance: 'Cosine',
                },
            });
        }
        // A keyword index on user_id is required so every memory query can be
        // filtered by the authenticated user. Create it idempotently.
        await this.ensureFieldIndex(client, name, 'user_id');
        await this.ensureFieldIndex(client, name, 'conversation_id');
    }
    static async ensureFieldIndex(client, collection, field) {
        try {
            await client.createPayloadIndex(collection, {
                field_name: field,
                field_schema: 'keyword',
            });
        }
        catch (err) {
            // "already exists" — ignore; anything else is fatal.
            const msg = String(err?.message || err).toLowerCase();
            if (!msg.includes('already exists') && !msg.includes('already_b') && !msg.startsWith('409')) {
                throw err;
            }
        }
    }
    /**
     * Upsert one memory point (idempotent on the same point id).
     */
    static async upsertMemory(point) {
        const client = this.getClient();
        await client.upsert(config_1.memoryConfig.collectionName, {
            wait: true,
            points: [
                { id: point.id, vector: point.vector, payload: point.payload },
            ],
        });
    }
    /**
     * Query semantically similar memories for a user.
     * The query is always scoped to the authenticated user.
     */
    static async queryMemories(userId, queryVector, limit = config_1.memoryConfig.retrievalLimit, scoreThreshold) {
        const client = this.getClient();
        const result = await client.query(config_1.memoryConfig.collectionName, {
            query: queryVector,
            filter: {
                must: [
                    {
                        key: 'user_id',
                        match: { value: userId },
                    },
                ],
            },
            limit,
            with_payload: true,
            score_threshold: scoreThreshold,
        });
        return (result.points || []).map((p) => ({
            id: String(p.id),
            score: p.score,
            payload: p.payload,
        }));
    }
    /**
     * Delete all memories for a user (account deletion / GDPR).
     */
    static async deleteUserMemories(userId) {
        const client = this.getClient();
        await client.delete(config_1.memoryConfig.collectionName, {
            wait: true,
            filter: {
                must: [
                    {
                        key: 'user_id',
                        match: { value: userId },
                    },
                ],
            },
        });
    }
    /**
     * Delete all memories for a user within a specific conversation.
     */
    static async deleteConversationMemories(userId, conversationId) {
        const client = this.getClient();
        await client.delete(config_1.memoryConfig.collectionName, {
            wait: true,
            filter: {
                must: [
                    {
                        key: 'user_id',
                        match: { value: userId },
                    },
                    {
                        key: 'conversation_id',
                        match: { value: conversationId },
                    },
                ],
            },
        });
    }
    /**
     * Lightweight health check: pings the collection.
     */
    static async healthCheck() {
        try {
            const client = this.getClient();
            const info = await client.getCollection(config_1.memoryConfig.collectionName);
            return { ok: true, detail: JSON.stringify(info.config?.params?.vectors || {}) };
        }
        catch (err) {
            return { ok: false, detail: err?.message || String(err) };
        }
    }
}
exports.QdrantService = QdrantService;
