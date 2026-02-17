import { describe, it, expect } from 'vitest';
import {
  createGearState,
  selectGear,
  GEAR_MODELS,
  DOWNSHIFT_THRESHOLD,
  GearState,
} from '../../src/agent/complexity';

describe('Gear System', () => {
  describe('createGearState', () => {
    it('starts at G1 with zero counters', () => {
      const state = createGearState();
      expect(state).toEqual({ level: 1, downshiftCounter: 0, turnCount: 0 });
    });
  });

  describe('GEAR_MODELS', () => {
    it('maps gears to correct models', () => {
      expect(GEAR_MODELS[1]).toContain('haiku');
      expect(GEAR_MODELS[2]).toContain('sonnet');
      expect(GEAR_MODELS[3]).toContain('opus');
    });
  });

  describe('selectGear - upshift', () => {
    it('stays G1 for simple greetings', () => {
      const state = createGearState();
      const result = selectGear('hey', state, false);
      expect(result.level).toBe(1);
    });

    it('upshifts to G3 for analysis keywords', () => {
      const state = createGearState();
      const result = selectGear('analyze the performance of this system', state, false);
      expect(result.level).toBe(3);
    });

    it('upshifts to G3 for design keywords', () => {
      const state = createGearState();
      const result = selectGear('design a database schema for users', state, false);
      expect(result.level).toBe(3);
    });

    it('upshifts to G3 for long messages (>500 chars)', () => {
      const state = createGearState();
      const longMsg = 'a'.repeat(501);
      const result = selectGear(longMsg, state, false);
      expect(result.level).toBe(3);
    });

    it('upshifts to G2 for medium messages (200-500 chars)', () => {
      const state = createGearState();
      const medMsg = 'word '.repeat(50); // ~250 chars, no complexity keywords
      const result = selectGear(medMsg, state, false);
      expect(result.level).toBe(2);
    });

    it('upshifts to G2 when previous turn used tools', () => {
      const state = createGearState();
      const result = selectGear('ok', state, true);
      expect(result.level).toBe(2);
    });

    it('upshifts on URLs', () => {
      const state = createGearState();
      const result = selectGear('check https://example.com', state, false);
      expect(result.level).toBeGreaterThanOrEqual(2);
    });

    it('upshifts on code blocks', () => {
      const state = createGearState();
      const result = selectGear('fix this:\n```\nconst x = 1;\n```', state, false);
      expect(result.level).toBeGreaterThanOrEqual(2);
    });

    it('upshifts on multi-sentence messages (3+)', () => {
      const state = createGearState();
      const result = selectGear('First thing. Second thing. Third thing here.', state, false);
      expect(result.level).toBeGreaterThanOrEqual(2);
    });

    it('upshifts on multiple questions', () => {
      const state = createGearState();
      const result = selectGear('What is this? How does it work?', state, false);
      expect(result.level).toBeGreaterThanOrEqual(2);
    });

    it('resets downshift counter on upshift', () => {
      const state: GearState = { level: 2, downshiftCounter: 2, turnCount: 5 };
      const result = selectGear('analyze this deeply', state, false);
      expect(result.downshiftCounter).toBe(0);
      expect(result.level).toBe(3);
    });

    it('never downshifts below current on complexity signal', () => {
      const state: GearState = { level: 3, downshiftCounter: 0, turnCount: 5 };
      const result = selectGear('check https://example.com', state, false);
      // URL is a G2 target, but max(3, 2) = 3
      expect(result.level).toBe(3);
    });
  });

  describe('selectGear - downshift', () => {
    it('increments downshift counter on simple messages', () => {
      const state: GearState = { level: 3, downshiftCounter: 0, turnCount: 5 };
      const result = selectGear('ok', state, false);
      expect(result.downshiftCounter).toBe(1);
      expect(result.level).toBe(3); // not yet
    });

    it('downshifts one gear after 3 consecutive simple messages', () => {
      let state: GearState = { level: 3, downshiftCounter: 0, turnCount: 5 };

      state = selectGear('ok', state, false);
      expect(state.level).toBe(3);
      expect(state.downshiftCounter).toBe(1);

      state = selectGear('thanks', state, false);
      expect(state.level).toBe(3);
      expect(state.downshiftCounter).toBe(2);

      state = selectGear('cool', state, false);
      expect(state.level).toBe(2); // downshifted!
      expect(state.downshiftCounter).toBe(0); // reset
    });

    it('requires 6 simple messages to go from G3 to G1', () => {
      let state: GearState = { level: 3, downshiftCounter: 0, turnCount: 0 };

      // 3 simple → G3 to G2
      for (let i = 0; i < 3; i++) {
        state = selectGear('ok', state, false);
      }
      expect(state.level).toBe(2);

      // 3 more simple → G2 to G1
      for (let i = 0; i < 3; i++) {
        state = selectGear('ok', state, false);
      }
      expect(state.level).toBe(1);
    });

    it('does not downshift below G1', () => {
      let state: GearState = { level: 1, downshiftCounter: 0, turnCount: 0 };

      for (let i = 0; i < 10; i++) {
        state = selectGear('ok', state, false);
      }
      expect(state.level).toBe(1);
    });

    it('resets downshift progress on any complexity signal', () => {
      let state: GearState = { level: 3, downshiftCounter: 2, turnCount: 5 };

      // One more simple would trigger downshift, but complexity interrupts
      state = selectGear('analyze this', state, false);
      expect(state.level).toBe(3);
      expect(state.downshiftCounter).toBe(0);
    });
  });

  describe('selectGear - turn counting', () => {
    it('increments turn count on every call', () => {
      let state = createGearState();
      state = selectGear('hey', state, false);
      expect(state.turnCount).toBe(1);
      state = selectGear('analyze this', state, false);
      expect(state.turnCount).toBe(2);
      state = selectGear('ok', state, false);
      expect(state.turnCount).toBe(3);
    });
  });

  describe('selectGear - realistic conversation flow', () => {
    it('simulates: greeting → complex → 3x simple → complex', () => {
      let state = createGearState();

      // "hey" → stays G1
      state = selectGear('hey', state, false);
      expect(state.level).toBe(1);

      // "analyze the performance of X compared to Y" → jumps to G3
      state = selectGear('analyze the performance of X compared to Y', state, false);
      expect(state.level).toBe(3);

      // 3x simple → downshift to G2
      state = selectGear('ok', state, false);
      state = selectGear('thanks', state, false);
      state = selectGear('cool', state, false);
      expect(state.level).toBe(2);

      // Complex again → back to G3
      state = selectGear('now debug the authentication flow', state, false);
      expect(state.level).toBe(3);
    });

    it('simulates: tools used → stays elevated', () => {
      let state = createGearState();

      // Simple message but previous turn used tools
      state = selectGear('ok', state, true);
      expect(state.level).toBe(2);

      // Another simple, no tools → starts downshift count
      state = selectGear('got it', state, false);
      expect(state.level).toBe(2);
      expect(state.downshiftCounter).toBe(1);
    });
  });
});
