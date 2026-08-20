"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const config_1 = require("../config");
const deapiImageService_1 = require("../services/deapiImageService");
const r2Service_1 = require("../services/r2Service");
const conversationStorageService_1 = require("../services/conversationStorageService");
const aiRouterService_1 = require("../services/aiRouterService");
const speechService_1 = require("../services/speechService");
const rateLimitService_1 = require("../services/rateLimitService");
const auth_1 = require("../middleware/auth");
// Shared Fish TTS voice for all characters right now; per-character voice IDs
// will replace it later (characters.voice_id already stores an optional ID).
const DEFAULT_VOICE_ID = '8fdcb77230554e1ab160e2361bff4296';
const router = (0, express_1.Router)();
// The public character catalog is global and rarely changes; cache it so the
// Discover/feed endpoints don't re-SELECT every character + feed media per hit.
const CHARACTERS_CACHE_TTL_MS = 5 * 60 * 1000;
let charactersCache = null;
// Reference images (character feed photos) are re-downloaded on every image/
// video generation request. Cache the decoded bytes per URL for 30 minutes:
// the photos are effectively immutable, so this is pure bandwidth savings.
const REF_IMAGE_CACHE_TTL_MS = 30 * 60 * 1000;
const REF_IMAGE_CACHE_MAX = 500;
const referenceImageCache = new Map();
async function getReferenceImageBytes(referenceUrl) {
    const cached = referenceImageCache.get(referenceUrl);
    if (cached && Date.now() - cached.ts < REF_IMAGE_CACHE_TTL_MS) {
        return cached.buffer;
    }
    const imageRes = await fetch(referenceUrl, { signal: AbortSignal.timeout(30000) });
    if (!imageRes.ok) {
        throw new Error('Failed to download character image');
    }
    const buffer = Buffer.from(await imageRes.arrayBuffer());
    if (referenceImageCache.size >= REF_IMAGE_CACHE_MAX) {
        referenceImageCache.delete(referenceImageCache.keys().next().value);
    }
    referenceImageCache.set(referenceUrl, { ts: Date.now(), buffer });
    return buffer;
}
/**
 * GET /api/v1/characters
 * List public discoverable characters
 */
