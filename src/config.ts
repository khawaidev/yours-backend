import dotenv from 'dotenv';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { S3Client } from '@aws-sdk/client-s3';

// Load backend/.env and root .env files
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config(); // fallback

// Extract R2 Account ID and Bucket Name from BUCKET_ENDPOINT if provided
let extractedAccountId = process.env.R2_ACCOUNT_ID || '';
let extractedBucketName = process.env.R2_BUCKET_NAME || 'yours';

if (process.env.BUCKET_ENDPOINT) {
  try {
    const url = new URL(process.env.BUCKET_ENDPOINT);
    extractedAccountId = url.hostname.split('.')[0] || extractedAccountId;
    const pathParts = url.pathname.split('/').filter(Boolean);
    if (pathParts.length > 0) extractedBucketName = pathParts[0];
  } catch {}
}

export const CONFIG = {
  PORT: parseInt(process.env.PORT || '5000', 10),
  HOST: process.env.HOST || '0.0.0.0',
  NODE_ENV: process.env.NODE_ENV || 'development',
  SUPABASE_URL: process.env.SUPABASE_URL || 'https://dgbxcakkqrgrapwsvrol.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
  R2: {
    ACCOUNT_ID: extractedAccountId,
    ACCESS_KEY_ID: process.env.ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || '',
    SECRET_ACCESS_KEY: process.env.SECRET_KEY_ID || process.env.R2_SECRET_ACCESS_KEY || '',
    BUCKET_NAME: extractedBucketName,
    PUBLIC_DOMAIN: process.env.R2_PUBLIC_DOMAIN || 'https://pub-475cca0b7414418d866128a4b30dfd97.r2.dev',
    BUCKET_ENDPOINT: process.env.BUCKET_ENDPOINT || '',
  },
};

// Initialize Supabase Admin Client
export const supabaseAdmin = createClient(
  CONFIG.SUPABASE_URL,
  CONFIG.SUPABASE_SERVICE_ROLE_KEY || CONFIG.SUPABASE_ANON_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

// Initialize Cloudflare R2 Client (S3 Compatible)
export const r2Client = new S3Client({
  region: 'auto',
  endpoint: CONFIG.R2.ACCOUNT_ID
    ? `https://${CONFIG.R2.ACCOUNT_ID}.r2.cloudflarestorage.com`
    : undefined,
  credentials: {
    accessKeyId: CONFIG.R2.ACCESS_KEY_ID || 'mock',
    secretAccessKey: CONFIG.R2.SECRET_ACCESS_KEY || 'mock',
  },
});

// Collect Gemini API key pool from environment variables
export const getGeminiKeyPool = (): string[] => {
  const keys: string[] = [];
  if (process.env.GEMINI_API_KEY) keys.push(process.env.GEMINI_API_KEY);
  for (let i = 1; i <= 50; i++) {
    const key = process.env[`GEMINI_API_KEY${i}`];
    if (key) keys.push(key);
  }
  return keys;
};
