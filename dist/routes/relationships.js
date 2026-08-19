"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const relationshipService_1 = require("../services/relationshipService");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
/**
 * GET /api/v1/relationships/:characterId
 * Get relationship state
 */
router.get('/:characterId', auth_1.requireAuth, async (req, res) => {
    try {
        const userId = req.query.userId;
        if (!userId)
            return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const relationship = await relationshipService_1.RelationshipService.getRelationship(userId, req.params.characterId);
        return res.json({ success: true, relationship });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * PATCH /api/v1/relationships/:characterId
 * Update relationship metrics
 */
router.patch('/:characterId', auth_1.requireAuth, async (req, res) => {
    try {
        const { userId, delta } = req.body;
        if (!userId)
            return res.status(400).json({ success: false, error: 'userId required' });
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const updated = await relationshipService_1.RelationshipService.updateRelationship(userId, req.params.characterId, delta || {});
        return res.json({ success: true, relationship: updated });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
exports.default = router;
