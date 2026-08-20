"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RelationshipService = void 0;
const config_1 = require("../config");
class RelationshipService {
    /**
     * Get or initialize relationship state between user and character
     */
    static async getRelationship(userId, characterId) {
        const { data } = await config_1.supabaseAdmin
            .from('character_relationships')
            .select('*')
            .eq('user_id', userId)
            .eq('character_id', characterId)
            .maybeSingle();
        if (data)
            return data;
        // Create default relationship state
        const { data: newRel, error } = await config_1.supabaseAdmin
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
        if (error)
            throw new Error(`Relationship init error: ${error.message}`);
        return newRel;
    }
    /**
     * Apply bounded updates to relationship metrics
     */
    static async updateRelationship(userId, characterId, delta, known) {
        const current = known || await this.getRelationship(userId, characterId);
        // Apply strict bounds (-5.0 to +5.0 per single interaction)
        const clampDelta = (val) => Math.max(-5.0, Math.min(5.0, val || 0));
        const newAffection = Math.max(0, Math.min(100, current.affection + clampDelta(delta.affection)));
        const newTrust = Math.max(0, Math.min(100, current.trust + clampDelta(delta.trust)));
        const newFamiliarity = Math.max(0, Math.min(100, current.familiarity + clampDelta(delta.familiarity)));
        const newIntimacy = Math.max(0, Math.min(100, current.intimacy + clampDelta(delta.intimacy)));
        // Calculate stage based on metrics
        let newStage = current.relationship_stage;
        const avgScore = (newAffection + newTrust + newFamiliarity) / 3;
        if (avgScore > 80 && newIntimacy > 50)
            newStage = 'partner';
        else if (avgScore > 65 && newIntimacy > 30)
            newStage = 'romantic_interest';
        else if (avgScore > 45)
            newStage = 'close_friend';
        else if (avgScore > 25)
            newStage = 'friend';
        else
            newStage = 'acquaintance';
        const level = Math.floor(avgScore / 10) + 1;
        const { data: updated, error } = await config_1.supabaseAdmin
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
        if (error)
            throw new Error(`Relationship update error: ${error.message}`);
        return updated;
    }
}
exports.RelationshipService = RelationshipService;
