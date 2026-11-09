"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const config_1 = require("../config");
const auth_1 = require("../middleware/auth");
const rateLimitService_1 = require("../services/rateLimitService");
const aiRouterService_1 = require("../services/aiRouterService");
const intentService_1 = require("../services/intentService");
const deapiImageService_1 = require("../services/deapiImageService");
const speechService_1 = require("../services/speechService");
const relationshipService_1 = require("../services/relationshipService");
const qdrantService_1 = require("../services/qdrantService");
const r2Service_1 = require("../services/r2Service");
const router = (0, express_1.Router)();
const DEFAULT_VOICE_ID = '8fdcb77230554e1ab160e2361bff4296';
// Character rows are stable catalog data; avoid re-reading them on every turn.
const CHARACTER_CACHE_TTL_MS = 5 * 60 * 1000;
const characterCache = new Map();
async function loadCharacter(characterId) {
    if (!characterId) return null;
    const cached = characterCache.get(characterId);
    if (cached && Date.now() - cached.ts < CHARACTER_CACHE_TTL_MS) return cached.value;
    const { data, error } = await config_1.supabaseAdmin.from('characters').select('*').eq('id', characterId).maybeSingle();
    if (error || !data) return null;
    characterCache.set(characterId, { ts: Date.now(), value: data });
    return data;
}
const REF_IMAGE_CACHE_TTL_MS = 30 * 60 * 1000;
const REF_IMAGE_CACHE_MAX = 300;
const referenceImageCache = new Map();
async function downloadBytes(url, timeoutMs) {
    const cached = referenceImageCache.get(url);
    if (cached && Date.now() - cached.ts < REF_IMAGE_CACHE_TTL_MS) {
        return { buffer: cached.buffer, mimeType: cached.mimeType };
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs || 30000) });
    if (!res.ok) throw new Error('Failed to download reference media');
    const buffer = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get('content-type') || 'image/jpeg';
    if (referenceImageCache.size >= REF_IMAGE_CACHE_MAX) referenceImageCache.clear();
    referenceImageCache.set(url, { ts: Date.now(), buffer, mimeType });
    return { buffer, mimeType };
}
async function characterReferenceImage(character) {
    try {
        const { data: feeds } = await config_1.supabaseAdmin
            .from('character_feeds')
            .select('media_url, media_type')
            .eq('character_id', character.id)
            .order('sort_order', { ascending: true });
        const imageFeed = (feeds || []).find((f) => f.media_type === 'image' && f.media_url);
        if (imageFeed) return { url: imageFeed.media_url, kind: 'url' };
    }
    catch { }
    const url = character.feed_media_url ||
        character.background_image_url ||
        character.portrait_image_url ||
        character.circular_profile_image_url ||
        null;
    return url ? { url, kind: 'url' } : null;
}
function parseDataUrl(value) {
    const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(value || ''));
    if (!m) return null;
    return { mimeType: m[1], buffer: Buffer.from(m[2], 'base64') };
}
function relationshipDefaults() {
    return {
        relationship_stage: 'acquaintance',
        relationship_level: 1,
        current_mood: 'happy',
        affection: 10,
        trust: 10,
    };
}
/**
 * POST /api/v1/ai/respond
 * Stateless: classifies the latest message and generates the text/acknowledgement.
 * Persists nothing.
 */
