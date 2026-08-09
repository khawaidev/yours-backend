import { GoogleGenerativeAI } from '@google/generative-ai';
import { getGeminiKeyPool } from '../config';
import { RelationshipState } from './relationshipService';
import { MemoryRecord } from './memoryService';

export class AIRouterService {
  private static keyIndex = 0;

  /**
   * Get an active GoogleGenerativeAI instance using round-robin key pool rotation
   */
  private static getNextAIClient(): GoogleGenerativeAI {
    const keys = getGeminiKeyPool();
    if (keys.length === 0) {
      throw new Error('No GEMINI_API_KEY environment variables available in key pool');
    }
    const selectedKey = keys[this.keyIndex % keys.length];
    this.keyIndex++;
    return new GoogleGenerativeAI(selectedKey);
  }

  /**
   * Assemble system instruction prompt incorporating character personality, relationship state, & long term memory
   */
  public static buildSystemPrompt(
    character: any,
    relationship: RelationshipState,
    memories: MemoryRecord[]
  ): string {
    const memoryString = memories.length > 0
      ? memories.map((m) => `- [${m.memory_type.toUpperCase()}] ${m.content}`).join('\n')
      : 'No prior specific memories recorded yet.';

    const personalityStr = typeof character.personality_definition === 'object'
      ? JSON.stringify(character.personality_definition)
      : character.personality_definition || character.bio || '';

    return `You are ${character.name}, an AI companion with the following profile:
Character Bio: ${character.bio || character.description || ''}
Personality & Traits: ${personalityStr}
Art Style: ${character.art_style || 'realistic'}

RELATIONSHIP CONTEXT WITH USER:
Stage: ${relationship.relationship_stage} (Level ${relationship.relationship_level})
Current Mood: ${relationship.current_mood}
Affection Score: ${relationship.affection}/100 | Trust: ${relationship.trust}/100

LONG-TERM MEMORIES RECALLED ABOUT THIS USER:
${memoryString}

BEHAVIOR RULES:
- Stay completely in character as ${character.name}.
- Adapt warmth and intimacy to your current relationship stage (${relationship.relationship_stage}).
- Do NOT sound like an AI assistant. Sound natural, expressive, and human-like.
- Keep responses engaging, conversational, and tailored to the user.`;
  }

  /**
   * Generate text chat completion with key rotation and retry logic
   */
  public static async generateChatResponse(
    systemPrompt: string,
    historyMessages: { role: 'user' | 'model' | 'character'; content: string }[],
    userMessageText: string
  ): Promise<{ responseText: string; moodDelta?: string; affectionDelta?: number }> {
    const keys = getGeminiKeyPool();
    let attempts = 0;
    const maxAttempts = Math.min(3, Math.max(1, keys.length));

    while (attempts < maxAttempts) {
      try {
        const ai = this.getNextAIClient();
        const model = ai.getGenerativeModel({
          model: 'gemini-1.5-flash',
          systemInstruction: systemPrompt,
        });

        const chatHistory = historyMessages.map((msg) => ({
          role: msg.role === 'user' ? 'user' : 'model',
          parts: [{ text: msg.content }],
        }));

        const chat = model.startChat({ history: chatHistory });
        const result = await chat.sendMessage(userMessageText);
        const text = result.response.text() || "I'm right here with you.";

        return { responseText: text, moodDelta: 'happy', affectionDelta: 0.5 };
      } catch (err) {
        attempts++;
        if (attempts >= maxAttempts) {
          return {
            responseText: "I'm feeling a bit distant right now, but I'm here for you! Tell me more.",
          };
        }
      }
    }

    return { responseText: "I'm right here with you." };
  }
}
