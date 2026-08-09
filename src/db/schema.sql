-- ==========================================
-- AI Companion Platform ("Yours") Schema
-- Target: Supabase PostgreSQL
-- ==========================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- 1. PRICING REGIONS TABLE (Dynamic multi-currency pricing)
CREATE TABLE IF NOT EXISTS public.pricing_regions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    region TEXT UNIQUE NOT NULL,
    country_codes TEXT[] NOT NULL,
    plus_price NUMERIC(10, 2) NOT NULL,
    premium_price NUMERIC(10, 2) NOT NULL,
    image_pack_price NUMERIC(10, 2) NOT NULL,
    voice_pack_price NUMERIC(10, 2) NOT NULL,
    currency TEXT NOT NULL,
    currency_symbol TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Seed Dynamic Pricing Regions
INSERT INTO public.pricing_regions (region, country_codes, plus_price, premium_price, image_pack_price, voice_pack_price, currency, currency_symbol)
VALUES 
    ('US', ARRAY['US'], 9.99, 19.99, 4.99, 3.99, 'USD', '$'),
    ('Canada', ARRAY['CA'], 12.99, 25.99, 6.49, 4.99, 'CAD', 'C$'),
    ('UK', ARRAY['GB', 'UK'], 8.99, 17.99, 4.49, 3.49, 'GBP', '£'),
    ('Australia', ARRAY['AU'], 14.99, 29.99, 7.49, 5.99, 'AUD', 'A$'),
    ('India', ARRAY['IN'], 499.00, 999.00, 249.00, 199.00, 'INR', '₹'),
    ('Brazil', ARRAY['BR'], 29.90, 59.90, 14.90, 11.90, 'BRL', 'R$'),
    ('Mexico', ARRAY['MX'], 129.00, 249.00, 69.00, 49.00, 'MXN', 'MX$'),
    ('Philippines', ARRAY['PH'], 299.00, 599.00, 149.00, 119.00, 'PHP', '₱'),
    ('Indonesia', ARRAY['ID'], 99000.00, 199000.00, 49000.00, 39000.00, 'IDR', 'Rp'),
    ('Turkey', ARRAY['TR'], 249.00, 499.00, 129.00, 99.00, 'TRY', '₺'),
    ('South Africa', ARRAY['ZA'], 199.00, 399.00, 99.00, 79.00, 'ZAR', 'R')
ON CONFLICT (region) DO UPDATE SET
    plus_price = EXCLUDED.plus_price,
    premium_price = EXCLUDED.premium_price,
    image_pack_price = EXCLUDED.image_pack_price,
    voice_pack_price = EXCLUDED.voice_pack_price,
    currency = EXCLUDED.currency,
    currency_symbol = EXCLUDED.currency_symbol,
    country_codes = EXCLUDED.country_codes;

-- 2. CLOUDFLARE R2 MEDIA ASSETS TABLE
CREATE TABLE IF NOT EXISTS public.media_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    character_id UUID,
    r2_bucket TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    media_type TEXT NOT NULL, -- e.g. 'image', 'video', 'portrait', 'voice', 'user_upload'
    mime_type TEXT NOT NULL,
    size BIGINT DEFAULT 0,
    width INTEGER,
    height INTEGER,
    duration NUMERIC(10,2),
    visibility TEXT DEFAULT 'private', -- 'public', 'private', 'unlisted'
    moderation_status TEXT DEFAULT 'approved', -- 'pending', 'approved', 'rejected'
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_media_assets_owner ON public.media_assets(owner_id);
CREATE INDEX IF NOT EXISTS idx_media_assets_character ON public.media_assets(character_id);

-- 3. PROFILES & USER PREFERENCES
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name TEXT,
    avatar_url TEXT,
    declared_age INTEGER,
    age_verified BOOLEAN DEFAULT false,
    gender TEXT,
    country TEXT DEFAULT 'US',
    timezone TEXT DEFAULT 'UTC',
    language TEXT DEFAULT 'en',
    bio TEXT,
    onboarding_state TEXT DEFAULT 'started',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    last_active_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_preferences (
    user_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    gender_interest TEXT,
    age_interest TEXT, -- 'adult_young' (18+), 'adult_mature'
    art_style TEXT,
    relationship_interests TEXT[],
    archetypes TEXT[],
    personality_preferences TEXT[],
    onboarding_completed BOOLEAN DEFAULT false,
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 4. CHARACTERS SYSTEM
CREATE TABLE IF NOT EXISTS public.characters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    username TEXT UNIQUE NOT NULL,
    description TEXT,
    bio TEXT,
    gender TEXT,
    age_category TEXT DEFAULT 'adult_young',
    art_style TEXT DEFAULT 'realistic',
    avatar_media_id UUID REFERENCES public.media_assets(id) ON DELETE SET NULL,
    portrait_media_id UUID REFERENCES public.media_assets(id) ON DELETE SET NULL,
    personality_definition JSONB DEFAULT '{}'::jsonb,
    relationship_definition JSONB DEFAULT '{}'::jsonb,
    conversation_definition JSONB DEFAULT '{}'::jsonb,
    voice_id TEXT,
    visibility TEXT DEFAULT 'public', -- 'public', 'unlisted', 'private'
    status TEXT DEFAULT 'active',
    is_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.saved_characters (
    user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
    character_id UUID REFERENCES public.characters(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, character_id)
);

-- 5. CONVERSATIONS & MESSAGES
CREATE TABLE IF NOT EXISTS public.conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
    character_id UUID REFERENCES public.characters(id) ON DELETE CASCADE NOT NULL,
    title TEXT,
    status TEXT DEFAULT 'active',
    last_message_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, character_id)
);

