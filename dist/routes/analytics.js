"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const config_1 = require("../config");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
/**
 * POST /api/v1/analytics/events
 * Record product telemetry event (authenticated; only the user's own id).
 */
router.post('/events', auth_1.requireAuth, async (req, res) => {
    try {
        const { userId, eventName, payload } = req.body;
        if (!eventName)
            return res.status(400).json({ success: false, error: 'eventName required' });
        if (userId && !(0, auth_1.requireOwnership)(req, res, userId))
            return;
        // Keep arbitrary client payloads bounded so the events table can't be
        // flooded with oversized rows.
        let cleanPayload = {};
        if (payload && typeof payload === 'object') {
            try {
                const text = JSON.stringify(payload);
                if (text.length <= 4096)
                    cleanPayload = payload;
            }
            catch {
                cleanPayload = {};
            }
        }
        const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
        const userAgent = req.headers['user-agent'] || null;
        const { data: event, error } = await config_1.supabaseAdmin
            .from('analytics_events')
            .insert({
            user_id: userId || null,
            event_name: eventName,
            payload: cleanPayload,
            ip_address: ipAddress,
            user_agent: userAgent,
        })
            .select()
            .single();
        if (error)
            throw new Error(error.message);
        return res.status(201).json({ success: true, event });
    }
    catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});
exports.default = router;
