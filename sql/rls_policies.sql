-- ============================================================================
-- Yours backend — Row Level Security migration (APPLIED 2026-08-18)
--
-- Closes direct-Supabase access. The backend talks to Supabase with the
-- service-role key, which BYPASSES RLS, so the API is unaffected. This only
-- governs browsers that query Supabase directly with the anon/publishable key
-- (e.g. feed.html, settings.html, character-profile.html, index.html).
--
-- Apply via: Supabase Dashboard → SQL → New query → paste → Run
-- (the Management API database/query endpoint also works; it runs as postgres).
--
-- SUMMARY OF PERMISSIONS AFTER THIS MIGRATION:
--   * characters / character_feeds / voices / character_media
--                                        → public SELECT (read-only catalog)
--   * profiles / user_profiles           → each user sees/edits only their own
--   * wallets, wallet_transactions,
--     subscriptions, saved_characters,
--     daily_rewards, character_relationships,
--     memories, character_chat_media,
--     gifts, user_charisma               → own-row by user_id (user_profiles,
--                                           user_charisma: own-row by id)
--   * conversations                      → own-row by user_id
--   * messages                           → via the owning conversation only
--   * analytics_events, user_preferences → locked down (service-role only)
--   * pricing_regions, token_packs       → RLS on, NO policies (service-role /
--                                           owner only; NOT forced so future
--                                           seeding via the management API works)
--
-- REMEDIATION (this run): dropped pre-existing wide-open policies
--   messages_public_all, conversations_public_all, memories_public_all,
--   character_relationships_public_all (ALL cmd, qual = true) and
--   char_media_insert, which let any anon/authenticated client read/write
--   those tables directly.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Remediation — drop wide-open policies created by earlier tooling
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS messages_public_all ON public.messages;
DROP POLICY IF EXISTS conversations_public_all ON public.conversations;
DROP POLICY IF EXISTS memories_public_all ON public.memories;
DROP POLICY IF EXISTS character_relationships_public_all ON public.character_relationships;
DROP POLICY IF EXISTS char_media_insert ON public.character_media;

-- ---------------------------------------------------------------------------
-- 1. Characters (public, read-only catalog)
-- ---------------------------------------------------------------------------
ALTER TABLE public.characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.characters FORCE ROW LEVEL SECURITY;

CREATE POLICY "characters_select_public" ON public.characters
  FOR SELECT USING (true);

ALTER TABLE public.character_feeds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_feeds FORCE ROW LEVEL SECURITY;

CREATE POLICY "character_feeds_select_public" ON public.character_feeds
  FOR SELECT USING (true);

-- voices / character_media: public read-only catalog (media rows only
-- insertable via the backend, service-role key)
ALTER TABLE public.voices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voices FORCE ROW LEVEL SECURITY;
CREATE POLICY "voices_read_all" ON public.voices FOR SELECT USING (true);

ALTER TABLE public.character_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_media FORCE ROW LEVEL SECURITY;
CREATE POLICY "char_media_read" ON public.character_media FOR SELECT USING (true);

-- ---------------------------------------------------------------------------
-- 2. Profiles — keyed by profiles.id = auth.uid()
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;

CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT USING (id = auth.uid());
CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT WITH CHECK (id = auth.uid());
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE USING (id = auth.uid()) WITH CHECK (id = auth.uid());
CREATE POLICY "profiles_delete_own" ON public.profiles
  FOR DELETE USING (id = auth.uid());

-- user_profiles — read directly by feed.html, keyed by id = auth.uid()
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY "profiles_select_own" ON public.user_profiles FOR SELECT USING (id = auth.uid());
CREATE POLICY "profiles_insert_own" ON public.user_profiles FOR INSERT WITH CHECK (id = auth.uid());
CREATE POLICY "profiles_update_own" ON public.user_profiles FOR UPDATE USING (id = auth.uid()) WITH CHECK (id = auth.uid());

