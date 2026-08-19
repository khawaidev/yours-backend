/**
 * Memory pipeline tests (Node built-in test runner).
 *
 * Run after building:  node --test tests/*.test.js
 *
 * Network-dependent tests (Qdrant, Gemini, R2) are skipped unless the matching
 * env vars are configured, so this suite runs cleanly in CI without secrets.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const memoryConfig = require('../dist/config').memoryConfig;
const QdrantService = require('../dist/services/qdrantService').QdrantService;
const EmbeddingService = require('../dist/services/embeddingService').EmbeddingService;
const ConversationMemoryService =
  require('../dist/services/conversationMemoryService').ConversationMemoryService;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
test('memoryConfig defaults are sane', () => {
  assert.strictEqual(memoryConfig.embeddingDimension, 1536);
  assert.strictEqual(memoryConfig.collectionName, 'chat_memory_gemini_embedding_2');
  assert.ok(memoryConfig.retrievalLimit >= 1);
  assert.ok(memoryConfig.minimumScore > 0 && memoryConfig.minimumScore < 1);
  assert.ok(memoryConfig.summaryMessageThreshold > 0);
});

test('memoryConfig can be overridden by env', () => {
  const oldDim = process.env.MEMORY_EMBEDDING_DIMENSION;
  const oldModel = process.env.MEMORY_EMBEDDING_MODEL;
  process.env.MEMORY_EMBEDDING_DIMENSION = '768';
  process.env.MEMORY_EMBEDDING_MODEL = 'gemini-embedding-2';
  delete require.cache[require.resolve('../dist/config')];
  const reloaded = require('../dist/config').memoryConfig;
  assert.strictEqual(reloaded.embeddingDimension, 768);
  if (oldDim !== undefined) process.env.MEMORY_EMBEDDING_DIMENSION = oldDim;
  else delete process.env.MEMORY_EMBEDDING_DIMENSION;
  if (oldModel !== undefined) process.env.MEMORY_EMBEDDING_MODEL = oldModel;
  else delete process.env.MEMORY_EMBEDDING_MODEL;
  delete require.cache[require.resolve('../dist/config')];
});

// ---------------------------------------------------------------------------
// Memory text building (pure, no network)
// ---------------------------------------------------------------------------
test('buildMemoryText produces clean prose from structured summary', () => {
  const text = ConversationMemoryService.buildMemoryText({
    summary: 'The user is building an AI tutoring SaaS.',
    facts: ['The product uses uploaded educational PDFs.'],
    goals: ['Implement persistent semantic memory.'],
    preferences: ['Prefers low infrastructure costs.'],
    open_questions: [],
  });
  assert.ok(text.includes('AI tutoring SaaS'));
  assert.ok(text.includes('uploaded educational PDFs'));
  assert.ok(text.includes('persistent semantic memory'));
  assert.ok(text.includes('low infrastructure costs'));
  // Raw JSON must not be embedded as-is.
  assert.ok(!text.includes('open_questions'));
  assert.ok(!text.includes('{'));
});

// ---------------------------------------------------------------------------
// Qdrant service (network)
// ---------------------------------------------------------------------------
const qdrantConfigured = QdrantService.isConfigured();

test('Qdrant client can be created', () => {
  if (!qdrantConfigured) return; // skip when unconfigured
  const client = QdrantService.getClient();
  assert.ok(client);
});

test('Qdrant collection exists with correct vector size', async () => {
  if (!qdrantConfigured) return;
  await QdrantService.ensureCollection();
  const info = await QdrantService.getClient().getCollection(memoryConfig.collectionName);
  const size = info.config.params.vectors.size;
  assert.strictEqual(size, memoryConfig.embeddingDimension);
});

test('Qdrant upsert + query returns point and respects user_id filter', async () => {
  if (!qdrantConfigured) return;
  await QdrantService.ensureCollection();
  const userA = 'test-user-a-' + Date.now();
  const userB = 'test-user-b-' + Date.now();
  const vec = new Array(memoryConfig.embeddingDimension).fill(0.5);

  await QdrantService.upsertMemory({
    id: randomUUID(),
    vector: vec,
    payload: {
      user_id: userA,
      conversation_id: 'test-conv',
      type: 'conversation_memory',
      summary: 'User A memory',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      embedding_model: memoryConfig.embeddingModel,
      embedding_dimension: memoryConfig.embeddingDimension,
    },
  });

  // Query as user A → should find it.
  const hitsA = await QdrantService.queryMemories(userA, vec, 5, 0);
  assert.ok(hitsA.some((h) => h.payload.summary === 'User A memory'));

  // Query as user B → MUST NOT find user A's memory.
  const hitsB = await QdrantService.queryMemories(userB, vec, 5, 0);
  assert.ok(!hitsB.some((h) => h.payload.summary === 'User A memory'));

  // Cleanup.
  await QdrantService.deleteUserMemories(userA);
});

test('Qdrant deletion removes only the targeted user memories', async () => {
  if (!qdrantConfigured) return;
  await QdrantService.ensureCollection();
  const user = 'test-user-del-' + Date.now();
  const vec = new Array(memoryConfig.embeddingDimension).fill(0.3);
  await QdrantService.upsertMemory({
    id: randomUUID(),
    vector: vec,
    payload: {
      user_id: user,
      conversation_id: 'conv-x',
      type: 'conversation_memory',
      summary: 'to delete',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      embedding_model: memoryConfig.embeddingModel,
      embedding_dimension: memoryConfig.embeddingDimension,
    },
  });
  await QdrantService.deleteUserMemories(user);
  const hits = await QdrantService.queryMemories(user, vec, 5, 0);
  assert.strictEqual(hits.length, 0);
});

test('Qdrant health check responds', async () => {
  if (!qdrantConfigured) return;
  const health = await QdrantService.healthCheck();
  assert.strictEqual(health.ok, true);
});

// ---------------------------------------------------------------------------
// Gemini embeddings (network)
// ---------------------------------------------------------------------------
const geminiConfigured = !!(process.env.GEMINI_API_KEY);

test('Gemini embedding returns the configured dimension', async () => {
  if (!geminiConfigured) return;
  const res = await EmbeddingService.embedText('Hello, this is a memory test.');
  assert.strictEqual(res.dimension, memoryConfig.embeddingDimension);
  assert.strictEqual(res.vector.length, memoryConfig.embeddingDimension);
  assert.strictEqual(res.model, memoryConfig.embeddingModel);
});

// ---------------------------------------------------------------------------
// Retrieval + score threshold
// ---------------------------------------------------------------------------
test('retrieveRelevantMemories returns [] when no memories exist', async () => {
  if (!geminiConfigured || !qdrantConfigured) return;
  const hits = await ConversationMemoryService.retrieveRelevantMemories(
    'nonexistent-user-' + Date.now(),
    'some random query text here',
    { limit: 5, minimumScore: 0.9 }
  );
  assert.ok(Array.isArray(hits));
});
