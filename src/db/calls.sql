-- ==========================================
-- AI voice calls + post-call feedback tables
-- Records Gemini Live voice calls and the
-- user's post-call rating / issues / comment.
-- ==========================================

CREATE TABLE IF NOT EXISTS public.calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
    character_id UUID REFERENCES public.characters(id) ON DELETE CASCADE NOT NULL,
    conversation_id UUID,
    model TEXT,
    started_at TIMESTAMPTZ DEFAULT now(),
    ended_at TIMESTAMPTZ,
    duration_seconds INTEGER DEFAULT 0,
    turns INTEGER DEFAULT 0,
    interruptions INTEGER DEFAULT 0,
    avg_response_latency_ms INTEGER DEFAULT 0,
    user_stt_failures INTEGER DEFAULT 0,
    ai_response_failures INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calls_user ON public.calls(user_id, started_at DESC);

ALTER TABLE public.calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY calls_user_select ON public.calls
    FOR SELECT USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.call_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id UUID REFERENCES public.calls(id) ON DELETE CASCADE,
    user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
    character_id UUID,
    rating INTEGER,
    rating_label TEXT,
    issues TEXT[],
    comment TEXT,
    duration_seconds INTEGER DEFAULT 0,
    turns INTEGER DEFAULT 0,
    interruptions INTEGER DEFAULT 0,
    avg_response_latency_ms INTEGER DEFAULT 0,
    user_stt_failures INTEGER DEFAULT 0,
    ai_response_failures INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_call_feedback_user ON public.call_feedback(user_id, created_at DESC);

ALTER TABLE public.call_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY call_feedback_user_insert ON public.call_feedback
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY call_feedback_user_select ON public.call_feedback
    FOR SELECT USING (auth.uid() = user_id);
