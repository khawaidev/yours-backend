"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.R2Service = void 0;
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const config_1 = require("../config");
// Bucket used for generated character images. The public R2 domain
// (pub-475cca0b7414418d866128a4b30dfd97.r2.dev) is bound to this bucket, so
// objects written here are directly readable through it.
const GENERATED_IMAGES_BUCKET = 'image-video-file-hosting';
class R2Service {
    /**
     * Generates a signed PUT URL for uploading directly from frontend to R2
     */
    static async generateUploadUrl(r2Key, mimeType, expiresInSeconds = 900) {
        const bucket = config_1.CONFIG.R2.BUCKET_NAME;
        const command = new client_s3_1.PutObjectCommand({
            Bucket: bucket,
            Key: r2Key,
            ContentType: mimeType,
        });
        try {
            const uploadUrl = await (0, s3_request_presigner_1.getSignedUrl)(config_1.r2Client, command, { expiresIn: expiresInSeconds });
            return { uploadUrl, bucket, r2Key };
        }
        catch (err) {
            console.warn('R2 presigned URL fallback mode active');
            return {
                uploadUrl: `${config_1.CONFIG.R2.PUBLIC_DOMAIN}/${r2Key}?upload=mock`,
                bucket,
                r2Key,
            };
        }
    }
    /**
     * Generates a signed PUT URL for uploading a character image directly from
     * the admin page to R2, under the `image-video-file-hosting` bucket at the
     * `images/yours/characters/` prefix. Returns the public URL too so the
     * admin form can save it to Supabase right after the upload completes.
     */
    static async generateCharacterImageUploadUrl(r2Key, mimeType, expiresInSeconds = 900) {
        const bucket = GENERATED_IMAGES_BUCKET;
        const command = new client_s3_1.PutObjectCommand({
            Bucket: bucket,
            Key: r2Key,
            ContentType: mimeType,
        });
        try {
            const uploadUrl = await (0, s3_request_presigner_1.getSignedUrl)(config_1.r2Client, command, { expiresIn: expiresInSeconds });
            return { uploadUrl, bucket, r2Key, publicUrl: `${config_1.CONFIG.R2.PUBLIC_DOMAIN}/${r2Key}` };
        }
        catch (err) {
            console.warn('R2 presigned URL fallback mode active');
            return {
                uploadUrl: `${config_1.CONFIG.R2.PUBLIC_DOMAIN}/${r2Key}?upload=mock`,
                bucket,
                r2Key,
                publicUrl: `${config_1.CONFIG.R2.PUBLIC_DOMAIN}/${r2Key}`,
            };
        }
    }
    /**
     * Upload a base64-encoded image directly to R2 and return its public URL.
     *
     * Writes to the `image-video-file-hosting` bucket under the
     * `images/yours/Created images of characters/` prefix (per project
     * convention) so the image is immediately readable via the public R2 domain.
     */
    static async uploadBase64Image(input) {
        const mimeType = input.mimeType || 'image/png';
        const ext = mimeType.split('/')[1] || 'png';
        const r2Key = `images/yours/Created images of characters/${input.characterId}-${Date.now()}.${ext}`;
        await config_1.r2Client.send(new client_s3_1.PutObjectCommand({
            Bucket: GENERATED_IMAGES_BUCKET,
            Key: r2Key,
            Body: Buffer.from(input.base64, 'base64'),
            ContentType: mimeType,
        }));
        return { r2Key, url: `${config_1.CONFIG.R2.PUBLIC_DOMAIN}/${r2Key}` };
    }
    /**
     * Upload a base64-encoded audio file (e.g. a generated voice note) to R2 and
     * return its public URL. Uses the same public bucket as generated images so
     * the file is readable directly through the public R2 domain.
     */
    static async uploadBase64Voice(input) {
        const mimeType = input.mimeType || 'audio/mpeg';
        const ext = (mimeType.split('/')[1] || 'mp3').replace(/[^a-z0-9]/gi, '');
        const r2Key = `voice/yours/${input.characterId}-${Date.now()}.${ext}`;
        await config_1.r2Client.send(new client_s3_1.PutObjectCommand({
            Bucket: GENERATED_IMAGES_BUCKET,
            Key: r2Key,
            Body: Buffer.from(input.base64, 'base64'),
            ContentType: mimeType,
        }));
        return { r2Key, url: `${config_1.CONFIG.R2.PUBLIC_DOMAIN}/${r2Key}` };
    }
    /**
     * Insert media asset record into database
     */
    static async createMediaAsset(input) {
        const bucket = input.r2_bucket || config_1.CONFIG.R2.BUCKET_NAME;
        const { data, error } = await config_1.supabaseAdmin
            .from('media_assets')
            .insert({
            owner_id: input.owner_id || null,
            character_id: input.character_id || null,
            r2_bucket: bucket,
            r2_key: input.r2_key,
            media_type: input.media_type,
            mime_type: input.mime_type,
            size: input.size || 0,
            width: input.width || null,
            height: input.height || null,
            duration: input.duration || null,
            visibility: input.visibility || 'private',
            moderation_status: 'approved',
        })
            .select()
            .single();
        if (error)
            throw new Error(`Database media asset creation error: ${error.message}`);
        return data;
    }
    /**
     * Format appropriate CDN public URL or short-lived Signed URL for R2 asset
     */
    static async getMediaAssetUrl(asset) {
        if (!asset)
            return null;
        if (asset.visibility === 'public') {
            // Use CDN / Public R2 Domain
            return `${config_1.CONFIG.R2.PUBLIC_DOMAIN}/${asset.r2_key}`;
        }
        // Generate Presigned GET URL for private asset
        try {
            const command = new client_s3_1.GetObjectCommand({
                Bucket: asset.r2_bucket || config_1.CONFIG.R2.BUCKET_NAME,
                Key: asset.r2_key,
            });
            return await (0, s3_request_presigner_1.getSignedUrl)(config_1.r2Client, command, { expiresIn: 3600 });
        }
        catch (err) {
            return `${config_1.CONFIG.R2.PUBLIC_DOMAIN}/${asset.r2_key}`;
        }
    }
}
exports.R2Service = R2Service;
