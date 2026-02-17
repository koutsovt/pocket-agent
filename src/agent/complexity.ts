/**
 * Query complexity detection and adaptive gear system
 * Routes simple messages to cheaper models, preserving Opus for complex queries.
 */

/**
 * Check if a query is "simple" (casual chat, short questions).
 * Simple queries skip expensive semantic search and use less thinking.
 */
export function isSimpleQuery(message: string): boolean {
  if (message.length < 30) return true;

  const casualPatterns = /^(hi|hey|hello|yo|sup|thanks|ok|okay|yes|no|sure|got it|cool|nice|great|good|yep|nope|k|ty|thx)\b/i;
  if (casualPatterns.test(message.trim())) return true;

  const wordCount = message.trim().split(/\s+/).length;
  if (wordCount <= 3) return true;

  return false;
}

// ============ Adaptive Gear System ============

export type GearLevel = 1 | 2 | 3;

export interface GearState {
  level: GearLevel;
  downshiftCounter: number;
  turnCount: number;
}

export const GEAR_MODELS: Record<GearLevel, string> = {
  1: 'claude-haiku-4-5-20251001',
  2: 'claude-sonnet-4-5-20250929',
  3: 'claude-opus-4-6',
};

export const DOWNSHIFT_THRESHOLD = 3;

export function createGearState(): GearState {
  return { level: 1, downshiftCounter: 0, turnCount: 0 };
}

/**
 * Determine the next gear based on message complexity and conversation momentum.
 * Fast upshift on any complexity signal, slow downshift after consecutive simple messages.
 */
export function selectGear(message: string, state: GearState, lastToolsUsed: boolean): GearState {
  const newState: GearState = { ...state, turnCount: state.turnCount + 1 };

  const hasComplexitySignal = detectComplexity(message) || lastToolsUsed;

  if (hasComplexitySignal) {
    const targetGear = getTargetGear(message, lastToolsUsed);
    newState.level = Math.max(state.level, targetGear) as GearLevel;
    newState.downshiftCounter = 0;
    return newState;
  }

  newState.downshiftCounter = state.downshiftCounter + 1;

  if (newState.downshiftCounter >= DOWNSHIFT_THRESHOLD && newState.level > 1) {
    newState.level = (newState.level - 1) as GearLevel;
    newState.downshiftCounter = 0;
  }

  return newState;
}

function detectComplexity(message: string): boolean {
  if (message.length > 200) return true;
  if (/```[\s\S]*```/.test(message)) return true;
  if (/https?:\/\/\S+/.test(message)) return true;

  const complexKeywords = /\b(analyze|compare|explain|implement|design|debug|refactor|optimize|research|summarize|review|evaluate|architecture|performance|security|database|schema|deploy|migrate|integrate)\b/i;
  if (complexKeywords.test(message)) return true;

  const sentences = message.split(/[.!?]+/).filter(s => s.trim().length > 0);
  if (sentences.length >= 3) return true;

  if ((message.match(/\?/g) || []).length >= 2) return true;

  return false;
}

function getTargetGear(message: string, lastToolsUsed: boolean): GearLevel {
  const heavyKeywords = /\b(analyze|design|architect|implement|debug|refactor|optimize|research|evaluate|compare.*vs|performance|security audit)\b/i;
  if (heavyKeywords.test(message)) return 3;
  if (message.length > 500) return 3;
  if (/```[\s\S]*```/.test(message) && message.length > 300) return 3;

  if (lastToolsUsed) return 2;
  if (message.length > 200) return 2;
  if (/https?:\/\/\S+/.test(message)) return 2;

  return 2;
}
