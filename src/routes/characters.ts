import { Router } from 'express';
import { supabaseAdmin } from '../config';

const router = Router();

/**
 * GET /api/v1/characters
 * List public discoverable characters
 */
router.get('/', async (req, res) => {
  try {
    const { data: characters, error } = await supabaseAdmin
      .from('characters')
      .select('*')
      .eq('visibility', 'public')
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return res.json({ success: true, characters });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/v1/characters/:id
 * Fetch character details
 */
router.get('/:id', async (req, res) => {
  try {
    const { data: character, error } = await supabaseAdmin
      .from('characters')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !character) {
      return res.status(404).json({ success: false, error: 'Character not found' });
    }

    return res.json({ success: true, character });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/v1/characters
 * Create custom character
 */
router.post('/', async (req, res) => {
  try {
    const { name, username, bio, description, gender, artStyle, creatorUserId, personalityDefinition } = req.body;
    if (!name || !username) {
      return res.status(400).json({ success: false, error: 'name and username required' });
    }

    const { data: character, error } = await supabaseAdmin
      .from('characters')
      .insert({
        creator_user_id: creatorUserId || null,
        name,
        username,
        bio: bio || null,
        description: description || null,
        gender: gender || 'female',
        art_style: artStyle || 'realistic',
        personality_definition: personalityDefinition || {},
        visibility: 'public',
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return res.status(201).json({ success: true, character });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/v1/characters/:id/save
 * Save character to user's saved list
 */
router.post('/:id/save', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId required' });

    const { data, error } = await supabaseAdmin
      .from('saved_characters')
      .upsert({ user_id: userId, character_id: req.params.id })
      .select();

    if (error) throw new Error(error.message);
    return res.json({ success: true, saved: data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
