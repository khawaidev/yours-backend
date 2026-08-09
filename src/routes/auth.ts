import { Router } from 'express';
import { supabaseAdmin } from '../config';

const router = Router();

/**
 * POST /api/v1/auth/profile
 * Bootstrap or retrieve user profile
 */
router.post('/profile', async (req, res) => {
  try {
    const { userId, displayName, avatarUrl, gender, declaredAge } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId is required' });
    }

    const { data: existing } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (existing) {
      return res.json({ success: true, profile: existing });
    }

    // Create profile
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .insert({
        id: userId,
        display_name: displayName || 'User',
        avatar_url: avatarUrl || null,
        gender: gender || null,
        declared_age: declaredAge || 18,
        age_verified: (declaredAge || 18) >= 18,
        onboarding_state: 'started',
      })
      .select()
      .single();

    if (error) throw new Error(`Profile creation error: ${error.message}`);

    // Create preferences & wallet defaults
    await supabaseAdmin.from('user_preferences').insert({ user_id: userId });
    await supabaseAdmin.from('wallets').insert({ user_id: userId, credits: 100.0 });
    await supabaseAdmin.from('subscriptions').insert({ user_id: userId, plan_type: 'free' });

    return res.status(201).json({ success: true, profile });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/v1/auth/onboarding
 * Update onboarding state
 */
router.post('/onboarding', async (req, res) => {
  try {
    const { userId, state, preferences } = req.body;
    if (!userId || !state) {
      return res.status(400).json({ success: false, error: 'userId and state required' });
    }

    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .update({ onboarding_state: state, updated_at: new Date().toISOString() })
      .eq('id', userId)
      .select()
      .single();

    if (error) throw new Error(`Onboarding state update error: ${error.message}`);

    if (preferences) {
      await supabaseAdmin
        .from('user_preferences')
        .upsert({ user_id: userId, ...preferences, updated_at: new Date().toISOString() });
    }

    return res.json({ success: true, profile });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
