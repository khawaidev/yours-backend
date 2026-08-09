import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2Client, CONFIG, supabaseAdmin } from '../config';

export interface MediaAssetInput {
  owner_id?: string;
  character_id?: string;
  r2_bucket?: string;
  r2_key: string;
  media_type: string; // 'image', 'video', 'portrait', 'voice', 'user_upload'
  mime_type: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
  visibility?: 'public' | 'private' | 'unlisted';
}

export class R2Service {
  /**
   * Generates a signed PUT URL for uploading directly from frontend to R2
   */
  static async generateUploadUrl(r2Key: string, mimeType: string, expiresInSeconds = 900) {
    const bucket = CONFIG.R2.BUCKET_NAME;
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: r2Key,
      ContentType: mimeType,
    });
    
    try {
      const uploadUrl = await getSignedUrl(r2Client, command, { expiresIn: expiresInSeconds });
      return { uploadUrl, bucket, r2Key };
    } catch (err) {
      console.warn('R2 presigned URL fallback mode active');
      return {
        uploadUrl: `${CONFIG.R2.PUBLIC_DOMAIN}/${r2Key}?upload=mock`,
        bucket,
        r2Key,
      };
    }
  }

  /**
   * Insert media asset record into database
   */
  static async createMediaAsset(input: MediaAssetInput) {
    const bucket = input.r2_bucket || CONFIG.R2.BUCKET_NAME;
    const { data, error } = await supabaseAdmin
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

    if (error) throw new Error(`Database media asset creation error: ${error.message}`);
    return data;
  }

  /**
   * Format appropriate CDN public URL or short-lived Signed URL for R2 asset
   */
  static async getMediaAssetUrl(asset: any) {
    if (!asset) return null;
    
    if (asset.visibility === 'public') {
      // Use CDN / Public R2 Domain
      return `${CONFIG.R2.PUBLIC_DOMAIN}/${asset.r2_key}`;
    }

    // Generate Presigned GET URL for private asset
    try {
      const command = new GetObjectCommand({
        Bucket: asset.r2_bucket || CONFIG.R2.BUCKET_NAME,
        Key: asset.r2_key,
      });
      return await getSignedUrl(r2Client, command, { expiresIn: 3600 });
    } catch (err) {
      return `${CONFIG.R2.PUBLIC_DOMAIN}/${asset.r2_key}`;
    }
  }
}
