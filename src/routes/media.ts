import { Router } from 'express';
import { R2Service } from '../services/r2Service';
import { supabaseAdmin } from '../config';

const router = Router();

/**
 * POST /api/v1/media/upload-url
 * Get a Cloudflare R2 presigned PUT upload URL
 */
router.post('/upload-url', async (req, res) => {
  try {
    const { filename, mimeType } = req.body;
    if (!filename || !mimeType) {
      return res.status(400).json({ success: false, error: 'filename and mimeType required' });
    }

    const ext = filename.split('.').pop() || 'bin';
    const r2Key = `uploads/${Date.now()}_${Math.random().toString(36).substr(2, 9)}.${ext}`;

    const presignedData = await R2Service.generateUploadUrl(r2Key, mimeType);
    return res.json({ success: true, ...presignedData });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/v1/media/assets
 * Record asset metadata in media_assets table
 */
router.post('/assets', async (req, res) => {
  try {
    const asset = await R2Service.createMediaAsset(req.body);
    const mediaUrl = await R2Service.getMediaAssetUrl(asset);
    return res.status(201).json({ success: true, asset, mediaUrl });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/v1/media/:id
 * Retrieve media asset details & formatted CDN/signed URL
 */
router.get('/:id', async (req, res) => {
  try {
    const { data: asset, error } = await supabaseAdmin
      .from('media_assets')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !asset) {
      return res.status(404).json({ success: false, error: 'Media asset not found' });
    }

    const url = await R2Service.getMediaAssetUrl(asset);
    return res.json({ success: true, asset, url });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
