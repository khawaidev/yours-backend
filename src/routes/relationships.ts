import { Router } from 'express';
import { RelationshipService } from '../services/relationshipService';

const router = Router();

/**
 * GET /api/v1/relationships/:characterId
 * Get relationship state
 */
router.get('/:characterId', async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) return res.status(400).json({ success: false, error: 'userId required' });

    const relationship = await RelationshipService.getRelationship(userId, req.params.characterId);
    return res.json({ success: true, relationship });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/v1/relationships/:characterId
 * Update relationship metrics
 */
router.patch('/:characterId', async (req, res) => {
  try {
    const { userId, delta } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId required' });

    const updated = await RelationshipService.updateRelationship(userId, req.params.characterId, delta || {});
    return res.json({ success: true, relationship: updated });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
