"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const config_1 = require("../config");
const qdrantService_1 = require("../services/qdrantService");
const conversationStorageService_1 = require("../services/conversationStorageService");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
/**
 * POST /api/v1/auth/profile
 * Bootstrap or retrieve user profile
 */
router.post('/profile', auth_1.requireAuth, async (req, res) => {
    try {
        const { userId, email, displayName, avatarUrl, gender, declaredAge } = req.body;
        if (!userId) {
            return res.status(400).json({ success: false, error: 'userId is required' });
        }
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const { data: existing } = await config_1.supabaseAdmin
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .maybeSingle();
        if (existing) {
            return res.json({ success: true, profile: existing });
        }
        // Duplicate-email guard: when signing up via Google OAuth with an email that
        // already belongs to an existing user, treat it as a login instead of creating
        // a brand-new account. Look up the auth user by email and, if found, point this
        // profile at the existing auth user so no duplicate user/profile is created.
        let existingUserId = null;
        if (email) {
            try {
                // Use the GoTrue admin list endpoint with an email filter (the most reliable
                // lookup in this project; unfiltered listUsers returns a DB error).
                const adminRes = await fetch(`${config_1.CONFIG.SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=10&filter=${encodeURIComponent(email)}`, {
                    headers: {
                        apikey: config_1.CONFIG.SUPABASE_SERVICE_ROLE_KEY || config_1.CONFIG.SUPABASE_ANON_KEY,
                        Authorization: `Bearer ${config_1.CONFIG.SUPABASE_SERVICE_ROLE_KEY || config_1.CONFIG.SUPABASE_ANON_KEY}`,
                        Accept: 'application/json',
                    },
                });
                if (adminRes.ok) {
                    const body = await adminRes.json();
                    const match = (body?.users || []).find((u) => u && (u.email || '').toLowerCase() === email.toLowerCase());
                    if (match)
                        existingUserId = match.id;
                }
            }
            catch (e) {
                // Admin lookup unavailable — proceed with normal bootstrap for this userId.
            }
        }
        const targetUserId = existingUserId || userId;
        // If an existing user owns this email, reuse (or refresh) their profile.
        if (existingUserId) {
            const { data: linkedProfile, error: linkErr } = await config_1.supabaseAdmin
                .from('profiles')
                .select('*')
                .eq('id', existingUserId)
                .maybeSingle();
            if (!linkErr && linkedProfile) {
                if (displayName) {
                    await config_1.supabaseAdmin
                        .from('profiles')
                        .update({ display_name: displayName, avatar_url: avatarUrl || null, updated_at: new Date().toISOString() })
                        .eq('id', existingUserId);
                }
                return res.json({ success: true, profile: linkedProfile, login: true, matchedUserId: existingUserId });
            }
        }
        // Create profile
        const { data: profile, error } = await config_1.supabaseAdmin
            .from('profiles')
            .insert({
            id: targetUserId,
            display_name: displayName || 'User',
            avatar_url: avatarUrl || null,
            gender: gender || null,
            declared_age: declaredAge || 18,
            age_verified: (declaredAge || 18) >= 18,
            onboarding_state: 'started',
        })
            .select()
            .single();
        if (error)
            throw new Error(`Profile creation error: ${error.message}`);
        // Create preferences & wallet defaults
        await config_1.supabaseAdmin.from('user_preferences').insert({
            user_id: targetUserId,
            gender_interest: 'women',
        });
        await config_1.supabaseAdmin.from('wallets').insert({ user_id: targetUserId, credits: 50.0 });
        await config_1.supabaseAdmin.from('subscriptions').insert({ user_id: targetUserId, plan_type: 'free' });
        return res.status(201).json({ success: true, profile });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * PATCH /api/v1/auth/profile
 * Update mutable profile fields (e.g. name, declared age) for the signed-in user.
 * Empty/omitted fields are left untouched so edits are per-field.
 */
router.patch('/profile', auth_1.requireAuth, async (req, res) => {
    try {
        const { userId, displayName, declaredAge } = req.body;
        if (!userId) {
            return res.status(400).json({ success: false, error: 'userId is required' });
        }
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const updates = { updated_at: new Date().toISOString() };
        if (typeof displayName === 'string' && displayName.trim()) {
            updates.display_name = displayName.trim();
        }
        if (declaredAge !== undefined && declaredAge !== null && declaredAge !== '') {
            const age = Number(declaredAge);
            if (!Number.isFinite(age) || age < 13 || age > 120) {
                return res.status(400).json({ success: false, error: 'declaredAge must be a number between 13 and 120' });
            }
            updates.declared_age = age;
            updates.age_verified = age >= 18;
        }
        const { data: profile, error } = await config_1.supabaseAdmin
            .from('profiles')
            .update(updates)
            .eq('id', userId)
            .select()
            .maybeSingle();
        if (error)
            throw new Error(`Profile update error: ${error.message}`);
        if (!profile) {
            return res.status(404).json({ success: false, error: 'Profile not found' });
        }
        return res.json({ success: true, profile });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * DELETE /api/v1/auth/account
 * Permanently delete a user account and all related data.
 * Requires the service role key (configured in backend/.env).
 */
router.delete('/account', auth_1.requireAuth, async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({ success: false, error: 'userId is required' });
        }
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        // 1. Remove the profile row. All other tables (preferences, conversations,
        //    messages, wallets, subscriptions, memories, etc.) cascade on profile delete.
        const { error: profileError } = await config_1.supabaseAdmin
            .from('profiles')
            .delete()
            .eq('id', userId);
        if (profileError) {
            console.error('Profile deletion error:', profileError.message);
            return res.status(500).json({ success: false, error: `Profile deletion error: ${profileError.message}` });
        }
        // 2. Remove the user's semantic memories from Qdrant (best-effort).
        if (qdrantService_1.QdrantService.isConfigured()) {
            try {
                await qdrantService_1.QdrantService.deleteUserMemories(userId);
            }
            catch (err) {
                console.error('Qdrant memory deletion error:', err?.message);
            }
        }
        // 3. Remove the user's raw conversation history from R2 (best-effort).
        try {
            await conversationStorageService_1.ConversationStorageService.deleteUserData(userId);
        }
        catch (err) {
            console.error('R2 user data deletion error:', err?.message);
        }
        // 4. Delete the Supabase auth user so they can no longer sign in.
        const { error: authError } = await config_1.supabaseAdmin.auth.admin.deleteUser(userId);
        if (authError) {
            console.error('Auth user deletion error:', authError.message);
            return res.status(500).json({ success: false, error: `Auth user deletion error: ${authError.message}` });
        }
        return res.json({ success: true, message: 'Account permanently deleted' });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * POST /api/v1/auth/onboarding
 * Update onboarding state
 */
router.post('/onboarding', auth_1.requireAuth, async (req, res) => {
    try {
        let { userId, state, preferences } = req.body;
        if (!userId || !state) {
            return res.status(400).json({ success: false, error: 'userId and state required' });
        }
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const { data: profile, error } = await config_1.supabaseAdmin
            .from('profiles')
            .update({ onboarding_state: state, updated_at: new Date().toISOString() })
            .eq('id', userId)
            .select()
            .single();
        if (error)
            throw new Error(`Onboarding state update error: ${error.message}`);
        if (preferences) {
            // Gender interest is fixed to women (the gender-interest onboarding
            // step was removed), so we never allow overwriting it from the client.
            preferences = { ...preferences, gender_interest: 'women' };
            await config_1.supabaseAdmin
                .from('user_preferences')
                .upsert({ user_id: userId, ...preferences, updated_at: new Date().toISOString() });
        }
        return res.json({ success: true, profile });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
exports.default = router;
