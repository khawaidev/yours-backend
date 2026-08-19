"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const config_1 = require("../config");
const auth_1 = require("../middleware/auth");
const telegramService_1 = require("../services/telegramService");
const router = (0, express_1.Router)();
function formatDuration(totalSeconds) {
    totalSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0)
        return `${h}h ${m}m`;
    if (m > 0)
        return `${m}m ${s}s`;
    return `${s}s`;
}
const RATING_SCALE = { excellent: 5, okay: 3, could_be_better: 1 };
const RATING_LABEL = { excellent: 'Excellent', okay: 'Okay', could_be_better: 'Could be better' };
const ISSUE_ICONS = {
    voice: '🎙️',
    speed: '⚡',
    smarter: '🧠',
    understanding: '👂',
};
function issueIcon(key) {
    return ISSUE_ICONS[key] || '•';
}
/**
 * POST /api/v1/calls
 * Begin a voice call: create the call record, return its id.
 */
router.post('/', auth_1.requireAuth, async (req, res) => {
    try {
        const { userId, characterId, conversationId } = req.body || {};
        if (!userId || !characterId) {
            return res.status(400).json({ success: false, error: 'userId and characterId required' });
        }
        if (!(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const { data: call, error } = await config_1.supabaseAdmin
            .from('calls')
            .insert({
            user_id: userId,
            character_id: characterId,
            conversation_id: conversationId || null,
            model: process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview',
        })
            .select()
            .single();
        if (error)
            throw new Error(error.message);
        return res.status(201).json({ success: true, callId: call.id, call });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * POST /api/v1/calls/:id/end
 * Finish a call: record metrics and drop a "Call ended (time)" character
 * message into the conversation so it shows as a bubble in messaging.
 */
router.post('/:id/end', auth_1.requireAuth, async (req, res) => {
    try {
        const callId = req.params.id;
        const { userId, metrics } = req.body || {};
        if (!userId || !(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const metricsObj = metrics || {};
        const durationSeconds = Math.max(0, Math.floor(Number(metricsObj.durationSeconds) || 0));
        const turns = Math.max(0, Math.floor(Number(metricsObj.turns) || 0));
        const interruptions = Math.max(0, Math.floor(Number(metricsObj.interruptions) || 0));
        const avgLatency = Math.max(0, Math.floor(Number(metricsObj.avgResponseLatencyMs) || 0));
        const sttFailures = Math.max(0, Math.floor(Number(metricsObj.userSttFailures) || 0));
        const aiFailures = Math.max(0, Math.floor(Number(metricsObj.aiResponseFailures) || 0));
        const { data: existing } = await config_1.supabaseAdmin
            .from('calls')
            .select('*')
            .eq('id', callId)
            .eq('user_id', userId)
            .maybeSingle();
        if (!existing) {
            return res.status(404).json({ success: false, error: 'Call not found' });
        }
        const characterId = existing.character_id;
        const conversationId = existing.conversation_id;
        await config_1.supabaseAdmin
            .from('calls')
            .update({
            ended_at: new Date().toISOString(),
            duration_seconds: durationSeconds,
            turns,
            interruptions,
            avg_response_latency_ms: avgLatency,
            user_stt_failures: sttFailures,
            ai_response_failures: aiFailures,
        })
            .eq('id', callId);
        let insertedMessage = null;
        if (conversationId) {
            const durationText = formatDuration(durationSeconds);
            const { data: msg, error: msgErr } = await config_1.supabaseAdmin
                .from('messages')
                .insert({
                conversation_id: conversationId,
                sender_type: 'character',
                sender_id: characterId,
                message_type: 'text',
                content: `Call ended (${durationText})`,
            })
                .select()
                .single();
            if (msgErr) {
                console.warn('[calls] insert call-ended message failed:', msgErr.message);
            }
            else {
                insertedMessage = msg;
                await config_1.supabaseAdmin
                    .from('conversations')
                    .update({ last_message_at: new Date().toISOString() })
                    .eq('id', conversationId);
            }
        }
        return res.json({
            success: true,
            durationSeconds,
            durationText: formatDuration(durationSeconds),
            message: insertedMessage,
        });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
/**
 * POST /api/v1/calls/:id/feedback
 * Save the post-call rating / issues / comment and notify the Telegram bot.
 */
router.post('/:id/feedback', auth_1.requireAuth, async (req, res) => {
    try {
        const callId = req.params.id;
        const { userId, rating, issues, comment } = req.body || {};
        if (!userId || !(0, auth_1.requireOwnership)(req, res, userId))
            return;
        const ratingKey = String(rating || '').toLowerCase().replace(/\s+/g, '_');
        const ratingVal = RATING_SCALE[ratingKey] != null ? RATING_SCALE[ratingKey] : null;
        const { data: existing } = await config_1.supabaseAdmin
            .from('calls')
            .select('*')
            .eq('id', callId)
            .eq('user_id', userId)
            .maybeSingle();
        if (!existing) {
            return res.status(404).json({ success: false, error: 'Call not found' });
        }
        const issueList = Array.isArray(issues) ? issues.filter(Boolean).slice(0, 20) : [];
        const { data: fb, error: fbErr } = await config_1.supabaseAdmin
            .from('call_feedback')
            .insert({
            call_id: callId,
            user_id: userId,
            character_id: existing.character_id,
            rating: ratingVal,
            rating_label: RATING_LABEL[ratingKey] || null,
            issues: issueList,
            comment: (comment || '').trim() || null,
            duration_seconds: existing.duration_seconds || 0,
            turns: existing.turns || 0,
            interruptions: existing.interruptions || 0,
            avg_response_latency_ms: existing.avg_response_latency_ms || 0,
            user_stt_failures: existing.user_stt_failures || 0,
            ai_response_failures: existing.ai_response_failures || 0,
        })
            .select()
            .single();
        if (fbErr)
            throw new Error(fbErr.message);
        // Notify the developer's Telegram bot.
        const durationText = formatDuration(existing.duration_seconds || 0);
        const ratingDisplay = ratingVal != null ? `${ratingVal}/5` : 'n/a';
        const issuesText = issueList.length
            ? issueList.map((i) => `  ${issueIcon(i)} ${String(i).replace(/_/g, ' ')}`).join('\n')
            : '  None reported';
        const commentText = (comment || '').trim() ? `"${String(comment).trim().slice(0, 500)}"` : '—';
        const avgLatencyS = ((existing.avg_response_latency_ms || 0) / 1000).toFixed(1);
        const telegramText = [
            '📞 Call Feedback',
            '',
            `⭐ Rating: ${ratingDisplay}`,
            '',
            'Issues:',
            issuesText,
            '',
            '📊 Call metrics:',
            `Duration: ${durationText}`,
            `Turns: ${existing.turns || 0}`,
            `Interruptions: ${existing.interruptions || 0}`,
            `Avg response latency: ${avgLatencyS}s`,
            `User speech recognition failures: ${existing.user_stt_failures || 0}`,
            `AI response failures: ${existing.ai_response_failures || 0}`,
            '',
            '💬 User comment:',
            commentText,
            '',
            `Call ID: ${String(callId).slice(0, 8)}...`,
        ].join('\n');
        telegramService_1.TelegramService.sendMessage(telegramText).catch(() => { });
        return res.status(201).json({ success: true, feedback: fb });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
module.exports = router;
