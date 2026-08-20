"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationStorageService = void 0;
const client_s3_1 = require("@aws-sdk/client-s3");
const config_1 = require("../config");
const BUCKET = () => config_1.CONFIG.R2.BUCKET_NAME || 'yours';
// Short-lived in-memory mirror of the most recent R2 objects for a conversation.
// The same metadata.json/chunk is frequently re-read right after being written
// (message append -> background summarization), so caching it for a few seconds
// avoids redundant R2 round trips without ever serving stale data for long.
const OBJECT_CACHE_TTL_MS = 5 * 1000;
const OBJECT_CACHE_MAX = 1000;
const objectCache = new Map();
function conversationDir(userId, conversationId) {
    return `users/${userId}/conversations/${conversationId}`;
}
function chunkKey(userId, conversationId, chunkIndex) {
    return `${conversationDir(userId, conversationId)}/messages/${String(chunkIndex).padStart(6, '0')}.jsonl`;
}
function metadataKey(userId, conversationId) {
    return `${conversationDir(userId, conversationId)}/metadata.json`;
}
/**
 * Persistent conversation storage on Cloudflare R2.
 *
 * Messages are appended to chunked JSONL files (never one giant JSON array):
 *
 *   users/{userId}/conversations/{conversationId}/metadata.json
 *   users/{userId}/conversations/{conversationId}/messages/000001.jsonl
 *   users/{userId}/conversations/{conversationId}/messages/000002.jsonl
 *
 * Each chunk holds up to `r2ChunkSize` messages. This keeps writes bounded and
 * cheap, and R2 is the source of truth for the complete raw conversation.
 */
