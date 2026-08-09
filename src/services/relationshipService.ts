import { supabaseAdmin } from '../config';

export interface RelationshipState {
  id: string;
  user_id: string;
  character_id: string;
  relationship_level: number;
  affection: number;
  trust: number;
  familiarity: number;
  intimacy: number;
  current_mood: string;
  relationship_stage: string;
  last_interaction_at: string;
}

export class RelationshipService {
  /**
   * Get or initialize relationship state between user and character
   */
  static async getRelationship(userId: string, characterId: string): Promise<RelationshipState> {
    const { data } = await supabaseAdmin
      .from('character_relationships')
      .select('*')
      .eq('user_id', userId)
      .eq('character_id', characterId)
      .maybeSingle();

    if (data) return data;

    // Create default relationship state
    const { data: newRel, error } = await supabaseAdmin
      .from('character_relationships')
      .insert({
        user_id: userId,
        character_id: characterId,
        relationship_level: 1,
        affection: 10.0,
        trust: 10.0,
        familiarity: 5.0,
        intimacy: 0.0,
        current_mood: 'happy',
        relationship_stage: 'acquaintance',
      })
      .select()
      .single();

    if (error) throw new Error(`Relationship init error: ${error.message}`);
    return newRel;
  }

  /**
   * Apply bounded updates to relationship metrics
   */
  static async updateRelationship(
    userId: string,
    characterId: string,
    delta: { affection?: number; trust?: number; familiarity?: number; intimacy?: number; mood?: string }
  ): Promise<RelationshipState> {
    const current = await this.getRelationship(userId, characterId);

    // Apply strict bounds (-5.0 to +5.0 per single interaction)
    const clampDelta = (val?: number) => Math.max(-5.0, Math.min(5.0, val || 0));

    const newAffection = Math.max(0, Math.min(100, current.affection + clampDelta(delta.affection)));
    const newTrust = Math.max(0, Math.min(100, current.trust + clampDelta(delta.trust)));
    const newFamiliarity = Math.max(0, Math.min(100, current.familiarity + clampDelta(delta.familiarity)));
    const newIntimacy = Math.max(0, Math.min(100, current.intimacy + clampDelta(delta.intimacy)));

    // Calculate stage based on metrics
    let newStage = current.relationship_stage;
    const avgScore = (newAffection + newTrust + newFamiliarity) / 3;
    
    if (avgScore > 80 && newIntimacy > 50) newStage = 'partner';
    else if (avgScore > 65 && newIntimacy > 30) newStage = 'romantic_interest';
    else if (avgScore > 45) newStage = 'close_friend';
    else if (avgScore > 25) newStage = 'friend';
    else newStage = 'acquaintance';

    const level = Math.floor(avgScore / 10) + 1;

    const { data: updated, error } = await supabaseAdmin
      .from('character_relationships')
      .update({
        affection: newAffection,
        trust: newTrust,
        familiarity: newFamiliarity,
        intimacy: newIntimacy,
        relationship_level: level,
        relationship_stage: newStage,
        current_mood: delta.mood || current.current_mood,
        last_interaction_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('character_id', characterId)
      .select()
      .single();

    if (error) throw new Error(`Relationship update error: ${error.message}`);
    return updated;
  }
}
