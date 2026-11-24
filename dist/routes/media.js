"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const r2Service_1 = require("../services/r2Service");
const config_1 = require("../config");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
/**
 * POST /api/v1/media/upload-url
 * Get a Cloudflare R2 presigned PUT upload URL (authenticated users only).
 * The extension is sanitized so it can't smuggle path separators or query
 * characters into the object key.
 */
router.post('/upload-url', auth_1.requireAuth, async (req, res) => {
    try {
        const { filename, mimeType } = req.body;
        if (!filename || !mimeType) {
            return res.status(400).json({ success: false, error: 'filename and mimeType required' });
        }
        // Allow only safe characters in the dedup suffix; never trust the client
        // filename for anything beyond a display label.
        const ext = String(filename).split('.').pop() || 'bin';
        const safeExt = ext.replace(/[^a-zA-Z0-9]+/g, '').slice(0, 8) || 'bin';
        const r2Key = `uploads/${Date.now()}_${Math.random().toString(36).substr(2, 9)}.${safeExt}`;
        const presignedData = await r2Service_1.R2Service.generateUploadUrl(r2Key, mimeType);
        return res.json({ success: true, ...presignedData });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
// Character feed media: still images plus MP4 video. Anything else (webm,
// quicktime, gif-as-video, ...) is rejected before a URL is ever signed.
const CHARACTER_MEDIA_MIME = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'video/mp4',
]);
const MAX_CHARACTER_VIDEO_BYTES = 5 * 1024 * 1024; // 5 MB per video upload
/**
 * POST /api/v1/media/character-image-upload-url
 * Get a Cloudflare R2 presigned PUT upload URL for character feed media
 * (image or MP4 video). The file is written to the `image-video-file-hosting`
 * bucket under the `images/yours/characters/` prefix, and the response also
 * includes the public URL to store in Supabase after the upload completes.
 *
 * Body: { filename, mimeType, size? }
 * `size` (bytes) is required for video/mp4 and is baked into the signature so
 * R2 rejects a body of any other length — that is what enforces the 5 MB cap.
 */
router.post('/character-image-upload-url', async (req, res) => {
    try {
        const { filename, mimeType, size } = req.body;
        if (!filename || !mimeType) {
            return res.status(400).json({ success: false, error: 'filename and mimeType required' });
        }
        const mime = String(mimeType).toLowerCase();
        if (!CHARACTER_MEDIA_MIME.has(mime)) {
            return res.status(400).json({
                success: false,
                error: 'unsupported media type: only images and video/mp4 are allowed',
            });
        }
        const isVideo = mime === 'video/mp4';
        // Sanitize the key so it can only ever target the characters folder.
        let safeName = String(filename).replace(/[^a-zA-Z0-9._-]/g, '-');
        let contentLength;
        if (isVideo) {
            if (!safeName.toLowerCase().endsWith('.mp4')) {
                safeName = `${safeName.replace(/\.(mov|webm|m4v|avi|mkv)$/i, '')}.mp4`;
            }
            const bytes = Number(size);
            if (!Number.isInteger(bytes) || bytes <= 0) {
                return res.status(400).json({
                    success: false,
                    error: 'size (bytes) is required for video uploads',
                });
            }
            if (bytes > MAX_CHARACTER_VIDEO_BYTES) {
                return res.status(413).json({
                    success: false,
                    error: 'video exceeds the 5 MB limit',
                    maxBytes: MAX_CHARACTER_VIDEO_BYTES,
                });
            }
            contentLength = bytes;
        }
        const r2Key = `images/yours/characters/${safeName}`;
        const presignedData = await r2Service_1.R2Service.generateCharacterImageUploadUrl(r2Key, mime, 900, contentLength);
        return res.json({
            success: true,
            ...presignedData,
            mediaType: isVideo ? 'video' : 'image',
            maxBytes: MAX_CHARACTER_VIDEO_BYTES,
        });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * POST /api/v1/media/assets
 * Record asset metadata in media_assets table (authenticated users only).
 * The caller must own the asset (or supply no owner, which stays private).
 */
router.post('/assets', auth_1.requireAuth, async (req, res) => {
    try {
        const body = req.body || {};
        if (body.owner_id && !(0, auth_1.requireOwnership)(req, res, body.owner_id))
            return;
        const asset = await r2Service_1.R2Service.createMediaAsset({ ...body, owner_id: body.owner_id || req.authUserId });
        const mediaUrl = await r2Service_1.R2Service.getMediaAssetUrl(asset);
        return res.status(201).json({ success: true, asset, mediaUrl });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * GET /api/v1/media/:id
 * Retrieve media asset details & formatted CDN/signed URL (authenticated).
 */
router.get('/:id', auth_1.requireAuth, async (req, res) => {
    try {
        const { data: asset, error } = await config_1.supabaseAdmin
            .from('media_assets')
            .select('*')
            .eq('id', req.params.id)
            .single();
        if (error || !asset) {
            return res.status(404).json({ success: false, error: 'Media asset not found' });
        }
        // A private asset is only reachable by its owner.
        if (asset.visibility !== 'public' && asset.owner_id) {
            if (!(0, auth_1.requireOwnership)(req, res, asset.owner_id))
                return;
        }
        const url = await r2Service_1.R2Service.getMediaAssetUrl(asset);
        return res.json({ success: true, asset, url });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
exports.default = router;