router.post('/respond', auth_1.requireAuth, rateLimitService_1.messagingRateLimiter, async (req, res) => {
    try {
        const body = req.body || {};
        const { userId, characterId, history, userMessage, images, forceIntent } = body;
        if (!userId) return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId)) return;

        const character = await loadCharacter(characterId);
        if (!character) return res.status(404).json({ success: false, error: 'Character not found' });

        let relationship = relationshipDefaults();
        try { relationship = await relationshipService_1.RelationshipService.getRelationship(userId, characterId); } catch (e) { /* defaults */ }

        const userText = String((userMessage && userMessage.text) || '').trim();
        if (!userText && !(userMessage && userMessage.image)) {
            return res.status(400).json({ success: false, error: 'userMessage required' });
        }

        let intentResult;
        if (forceIntent && ['IMAGE', 'VIDEO', 'VOICE', 'TEXT'].includes(String(forceIntent).toUpperCase())) {
            const forced = String(forceIntent).toUpperCase();
            intentResult = {
                intent: forced,
                confidence: 1,
                intents: forced === 'TEXT' ? [] : [{ type: forced, prompt: userText, usesPreviousMedia: false }],
                call: null,
                clarification: null,
                reason: 'forced_by_quick_action',
            };
        } else {
            intentResult = await intentService_1.IntentService.classify({
                character,
                history: history || [],
                userText: userText,
                hasImageAttachment: !!(userMessage && userMessage.image),
                hasPreviousMedia: !!body.hasPreviousMedia,
            });
        }

        const systemPrompt = aiRouterService_1.AIRouterService.buildSystemPrompt(
            character,
            relationship,
            (body.memories || []).map((content) => ({ memory_type: 'memory', content: String(content) })),
            (body.semanticMemories || []).map((content) => String(content)),
        );
        const historyMessages = (history || []).slice(-12).map((m) => ({
            role: m.role === 'user' ? 'user' : 'model',
            content: String(m.content || '').slice(0, 2000),
        }));

        let reply = null;
        let acknowledgement = null;
        const mediaIntent = intentResult.intent === 'IMAGE' || intentResult.intent === 'VIDEO' || intentResult.intent === 'VOICE';
        const needsText = intentResult.intent === 'TEXT' || intentResult.intent === 'MIXED' ||
            intentResult.intent === 'VOICE_CALL' || intentResult.intent === 'CLARIFICATION';

        if (needsText) {
            const result = await aiRouterService_1.AIRouterService.generateChatResponse(
                systemPrompt,
                historyMessages,
                userText || '[Image]',
                userMessage && userMessage.image ? userMessage.image : null,
            );
            reply = result && result.responseText;
        }

        if (mediaIntent) {
            // Short in-character acknowledgement before the media arrives. Ask for
            // something the character would actually say, not a status message.
            const ackSystem = systemPrompt + `\n\nSPECIAL INSTRUCTION: The user just asked you for ${intentResult.intent === 'IMAGE' ? 'a photo' : intentResult.intent === 'VIDEO' ? 'a video' : 'a voice message'}. Reply with ONE short in-character line (max 18 words) that acknowledges it naturally (e.g. teasing, shy, excited), as if you are about to take/record it. Do not say it is already sent. Do not describe the process.`; 
            try {
                const ack = await aiRouterService_1.AIRouterService.generateChatResponse(
                    ackSystem,
                    historyMessages,
                    userText,
                    userMessage && userMessage.image ? userMessage.image : null,
                );
                acknowledgement = (ack && ack.responseText) || null;
            } catch (e) {
                acknowledgement = null;
            }
        }

        if (intentResult.intent === 'VOICE_CALL' && !intentResult.call) {
            intentResult.call = { trigger: 'explicit', reason: 'user requested a call' };
        }

        // Telemetry-free response. No persistence of user content.
        return res.json({
            success: true,
            intent: intentResult.intent,
            confidence: intentResult.confidence,
            intents: intentResult.intents,
            call: intentResult.call || null,
            reply: reply,
            acknowledgement: acknowledgement,
            clarification: intentResult.clarification || null,
            reason: intentResult.reason || null,
            character: {
                id: character.id,
                name: character.name,
                voice_id: character.voice_id || null,
            },
        });
    }
    catch (err) {
        console.error('[ai/respond]', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * POST /api/v1/ai/generate-image
 * Stateless image generation. Returns base64 only; the browser stores it.
 */
router.post('/generate-image', auth_1.requireAuth, rateLimitService_1.messagingRateLimiter, async (req, res) => {
    try {
        const { userId, characterId, prompt, referenceImage, usesPreviousMedia } = req.body || {};
        if (!userId) return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId)) return;
        if (!prompt || !String(prompt).trim()) return res.status(400).json({ success: false, error: 'prompt required' });

        const character = await loadCharacter(characterId);
        if (!character) return res.status(404).json({ success: false, error: 'Character not found' });

        let imageBuffer;
        let mimeType = 'image/jpeg';
        const provided = referenceImage ? parseDataUrl(referenceImage) : null;
        if (provided && usesPreviousMedia) {
            imageBuffer = provided.buffer;
            mimeType = provided.mimeType;
        } else {
            const reference = await characterReferenceImage(character);
            if (!reference) return res.status(404).json({ success: false, error: 'No character image available to edit' });
            try {
                const downloaded = await downloadBytes(reference.url, 30000);
                imageBuffer = downloaded.buffer;
                mimeType = downloaded.mimeType;
            } catch (err) {
                return res.status(502).json({ success: false, error: 'Failed to download character image' });
            }
        }

        const result = await deapiImageService_1.DeApiImageService.generatePortrait(imageBuffer, String(prompt), mimeType);
        if (!result.success || !result.imageBase64) {
            return res.status(502).json({ success: false, error: result.error || 'Image generation failed' });
        }

        let finalBase64 = result.imageBase64;
        let finalMimeType = result.mimeType || 'image/png';
        if (String(finalBase64).startsWith('http')) {
            const imgRes = await fetch(finalBase64, { signal: AbortSignal.timeout(30000) });
            if (!imgRes.ok) return res.status(502).json({ success: false, error: 'Failed to download generated image' });
            finalBase64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64');
            finalMimeType = imgRes.headers.get('content-type') || 'image/png';
        }

        return res.json({
            success: true,
            dataUrl: `data:${finalMimeType};base64,${finalBase64}`,
            mimeType: finalMimeType,
        });
    }
    catch (err) {
        console.error('[ai/generate-image]', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * POST /api/v1/ai/generate-video
 * Stateless short video generation. Returns base64 only.
 */
router.post('/generate-video', auth_1.requireAuth, rateLimitService_1.messagingRateLimiter, async (req, res) => {
    try {
        const { userId, characterId, prompt, referenceImage, usesPreviousMedia } = req.body || {};
        if (!userId) return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId)) return;
        if (!prompt || !String(prompt).trim()) return res.status(400).json({ success: false, error: 'prompt required' });

        const character = await loadCharacter(characterId);
        if (!character) return res.status(404).json({ success: false, error: 'Character not found' });

        let imageBuffer;
        let mimeType = 'image/jpeg';
        const provided = referenceImage ? parseDataUrl(referenceImage) : null;
        if (provided && usesPreviousMedia) {
            imageBuffer = provided.buffer;
            mimeType = provided.mimeType;
        } else {
            const reference = await characterReferenceImage(character);
            if (!reference) return res.status(404).json({ success: false, error: 'No character image available to animate' });
            try {
                const downloaded = await downloadBytes(reference.url, 30000);
                imageBuffer = downloaded.buffer;
                mimeType = downloaded.mimeType;
            } catch (err) {
                return res.status(502).json({ success: false, error: 'Failed to download character image' });
            }
        }

        const result = await deapiImageService_1.DeApiImageService.generateVideo(imageBuffer, String(prompt).trim(), mimeType);
        if (!result.success || !result.source) {
            return res.status(502).json({ success: false, error: result.error || 'Video generation failed' });
        }

        let base64;
        let videoMimeType = 'video/mp4';
        const source = result.source;
        if (source.startsWith('data:')) {
            const dm = /^data:([^;,]+);base64,(.*)$/s.exec(source);
            if (!dm) return res.status(502).json({ success: false, error: 'Unreadable video result' });
            videoMimeType = dm[1];
            base64 = dm[2];
        } else {
            const videoRes = await fetch(source, { signal: AbortSignal.timeout(120000) });
            if (!videoRes.ok) return res.status(502).json({ success: false, error: 'Failed to download generated video' });
            base64 = Buffer.from(await videoRes.arrayBuffer()).toString('base64');
            videoMimeType = videoRes.headers.get('content-type') || videoMimeType;
        }

        return res.json({
            success: true,
            dataUrl: `data:${videoMimeType};base64,${base64}`,
            mimeType: videoMimeType,
        });
    }
    catch (err) {
        console.error('[ai/generate-video]', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * POST /api/v1/ai/generate-voice
 * Stateless voice-note generation. Returns base64 audio + transcript.
 */
router.post('/generate-voice', auth_1.requireAuth, rateLimitService_1.messagingRateLimiter, async (req, res) => {
    try {
        const { userId, characterId, prompt, history } = req.body || {};
        if (!userId) return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId)) return;
        if (!prompt || !String(prompt).trim()) return res.status(400).json({ success: false, error: 'prompt required' });
        if (!speechService_1.SpeechService.isConfigured()) return res.status(502).json({ success: false, error: 'Speech synthesis is not configured' });

        const character = await loadCharacter(characterId);
        if (!character) return res.status(404).json({ success: false, error: 'Character not found' });

        const historyMessages = (history || []).slice(-8).map((m) => ({
            role: m.role === 'user' ? 'user' : 'model',
            content: String(m.content || '').slice(0, 1200),
        }));
        const script = await aiRouterService_1.AIRouterService.generateVoiceScript(character, historyMessages, String(prompt).trim());
        const speech = await speechService_1.SpeechService.generateSpeech({
            text: script,
            voice: character.voice_id && /^[a-f0-9]{32}$/i.test(character.voice_id) ? character.voice_id : DEFAULT_VOICE_ID,
            speed: 1.0,
        });

        return res.json({
            success: true,
            audioBase64: speech.audioBase64,
            mimeType: speech.mimeType || 'audio/mpeg',
            transcript: script,
            voiceId: DEFAULT_VOICE_ID,
        });
    }
    catch (err) {
        console.error('[ai/generate-voice]', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * GET /api/v1/ai/migrate/export
 * One-time legacy export of this user's cloud chat + media references.
 */
router.get('/migrate/export', auth_1.requireAuth, async (req, res) => {
    try {
        const userId = String(req.query.userId || '');
        if (!userId) return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId)) return;

        const { data: conversations, error: convErr } = await config_1.supabaseAdmin
            .from('conversations')
            .select('id,user_id,character_id,title,status,last_message_at,created_at,updated_at')
            .eq('user_id', userId);
        if (convErr) throw new Error(convErr.message);

        const convIds = (conversations || []).map((c) => c.id);
        const messages = [];
        if (convIds.length) {
            const { data, error } = await config_1.supabaseAdmin
                .from('messages')
                .select('id,conversation_id,sender_type,sender_id,message_type,content,media_id,created_at')
                .in('conversation_id', convIds)
                .order('created_at', { ascending: true });
            if (error) throw new Error(error.message);
            (data || []).forEach((m) => messages.push(m));
        }

        const { data: chatMedia, error: mediaErr } = await config_1.supabaseAdmin
            .from('character_chat_media')
            .select('id,character_id,user_id,media_url,media_type,created_at')
            .eq('user_id', userId);
        if (mediaErr) throw new Error(mediaErr.message);

        // Long-term memories move to the device too; their embeddings are
        // rebuilt locally by the browser (keyword matching works immediately).
        let memories = [];
        try {
            const { data: memRows } = await config_1.supabaseAdmin
                .from('memories')
                .select('id,user_id,character_id,memory_type,content,importance,created_at,status')
                .eq('user_id', userId);
            memories = memRows || [];
        } catch (e) { /* memories table may be empty/absent */ }

        const mediaById = {};
        (chatMedia || []).forEach((m) => { mediaById[m.id] = m; });
        const referenced = {};
        messages.forEach((m) => {
            if (m.media_id) {
                referenced[m.media_id] = true;
                const media = mediaById[m.media_id];
                m.media_url = media ? media.media_url : null;
            }
        });

        // Orphaned media (present in Photos but missing a linked message) is
        // repaired on import as a synthetic character media message.
        const orphans = (chatMedia || [])
            .filter((m) => !referenced[m.id])
            .map((m) => Object.assign({}, m, { orphan: true }));

        return res.json({
            success: true,
            exportedAt: new Date().toISOString(),
            conversations: conversations || [],
            messages,
            chatMedia: chatMedia || [],
            orphanMedia: orphans,
            memories,
        });
    }
    catch (err) {
        console.error('[ai/migrate/export]', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * GET /api/v1/ai/migrate/fetch-media?url=...
 * Proxy for legacy media so the browser can store it locally even when CORS
 * blocks a direct fetch. Only allows the project's R2 public domain.
 */
router.get('/migrate/fetch-media', auth_1.requireAuth, async (req, res) => {
    try {
        const url = String(req.query.url || '');
        const domain = config_1.CONFIG.R2.PUBLIC_DOMAIN || '';
        let allowed = false;
        try {
            if (url && domain) {
                const target = new URL(url);
                const allowedOrigin = new URL(domain).origin;
                // Compare full origins so "https://bucket.r2.dev.evil.tld" is rejected.
                allowed = target.origin === allowedOrigin;
            }
        } catch (e) { allowed = false; }
        if (!allowed) {
            return res.status(400).json({ success: false, error: 'Unsupported media URL' });
        }
        const upstream = await fetch(url, { signal: AbortSignal.timeout(60000) });
        if (!upstream.ok) return res.status(502).json({ success: false, error: 'Media download failed' });
        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
        const buf = Buffer.from(await upstream.arrayBuffer());
        return res.send(buf);
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * POST /api/v1/ai/migrate/purge
 * Deletes this user's cloud chat + generated chat media + memory vectors.
 * Relationship state and call history are intentionally kept.
 */
router.post('/migrate/purge', auth_1.requireAuth, async (req, res) => {
    try {
        const userId = String((req.body && req.body.userId) || '');
        if (!userId) return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId)) return;

        const errors = [];
        const { data: conversations } = await config_1.supabaseAdmin
            .from('conversations')
            .select('id')
            .eq('user_id', userId);
        const convIds = (conversations || []).map((c) => c.id);

        if (convIds.length) {
            const { error: msgErr } = await config_1.supabaseAdmin
                .from('messages')
                .delete()
                .in('conversation_id', convIds);
            if (msgErr) errors.push('messages: ' + msgErr.message);
        }

        const { data: chatMedia } = await config_1.supabaseAdmin
            .from('character_chat_media')
            .select('id,media_url')
            .eq('user_id', userId);

        for (const media of chatMedia || []) {
            try { await r2Service_1.R2Service.deleteByPublicUrl(media.media_url); } catch (e) { errors.push('r2: ' + (e.message || e)); }
        }
        if ((chatMedia || []).length) {
            const { error: mediaErr } = await config_1.supabaseAdmin
                .from('character_chat_media')
                .delete()
                .eq('user_id', userId);
            if (mediaErr) errors.push('chat_media: ' + mediaErr.message);
        }

        if (convIds.length) {
            // Call history stays in Supabase. Null out any legacy FK first so
            // deleting cloud conversations cannot fail (or cascade) on it.
            try {
                const { error: unlinkErr } = await config_1.supabaseAdmin
                    .from('calls')
                    .update({ conversation_id: null })
                    .in('conversation_id', convIds);
                if (unlinkErr) errors.push('calls unlink: ' + unlinkErr.message);
            } catch (e) { /* table/column shape may differ; deletion below decides */ }
            const { error: convErr } = await config_1.supabaseAdmin
                .from('conversations')
                .delete()
                .eq('user_id', userId);
            if (convErr) errors.push('conversations: ' + convErr.message);
        }

        try {
            const { error: memErr } = await config_1.supabaseAdmin.from('memories').delete().eq('user_id', userId);
            if (memErr) errors.push('memories: ' + memErr.message);
        } catch (e) { errors.push('memories: ' + (e.message || e)); }

        for (const convId of convIds) {
            try { await qdrantService_1.QdrantService.deleteConversationMemories(userId, convId); } catch (e) { /* best effort */ }
        }

        return res.json({ success: errors.length === 0, errors, purged: {
            conversations: convIds.length,
            chatMedia: (chatMedia || []).length,
        } });
    }
    catch (err) {
        console.error('[ai/migrate/purge]', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});
exports.default = router;
