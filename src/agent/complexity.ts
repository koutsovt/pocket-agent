/**
 * Query complexity detection for optimizing agent behavior
 * Simple queries skip expensive operations like semantic search
 */

/**
 * Check if a query is "simple" (casual chat, short questions).
 * Simple queries skip expensive semantic search and use less thinking.
 */
export function isSimpleQuery(message: string): boolean {
  // Very short messages are simple
  if (message.length < 30) return true;

  // Greetings and casual phrases
  const casualPatterns = /^(hi|hey|hello|yo|sup|thanks|ok|okay|yes|no|sure|got it|cool|nice|great|good|yep|nope|k|ty|thx)\b/i;
  if (casualPatterns.test(message.trim())) return true;

  // Single words or very few words (less than 4)
  const wordCount = message.trim().split(/\s+/).length;
  if (wordCount <= 3) return true;

  return false;
}

// Thinking level to token budget mapping
export const THINKING_BUDGETS: Record<string, number | undefined> = {
  'none': 0,
  'minimal': 2048,
  'normal': 10000,
  'extended': 32000,
};
