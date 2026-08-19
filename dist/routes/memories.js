"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const config_1 = require("../config");
const memoryService_1 = require("../services/memoryService");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
/**
 * GET /api/v1/memories
 * Fetch stored memories for user and character
 */
router.get('/', auth_1.requireAuth, async (req, res) => {
    try {
        const { userId, characterId } = req.query;
        if (!userId)
            return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        let query = config_1.supabaseAdmin
            .from('memories')
            .select('*')
            .eq('user_id', userId)
            .eq('status', 'active');
        if (characterId)
            query = query.eq('character_id', characterId);
        const { data: memories, error } = await query.order('created_at', { ascending: false });
        if (error)
            throw new Error(error.message);
        return res.json({ success: true, memories });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * DELETE /api/v1/memories/:id
 * Delete specific memory
 */
router.delete('/:id', auth_1.requireAuth, async (req, res) => {
    try {
        const userId = req.query.userId;
        if (!userId)
            return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        await memoryService_1.MemoryService.deleteMemory(userId, req.params.id);
        return res.json({ success: true, message: 'Memory deleted successfully' });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * DELETE /api/v1/memories
 * Clear all memories
 */
router.delete('/', auth_1.requireAuth, async (req, res) => {
    try {
        const { userId, characterId } = req.query;
        if (!userId)
            return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        await memoryService_1.MemoryService.clearAllMemories(userId, characterId);
        return res.json({ success: true, message: 'All memories cleared' });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
exports.default = router;