class ConversationStorageService {
    /**
     * Append new messages to a conversation. Writes them to the current JSONL
     * chunk, rolling to a new chunk once the configured chunk size is reached.
     */
    static async appendMessages(userId, conversationId, characterId, messages) {
        if (messages.length === 0)
            return;
        const meta = await this.getMetadata(userId, conversationId);
        let chunkIndex = meta.chunkCount > 0 ? meta.chunkCount - 1 : 0;
        // Read the current chunk so we can append without rewriting history.
        let existingLines = [];
        try {
            existingLines = await this.readChunk(userId, conversationId, chunkIndex);
        }
        catch {
            existingLines = [];
        }
        const now = new Date().toISOString();
        for (const message of messages) {
            if (existingLines.length >= config_1.memoryConfig.r2ChunkSize) {
                // Roll to a new chunk.
                chunkIndex += 1;
                existingLines = [];
            }
            existingLines.push(JSON.stringify(message));
        }
        await this.putObject(chunkKey(userId, conversationId, chunkIndex), existingLines.join('\n') + '\n', 'application/x-ndjson');
        const newMeta = {
            conversationId,
            userId,
            characterId,
            messageCount: meta.messageCount + messages.length,
            chunkCount: chunkIndex + 1,
            summarizedThrough: meta.summarizedThrough || 0,
            lastMessageAt: messages[messages.length - 1]?.timestamp || now,
            updatedAt: now,
        };
        await this.putObject(metadataKey(userId, conversationId), JSON.stringify(newMeta), 'application/json');
        // Return the fresh metadata so callers (e.g. background summarization)
        // don't have to re-read what we just wrote.
        return newMeta;
    }
    /**
     * Update the summary bookkeeping for a conversation (how many messages have
     * been summarized into Qdrant memories).
     */
    static async saveMetadata(meta) {
        await this.putObject(metadataKey(meta.userId, meta.conversationId), JSON.stringify({ ...meta, updatedAt: new Date().toISOString() }), 'application/json');
    }
    /**
     * Read the most recent N messages from R2, newest first. Reads backward from
     * the last chunk so we never load the full conversation into memory.
     */
    static async readRecentMessages(userId, conversationId, limit) {
        const meta = await this.getMetadata(userId, conversationId);
        if (meta.messageCount === 0 || meta.chunkCount === 0)
            return [];
        const collected = [];
        for (let c = meta.chunkCount - 1; c >= 0; c--) {
            let lines = [];
            try {
                lines = await this.readChunk(userId, conversationId, c);
            }
            catch {
                break;
            }
            for (let i = lines.length - 1; i >= 0; i--) {
                if (collected.length >= limit)
                    break;
                try {
                    collected.push(JSON.parse(lines[i]));
                }
                catch {
                    // skip malformed line
                }
            }
            if (collected.length >= limit)
                break;
        }
        return collected;
    }
    /**
     * Read the entire conversation (all chunks, in order). Used on initial load.
     */
    static async readAllMessages(userId, conversationId) {
        const meta = await this.getMetadata(userId, conversationId);
        const all = [];
        for (let c = 0; c < meta.chunkCount; c++) {
            try {
                const lines = await this.readChunk(userId, conversationId, c);
                for (const line of lines) {
                    try {
                        all.push(JSON.parse(line));
                    }
                    catch {
                        // skip malformed line
                    }
                }
            }
            catch {
                break;
            }
        }
        return all;
    }
    static async getMetadata(userId, conversationId) {
        try {
            const body = await this.getObject(metadataKey(userId, conversationId));
            if (body) {
                const parsed = JSON.parse(body);
                if (parsed)
                    return parsed;
            }
        }
        catch {
            // not found yet — default below
        }
        return {
            conversationId,
            userId,
            messageCount: 0,
            chunkCount: 0,
            summarizedThrough: 0,
            updatedAt: new Date().toISOString(),
        };
    }
    /**
     * Delete all R2 objects for a single conversation (chat reset).
     */
    static async deleteConversationMessages(userId, conversationId) {
        const prefix = `${conversationDir(userId, conversationId)}/`;
        let continuationToken;
        do {
            const list = await config_1.r2Client.send(new client_s3_1.ListObjectsV2Command({
                Bucket: BUCKET(),
                Prefix: prefix,
                ContinuationToken: continuationToken,
            }));
            const keys = (list.Contents || []).map((o) => o.Key).filter((k) => !!k);
            if (keys.length > 0) {
                await config_1.r2Client.send(new client_s3_1.DeleteObjectsCommand({
                    Bucket: BUCKET(),
                    Delete: { Objects: keys.map((Key) => ({ Key })) },
                }));
                keys.forEach((k) => objectCache.delete(k));
            }
            continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
        } while (continuationToken);
    }
    /**
     * Delete all R2 objects belonging to a user (account deletion).
     */
    static async deleteUserData(userId) {
        const prefix = `users/${userId}/`;
        let continuationToken;
        do {
            const list = await config_1.r2Client.send(new client_s3_1.ListObjectsV2Command({
                Bucket: BUCKET(),
                Prefix: prefix,
                ContinuationToken: continuationToken,
            }));
            const keys = (list.Contents || []).map((o) => o.Key).filter((k) => !!k);
            if (keys.length > 0) {
                await config_1.r2Client.send(new client_s3_1.DeleteObjectsCommand({
                    Bucket: BUCKET(),
                    Delete: { Objects: keys.map((Key) => ({ Key })) },
                }));
            }
            continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
        } while (continuationToken);
    }
    static async readChunk(userId, conversationId, chunkIndex) {
        const body = await this.getObject(chunkKey(userId, conversationId, chunkIndex));
        if (!body)
            return [];
        return body
            .split('\n')
            .filter((l) => l.trim().length > 0);
    }
    static async getObject(key) {
        const cached = objectCache.get(key);
        if (cached && Date.now() - cached.ts < OBJECT_CACHE_TTL_MS) {
            return cached.body;
        }
        try {
            const result = await config_1.r2Client.send(new client_s3_1.GetObjectCommand({ Bucket: BUCKET(), Key: key }));
            if (!result.Body)
                return null;
            const chunks = [];
            for await (const chunk of result.Body) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const body = Buffer.concat(chunks).toString('utf8');
            if (body) {
                this.cacheSet(key, body);
            }
            return body;
        }
        catch (err) {
            if (err?.$metadata?.httpStatusCode === 404) {
                objectCache.delete(key);
                return null;
            }
            throw err;
        }
    }
    static async putObject(key, body, contentType) {
        await config_1.r2Client.send(new client_s3_1.PutObjectCommand({
            Bucket: BUCKET(),
            Key: key,
            Body: body,
            ContentType: contentType,
        }));
        // Refresh the cache with what we just wrote so the next read is free.
        if (body) {
            this.cacheSet(key, Buffer.isBuffer(body) ? body.toString('utf8') : body);
        }
    }
    /**
     * Insert into the bounded object cache, evicting the oldest entry when full.
     */
    static cacheSet(key, body) {
        if (objectCache.size >= OBJECT_CACHE_MAX) {
            let oldestKey = null;
            let oldestTs = Infinity;
            for (const [k, v] of objectCache) {
                if (v.ts < oldestTs) {
                    oldestTs = v.ts;
                    oldestKey = k;
                }
            }
            if (oldestKey)
                objectCache.delete(oldestKey);
        }
        objectCache.set(key, { ts: Date.now(), body });
    }
}
exports.ConversationStorageService = ConversationStorageService;
