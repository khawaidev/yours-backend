import { GoogleGenerativeAI } from '@google/generative-ai';
import { supabaseAdmin, getGeminiKeyPool } from '../config';

export interface MemoryRecord {
  id: string;
  user_id: string;
  character_id: string;
  memory_type: 'fact' | 'preference' | 'event' | 'relationship' | 'promise';
  content: string;
  importance: number;
  confidence: number;
  created_at: string;
}

export class MemoryService {
  /**
   * Retrieve relevant memories for context assembly
   */
  static async getRelevantMemories(userId: string, characterId: string, queryText: string, limit = 5): Promise<MemoryRecord[]> {
    try {
      // First attempt vector similarity search via Supabase RPC if configured
      const { data: vectorMemories } = await supabaseAdmin.rpc('match_memories', {
        query_text: queryText,
        match_user_id: userId,
        match_character_id: characterId,
        match_threshold: 0.5,
        match_count: limit,
      });

      if (vectorMemories && vectorMemories.length > 0) {
        return vectorMemories;
      }
    } catch {
      // fallback to recent high-importance memories
    }

    const { data } = await supabaseAdmin
      .from('memories')
      .select('*')
      .eq('user_id', userId)
      .eq('character_id', characterId)
      .eq('status', 'active')
      .order('importance', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit);

    return data || [];
  }

  /**
   * Save a newly extracted memory
   */
  static async saveMemory(
    userId: string,
    characterId: string,
    memoryType: 'fact' | 'preference' | 'event' | 'relationship' | 'promise',
    content: string,
    importance = 0.5
  ) {
    const { data, error } = await supabaseAdmin
      .from('memories')
      .insert({
        user_id: userId,
        character_id: characterId,
        memory_type: memoryType,
        content,
        importance,
        confidence: 0.9,
        status: 'active',
      })
      .select()
      .single();

    if (error) throw new Error(`Save memory error: ${error.message}`);
    return data;
  }

  /**
   * Extract potential long-term memories from recent conversation
   */
  static async extractMemoriesFromConversation(userId: string, characterId: string, userMessage: string, aiResponse: string) {
    const keys = getGeminiKeyPool();
    if (keys.length === 0) return;

    try {
      const ai = new GoogleGenerativeAI(keys[0]);
      const model = ai.getGenerativeModel({
        model: 'gemini-1.5-flash',
        generationConfig: { responseMimeType: 'application/json' },
      });

      const prompt = `Analyze this chat exchange and extract 0 to 2 key facts/memories worth saving for long-term companion recall.
User: "${userMessage}"
AI: "${aiResponse}"

Return JSON array of items: [{"type": "fact|preference|event|promise", "content": "short sentence", "importance": 0.1 to 1.0}]. Return [] if nothing worth saving.`;

      const response = await model.generateContent(prompt);
      const text = response.response.text() || '[]';
      const items = JSON.parse(text);
      if (Array.isArray(items)) {
        for (const item of items) {
          if (item.content && item.type) {
            await this.saveMemory(userId, characterId, item.type, item.content, item.importance || 0.6);
          }
        }
      }
    } catch (err) {
      // background memory extraction failure ignored silently
    }
  }

  /**
   * Delete specific memory or clear all user memories
   */
  static async deleteMemory(userId: string, memoryId: string) {
    return supabaseAdmin.from('memories').delete().eq('id', memoryId).eq('user_id', userId);
  }

  static async clearAllMemories(userId: string, characterId?: string) {
    let query = supabaseAdmin.from('memories').delete().eq('user_id', userId);
    if (characterId) query = query.eq('character_id', characterId);
    return query;
  }
}
