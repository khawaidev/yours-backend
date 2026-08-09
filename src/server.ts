import express from 'express';
import cors from 'cors';
import { CONFIG } from './config';

import pricingRouter from './routes/pricing';
import mediaRouter from './routes/media';
import authRouter from './routes/auth';
import charactersRouter from './routes/characters';
import conversationsRouter from './routes/conversations';
import memoriesRouter from './routes/memories';
import relationshipsRouter from './routes/relationships';
import walletRouter from './routes/wallet';
import analyticsRouter from './routes/analytics';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/api/v1/health', (req, res) => {
  return res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    env: CONFIG.NODE_ENV,
    supabaseConfigured: !!CONFIG.SUPABASE_URL,
    r2Configured: !!CONFIG.R2.ACCOUNT_ID,
  });
});

// API v1 Router mounts
app.use('/api/v1/pricing', pricingRouter);
app.use('/api/v1/media', mediaRouter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/characters', charactersRouter);
app.use('/api/v1/conversations', conversationsRouter);
app.use('/api/v1/memories', memoriesRouter);
app.use('/api/v1/relationships', relationshipsRouter);
app.use('/api/v1/wallet', walletRouter);
app.use('/api/v1/analytics', analyticsRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// Global error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
});

app.listen(CONFIG.PORT, CONFIG.HOST, () => {
  console.log(`🚀 Yours Backend Server running on http://${CONFIG.HOST}:${CONFIG.PORT}`);
});

if (CONFIG.PORT !== 3000) {
  app.listen(3000, CONFIG.HOST, () => {
    console.log(`🚀 Yours Backend Server also running on http://${CONFIG.HOST}:3000`);
  });
}

export default app;
