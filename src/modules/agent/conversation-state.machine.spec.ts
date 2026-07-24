import { STATE_RESPONSES, isValidTransition, VALID_TRANSITIONS } from './conversation-state.machine';
import { ConversationState, ConversationContext } from './types';

const empty: ConversationContext = {};

// ── Unit tests — STATE_RESPONSES ──────────────────────────────────────────────

describe('STATE_RESPONSES — all states return strings', () => {
  it.each(Object.values(ConversationState))('state %s returns a non-empty string', (state) => {
    const fn = STATE_RESPONSES[state as ConversationState];
    expect(fn).toBeDefined();
    const result = fn(empty);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('STATE_RESPONSES — DATA_CAPTURE progressive flow', () => {
  it('asks for cédula when context is empty', () => {
    expect(STATE_RESPONSES[ConversationState.DATA_CAPTURE](empty)).toContain('cédula');
  });

  it('asks for nombre after cédula is captured', () => {
    const ctx: ConversationContext = { cedula: '12345678' };
    expect(STATE_RESPONSES[ConversationState.DATA_CAPTURE](ctx)).toContain('nombre');
  });

  it('asks for email after nombre is captured', () => {
    const ctx: ConversationContext = { cedula: '12345678', nombre: 'Juan Pérez' };
    expect(STATE_RESPONSES[ConversationState.DATA_CAPTURE](ctx)).toContain('correo');
  });

  it('shows confirmation summary when all fields captured', () => {
    const ctx: ConversationContext = { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@email.com' };
    const response = STATE_RESPONSES[ConversationState.DATA_CAPTURE](ctx);
    expect(response).toContain('Juan Pérez');
    expect(response).toContain('12345678');
  });

  it('confirmation summary does not ask for cédula again', () => {
    const ctx: ConversationContext = { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@email.com' };
    const response = STATE_RESPONSES[ConversationState.DATA_CAPTURE](ctx);
    expect(response).not.toContain('cédula');
  });

  it('regression — confirmation summary shows the real quoted product name, not the raw category slug', () => {
    // Bug: summary showed "🛡️ mascotas Colsubsidio" (raw productCategory value) instead of
    // the actual product name ("Asistencia veterinaria Colsubsidio") — reads as a broken
    // placeholder rather than a professional purchase summary.
    const ctx: ConversationContext = {
      cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@email.com',
      productCategory: 'mascotas', quoteProductId: 'asistencia-veterinaria',
    };
    const response = STATE_RESPONSES[ConversationState.DATA_CAPTURE](ctx);
    expect(response).toContain('Asistencia veterinaria');
    expect(response).not.toContain('mascotas Colsubsidio');
  });

  it('regression — confirmation summary shows the real document type, not a hardcoded "CC"', () => {
    // Not everyone has a CC (cédula de ciudadanía) — a CE/TI/NIP/NUIP holder shouldn't
    // see their document mislabeled on the purchase summary.
    const ctx: ConversationContext = {
      cedula: '987654321', documentType: 'CE', nombre: 'Juan Pérez', email: 'juan@email.com',
    };
    const response = STATE_RESPONSES[ConversationState.DATA_CAPTURE](ctx);
    expect(response).toContain('CE 987654321');
  });

  it('defaults to "CC" in the summary when documentType is not set (backward compatible)', () => {
    const ctx: ConversationContext = { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@email.com' };
    const response = STATE_RESPONSES[ConversationState.DATA_CAPTURE](ctx);
    expect(response).toContain('CC 12345678');
  });

  it('the initial prompt asks for "documento de identidad" generically, not just "cédula"', () => {
    expect(STATE_RESPONSES[ConversationState.DATA_CAPTURE](empty)).toContain('documento de identidad');
  });
});

describe('STATE_RESPONSES — POLICY_ISSUED', () => {
  // Blockchain (Celo) verification was descoped from the active flow — the message no
  // longer mentions it regardless of context.
  it('never mentions blockchain/Celo', () => {
    expect(STATE_RESPONSES[ConversationState.POLICY_ISSUED](empty)).not.toContain('celoscan');
    expect(STATE_RESPONSES[ConversationState.POLICY_ISSUED](empty)).not.toContain('blockchain');
  });

  it('shows active policy confirmation', () => {
    expect(STATE_RESPONSES[ConversationState.POLICY_ISSUED](empty)).toContain('activo');
  });
});

describe('STATE_RESPONSES — null/undefined context safety', () => {
  it.each(Object.values(ConversationState))('state %s does not throw with null context', (state) => {
    expect(() => STATE_RESPONSES[state as ConversationState](null as any)).not.toThrow();
  });

  it.each(Object.values(ConversationState))('state %s does not throw with undefined context', (state) => {
    expect(() => STATE_RESPONSES[state as ConversationState](undefined as any)).not.toThrow();
  });
});

// ── Unit tests — isValidTransition ────────────────────────────────────────────

describe('isValidTransition', () => {
  it('GREETING → AUTHORIZATION is valid', () => {
    expect(isValidTransition(ConversationState.GREETING, ConversationState.AUTHORIZATION)).toBe(true);
  });

  it('GREETING → DATA_CAPTURE is invalid', () => {
    expect(isValidTransition(ConversationState.GREETING, ConversationState.DATA_CAPTURE)).toBe(false);
  });

  it('DATA_CAPTURE → PAYMENT is valid', () => {
    expect(isValidTransition(ConversationState.DATA_CAPTURE, ConversationState.PAYMENT)).toBe(true);
  });

  it('PAYMENT → POLICY_ISSUED is valid', () => {
    expect(isValidTransition(ConversationState.PAYMENT, ConversationState.POLICY_ISSUED)).toBe(true);
  });

  it('COMPLETED → anything is invalid', () => {
    const states = Object.values(ConversationState);
    for (const target of states) {
      if (target !== ConversationState.COMPLETED) {
        expect(isValidTransition(ConversationState.COMPLETED, target as ConversationState)).toBe(false);
      }
    }
  });
});

// ── Invariant tests ───────────────────────────────────────────────────────────

describe('STATE_RESPONSES INVARIANTS', () => {
  it('invariant: AUTHORIZATION response always mentions Ley 1581', () => {
    expect(STATE_RESPONSES[ConversationState.AUTHORIZATION](empty)).toContain('1581');
  });

  it('invariant: all terminal states have empty or no outgoing transitions', () => {
    const terminal = [ConversationState.COMPLETED, ConversationState.ABANDONED, ConversationState.REJECTED];
    for (const state of terminal) {
      const transitions = VALID_TRANSITIONS[state] ?? [];
      expect(transitions.length).toBe(0);
    }
  });

  it('invariant: every non-terminal state has at least one valid transition', () => {
    const terminal = new Set([ConversationState.COMPLETED, ConversationState.ABANDONED, ConversationState.REJECTED]);
    for (const state of Object.values(ConversationState)) {
      if (!terminal.has(state as ConversationState)) {
        const transitions = VALID_TRANSITIONS[state as ConversationState] ?? [];
        expect(transitions.length).toBeGreaterThan(0);
      }
    }
  });
});
