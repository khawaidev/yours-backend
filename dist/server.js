"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const http_1 = __importDefault(require("http"));
const url_1 = __importDefault(require("url"));
const ws_1 = __importDefault(require("ws"));
const config_1 = require("./config");
const qdrantService_1 = require("./services/qdrantService");
const geminiLiveService_1 = require("./services/geminiLiveService");
const calls_1 = __importDefault(require("./routes/calls"));
const pricing_1 = __importDefault(require("./routes/pricing"));
const media_1 = __importDefault(require("./routes/media"));
const auth_1 = __importDefault(require("./routes/auth"));
const characters_1 = __importDefault(require("./routes/characters"));
const conversations_1 = __importDefault(require("./routes/conversations"));
const memories_1 = __importDefault(require("./routes/memories"));
const relationships_1 = __importDefault(require("./routes/relationships"));
const wallet_1 = __importDefault(require("./routes/wallet"));
const payments_1 = __importDefault(require("./routes/payments"));
const analytics_1 = __importDefault(require("./routes/analytics"));
const rewards_1 = __importDefault(require("./routes/rewards"));
const gifts_1 = __importDefault(require("./routes/gifts"));
const app = (0, express_1.default)();
// Middleware
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
// Health check endpoint
app.get('/api/v1/health', (req, res) => {
    return res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        env: config_1.CONFIG.NODE_ENV,
        supabaseConfigured: !!config_1.CONFIG.SUPABASE_URL,
        r2Configured: !!config_1.CONFIG.R2.ACCOUNT_ID,
    });
});
// API v1 Router mounts
app.use('/api/v1/pricing', pricing_1.default);
app.use('/api/v1/media', media_1.default);
app.use('/api/v1/auth', auth_1.default);
app.use('/api/v1/characters', characters_1.default);
app.use('/api/v1/conversations', conversations_1.default);
app.use('/api/v1/memories', memories_1.default);
app.use('/api/v1/relationships', relationships_1.default);
app.use('/api/v1/wallet', wallet_1.default);
app.use('/api/v1/payments', payments_1.default);
app.use('/api/v1/analytics', analytics_1.default);
app.use('/api/v1/rewards', rewards_1.default);
app.use('/api/v1/gifts', gifts_1.default);
app.use('/api/v1/calls', calls_1.default);
// 404 handler
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint not found' });
});
// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled server error:', err);
    res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
});
const server = http_1.default.createServer(app);

/**
 * Live AI voice-call WebSocket proxy.
 * The browser connects to /api/v1/calls/live?token=...&characterId=...
 * and this server proxies raw frames to the Gemini Live API.
 */
const liveConnections = new Map();
const wss = new ws_1.default.Server({ server, path: '/api/v1/calls/live', maxPayload: 4 * 1024 * 1024 });
wss.on('connection', async (socket, req) => {
    const query = url_1.default.parse(req.url || '', true).query;
    const token = String(query.token || '');
    const characterId = String(query.characterId || '');
    if (!token) {
        socket.close(1008, 'token_required');
        return;
    }
    let userId = null;
    try {
        const { data, error } = await config_1.supabaseAdmin.auth.getUser(token);
        if (error || !data || !data.user) {
            socket.close(1008, 'invalid_token');
            return;
        }
        userId = data.user.id;
    }
    catch (err) {
        socket.close(1011, 'auth_failed');
        return;
    }
    let character = null;
    if (characterId) {
        const { data } = await config_1.supabaseAdmin
            .from('characters')
            .select('id,name,age,about,personality,message_style')
            .eq('id', characterId)
            .maybeSingle();
        character = data || null;
    }
    const handle = geminiLiveService_1.GeminiLiveService.connect(socket, { character, userId });
    liveConnections.set(socket, handle);
    socket.on('close', () => liveConnections.delete(socket));
    socket.on('error', () => liveConnections.delete(socket));
});

// Expose active live connections for other services (metrics / health checks).
const getLiveConnectionCount = () => liveConnections.size;

server.listen(config_1.CONFIG.PORT, config_1.CONFIG.HOST, () => {
    console.log(`🚀 Yours Backend Server running on http://${config_1.CONFIG.HOST}:${config_1.CONFIG.PORT}`);
});
if (config_1.CONFIG.PORT !== 3000) {
    app.listen(3000, config_1.CONFIG.HOST, () => {
        console.log(`🚀 Yours Backend Server also running on http://${config_1.CONFIG.HOST}:3000`);
    });
}
// Ensure the Qdrant memory collection exists before serving traffic.
// A missing/invalid Qdrant config must not block the server from starting;
// semantic memory features will simply be unavailable until Qdrant is healthy.
if (qdrantService_1.QdrantService.isConfigured()) {
    qdrantService_1.QdrantService.ensureCollection()
        .then(() => console.log(`🚀 Qdrant collection "${config_1.CONFIG.QDRANT_URL ? 'ready' : ''}" ready`))
        .catch((err) => {
        console.error('⚠️ Qdrant collection initialization failed:', err?.message);
    });
}
else {
    console.warn('⚠️ Qdrant not configured — semantic long-term memory disabled.');
}
exports.default = app;
