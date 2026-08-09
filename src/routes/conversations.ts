import { Router } from 'express';
import { supabaseAdmin } from '../config';
import { RelationshipService } from '../services/relationshipService';
import { MemoryService } from '../services/memoryService';
import { AIRouterService } from '../services/aiRouterService';

const router = Router();

/**
 * GET /api/v1/conversations
 * Fetch active conversations for user
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) return res.status(400).json({ success: false, error: 'userId required' });

    const { data: conversations, error } = await supabaseAdmin
      .from('conversations')
      .select('*, character:characters(*)')
      .eq('user_id', userId)
      .order('last_message_at', { ascending: false });

    if (error) throw new Error(error.message);
    return res.json({ success: true, conversations });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/v1/conversations
 * Get or create conversation with character
 */
router.post('/', async (req, res) => {
  try {
    const { userId, characterId } = req.body;
    if (!userId || !characterId) {
      return res.status(400).json({ success: false, error: 'userId and characterId required' });
    }

    const { data: existing } = await supabaseAdmin
      .from('conversations')
      .select('*, character:characters(*)')
      .eq('user_id', userId)
      .eq('character_id', characterId)
      .maybeSingle();

    if (existing) return res.json({ success: true, conversation: existing });

    const { data: conversation, error } = await supabaseAdmin
      .from('conversations')
      .insert({ user_id: userId, character_id: characterId })
      .select('*, character:characters(*)')
      .single();

    if (error) throw new Error(error.message);
    return res.status(201).json({ success: true, conversation });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/v1/conversations/:id/messages
 * List recent messages in conversation
 */
router.get('/:id/messages', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 30;
    const { data: messages, error } = await supabaseAdmin
      .from('messages')
      .select('*')
      .eq('conversation_id', req.params.id)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) throw new Error(error.message);
    return res.json({ success: true, messages });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/v1/conversations/:id/messages
 * Send message and receive AI companion response
 */
router.post('/:id/messages', async (req, res) => {
  try {
    const conversationId = req.params.id;
    const { userId, characterId, content } = req.body;

    if (!userId || !characterId || !content) {
      return res.status(400).json({ success: false, error: 'userId, characterId, content required' });
    }

    // 1. Fetch character details
    const { data: character } = await supabaseAdmin
      .from('characters')
      .select('*')
      .eq('id', characterId)
      .single();

    if (!character) return res.status(404).json({ success: false, error: 'Character not found' });

    // 2. Save user message
    const { data: userMsg, error: userMsgErr } = await supabaseAdmin
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_type: 'user',
        sender_id: userId,
        message_type: 'text',
        content,
      })
      .select()
      .single();

    if (userMsgErr) throw new Error(userMsgErr.message);

    // 3. Fetch Relationship state & Memories
    const relationship = await RelationshipService.getRelationship(userId, characterId);
    const memories = await MemoryService.getRelevantMemories(userId, characterId, content, 5);

    // 4. Fetch recent chat history
    const { data: history } = await supabaseAdmin
      .from('messages')
      .select('sender_type, content')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(10);

    const historyMessages = (history || [])
      .reverse()
      .map((m) => ({
        role: (m.sender_type === 'user' ? 'user' : 'model') as 'user' | 'model',
        content: m.content,
      }));

    // 5. Construct prompt & run AI Router inference
    const systemPrompt = AIRouterService.buildSystemPrompt(character, relationship, memories);
    const aiResult = await AIRouterService.generateChatResponse(systemPrompt, historyMessages, content);

    // 6. Save AI character response message
    const { data: aiMsg, error: aiMsgErr } = await supabaseAdmin
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_type: 'character',
        sender_id: characterId,
        message_type: 'text',
        content: aiResult.responseText,
      })
      .select()
      .single();

    if (aiMsgErr) throw new Error(aiMsgErr.message);

    // 7. Update conversation timestamp
    await supabaseAdmin
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversationId);

    // 8. Background updates: relationship metrics & long-term memory extraction
    RelationshipService.updateRelationship(userId, characterId, {
      affection: aiResult.affectionDelta || 0.3,
      familiarity: 0.2,
      mood: aiResult.moodDelta || 'happy',
    }).catch(() => {});

    MemoryService.extractMemoriesFromConversation(userId, characterId, content, aiResult.responseText).catch(() => {});

    return res.status(201).json({
      success: true,
      userMessage: userMsg,
      aiMessage: aiMsg,
      relationshipState: relationship,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