router.get('/', async (req, res) => {
    try {
        if (req.query.fresh !== '1' && charactersCache && Date.now() - charactersCache.ts < CHARACTERS_CACHE_TTL_MS) {
            return res.json({ success: true, characters: charactersCache.characters });
        }
        const { data: characters, error } = await config_1.supabaseAdmin
            .from('characters')
            .select('*,character_feeds(media_url,media_type)')
            .eq('is_active', true)
            .order('created_at', { ascending: false });
        if (error)
            throw new Error(error.message);
        charactersCache = { ts: Date.now(), characters };
        return res.json({ success: true, characters });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * GET /api/v1/characters/saved?userId=...
 * List the characters a user has liked/saved, newest first, with their
 * feed media so the Discover page can render full cards.
 */
router.get('/saved', auth_1.requireAuth, async (req, res) => {
    try {
        const userId = String(req.query.userId || '');
        if (!userId)
            return res.status(400).json({ success: false, error: 'userId query param required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const { data, error } = await config_1.supabaseAdmin
            .from('saved_characters')
            .select('character_id, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
        if (error)
            throw new Error(error.message);
        if (!data || !data.length)
            return res.json({ success: true, characters: [] });
        const ids = data.map((row) => row.character_id);
        const { data: chars, error: charsErr } = await config_1.supabaseAdmin
            .from('characters')
            .select('id,name,age,about,gender,art_style,circular_profile_image_url,character_feeds(media_url,media_type)')
            .in('id', ids);
        if (charsErr)
            throw new Error(charsErr.message);
        // Keep the save order (newest liked first).
        const byId = {};
        (chars || []).forEach((c) => { byId[c.id] = c; });
        const characters = ids.map((id) => byId[id]).filter(Boolean);
        return res.json({ success: true, characters });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * GET /api/v1/characters/:id
 * Fetch character details
 */
router.get('/:id', async (req, res) => {
    try {
        const { data: character, error } = await config_1.supabaseAdmin
            .from('characters')
            .select('*')
            .eq('id', req.params.id)
            .single();
        if (error || !character) {
            return res.status(404).json({ success: false, error: 'Character not found' });
        }
        return res.json({ success: true, character });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * POST /api/v1/characters
 * Create custom character
 */
router.post('/', auth_1.requireAuth, async (req, res) => {
    try {
        const { name, gender, age, about, messageStyle, personality, artStyle, voiceId, profileImageUrl } = req.body;
        if (!name) {
            return res.status(400).json({ success: false, error: 'name is required' });
        }
        const { data: character, error } = await config_1.supabaseAdmin
            .from('characters')
            .insert({
            name,
            gender: gender || 'women',
            age: age || null,
            about: about || null,
            message_style: messageStyle || 'normal',
            personality: personality || 'the_sweetheart',
            art_style: artStyle || 'realistic',
            voice_id: voiceId || null,
            circular_profile_image_url: profileImageUrl || null,
            is_active: true,
        })
            .select()
            .single();
        if (error)
            throw new Error(error.message);
        charactersCache = null;
        return res.status(201).json({ success: true, character });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * POST /api/v1/characters/:id/save
 * Save character to user's saved list
 */
router.post('/:id/save', auth_1.requireAuth, async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId)
            return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const { data, error } = await config_1.supabaseAdmin
            .from('saved_characters')
            .upsert({ user_id: userId, character_id: req.params.id })
            .select();
        if (error)
            throw new Error(error.message);
        return res.json({ success: true, saved: data });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * DELETE /api/v1/characters/:id/save
 * Remove a character from the user's saved (liked) list.
 */
router.delete('/:id/save', auth_1.requireAuth, async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId)
            return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const { error } = await config_1.supabaseAdmin
            .from('saved_characters')
            .delete()
            .eq('user_id', userId)
            .eq('character_id', req.params.id);
        if (error)
            throw new Error(error.message);
        return res.json({ success: true });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * POST /api/v1/characters/:id/generate-image
 * Generate a portrait image of the character (from their feed/background photo)
 * edited according to the user's natural-language request.
 *
 * Flow:
 *   1. Load the character + pick their feed image (NOT the circular avatar)
 *   2. Download the feed image bytes
 *   3. Call DeAPI img2img to regenerate the portrait (same face/body, new
 *      pose/outfit/environment)
 *   4. Return the generated image as a base64 data URL
 */
router.post('/:id/generate-image', auth_1.requireAuth, rateLimitService_1.messagingRateLimiter, async (req, res) => {
    try {
        const characterId = req.params.id;
        const { prompt, userId, conversationId } = req.body;
        if (!prompt || !prompt.trim()) {
            return res.status(400).json({ success: false, error: 'prompt required' });
        }
        if (!userId)
            return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const { data: character, error } = await config_1.supabaseAdmin
            .from('characters')
            .select('*')
            .eq('id', characterId)
            .single();
        if (error || !character) {
            return res.status(404).json({ success: false, error: 'Character not found' });
        }
        // Pick the reference image: the character's feed / background photo.
        // Prefer an image feed; skip videos. Fall back to the portrait/media fields.
        let referenceUrl = null;
        let mimeType = 'image/jpeg';
        try {
            const { data: feeds } = await config_1.supabaseAdmin
                .from('character_feeds')
                .select('media_url, media_type')
                .eq('character_id', characterId)
                .order('sort_order', { ascending: true });
            const imageFeed = (feeds || []).find((f) => f.media_type === 'image' && f.media_url);
            referenceUrl = imageFeed ? imageFeed.media_url : null;
        }
        catch { }
        if (!referenceUrl) {
            referenceUrl =
                character.feed_media_url ||
                    character.background_image_url ||
                    character.portrait_image_url ||
                    character.circular_profile_image_url ||
                    null;
        }
        if (!referenceUrl) {
            return res.status(404).json({ success: false, error: 'No character image available to edit' });
        }
        const m = /\.(jpe?g|png|webp)(\?|$)/i.exec(referenceUrl);
        if (m) {
            const ext = m[1].toLowerCase();
            if (ext === 'png')
                mimeType = 'image/png';
            else if (ext === 'webp')
                mimeType = 'image/webp';
            else
                mimeType = 'image/jpeg';
        }
        let imageBuffer;
        try {
            imageBuffer = await getReferenceImageBytes(referenceUrl);
        }
        catch {
            return res.status(502).json({ success: false, error: 'Failed to download character image' });
        }
        const result = await deapiImageService_1.DeApiImageService.generatePortrait(imageBuffer, prompt, mimeType);
        if (!result.success || !result.imageBase64) {
            return res.status(502).json({ success: false, error: result.error || 'Image generation failed' });
        }
        // If DeAPI returned an http URL, fetch it into a data URL so the client can
        // render it without an extra round trip.
        let finalBase64 = result.imageBase64;
        let finalMimeType = result.mimeType || 'image/png';
        if (result.imageBase64.startsWith('http')) {
            const imgRes = await fetch(result.imageBase64, { signal: AbortSignal.timeout(30000) });
            if (imgRes.ok) {
                const buf = Buffer.from(await imgRes.arrayBuffer());
                const ct = imgRes.headers.get('content-type') || 'image/png';
                finalBase64 = buf.toString('base64');
                finalMimeType = ct;
            }
        }
        const imageDataUrl = `data:${finalMimeType};base64,${finalBase64}`;
        // Persist the request + generated image when the caller supplied a
        // conversation. Upload the image to R2, record it in character_chat_media,
        // save the user request as a user message, and save the generated image as
        // a character image message so reloads restore the full exchange.
        let mediaUrl = null;
        if (userId && conversationId) {
            try {
                const upload = await r2Service_1.R2Service.uploadBase64Image({
                    characterId,
                    base64: finalBase64,
                    mimeType: finalMimeType,
                });
                mediaUrl = upload.url;
                const now = new Date();
                const { data: media, error: mediaErr } = await config_1.supabaseAdmin
                    .from('character_chat_media')
                    .insert({
                    character_id: characterId,
                    user_id: userId,
                    media_url: mediaUrl,
                    media_type: 'image',
                })
                    .select()
                    .single();
                if (mediaErr)
                    throw new Error(mediaErr.message);
                const { data: userMsg, error: userMsgErr } = await config_1.supabaseAdmin
                    .from('messages')
                    .insert({
                    conversation_id: conversationId,
                    sender_type: 'user',
                    sender_id: userId,
                    message_type: 'text',
                    content: prompt.trim(),
                })
                    .select()
                    .single();
                if (userMsgErr)
                    throw new Error(userMsgErr.message);
                const { data: aiMsg, error: aiMsgErr } = await config_1.supabaseAdmin
                    .from('messages')
                    .insert({
                    conversation_id: conversationId,
                    sender_type: 'character',
                    sender_id: characterId,
                    message_type: 'image',
                    content: '[Photo]',
                    media_id: media.id,
                })
                    .select()
                    .single();
                if (aiMsgErr)
                    throw new Error(aiMsgErr.message);
                await config_1.supabaseAdmin
                    .from('conversations')
                    .update({ last_message_at: now.toISOString() })
                    .eq('id', conversationId);
                const storedMessages = [
                    {
                        id: userMsg.id,
                        role: 'user',
                        content: prompt.trim(),
                        timestamp: now.toISOString(),
                    },
                    {
                        id: aiMsg.id,
                        role: 'assistant',
                        content: '[Photo]',
                        timestamp: now.toISOString(),
                        messageType: 'image',
                        mediaUrl,
                        mediaId: media.id,
                    },
                ];
                conversationStorageService_1.ConversationStorageService.appendMessages(userId, conversationId, characterId, storedMessages).catch((err) => {
                    console.warn('[characters] R2 append failed:', err?.message);
                });
            }
            catch (err) {
                console.warn('[characters] image persistence failed (image still returned):', err?.message);
            }
        }
        return res.json({
            success: true,
            imageDataUrl,
            imageUrl: mediaUrl,
            mimeType: finalMimeType,
        });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * POST /api/v1/characters/:id/generate-voice
 * Generate an in-character voice note.
 *
 * Flow:
 *   1. Read recent chat history (R2 preferred, Supabase fallback)
 *   2. Generate an emotion-tagged voice script with the character's
 *      personality steering the tone (Fish Audio bracket tags)
 *   3. Synthesize the audio via OpenRouter (Fish Audio s2.1)
 *   4. Upload the MP3 to R2, record it in character_chat_media, persist the
 *      user request + the character audio message, and append to R2 history
 *   5. Return the public audio URL + the transcript
 */
router.post('/:id/generate-voice', auth_1.requireAuth, rateLimitService_1.messagingRateLimiter, async (req, res) => {
    try {
        const characterId = req.params.id;
        const { prompt, userId, conversationId } = req.body;
        if (!prompt || !prompt.trim()) {
            return res.status(400).json({ success: false, error: 'prompt required' });
        }
        if (!userId)
            return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const { data: character, error } = await config_1.supabaseAdmin
            .from('characters')
            .select('*')
            .eq('id', characterId)
            .single();
        if (error || !character) {
            return res.status(404).json({ success: false, error: 'Character not found' });
        }
        if (!speechService_1.SpeechService.isConfigured()) {
            return res.status(502).json({ success: false, error: 'OPENROUTER_API_KEY not configured' });
        }
        // Recent chat history for conversational context (voice notes should feel
        // like a continuation of the conversation, not a cold greeting).
        let historyMessages = [];
        if (userId && conversationId) {
            try {
                const recent = await conversationStorageService_1.ConversationStorageService.readRecentMessages(userId, conversationId, 8);
                historyMessages = recent
                    .slice()
                    .reverse()
                    .map((m) => ({
                    role: (m.role === 'user' ? 'user' : 'model'),
                    content: m.content,
                }));
            }
            catch (err) {
                console.warn('[characters] voice history read failed:', err?.message);
            }
            if (historyMessages.length === 0) {
                const { data: history } = await config_1.supabaseAdmin
                    .from('messages')
                    .select('sender_type, content')
                    .eq('conversation_id', conversationId)
                    .order('created_at', { ascending: false })
                    .limit(8);
                historyMessages = (history || [])
                    .reverse()
                    .map((m) => ({
                    role: (m.sender_type === 'user' ? 'user' : 'model'),
                    content: m.content,
                }));
            }
        }
        // 1. Generate the in-character voice script.
        const script = await aiRouterService_1.AIRouterService.generateVoiceScript(character, historyMessages, prompt.trim());
        // 2. Synthesize speech with the shared Fish voice (per-character voice IDs
        //    will be wired up later once each character has a real Fish UUID —
        //    characters.voice_id currently holds arbitrary labels, not Fish IDs).
        const speech = await speechService_1.SpeechService.generateSpeech({
            text: script,
            voice: DEFAULT_VOICE_ID,
            speed: 1.0,
        });
        // 3. Persist when a conversation is available (mirrors generate-image).
        let audioUrl = null;
        if (userId && conversationId) {
            try {
                const upload = await r2Service_1.R2Service.uploadBase64Voice({
                    characterId,
                    base64: speech.audioBase64,
                    mimeType: speech.mimeType,
                });
                audioUrl = upload.url;
                const now = new Date();
                const { data: media, error: mediaErr } = await config_1.supabaseAdmin
                    .from('character_chat_media')
                    .insert({
                    character_id: characterId,
                    user_id: userId,
                    media_url: audioUrl,
                    // The DB's public.media_type enum only allows 'image'/'video', so
                    // the chat-media row reuses 'image' to carry the audio URL. The
                    // semantic type lives on the messages row (message_type 'voice').
                    media_type: 'image',
                })
                    .select()
                    .single();
                if (mediaErr)
                    throw new Error(mediaErr.message);
                const { data: userMsg, error: userMsgErr } = await config_1.supabaseAdmin
                    .from('messages')
                    .insert({
                    conversation_id: conversationId,
                    sender_type: 'user',
                    sender_id: userId,
                    message_type: 'text',
                    content: prompt.trim(),
                })
                    .select()
                    .single();
                if (userMsgErr)
                    throw new Error(userMsgErr.message);
                const { data: aiMsg, error: aiMsgErr } = await config_1.supabaseAdmin
                    .from('messages')
                    .insert({
                    conversation_id: conversationId,
                    sender_type: 'character',
                    sender_id: characterId,
                    message_type: 'voice',
                    content: script,
                    media_id: media.id,
                })
                    .select()
                    .single();
                if (aiMsgErr)
                    throw new Error(aiMsgErr.message);
                await config_1.supabaseAdmin
                    .from('conversations')
                    .update({ last_message_at: now.toISOString() })
                    .eq('id', conversationId);
                const storedMessages = [
                    {
                        id: userMsg.id,
                        role: 'user',
                        content: prompt.trim(),
                        timestamp: now.toISOString(),
                    },
                    {
                        id: aiMsg.id,
                        role: 'assistant',
                        content: script,
                        timestamp: now.toISOString(),
                        messageType: 'voice',
                        mediaUrl: audioUrl,
                        mediaId: media.id,
                    },
                ];
                conversationStorageService_1.ConversationStorageService.appendMessages(userId, conversationId, characterId, storedMessages).catch((err) => {
                    console.warn('[characters] voice R2 append failed:', err?.message);
                });
            }
            catch (err) {
                console.warn('[characters] voice persistence failed (audio still returned):', err?.message);
            }
        }
        return res.json({
            success: true,
            audioUrl,
            transcript: script,
            voiceId: DEFAULT_VOICE_ID,
        });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * POST /api/v1/characters/:id/generate-video
 * Generate a short animated video of the character (DeAPI animation).
 *
 * Flow mirrors generate-image: pick the character's reference photo, submit
 * an animation job to DeAPI, poll until done, upload the clip to R2, persist
 * the user request + character video message, and return the public URL.
 */
router.post('/:id/generate-video', auth_1.requireAuth, rateLimitService_1.messagingRateLimiter, async (req, res) => {
    try {
        const characterId = req.params.id;
        const { prompt, userId, conversationId } = req.body;
        if (!prompt || !prompt.trim()) {
            return res.status(400).json({ success: false, error: 'prompt required' });
        }
        if (!userId)
            return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const { data: character, error } = await config_1.supabaseAdmin
            .from('characters')
            .select('*')
            .eq('id', characterId)
            .single();
        if (error || !character) {
            return res.status(404).json({ success: false, error: 'Character not found' });
        }
        let referenceUrl = null;
        let mimeType = 'image/jpeg';
        try {
            const { data: feeds } = await config_1.supabaseAdmin
                .from('character_feeds')
                .select('media_url, media_type')
                .eq('character_id', characterId)
                .order('sort_order', { ascending: true });
            const imageFeed = (feeds || []).find((f) => f.media_type === 'image' && f.media_url);
            referenceUrl = imageFeed ? imageFeed.media_url : null;
        }
        catch { }
        if (!referenceUrl) {
            referenceUrl =
                character.feed_media_url ||
                    character.background_image_url ||
                    character.portrait_image_url ||
                    character.circular_profile_image_url ||
                    null;
        }
        if (!referenceUrl) {
            return res.status(404).json({ success: false, error: 'No character image available to animate' });
        }
        const m = /\.(jpe?g|png|webp)(\?|$)/i.exec(referenceUrl);
        if (m) {
            const ext = m[1].toLowerCase();
            if (ext === 'png')
                mimeType = 'image/png';
            else if (ext === 'webp')
                mimeType = 'image/webp';
            else
                mimeType = 'image/jpeg';
        }
        let imageBuffer;
        try {
            imageBuffer = await getReferenceImageBytes(referenceUrl);
        }
        catch {
            return res.status(502).json({ success: false, error: 'Failed to download character image' });
        }
        const result = await deapiImageService_1.DeApiImageService.generateVideo(imageBuffer, prompt.trim(), mimeType);
        if (!result.success || !result.source) {
            return res.status(502).json({ success: false, error: result.error || 'Video generation failed' });
        }
        // Resolve the raw result (HTTP URL or data URL) into base64 + mimeType.
        let base64;
        let videoMimeType = 'video/mp4';
        const source = result.source;
        if (source.startsWith('data:')) {
            const dm = /^data:([^;,]+);base64,(.*)$/s.exec(source);
            if (!dm) {
                return res.status(502).json({ success: false, error: 'deAPI returned an unreadable video result' });
            }
            videoMimeType = dm[1];
            base64 = dm[2];
        }
        else {
            const videoRes = await fetch(source, { signal: AbortSignal.timeout(120000) });
            if (!videoRes.ok) {
                return res.status(502).json({ success: false, error: 'Failed to download generated video' });
            }
            const buf = Buffer.from(await videoRes.arrayBuffer());
            base64 = buf.toString('base64');
            videoMimeType = videoRes.headers.get('content-type') || videoMimeType;
        }
        let mediaUrl = null;
        if (userId && conversationId) {
            try {
                const upload = await r2Service_1.R2Service.uploadBase64Video({
                    characterId,
                    base64,
                    mimeType: videoMimeType,
                });
                mediaUrl = upload.url;
                const now = new Date();
                const { data: media, error: mediaErr } = await config_1.supabaseAdmin
                    .from('character_chat_media')
                    .insert({
                    character_id: characterId,
                    user_id: userId,
                    media_url: mediaUrl,
                    media_type: 'video',
                })
                    .select()
                    .single();
                if (mediaErr)
                    throw new Error(mediaErr.message);
                const { data: userMsg, error: userMsgErr } = await config_1.supabaseAdmin
                    .from('messages')
                    .insert({
                    conversation_id: conversationId,
                    sender_type: 'user',
                    sender_id: userId,
                    message_type: 'text',
                    content: prompt.trim(),
                })
                    .select()
                    .single();
                if (userMsgErr)
                    throw new Error(userMsgErr.message);
                const { data: aiMsg, error: aiMsgErr } = await config_1.supabaseAdmin
                    .from('messages')
                    .insert({
                    conversation_id: conversationId,
                    sender_type: 'character',
                    sender_id: characterId,
                    message_type: 'video',
                    content: '[Video]',
                    media_id: media.id,
                })
                    .select()
                    .single();
                if (aiMsgErr)
                    throw new Error(aiMsgErr.message);
                await config_1.supabaseAdmin
                    .from('conversations')
                    .update({ last_message_at: now.toISOString() })
                    .eq('id', conversationId);
                const storedMessages = [
                    {
                        id: userMsg.id,
                        role: 'user',
                        content: prompt.trim(),
                        timestamp: now.toISOString(),
                    },
                    {
                        id: aiMsg.id,
                        role: 'assistant',
                        content: '[Video]',
                        timestamp: now.toISOString(),
                        messageType: 'video',
                        mediaUrl,
                        mediaId: media.id,
                    },
                ];
                conversationStorageService_1.ConversationStorageService.appendMessages(userId, conversationId, characterId, storedMessages).catch((err) => {
                    console.warn('[characters] video R2 append failed:', err?.message);
                });
            }
            catch (err) {
                console.warn('[characters] video persistence failed (video still returned):', err?.message);
            }
        }
        return res.json({
            success: true,
            videoUrl: mediaUrl,
            mimeType: videoMimeType,
        });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * GET /api/v1/characters/:id/chat-media?userId=...
 * Private album: list the media (photos the user generated in chat with this
 * character) stored for this user+character, newest first. Only that user's
 * own generated media is returned.
 */
router.get('/:id/chat-media', auth_1.requireAuth, async (req, res) => {
    try {
        const characterId = String(req.params.id || '');
        const userId = String(req.query.userId || '');
        if (!characterId || !userId) {
            return res.status(400).json({ success: false, error: 'characterId and userId are required' });
        }
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const { data, error } = await config_1.supabaseAdmin
            .from('character_chat_media')
            .select('id, character_id, user_id, media_url, media_type, created_at')
            .eq('character_id', characterId)
            .eq('user_id', userId)
            .eq('media_type', 'image')
            .order('created_at', { ascending: false });
        if (error)
            throw new Error(error.message);
        return res.json({ success: true, media: data || [] });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
exports.default = router;
