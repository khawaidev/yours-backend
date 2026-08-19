"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeApiImageService = void 0;
const config_1 = require("../config");
const DEAPI_ENDPOINT = 'https://api.deapi.ai/api/v1/client/img2img';
const DEAPI_JOB_ENDPOINT = 'https://api.deapi.ai/api/v2/jobs';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 300000;
/**
 * DeAPI portrait generation service.
 *
 * Takes an existing character image (their feed / background photo) and
 * regenerates it with an edited prompt. The output is always a portrait that
 * preserves the person's identity (face, body, pose, composition) while the
 * user-requested changes (outfit, environment, pose) are applied.
 *
 * Result is returned as a base64 data URL so it can be rendered directly or
 * persisted to R2.
 */
class DeApiImageService {
    static isConfigured() {
        return (0, config_1.getDeAPiKeyPool)().length > 0;
    }
    static resultToDataUrl(json) {
        if (!json)
            return null;
        // DeAPI can return the image in a few shapes. Handle the common ones.
        const candidate = json.data ||
            json.output ||
            json.images ||
            json.result ||
            json.image ||
            json.url ||
            json;
        if (typeof candidate === 'string') {
            if (candidate.startsWith('data:')) {
                const m = /^data:([^;,]+);base64,(.*)$/s.exec(candidate);
                if (m)
                    return { imageBase64: m[2], mimeType: m[1] };
            }
            if (candidate.startsWith('http')) {
                return { imageBase64: candidate, mimeType: '' };
            }
            return { imageBase64: candidate, mimeType: 'image/png' };
        }
        if (Array.isArray(candidate) && candidate.length > 0) {
            return this.resultToDataUrl(candidate[0]);
        }
        if (candidate && typeof candidate === 'object') {
            return this.resultToDataUrl(candidate.b64 || candidate.base64 || candidate.url || candidate.data);
        }
        return null;
    }
    /**
     * Generate a portrait image of the character by editing their reference
     * photo according to the user's request.
     *
     * DeAPI's v1 img2img endpoint is asynchronous: submitting returns a
     * `request_id` immediately and the image is produced in the background.
     * This polls `GET /api/v2/jobs/{request_id}` until the job is done.
     *
     * @param referenceImage Buffer of the character's feed/bg image
     * @param userRequest  The user's natural-language request ("send me a pic of ...")
     * @param mimeType     Mime type of the reference image
     */
    static async generatePortrait(referenceImage, userRequest, mimeType = 'image/jpeg') {
        const keys = (0, config_1.getDeAPiKeyPool)();
        if (keys.length === 0) {
            return { success: false, error: 'DEAPI_API_KEY not configured' };
        }
        const prompt = `Edit this portrait of the character according to the user's request: "${userRequest}".

Transform the image into a new portrait: give the character a different pose, a different outfit and a different environment, but keep the exact same person — the same face, facial features, hairstyle, skin tone, body shape and proportions.

Photorealistic result with natural lighting and realistic skin texture. Output must always be a vertical portrait orientation.`;
        // Try each key; fall through on transient errors.
        let lastError = null;
        const maxKeys = Math.min(keys.length, 3);
        for (let i = 0; i < maxKeys; i++) {
            try {
                const requestId = await this.submit(keys[i], referenceImage, prompt, mimeType);
                if (!requestId)
                    continue;
                const resultUrl = await this.pollUntilDone(keys[i], requestId);
                if (!resultUrl) {
                    lastError = 'deAPI job did not finish';
                    continue;
                }
                const dataUrl = await this.urlToDataUrl(resultUrl);
                if (!dataUrl) {
                    lastError = 'deAPI result URL could not be fetched';
                    continue;
                }
                return {
                    success: true,
                    imageBase64: dataUrl.imageBase64,
                    mimeType: dataUrl.mimeType,
                };
            }
            catch (err) {
                lastError = err?.message || String(err);
            }
        }
        return { success: false, error: lastError || 'Image generation failed' };
    }
    static async submit(key, referenceImage, prompt, mimeType) {
        const form = new FormData();
        form.append('model', 'QwenImageEdit_Plus_NF4');
        form.append('image', new Blob([new Uint8Array(referenceImage)], { type: mimeType }), `portrait.${mimeType.split('/')[1] || 'jpg'}`);
        form.append('prompt', prompt);
        form.append('steps', '25');
        form.append('guidance', '7.5');
        form.append('seed', '-1');
        const response = await fetch(DEAPI_ENDPOINT, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${key}`,
                Accept: 'application/json',
            },
            body: form,
            signal: AbortSignal.timeout(120000),
        });
        if (!response.ok) {
            const bodyText = await response.text().catch(() => '');
            throw new Error(`deAPI submit ${response.status}: ${bodyText}`);
        }
        const json = await response.json();
        const requestId = json?.data?.request_id;
        if (!requestId) {
            throw new Error('deAPI submit returned no request_id');
        }
        return requestId;
    }
    static async pollUntilDone(key, requestId) {
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            let json;
            try {
                const response = await fetch(`${DEAPI_JOB_ENDPOINT}/${requestId}`, {
                    headers: {
                        Authorization: `Bearer ${key}`,
                        Accept: 'application/json',
                    },
                    signal: AbortSignal.timeout(30000),
                });
                if (!response.ok) {
                    continue;
                }
                json = await response.json();
            }
            catch {
                continue;
            }
            const data = json?.data || json || {};
            const status = data.status || '';
            if (status === 'done' || status === 'succeeded' || status === 'completed') {
                const url = data.result_url ||
                    (Array.isArray(data.results_alt_formats) && data.results_alt_formats[0]?.url) ||
                    (Array.isArray(data.images) && data.images[0]) ||
                    '';
                if (url)
                    return url;
                if (typeof data.result === 'string' && data.result.startsWith('data:')) {
                    const m = /^data:([^;,]+);base64,(.*)$/s.exec(data.result);
                    if (m) {
                        // Encode as a fetchable data URL we can hand to urlToDataUrl.
                        return data.result;
                    }
                }
                return null;
            }
            if (status === 'error' || status === 'failed' || status === 'cancelled') {
                const reason = data.error_message || data.error_reason || status;
                throw new Error(`deAPI job ${status}: ${reason}`);
            }
        }
        throw new Error('deAPI job timed out while polling');
    }
    static async urlToDataUrl(url) {
        try {
            if (url.startsWith('data:')) {
                const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
                if (m)
                    return { imageBase64: m[2], mimeType: m[1] };
                return null;
            }
            const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
            if (!response.ok)
                return null;
            const contentType = response.headers.get('content-type') || 'image/png';
            const buf = Buffer.from(await response.arrayBuffer());
            return { imageBase64: buf.toString('base64'), mimeType: contentType };
        }
        catch {
            return null;
        }
    }
}
exports.DeApiImageService = DeApiImageService;
