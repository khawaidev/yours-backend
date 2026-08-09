import { Router } from 'express';
import { supabaseAdmin } from '../config';

const router = Router();

/**
 * POST /api/v1/analytics/events
 * Record product telemetry event
 */
router.post('/events', async (req, res) => {
  try {
    const { userId, eventName, payload } = req.body;
    if (!eventName) return res.status(400).json({ success: false, error: 'eventName required' });

    const ipAddress = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || null;
    const userAgent = req.headers['user-agent'] || null;

    const { data: event, error } = await supabaseAdmin
      .from('analytics_events')
      .insert({
        user_id: userId || null,
        event_name: eventName,
        payload: payload || {},
        ip_address: ipAddress,
        user_agent: userAgent,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return res.status(201).json({ success: true, event });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
