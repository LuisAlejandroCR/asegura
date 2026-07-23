import { GroqNlpService } from './groq-nlp.service';
import { InsuranceIntent } from './types';

const mockConfig = { get: jest.fn((_key: string, def?: unknown) => def ?? '') } as any;

function makeService(): GroqNlpService {
  return new GroqNlpService(mockConfig);
}

function baseMascotas(petType: InsuranceIntent['petType'] = null): InsuranceIntent {
  return { productCategory: 'mascotas', petType, coverage: [], beneficiaries: 1, urgency: 'exploring' };
}

function postProcess(service: GroqNlpService, intent: InsuranceIntent, text: string): InsuranceIntent {
  return (service as any).postProcess(intent, text);
}

function fallback(service: GroqNlpService, text: string): InsuranceIntent {
  return (service as any).fallbackIntent(text);
}

// ── Unit tests ────────────────────────────────────────────────────────────────

describe('GroqNlpService.postProcess — pet type detection', () => {
  const service = makeService();

  it('sets gato when only cat keywords present', () => {
    expect(postProcess(service, baseMascotas(), 'tengo un gato').petType).toBe('gato');
  });

  it('sets gato for alias "michi"', () => {
    expect(postProcess(service, baseMascotas(), 'mi michi necesita seguro').petType).toBe('gato');
  });

  it('sets gato for alias "felino"', () => {
    expect(postProcess(service, baseMascotas(), 'tengo un felino').petType).toBe('gato');
  });

  it('sets perro when only dog keywords present', () => {
    expect(postProcess(service, baseMascotas(), 'tengo un perro').petType).toBe('perro');
  });

  it('sets perro for alias "canino"', () => {
    expect(postProcess(service, baseMascotas(), 'mi canino se accidentó').petType).toBe('perro');
  });

  it('sets mixto when cat and dog keywords both present', () => {
    expect(postProcess(service, baseMascotas('perro'), 'tengo un gato y dos perros').petType).toBe('mixto');
  });

  it('overrides Groq perro → mixto when gato keyword is also present', () => {
    // Regression: Groq returned 'perro' but text had both → must become 'mixto'
    const intent = baseMascotas('perro');
    expect(postProcess(service, intent, 'un gato, dos perros y yo solo').petType).toBe('mixto');
  });

  it('does not override petType when category is not mascotas', () => {
    const intent: InsuranceIntent = { productCategory: 'vida', petType: null, coverage: [], beneficiaries: 1, urgency: 'exploring' };
    expect(postProcess(service, intent, 'mi gato y mi perro').petType).toBeNull();
  });

  it('preserves existing petType when no pet keywords found', () => {
    const intent = baseMascotas('gato');
    expect(postProcess(service, intent, 'quiero el seguro').petType).toBe('gato');
  });

  it('regression — resets mixto to null when text has no pet keywords ("para todos")', () => {
    // Groq might return 'mixto' for "para todos" but there are no cat/dog keywords
    // postProcess must reject this guess, otherwise the clarification loop re-triggers
    const intent = baseMascotas('mixto');
    expect(postProcess(service, intent, 'para todos').petType).toBeNull();
  });

  it('regression — resets mixto to null for bare "todos"', () => {
    const intent = baseMascotas('mixto');
    expect(postProcess(service, intent, 'todos').petType).toBeNull();
  });
});

describe('GroqNlpService.fallbackIntent — intent extraction', () => {
  const service = makeService();

  it.each([
    ['quiero un seguro de vida', 'vida'],
    ['necesito proteger mi hogar', 'hogar'],
    ['asistencia médica familiar', 'asistencia'],
    ['seguro para mi gato', 'mascotas'],
    ['tengo dos perros', 'mascotas'],
    ['michi necesita vacunas', 'mascotas'],
    ['accidente de tránsito', 'accidentes'],
  ])('"%s" → productCategory "%s"', (text, expected) => {
    expect(fallback(service, text).productCategory).toBe(expected);
  });

  it('detects mixto in fallback when both gato and perro present', () => {
    expect(fallback(service, 'tengo un gato y un perro').petType).toBe('mixto');
  });

  it('detects mixto for aliases: michi y canino', () => {
    expect(fallback(service, 'mi michi y mi canino').petType).toBe('mixto');
  });

  it('returns null productCategory for unrelated text', () => {
    expect(fallback(service, 'hola buenos días').productCategory).toBeNull();
  });

  it('sets abandonIntent for "después"', () => {
    expect(fallback(service, 'lo veo después').abandonIntent).toBe(true);
  });
});

// ── Fuzz / property-based tests ───────────────────────────────────────────────

describe('GroqNlpService FUZZ — petType invariants', () => {
  const service = makeService();

  const catWords = ['gato', 'michi', 'felino'];
  const dogWords = ['perro', 'canino'];

  it('invariant: any text with BOTH cat and dog keywords → petType mixto', () => {
    const mixedSamples = [
      'tengo un gato y dos perros',
      'mi michi y mi perro',
      'gatos y perros en casa',
      'el canino y el felino',
      'un gato, dos perros y yo solo',   // real bug case — comma-separated
      'perro y gato',
      'gato perro',
    ];
    for (const text of mixedSamples) {
      const result = postProcess(service, baseMascotas('perro'), text);
      expect(result.petType).toBe('mixto');
    }
  });

  it('invariant: cat-only text never returns petType perro', () => {
    for (const word of catWords) {
      const result = postProcess(service, baseMascotas(), `tengo un ${word}`);
      expect(result.petType).not.toBe('perro');
    }
  });

  it('invariant: dog-only text never returns petType gato', () => {
    for (const word of dogWords) {
      const result = postProcess(service, baseMascotas(), `tengo un ${word}`);
      expect(result.petType).not.toBe('gato');
    }
  });

  it('invariant: fallback never throws for arbitrary strings', () => {
    const noise = [
      '', ' ', '\n', '\t', '123456', '!@#$%', 'ñoño', 'a'.repeat(500),
      'GATO PERRO', 'gAtO pErRo',
    ];
    for (const text of noise) {
      expect(() => fallback(service, text)).not.toThrow();
    }
  });
});