-- user_charisma — read directly by chat.html, keyed by user_id
ALTER TABLE public.user_charisma ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_charisma FORCE ROW LEVEL SECURITY;
CREATE POLICY "charisma_select_own" ON public.user_charisma FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "charisma_insert_own" ON public.user_charisma FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "charisma_update_own" ON public.user_charisma FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 3. Per-user tables keyed by user_id
-- ---------------------------------------------------------------------------
-- wallets
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets FORCE ROW LEVEL SECURITY;
CREATE POLICY "wallets_select_own" ON public.wallets FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "wallets_update_own" ON public.wallets FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- wallet_transactions
ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY "wallet_transactions_select_own" ON public.wallet_transactions FOR SELECT USING (user_id = auth.uid());

-- subscriptions
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY "subscriptions_select_own" ON public.subscriptions FOR SELECT USING (user_id = auth.uid());

-- saved_characters
ALTER TABLE public.saved_characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_characters FORCE ROW LEVEL SECURITY;
CREATE POLICY "saved_characters_select_own" ON public.saved_characters FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "saved_characters_insert_own" ON public.saved_characters FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "saved_characters_delete_own" ON public.saved_characters FOR DELETE USING (user_id = auth.uid());

-- daily_rewards
ALTER TABLE public.daily_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_rewards FORCE ROW LEVEL SECURITY;
CREATE POLICY "daily_rewards_select_own" ON public.daily_rewards FOR SELECT USING (user_id = auth.uid());

-- character_relationships
ALTER TABLE public.character_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_relationships FORCE ROW LEVEL SECURITY;
CREATE POLICY "character_relationships_select_own" ON public.character_relationships FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "character_relationships_insert_own" ON public.character_relationships FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "character_relationships_update_own" ON public.character_relationships FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "character_relationships_delete_own" ON public.character_relationships FOR DELETE USING (user_id = auth.uid());

-- memories
ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memories FORCE ROW LEVEL SECURITY;
CREATE POLICY "memories_select_own" ON public.memories FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "memories_insert_own" ON public.memories FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "memories_update_own" ON public.memories FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "memories_delete_own" ON public.memories FOR DELETE USING (user_id = auth.uid());

-- character_chat_media (media a user generated for a character)
ALTER TABLE public.character_chat_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_chat_media FORCE ROW LEVEL SECURITY;
CREATE POLICY "character_chat_media_select_own" ON public.character_chat_media FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "character_chat_media_insert_own" ON public.character_chat_media FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "character_chat_media_delete_own" ON public.character_chat_media FOR DELETE USING (user_id = auth.uid());

-- gifts
ALTER TABLE public.gifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gifts FORCE ROW LEVEL SECURITY;
CREATE POLICY "gifts_select_own" ON public.gifts FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "gifts_insert_own" ON public.gifts FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "gifts_delete_own" ON public.gifts FOR DELETE USING (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. Conversations & messages
-- ---------------------------------------------------------------------------
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY "conversations_select_own" ON public.conversations FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "conversations_insert_own" ON public.conversations FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "conversations_update_own" ON public.conversations FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "conversations_delete_own" ON public.conversations FOR DELETE USING (user_id = auth.uid());

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages FORCE ROW LEVEL SECURITY;

-- Read a message only if its conversation belongs to you.
CREATE POLICY "messages_select_own_conv" ON public.messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_id AND c.user_id = auth.uid()
    )
  );

-- Insert your own messages into your own conversations. Server-side AI replies
-- are written by the service-role key and bypass RLS.
CREATE POLICY "messages_insert_own" ON public.messages
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_id AND c.user_id = auth.uid()
    )
    AND (sender_type = 'user')
    AND (sender_id::uuid = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 5. Lock down everything else (no policies => service-role only)
-- ---------------------------------------------------------------------------
ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_events FORCE ROW LEVEL SECURITY;

ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences FORCE ROW LEVEL SECURITY;

-- Pricing tables: RLS on with zero policies. NOT forced so that future seeding
-- via the Management API (postgres/owner) still works; the anon key is denied
-- and the backend serves pricing through its own endpoints with the
-- service-role key (which bypasses RLS).
ALTER TABLE public.token_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pricing_regions ENABLE ROW LEVEL SECURITY;
