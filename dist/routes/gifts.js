"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const config_1 = require("../config");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
/**
 * GET /api/v1/gifts?userId=...&characterId=...
 * List the gifts a specific user sent to a specific character (newest first).
 * Requires at least userId; characterId is optional (returns all gifts for
 * that user when omitted).
 */
router.get('/', auth_1.requireAuth, async (req, res) => {
    try {
        const userId = req.query.userId;
        const characterId = req.query.characterId;
        if (!userId)
            return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        let query = config_1.supabaseAdmin
            .from('gifts')
            .select('id, gift_name, gift_image, sent_at, character_id')
            .eq('user_id', userId)
            .order('sent_at', { ascending: false });
        if (characterId)
            query = query.eq('character_id', characterId);
        const { data: gifts, error } = await query;
        if (error)
            throw new Error(`Gifts query error: ${error.message}`);
        return res.json({ success: true, gifts: gifts || [] });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * POST /api/v1/gifts
 * Record a gift sent by a user to a character.
 * Body: { userId, characterId, giftName, giftImage? }
 */
router.post('/', auth_1.requireAuth, async (req, res) => {
    try {
        const { userId, characterId, giftName, giftImage } = req.body;
        if (!userId)
            return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        if (!characterId)
            return res.status(400).json({ success: false, error: 'characterId required' });
        if (!giftName || !String(giftName).trim()) {
            return res.status(400).json({ success: false, error: 'giftName required' });
        }
        const { data: gift, error } = await config_1.supabaseAdmin
            .from('gifts')
            .insert({
            user_id: userId,
            character_id: characterId,
            gift_name: String(giftName).trim(),
            gift_image: giftImage ? String(giftImage) : null,
        })
            .select()
            .single();
        if (error)
            throw new Error(`Gift insert error: ${error.message}`);
        return res.status(201).json({ success: true, gift });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
exports.default = router;
