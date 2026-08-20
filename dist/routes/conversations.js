"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const config_1 = require("../config");
const relationshipService_1 = require("../services/relationshipService");
const memoryService_1 = require("../services/memoryService");
const aiRouterService_1 = require("../services/aiRouterService");
const conversationStorageService_1 = require("../services/conversationStorageService");
const conversationMemoryService_1 = require("../services/conversationMemoryService");
const rateLimitService_1 = require("../services/rateLimitService");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// Recent-messages responses are cached briefly per conversation so chat loads
// don't re-read R2 metadata+chunks on every fetch. Invalidate on any new
// message (POST) or reset (DELETE) so the cache never serves stale history.
const MESSAGES_CACHE_TTL_MS = 10 * 1000;
const messagesCache = new Map();
function messagesCacheKey(userId, conversationId, limit) {
    return userId + ':' + conversationId + ':' + limit;
}
function invalidateMessagesCache(userId, conversationId) {
    const prefix = userId + ':' + conversationId + ':';
    for (const key of messagesCache.keys()) {
        if (key.startsWith(prefix)) {
            messagesCache.delete(key);
        }
    }
}
/**
 * GET /api/v1/conversations
 * Fetch active conversations for user
 */
router.get('/', auth_1.requireAuth, async (req, res) => {
    try {
        const userId = req.query.userId;
        if (!userId)
            return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const { data: conversations, error } = await config_1.supabaseAdmin
            .from('conversations')
            .select('*, character:characters(*, character_feeds(media_url,media_type)), last_message:messages(id, content, sender_type, created_at)')
            .eq('user_id', userId)
            .order('last_message_at', { ascending: false });
        if (error)
            throw new Error(error.message);
        return res.json({ success: true, conversations });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * POST /api/v1/conversations
 * Get or create conversation with character
 */
router.post('/', auth_1.requireAuth, async (req, res) => {
    try {
        const { userId, characterId } = req.body;
        if (!userId || !characterId) {
            return res.status(400).json({ success: false, error: 'userId and characterId required' });
        }
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const { data: existing } = await config_1.supabaseAdmin
            .from('conversations')
            .select('*, character:characters(*, character_feeds(media_url,media_type))')
            .eq('user_id', userId)
            .eq('character_id', characterId)
            .maybeSingle();
        if (existing)
            return res.json({ success: true, conversation: existing });
        const { data: conversation, error } = await config_1.supabaseAdmin
            .from('conversations')
            .insert({ user_id: userId, character_id: characterId })
            .select('*, character:characters(*, character_feeds(media_url,media_type))')
            .single();
        if (error)
            throw new Error(error.message);
        return res.status(201).json({ success: true, conversation });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * GET /api/v1/conversations/:id/messages
 * List recent messages in conversation. Reads from R2 (source of truth); falls
 * back to Supabase when the conversation has not yet been written to R2.
 */
router.get('/:id/messages', auth_1.requireAuth, async (req, res) => {
    try {
        const userId = req.query.userId;
        const limit = parseInt(req.query.limit) || 30;
        if (!userId)
            return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        // The conversation must exist and belong to this user before any messages
        // are read (prevents reading another user's conversation by id).
        const { data: conv, error: convErr } = await config_1.supabaseAdmin
            .from('conversations')
            .select('user_id')
            .eq('id', req.params.id)
            .maybeSingle();
        if (convErr)
            throw new Error(convErr.message);
        if (!conv || conv.user_id !== userId) {
            return res.status(404).json({ success: false, error: 'Conversation not found' });
        }
        const cacheKey = messagesCacheKey(userId, req.params.id, limit);
        if (req.query.fresh !== '1') {
            const hit = messagesCache.get(cacheKey);
            if (hit && Date.now() - hit.ts < MESSAGES_CACHE_TTL_MS) {
                return res.json({ success: true, messages: hit.messages });
            }
        }
        try {
            const r2Messages = await conversationStorageService_1.ConversationStorageService.readRecentMessages(userId, req.params.id, limit);
            if (r2Messages.length > 0) {
                // readRecentMessages returns newest-first; reverse to chronological.
                const messages = r2Messages
                    .slice()
                    .reverse()
                    .map((m) => ({
                    id: m.id,
                    conversation_id: req.params.id,
                    sender_type: m.role === 'user' ? 'user' : 'character',
                    sender_id: m.role === 'user' ? userId : null,
                    content: m.content,
                    message_type: m.messageType || (m.mediaUrl ? 'image' : 'text'),
                    media_url: m.mediaUrl || null,
                    media_id: m.mediaId || null,
                    created_at: m.timestamp,
                    _source: 'r2',
                }));
                messagesCache.set(cacheKey, { ts: Date.now(), messages });
                return res.json({ success: true, messages });
            }
        }
        catch (err) {
            console.warn('[conversations] R2 read failed, falling back to Supabase:', err?.message);
        }
        const { data: messages, error } = await config_1.supabaseAdmin
            .from('messages')
            .select('*')
            .eq('conversation_id', req.params.id)
            .order('created_at', { ascending: true })
            .limit(limit);
        if (error)
            throw new Error(error.message);
        // Hydrate image + voice messages with their media URL from character_chat_media.
        const mediaIds = (messages || [])
            .filter((m) => (m.message_type === 'image' || m.message_type === 'voice') && m.media_id)
            .map((m) => m.media_id);
        const mediaByUrl = {};
        if (mediaIds.length > 0) {
            const { data: mediaRows } = await config_1.supabaseAdmin
                .from('character_chat_media')
                .select('id, media_url')
                .in('id', mediaIds);
            for (const row of mediaRows || [])
                mediaByUrl[row.id] = row.media_url;
        }
        for (const m of messages || []) {
            if (m.message_type === 'image' || m.message_type === 'voice') {
                m.media_url = m.media_url || mediaByUrl[m.media_id] || null;
            }
        }
        messagesCache.set(cacheKey, { ts: Date.now(), messages: messages || [] });
        return res.json({ success: true, messages });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * POST /api/v1/conversations/:id/messages
 * Send message and receive AI companion response.
 *
 * Flow:
 *   1. Save user message to Supabase (transactional record)
 *   2. Retrieve recent conversation from R2 (exact continuity) + Supabase
 *   3. Embed current message and query Qdrant for relevant long-term memories
 *   4. Build Gemini context (system + memory + recent + current)
 *   5. Generate response
 *   6. Save AI message; persist user + AI messages to R2
 *   7. Fire-and-forget background summary/memory update
 */
router.post('/:id/messages', auth_1.requireAuth, rateLimitService_1.messagingRateLimiter, async (req, res) => {
    try {
        const conversationId = req.params.id;
        const { userId, characterId, content, image } = req.body;
        if (!userId || (!content && !image)) {
            return res.status(400).json({ success: false, error: 'userId and content or image required' });
        }
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        // The conversation must exist and belong to this user before any messages
        // are posted (prevents posting/reading into another user's conversation).
        const { data: conv, error: convErr } = await config_1.supabaseAdmin
            .from('conversations')
            .select('user_id, character_id')
            .eq('id', conversationId)
            .maybeSingle();
        if (convErr)
            throw new Error(convErr.message);
        if (!conv || conv.user_id !== userId) {
            return res.status(404).json({ success: false, error: 'Conversation not found' });
        }
        const effectiveCharacterId = characterId || conv.character_id || undefined;
        // 1. Fetch character details
        const { data: character } = await config_1.supabaseAdmin
            .from('characters')
            .select('*')
            .eq('id', effectiveCharacterId)
            .single();
        if (!character)
            return res.status(404).json({ success: false, error: 'Character not found' });
        // 2. Save user message
        const now = new Date();
        const userContent = (content || '').trim();
        const { data: userMsg, error: userMsgErr } = await config_1.supabaseAdmin
            .from('messages')
            .insert({
            conversation_id: conversationId,
            sender_type: 'user',
            sender_id: userId,
            message_type: image ? 'image' : 'text',
            content: userContent || '[Image]',
        })
            .select()
            .single();
        if (userMsgErr)
            throw new Error(userMsgErr.message);
        // 3. Fetch Relationship state & short-term memories
        const relationship = await relationshipService_1.RelationshipService.getRelationship(userId, effectiveCharacterId);
        const memories = await memoryService_1.MemoryService.getRelevantMemories(userId, effectiveCharacterId, userContent || '[Image]', 5);
        // 4. Fetch recent chat history.
        //    Prefer R2 for exact continuity; fall back to Supabase when unused.
        let recentMessages = [];
        try {
            recentMessages = await conversationStorageService_1.ConversationStorageService.readRecentMessages(userId, conversationId, 10);
        }
        catch (err) {
            console.warn('[conversations] R2 history read failed:', err?.message);
        }
        let historyMessages;
        if (recentMessages.length > 0) {
            // R2 messages are stored newest-first from readRecentMessages; reverse to chronological.
            historyMessages = recentMessages
                .slice()
                .reverse()
                .map((m) => ({
                role: (m.role === 'user' ? 'user' : 'model'),
                content: m.content,
            }));
        }
        else {
            const { data: history } = await config_1.supabaseAdmin
                .from('messages')
                .select('sender_type, content')
                .eq('conversation_id', conversationId)
                .order('created_at', { ascending: false })
                .limit(10);
            historyMessages = (history || [])
                .reverse()
                .map((m) => ({
                role: (m.sender_type === 'user' ? 'user' : 'model'),
                content: m.content,
            }));
        }
        // 5. Query semantic long-term memory from Qdrant (scoped to authenticated user).
        //    Failures degrade gracefully — memory is supporting context, not required.
        let semanticMemories = [];
        try {
            const hits = await conversationMemoryService_1.ConversationMemoryService.retrieveRelevantMemories(userId, userContent || '[Image]');
            semanticMemories = hits.map((h) => h.summary);
        }
        catch (err) {
            console.warn('[conversations] semantic memory retrieval failed:', err?.message);
        }
        // 6. Construct prompt & run AI Router inference
        const systemPrompt = aiRouterService_1.AIRouterService.buildSystemPrompt(character, relationship, memories, semanticMemories);
        const aiResult = await aiRouterService_1.AIRouterService.generateChatResponse(systemPrompt, historyMessages, userContent, image || null);
        const finalText = aiResult.responseText;
        // 7. Save AI character response message
        const { data: aiMsg, error: aiMsgErr } = await config_1.supabaseAdmin
            .from('messages')
            .insert({
            conversation_id: conversationId,
            sender_type: 'character',
            sender_id: effectiveCharacterId,
            message_type: 'text',
            content: finalText,
        })
            .select()
            .single();
        if (aiMsgErr)
            throw new Error(aiMsgErr.message);
        // 8. Update conversation timestamp
        await config_1.supabaseAdmin
            .from('conversations')
            .update({ last_message_at: now.toISOString() })
            .eq('id', conversationId);
        // The history just changed — drop any cached copy so the next read is fresh.
        invalidateMessagesCache(userId, conversationId);
        // 9. Persist both messages to R2 (source of truth for raw history).
        const storedMessages = [
            {
                id: userMsg.id,
                role: 'user',
                content: userContent || '[Image]',
                timestamp: now.toISOString(),
            },
            {
                id: aiMsg.id,
                role: 'assistant',
                content: finalText,
                timestamp: new Date().toISOString(),
            },
        ];
        conversationStorageService_1.ConversationStorageService.appendMessages(userId, conversationId, effectiveCharacterId, storedMessages)
            .then((meta) => {
            // 10. Background: periodic memory summary -> embed -> Qdrant upsert.
            return conversationMemoryService_1.ConversationMemoryService.maybeSummarizeConversation(userId, conversationId, effectiveCharacterId, meta);
        })
            .catch((err) => {
            console.warn('[conversations] R2 append / memory update failed:', err?.message);
        });
        // 11. Background updates: relationship metrics & short-term memory extraction
        relationshipService_1.RelationshipService.updateRelationship(userId, effectiveCharacterId, {
            affection: aiResult.affectionDelta || 0.3,
            familiarity: 0.2,
            mood: aiResult.moodDelta || 'happy',
        }, relationship).catch(() => { });
        memoryService_1.MemoryService.extractMemoriesFromConversation(userId, effectiveCharacterId, userContent || '[Image]', finalText).catch(() => { });
        return res.status(201).json({
            success: true,
            userMessage: userMsg,
            aiMessage: aiMsg,
            relationshipState: relationship,
        });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * DELETE /api/v1/conversations/:id
 * Reset a conversation: wipe all messages (Supabase + R2 raw history). The
 * conversation row itself is kept and its timestamp cleared, so the user can
 * start fresh with the same character.
 */
router.delete('/:id', auth_1.requireAuth, async (req, res) => {
    try {
        const conversationId = req.params.id;
        const userId = (req.body && req.body.userId) || String(req.query.userId || '');
        if (!userId)
            return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        // 1. The conversation must exist and belong to this user.
        const { data: conv, error: convErr } = await config_1.supabaseAdmin
            .from('conversations')
            .select('id, user_id')
            .eq('id', conversationId)
            .maybeSingle();
        if (convErr)
            throw new Error(convErr.message);
        if (!conv || conv.user_id !== userId) {
            return res.status(404).json({ success: false, error: 'Conversation not found' });
        }
        // 2. Delete the messages from Supabase.
        const { error: msgErr } = await config_1.supabaseAdmin
            .from('messages')
            .delete()
            .eq('conversation_id', conversationId);
        if (msgErr)
            throw new Error(msgErr.message);
        // 3. Clear the raw chat history on R2 (best-effort; the next read falls
        //    back to the now-empty Supabase table).
        try {
            await conversationStorageService_1.ConversationStorageService.deleteConversationMessages(userId, conversationId);
        }
        catch (err) {
            console.warn('[conversations] R2 reset failed:', err?.message);
        }
        // 4. Reset the conversation timestamp so it sorts as fresh.
        await config_1.supabaseAdmin
            .from('conversations')
            .update({ last_message_at: null, updated_at: new Date().toISOString() })
            .eq('id', conversationId);
        invalidateMessagesCache(userId, conversationId);
        return res.json({ success: true, message: 'Conversation reset' });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
exports.default = router;
