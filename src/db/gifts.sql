-- ==========================================
-- Gifts history table
-- Tracks gifts sent by a user to a character
-- (user-specific gift history, not app-wide).
-- ==========================================

CREATE TABLE IF NOT EXISTS public.gifts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
    character_id UUID REFERENCES public.characters(id) ON DELETE CASCADE NOT NULL,
    gift_name TEXT NOT NULL,
    gift_image TEXT,
    sent_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gifts_user_character
    ON public.gifts(user_id, character_id, sent_at DESC);

ALTER TABLE public.gifts ENABLE ROW LEVEL SECURITY;

-- Users can read their own gift history.
CREATE POLICY gifts_user_select ON public.gifts
    FOR SELECT USING (auth.uid() = user_id);

-- Authenticated users can record a gift they sent.
CREATE POLICY gifts_user_insert ON public.gifts
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Backend service role can always read/write (bypasses RLS).