CREATE TABLE IF NOT EXISTS public.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES public.conversations(id) ON DELETE CASCADE NOT NULL,
    sender_type TEXT NOT NULL, -- 'user', 'character', 'system'
    sender_id UUID NOT NULL,
    message_type TEXT DEFAULT 'text', -- 'text', 'image', 'video', 'voice', 'gift'
    content TEXT NOT NULL,
    media_id UUID REFERENCES public.media_assets(id) ON DELETE SET NULL,
    reply_to_message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON public.messages(conversation_id, created_at DESC);

-- 6. LONG-TERM MEMORY (pgvector)
CREATE TABLE IF NOT EXISTS public.memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
    character_id UUID REFERENCES public.characters(id) ON DELETE CASCADE NOT NULL,
    conversation_id UUID REFERENCES public.conversations(id) ON DELETE CASCADE,
    memory_type TEXT NOT NULL, -- 'fact', 'preference', 'event', 'relationship', 'promise'
    content TEXT NOT NULL,
    importance NUMERIC(3,2) DEFAULT 0.50,
    confidence NUMERIC(3,2) DEFAULT 0.90,
    embedding vector(768), -- Gemini Embedding dimension
    created_at TIMESTAMPTZ DEFAULT now(),
    last_accessed_at TIMESTAMPTZ DEFAULT now(),
    expires_at TIMESTAMPTZ,
    status TEXT DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_memories_user_character ON public.memories(user_id, character_id);

-- 7. CHARACTER RELATIONSHIPS STATE
CREATE TABLE IF NOT EXISTS public.character_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
    character_id UUID REFERENCES public.characters(id) ON DELETE CASCADE NOT NULL,
    relationship_level INTEGER DEFAULT 1,
    affection NUMERIC(5,2) DEFAULT 10.00,
    trust NUMERIC(5,2) DEFAULT 10.00,
    familiarity NUMERIC(5,2) DEFAULT 5.00,
    intimacy NUMERIC(5,2) DEFAULT 0.00,
    current_mood TEXT DEFAULT 'happy',
    relationship_stage TEXT DEFAULT 'acquaintance',
    last_interaction_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, character_id)
);

-- 8. WALLETS & TRANSACTIONS
CREATE TABLE IF NOT EXISTS public.wallets (
    user_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    credits NUMERIC(12, 2) DEFAULT 100.00,
    bonus_credits NUMERIC(12, 2) DEFAULT 0.00,
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.wallet_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
    type TEXT NOT NULL, -- 'purchase', 'reward', 'image_generation', 'gift', 'refund'
    amount NUMERIC(12, 2) NOT NULL,
    balance_after NUMERIC(12, 2) NOT NULL,
    reference_type TEXT,
    reference_id TEXT,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 9. PLANS & SUBSCRIPTIONS
CREATE TABLE IF NOT EXISTS public.subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
    plan_type TEXT DEFAULT 'free', -- 'free', 'plus', 'premium'
    status TEXT DEFAULT 'active', -- 'active', 'past_due', 'cancelled', 'expired'
    region TEXT DEFAULT 'US',
    current_period_start TIMESTAMPTZ DEFAULT now(),
    current_period_end TIMESTAMPTZ DEFAULT (now() + interval '30 days'),
    cancel_at_period_end BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 10. ANALYTICS & EVENTS
CREATE TABLE IF NOT EXISTS public.analytics_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    event_name TEXT NOT NULL,
    payload JSONB DEFAULT '{}'::jsonb,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- RLS POLICIES ENABLEMENT
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- Public Read for Public Pricing Regions & Public Characters
CREATE POLICY pricing_regions_public_read ON public.pricing_regions FOR SELECT USING (true);
CREATE POLICY characters_public_read ON public.characters FOR SELECT USING (visibility = 'public' OR auth.uid() = creator_user_id);
