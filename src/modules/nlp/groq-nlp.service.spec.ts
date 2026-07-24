import { Logger } from '@nestjs/common';
import { GroqNlpService } from './groq-nlp.service';
import { InsuranceIntent } from './types';

const mockConfig = { get: jest.fn((_key: string, def?: unknown) => def ?? '') } as any;

function makeService(): GroqNlpService {
  return new GroqNlpService(mockConfig);
}

// Regression: WompiService and TelegramAdapter both warn at boot when their required env
// vars are missing — GroqNlpService was the only one of the three optional integrations
// that stayed completely silent either way. That gap directly caused a real live-test
// confusion: after adding LLM_API_KEY to Railway and redeploying, there was no boot-log
// line confirming it (or denying it) the way Wompi's "disabled" warning does — the only
// way to check was hitting /health. Bringing this in line with the other two integrations.
describe('GroqNlpService — boot-time configuration warning', () => {
  it('regression — warns when LLM_API_KEY is missing, matching WompiService/TelegramAdapter behavior', () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const config = { get: jest.fn((_key: string, def?: unknown) => def ?? '') } as any;
    new GroqNlpService(config);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('LLM_API_KEY'));
    warnSpy.mockRestore();
  });

  it('does not warn when LLM_API_KEY is set', () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const config = { get: jest.fn((key: string, def?: unknown) => (key === 'LLM_API_KEY' ? 'gsk_test' : def ?? '')) } as any;
    new GroqNlpService(config);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

function baseMascotas(petType: InsuranceIntent['petType'] = null): InsuranceIntent {
  return { productCategory: 'mascotas', petType, coverage: [], beneficiaries: 1, urgency: 'exploring', isAffirmative: false, isNegative: false, wantsAlternative: false, petResolution: null };
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

  // Real live-test bug: "Somos dos perros, una gatica y yo." — hasCat here checked only
  // 'gato'/'gata'/'michi'/'felino', missing the "gatica" diminutive that hasCatExt
  // (petResolution, a few lines below) already recognized. This silently overrode a
  // correct mixto classification back to 'perro', dropping the cat entirely and quoting
  // the whole household as a dogs-only product.
  it('regression — overrides Groq perro → mixto for the "gatica" diminutive, not just "gato"/"gata"', () => {
    const intent = baseMascotas('perro');
    expect(postProcess(service, intent, 'somos dos perros, una gatica y yo').petType).toBe('mixto');
  });

  it('does not override petType when category is not mascotas', () => {
    const intent: InsuranceIntent = { productCategory: 'vida', petType: null, coverage: [], beneficiaries: 1, urgency: 'exploring', isAffirmative: false, isNegative: false, wantsAlternative: false, petResolution: null };
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
    // Regression: "Ahora el de salud." (real live-test message) got no category at all —
    // colloquial Spanish uses "salud" for health/medical coverage, but the formal catalog
    // category is "asistencia" (asistencia médica), and neither the fallback dict nor the
    // Groq prompt had this alias. The message fell through to "re-show the current quote
    // unchanged", ignoring the request entirely.
    ['ahora el de salud', 'asistencia'],
    ['quiero un seguro de salud', 'asistencia'],
  ])('"%s" → productCategory "%s"', (text, expected) => {
    expect(fallback(service, text).productCategory).toBe(expected);
  });

  it('detects mixto in fallback when both gato and perro present', () => {
    expect(fallback(service, 'tengo un gato y un perro').petType).toBe('mixto');
  });

  // Real live-test bug (fallback path — used when Groq itself is unreachable): "una
  // gatica" matched no category key at all before ('gato'/'gata' aren't substrings of
  // 'gatica'), so the whole household got silently classified as dogs-only.
  it('regression — detects mixto in fallback for the "gatica" diminutive', () => {
    expect(fallback(service, 'somos dos perros, una gatica y yo').petType).toBe('mixto');
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

// ── Per-pet detail extraction (fallback) ──────────────────────────────────────

describe('GroqNlpService.fallbackIntent — pet name/age/breed extraction', () => {
  const service = makeService();

  it('extracts petName from "se llama X"', () => {
    expect(fallback(service, 'se llama Max, tiene 3 años, es un labrador').petName).toBe('Max');
  });

  it('extracts petName from "llamada X" (feminine)', () => {
    expect(fallback(service, 'mi gata llamada Luna tiene 2 años').petName).toBe('Luna');
  });

  it('extracts petAge from "tiene N años"', () => {
    expect(fallback(service, 'se llama Rocky, tiene 5 años').petAge).toBe('5 años');
  });

  it('returns null petName when the message does not name a pet', () => {
    expect(fallback(service, 'tiene 3 años').petName).toBeNull();
  });

  it('returns null petAge when no age is mentioned', () => {
    expect(fallback(service, 'se llama Max').petAge).toBeNull();
  });

  it('populates pets as a one-element array mirroring petName/petAge when a pet is named', () => {
    const result = fallback(service, 'se llama Max, tiene 3 años, es un labrador');
    expect(result.pets).toEqual([{ name: 'Max', age: '3 años', breed: null }]);
  });

  it('populates pets as an empty array when no pet is named', () => {
    expect(fallback(service, 'tiene 3 años').pets).toEqual([]);
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

// ── wantsAlternative extraction ───────────────────────────────────────────────

describe('GroqNlpService — wantsAlternative (fallback)', () => {
  const service = makeService();

  it.each([
    'otro',
    'otra opción',
    'diferente',
    'muéstrame más',
    'cambia',
    'cambiar',
    'siguiente cotización',
    'hay otra',
    'no ese',
  ])('"%s" → wantsAlternative true', (text) => {
    expect(fallback(service, text).wantsAlternative).toBe(true);
  });

  it.each([
    'sí',
    'me interesa',
    'quiero ese',
    'hola',
    'quiero un seguro de vida',
  ])('"%s" → wantsAlternative false', (text) => {
    expect(fallback(service, text).wantsAlternative).toBe(false);
  });
});

// ── petResolution extraction ──────────────────────────────────────────────────

describe('GroqNlpService.postProcess — petResolution extraction', () => {
  const service = makeService();

  it.each([
    ['el gato', 'gato'],
    ['para mi gatita', 'gato'],
    ['el michi', 'gato'],
    ['el felino', 'gato'],
    ['el minino', 'gato'],
  ])('"%s" → petResolution gato', (text, expected) => {
    expect(postProcess(service, baseMascotas(), text).petResolution).toBe(expected);
  });

  it.each([
    ['el perro', 'perro'],
    ['mi lomito', 'perro'],
    ['mi perrita', 'perro'],
    ['el canino', 'perro'],
  ])('"%s" → petResolution perro', (text, expected) => {
    expect(postProcess(service, baseMascotas(), text).petResolution).toBe(expected);
  });

  it.each([
    ['para todos', 'all'],
    ['los dos', 'all'],
    ['ambos', 'all'],
    ['para las dos mascotas', 'all'],
  ])('"%s" → petResolution all', (text, expected) => {
    expect(postProcess(service, baseMascotas(), text).petResolution).toBe(expected);
  });

  it('invariant: cat+dog text never returns petResolution as a single type', () => {
    const bothTexts = ['mi gato y mi perro', 'gato y canino', 'michi y lomito'];
    for (const text of bothTexts) {
      const res = postProcess(service, baseMascotas(), text).petResolution;
      expect(res).not.toBe('gato');
      expect(res).not.toBe('perro');
    }
  });
});

// ── productCategory inference from petType ────────────────────────────────────

describe('GroqNlpService.postProcess — productCategory inference from petType', () => {
  const service = makeService();

  function noCategory(petType: InsuranceIntent['petType'] = null): InsuranceIntent {
    return { productCategory: null, petType, coverage: [], beneficiaries: 1, urgency: 'exploring', isAffirmative: false, isNegative: false, wantsAlternative: false, petResolution: null };
  }

  it('infers productCategory mascotas when Groq returns petType gato but productCategory null', () => {
    expect(postProcess(service, noCategory('gato'), 'mi gata tiene 10 años').productCategory).toBe('mascotas');
  });

  it('infers productCategory mascotas when Groq returns petType perro but productCategory null', () => {
    expect(postProcess(service, noCategory('perro'), 'mi perro').productCategory).toBe('mascotas');
  });

  it('infers productCategory mascotas from pet keyword in text when both are null', () => {
    expect(postProcess(service, noCategory(), 'tengo un gato').productCategory).toBe('mascotas');
  });

  it('does NOT infer mascotas when text has no pet keywords and petType is null', () => {
    expect(postProcess(service, noCategory(), 'necesito proteger a mi familia').productCategory).toBeNull();
  });

  it('does NOT override productCategory when Groq already set it', () => {
    const intent: InsuranceIntent = { ...noCategory(), productCategory: 'vida' };
    expect(postProcess(service, intent, 'mi gato').productCategory).toBe('vida');
  });
});

// ── petType inference when Groq returns productCategory=null (regression) ─────
// Real bug: "Tengo un gato, dos perros y yo solo." — Groq returned productCategory=null
// AND petType=null. The old petType-from-keywords block only ran when
// productCategory === 'mascotas', so petType stayed null forever even though the text
// clearly names both pets — the mixto clarification question never fired, and the
// conversation looped on the generic DISCOVERY question indefinitely.

describe('GroqNlpService.postProcess — petType inference when productCategory is null', () => {
  const service = makeService();

  function noCategory(petType: InsuranceIntent['petType'] = null): InsuranceIntent {
    return { productCategory: null, petType, coverage: [], beneficiaries: 1, urgency: 'exploring', isAffirmative: false, isNegative: false, wantsAlternative: false, petResolution: null };
  }

  it('regression — infers petType mixto from keywords when Groq returns productCategory=null', () => {
    const result = postProcess(service, noCategory(), 'Tengo un gato, dos perros y yo solo.');
    expect(result.petType).toBe('mixto');
  });

  it('regression — both petType AND productCategory are set together for the same message', () => {
    const result = postProcess(service, noCategory(), 'Tengo un gato, dos perros y yo solo.');
    expect(result.petType).toBe('mixto');
    expect(result.productCategory).toBe('mascotas');
  });

  it('infers petType gato from keywords when Groq returns productCategory=null', () => {
    expect(postProcess(service, noCategory(), 'mi gata tiene 10 años').petType).toBe('gato');
  });

  it('infers petType perro from keywords when Groq returns productCategory=null', () => {
    expect(postProcess(service, noCategory(), 'mi perro').petType).toBe('perro');
  });

  it('does NOT infer petType from keywords when Groq set an unrelated category explicitly', () => {
    const intent: InsuranceIntent = { ...noCategory(), productCategory: 'vida' };
    expect(postProcess(service, intent, 'mi gato y mi perro').petType).toBeNull();
  });
});

// ── isAffirmative question-mark guardrail (regression) ────────────────────────
// Real bug: "Me interesan mascotas y para mí ¿qué hay?" was classified isAffirmative=true
// (substring match: "me interesan" contains "me interesa") and fast-forwarded straight to
// DATA_CAPTURE / purchase confirmation, even though the user was asking a follow-up
// question, not confirming. A message containing a question mark is asking, not confirming.

describe('GroqNlpService.postProcess — isAffirmative question-mark guardrail', () => {
  const service = makeService();

  function affirmativeIntent(): InsuranceIntent {
    return { productCategory: 'mascotas', petType: null, coverage: [], beneficiaries: 1, urgency: 'exploring', isAffirmative: true, isNegative: false, wantsAlternative: false, petResolution: null };
  }

  it('regression — overrides isAffirmative to false when the message contains a question mark', () => {
    const result = postProcess(service, affirmativeIntent(), 'Me interesan mascotas y para mí ¿qué hay?');
    expect(result.isAffirmative).toBe(false);
  });

  it('overrides isAffirmative to false for a plain "?" question mark too', () => {
    const result = postProcess(service, affirmativeIntent(), 'me interesa, pero cuanto cuesta?');
    expect(result.isAffirmative).toBe(false);
  });

  it('does not override isAffirmative when there is no question mark', () => {
    expect(postProcess(service, affirmativeIntent(), 'sí, me interesa').isAffirmative).toBe(true);
  });
});

describe('GroqNlpService.fallbackIntent — isAffirmative question-mark guardrail', () => {
  const service = makeService();

  it('regression — does not mark isAffirmative true for a question containing "me interesa"', () => {
    expect(fallback(service, 'Me interesan mascotas y para mí ¿qué hay?').isAffirmative).toBe(false);
  });

  it('still marks isAffirmative true for plain confirmations without a question mark', () => {
    expect(fallback(service, 'sí, me interesa').isAffirmative).toBe(true);
  });
});

// ── Colombian slang affirmatives (regression) ─────────────────────────────────
// Real live-test bug: "generalo" (Colombian slang for "generate it") was not recognized
// as a confirmation, so the payment-link prompt repeated verbatim instead of proceeding.

describe('GroqNlpService.fallbackIntent — Colombian slang affirmatives', () => {
  const service = makeService();

  it.each([
    'genera',
    'generalo',
    'procede',
    'procédele',
    'hágale',
    'vale',
  ])('"%s" → isAffirmative true', (text) => {
    expect(fallback(service, text).isAffirmative).toBe(true);
  });
});
