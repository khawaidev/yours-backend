import { Router } from 'express';
import { supabaseAdmin } from '../config';
import { MemoryService } from '../services/memoryService';

const router = Router();

/**
 * GET /api/v1/memories
 * Fetch stored memories for user and character
 */
router.get('/', async (req, res) => {
  try {
    const { userId, characterId } = req.query as { userId: string; characterId?: string };
    if (!userId) return res.status(400).json({ success: false, error: 'userId required' });

    let query = supabaseAdmin
      .from('memories')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active');

    if (characterId) query = query.eq('character_id', characterId);

    const { data: memories, error } = await query.order('created_at', { ascending: false });
    if (error) throw new Error(error.message);

    return res.json({ success: true, memories });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/v1/memories/:id
 * Delete specific memory
 */
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) return res.status(400).json({ success: false, error: 'userId required' });

    await MemoryService.deleteMemory(userId, req.params.id);
    return res.json({ success: true, message: 'Memory deleted successfully' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/v1/memories
 * Clear all memories
 */
router.delete('/', async (req, res) => {
  try {
    const { userId, characterId } = req.query as { userId: string; characterId?: string };
    if (!userId) return res.status(400).json({ success: false, error: 'userId required' });

    await MemoryService.clearAllMemories(userId, characterId);
    return res.json({ success: true, message: 'All memories cleared' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
