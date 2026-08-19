"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.memoryConfig = exports.getDeAPiKeyPool = exports.getGeminiKeyPool = exports.r2Client = exports.supabaseAdmin = exports.CONFIG = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
const supabase_js_1 = require("@supabase/supabase-js");
const client_s3_1 = require("@aws-sdk/client-s3");
// Load backend/.env and root .env files
dotenv_1.default.config({ path: path_1.default.resolve(__dirname, '../.env') });
dotenv_1.default.config({ path: path_1.default.resolve(__dirname, '../../.env') });
dotenv_1.default.config(); // fallback
// Extract R2 Account ID and Bucket Name from BUCKET_ENDPOINT if provided
let extractedAccountId = process.env.R2_ACCOUNT_ID || '';
let extractedBucketName = process.env.R2_BUCKET_NAME || 'yours';
if (process.env.BUCKET_ENDPOINT) {
    try {
        const url = new URL(process.env.BUCKET_ENDPOINT);
        extractedAccountId = url.hostname.split('.')[0] || extractedAccountId;
        const pathParts = url.pathname.split('/').filter(Boolean);
        if (pathParts.length > 0)
            extractedBucketName = pathParts[0];
    }
    catch { }
}
exports.CONFIG = {
    PORT: parseInt(process.env.PORT || '5000', 10),
    HOST: process.env.HOST || '0.0.0.0',
    NODE_ENV: process.env.NODE_ENV || 'development',
    SUPABASE_URL: process.env.SUPABASE_URL || 'https://dgbxcakkqrgrapwsvrol.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
    // Qdrant vector store. Supports both the canonical names (QDRANT_URL /
    // QDRANT_API_KEY) and the pre-existing names used in this project's .env
    // (QRANT_ENDPOINT / QDRANT_API).
    QDRANT_URL: process.env.QDRANT_URL || process.env.QRANT_ENDPOINT || '',
    QDRANT_API_KEY: process.env.QDRANT_API_KEY || process.env.QDRANT_API || '',
    R2: {
        ACCOUNT_ID: extractedAccountId,
        ACCESS_KEY_ID: process.env.ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || '',
        SECRET_ACCESS_KEY: process.env.SECRET_KEY_ID || process.env.R2_SECRET_ACCESS_KEY || '',
        BUCKET_NAME: extractedBucketName,
        PUBLIC_DOMAIN: process.env.R2_PUBLIC_DOMAIN || 'https://pub-475cca0b7414418d866128a4b30dfd97.r2.dev',
        BUCKET_ENDPOINT: process.env.BUCKET_ENDPOINT || '',
    },
    // Razorpay payment gateway. RAZORPAY_LIVE holds the key_id and
    // RAZORPAY_SECRET holds the key_secret (as configured in the .env file).
    RAZORPAY: {
        KEY_ID: process.env.RAZORPAY_LIVE || process.env.RAZORPAY_KEY_ID || '',
        KEY_SECRET: process.env.RAZORPAY_SECRET || '',
    },
};
// Initialize Supabase Admin Client
exports.supabaseAdmin = (0, supabase_js_1.createClient)(exports.CONFIG.SUPABASE_URL, exports.CONFIG.SUPABASE_SERVICE_ROLE_KEY || exports.CONFIG.SUPABASE_ANON_KEY, {
    auth: {
        autoRefreshToken: false,
        persistSession: false,
    },
});
// Initialize Cloudflare R2 Client (S3 Compatible)
exports.r2Client = new client_s3_1.S3Client({
    region: 'auto',
    endpoint: exports.CONFIG.R2.ACCOUNT_ID
        ? `https://${exports.CONFIG.R2.ACCOUNT_ID}.r2.cloudflarestorage.com`
        : undefined,
    credentials: {
        accessKeyId: exports.CONFIG.R2.ACCESS_KEY_ID || 'mock',
        secretAccessKey: exports.CONFIG.R2.SECRET_ACCESS_KEY || 'mock',
    },
});
// Collect Gemini API key pool from environment variables
const getGeminiKeyPool = () => {
    const keys = [];
    if (process.env.GEMINI_API_KEY)
        keys.push(process.env.GEMINI_API_KEY);
    for (let i = 1; i <= 50; i++) {
        const key = process.env[`GEMINI_API_KEY${i}`];
        if (key)
            keys.push(key);
    }
    return keys;
};
exports.getGeminiKeyPool = getGeminiKeyPool;
// Collect DeAPI key pool (DEAPI_API_KEY + numbered variants)
const getDeAPiKeyPool = () => {
    const keys = [];
    if (process.env.DEAPI_API_KEY)
        keys.push(process.env.DEAPI_API_KEY);
    for (let i = 1; i <= 50; i++) {
        const key = process.env[`DEAPI_API_KEY${i}`];
        if (key)
            keys.push(key);
    }
    return keys;
};
exports.getDeAPiKeyPool = getDeAPiKeyPool;
// Semantic memory pipeline configuration.
// Vector dimension MUST exactly match the Qdrant collection's vector size.
exports.memoryConfig = {
    embeddingModel: process.env.MEMORY_EMBEDDING_MODEL ?? 'gemini-embedding-2',
    embeddingDimension: Number(process.env.MEMORY_EMBEDDING_DIMENSION ?? 1536),
    collectionName: process.env.QDRANT_COLLECTION ?? 'chat_memory_gemini_embedding_2',
    retrievalLimit: Number(process.env.MEMORY_RETRIEVAL_LIMIT ?? 5),
    minimumScore: Number(process.env.MEMORY_MINIMUM_SCORE ?? 0.65),
    summaryMessageThreshold: Number(process.env.MEMORY_SUMMARY_MESSAGE_THRESHOLD ?? 75),
    // R2 JSONL chunking
    r2ChunkSize: Number(process.env.CONVERSATION_R2_CHUNK_SIZE ?? 100),
};
