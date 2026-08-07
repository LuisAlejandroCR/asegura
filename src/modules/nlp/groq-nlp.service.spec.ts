// groq-nlp.service.spec.ts: tests the Groq provider — the 429 retry-once policy, the
// fallback intent when it fails, and the deterministic postProcess guardrails that
// correct or fill in what the LLM got wrong.

import { Logger } from '@nestjs/common';
import { GroqNlpService } from './groq-nlp.service';
import { InsuranceIntent } from './types';
import { F01_CHOICES } from '../agent/agent.service';

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

// 2026-07-26 live-test bug: a real Groq free-tier TPM rate limit (429) hit mid-
// conversation degraded that turn straight to the weaker keyword-only fallbackIntent(),
// with zero attempt to recover, even though Groq's own error body says "Please try again
// in 2.1s". One short, fixed retry should recover most of these before giving up.
describe('GroqNlpService.extractIntent — 429 rate-limit retry', () => {
  const validIntentJson = JSON.stringify({
    productCategory: 'vida', petType: null, petCount: null, coverage: [], beneficiaries: 1,
    urgency: 'exploring', budget: null, abandonIntent: false, priceObjection: false,
    isAffirmative: false, isNegative: false, wantsAlternative: false, petResolution: null,
    petName: null, petAge: null, petBreed: null, pets: [],
  });

  function mockResponse(status: number, body: unknown) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: jest.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
      json: jest.fn().mockResolvedValue(body),
    };
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    (global as any).fetch = undefined;
    jest.useRealTimers();
  });

  it('retries once on a 429 and succeeds if the retry succeeds — no fallback used', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(mockResponse(429, { error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }))
      .mockResolvedValueOnce(mockResponse(200, { choices: [{ message: { content: validIntentJson } }] }));
    (global as any).fetch = fetchMock;

    const config = { get: jest.fn((key: string, def?: unknown) => (key === 'LLM_API_KEY' ? 'gsk_test' : def ?? '')) } as any;
    const service = new GroqNlpService(config);

    const resultPromise = service.extractIntent('quiero un seguro de vida');
    await jest.advanceTimersByTimeAsync(2_500);
    const result = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.productCategory).toBe('vida');
  });

  it('falls back to fallbackIntent when the retry ALSO fails', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(mockResponse(429, { error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }))
      .mockResolvedValueOnce(mockResponse(429, { error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }));
    (global as any).fetch = fetchMock;

    const config = { get: jest.fn((key: string, def?: unknown) => (key === 'LLM_API_KEY' ? 'gsk_test' : def ?? '')) } as any;
    const service = new GroqNlpService(config);

    const resultPromise = service.extractIntent('no tengo mascotas');
    await jest.advanceTimersByTimeAsync(2_500);
    const result = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // fallbackIntent's own keyword logic for this exact phrase — confirms the fallback
    // path actually ran, not a crash or an empty object.
    expect(result.productCategory).toBeNull();
  });

  it('does NOT retry a non-429 error — falls straight to fallback on the first failure', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(mockResponse(500, { error: { message: 'internal error' } }));
    (global as any).fetch = fetchMock;

    const config = { get: jest.fn((key: string, def?: unknown) => (key === 'LLM_API_KEY' ? 'gsk_test' : def ?? '')) } as any;
    const service = new GroqNlpService(config);

    const result = await service.extractIntent('hola');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
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

  // Real live-test bug (2026-07-24): "Somos dos perritos, una gata y yo." — hasDog only
  // checked 'perro'/'perra'/'canino', missing the extremely common "perrito"/"perritos"
  // diminutive (affectionate, everyday Spanish for dogs, especially in casual voice
  // messages). This silently classified a mixed household as 'gato' only, dropping both
  // dogs from the quote.
  it('regression — recognizes the "perrito"/"perritos" diminutive as a dog, not just "perro"/"perra"', () => {
    const intent = baseMascotas('gato');
    expect(postProcess(service, intent, 'somos dos perritos, una gata y yo').petType).toBe('mixto');
  });

  it('does not override petType when category is not mascotas', () => {
    const intent: InsuranceIntent = { productCategory: 'vida', petType: null, coverage: [], beneficiaries: 1, urgency: 'exploring', isAffirmative: false, isNegative: false, wantsAlternative: false, petResolution: null };
    expect(postProcess(service, intent, 'mi gato y mi perro').petType).toBeNull();
  });

  it('preserves existing petType when no pet keywords found', () => {
    const intent = baseMascotas('gato');
    expect(postProcess(service, intent, 'quiero el seguro').petType).toBe('gato');
  });

  // 2026-07-26 live-test bug: "ambos" was incorrectly nullified → re-asked first
  // question. "todos", "para todos", "ambos" all mean "both types" — mixto is correct.
  it('preserves mixto for "para todos" (means both types)', () => {
    const intent = baseMascotas('mixto');
    expect(postProcess(service, intent, 'para todos').petType).toBe('mixto');
  });

  it('preserves mixto for bare "todos" (means both types)', () => {
    const intent = baseMascotas('mixto');
    expect(postProcess(service, intent, 'todos').petType).toBe('mixto');
  });
});

// Real live-test bug (screenshot, 2026-07-25/26): "No, pero no tengo gatos. No sé por
// qué pensaste que tenía gatos..." — an explicit correction DENYING a pet — kept getting
// read as CONFIRMING a cat, because hasCat/hasDog were bare substring checks with no
// awareness of a preceding negation. "no tengo gatos" contains "gato" just like "tengo
// un gato" does.
describe('GroqNlpService.postProcess — negated pet mentions are not confirmations (2026-07-26 live bug)', () => {
  const service = makeService();

  it('does not set petType gato for "no tengo gatos"', () => {
    expect(postProcess(service, baseMascotas(), 'no tengo gatos').petType).toBeNull();
  });

  it('does not set petType perro for "no tengo perros"', () => {
    expect(postProcess(service, baseMascotas(), 'no tengo perros').petType).toBeNull();
  });

  it('does not infer productCategory mascotas from "no tengo mascotas"', () => {
    const intent: InsuranceIntent = { productCategory: null, petType: null, coverage: [], beneficiaries: 1, urgency: 'exploring', isAffirmative: false, isNegative: false, wantsAlternative: false, petResolution: null };
    expect(postProcess(service, intent, 'no tengo mascotas').productCategory).toBeNull();
  });

  it('still confirms the OTHER species when denying one ("no tengo gatos, tengo perros")', () => {
    expect(postProcess(service, baseMascotas(), 'no tengo gatos, tengo perros').petType).toBe('perro');
  });

  it('a real denial does not overwrite an already-confirmed opposite species from context', () => {
    // Regression guard: denying cats while Groq/context already says perro must not
    // reset petType to null via the "no keywords found" branch below it.
    const intent = baseMascotas('perro');
    expect(postProcess(service, intent, 'no tengo gatos').petType).toBe('perro');
  });

  it('still recognizes an affirmative mention elsewhere in the same message ("sin gatos, pero con un perro")', () => {
    expect(postProcess(service, baseMascotas(), 'sin gatos, pero con un perro').petType).toBe('perro');
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

  it('regression — detects mixto in fallback for the "perrito"/"perritos" diminutive', () => {
    expect(fallback(service, 'somos dos perritos, una gata y yo').petType).toBe('mixto');
  });

  // Same 2026-07-26 live bug as postProcess above, but on the path used when Groq's API
  // itself is unreachable — "no tengo gatos" must not fall back to classifying mascotas/
  // gato just because "gato" is a substring of the denial.
  it('regression — "no tengo gatos" does not classify as mascotas category', () => {
    expect(fallback(service, 'no tengo gatos').productCategory).toBeNull();
  });

  it('regression — "no tengo perros" does not set petType perro', () => {
    expect(fallback(service, 'no tengo perros, pero sí quiero un seguro de vida').productCategory).toBe('vida');
  });

  it('returns null productCategory for unrelated text', () => {
    expect(fallback(service, 'hola buenos días').productCategory).toBeNull();
  });

  it('sets abandonIntent for "después"', () => {
    expect(fallback(service, 'lo veo después').abandonIntent).toBe(true);
  });

  // Real lesson from a second live-test conversation (2026-07-24): a user genuinely
  // asking for help ("no lo sé, qué me ofreces?") could be misread as wanting to abandon
  // the conversation entirely — abandonIntent used to fire on ANY message merely
  // containing "no" as a substring, immediately routing to ABANDONED (see
  // processMessage's very first check) and skipping the isNegative-driven "show
  // alternatives" flow that already exists in each state handler for genuine product
  // rejections. abandonIntent should only fire for a clear, deliberate exit signal.
  it('regression — "no lo sé, qué me ofreces?" (asking for help) is not treated as abandonment', () => {
    expect(fallback(service, 'no lo sé, qué me ofreces?').abandonIntent).toBe(false);
  });

  it('regression — rejecting a specific option ("no me interesa") is not treated as abandoning the whole conversation', () => {
    // This is a rejection of ONE option — isNegative (handled separately, shows the
    // next alternative) is the right signal, not abandonIntent (ends the conversation).
    expect(fallback(service, 'no me interesa').abandonIntent).toBe(false);
  });

  it('regression — a name containing "no" as a substring (e.g. "Bruno") does not trigger abandonIntent', () => {
    expect(fallback(service, 'se llama Bruno, tiene 3 años').abandonIntent).toBe(false);
  });

  it('still sets abandonIntent for a clear, deliberate exit phrase ("cancelar")', () => {
    expect(fallback(service, 'quiero cancelar todo').abandonIntent).toBe(true);
  });

  // Real live-test bug (screenshot, 2026-07-25): "terminar" sent right after a quote was
  // shown wasn't recognized as an exit signal at all (missing from this list AND from the
  // Groq prompt's abandonIntent examples), so it fell through to a neutral re-show of the
  // same quote card instead of ending the conversation.
  it('regression — sets abandonIntent for "terminar"', () => {
    expect(fallback(service, 'terminar').abandonIntent).toBe(true);
  });
});

// Per-pet detail extraction (fallback)

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

// Multi-pet "Name, age, breed." period-separated extraction (2026-07-24 live bug)
// Real live-test bug: a 3-pet voice message ("Bruna, 10 años, criollo. Ramón, 3 años,
// cocker. Pancha, 10 años, doberman.") only yielded 2 pets — Bruna was silently dropped
// (Groq's own extraction under-counted a compound sentence), and the user's later
// attempt to provide the "missing" pet re-stated Pancha instead, producing a literal
// duplicate that reached the paid, issued policy. This comma-triple, period-separated
// shape is a completely different pattern from the "se llama X" one already handled —
// existing extractPetName only matches "se llama"/"llamado"/"nombre es" phrasing, so it
// returned null for this message entirely.
describe('GroqNlpService.fallbackIntent — "Name, age, breed." period-separated multi-pet extraction', () => {
  const service = makeService();

  it('extracts all 3 pets from the exact real-world message shape', () => {
    const result = fallback(service, 'Bruna, 10 años, criollo. Ramón, 3 años, cocker. Pancha, 10 años, doberman.');
    expect(result.pets).toEqual([
      { name: 'Bruna', age: '10 años', breed: 'criollo' },
      { name: 'Ramón', age: '3 años', breed: 'cocker' },
      { name: 'Pancha', age: '10 años', breed: 'doberman' },
    ]);
  });

  it('extracts a single pet in the same comma-triple shape without a trailing period', () => {
    const result = fallback(service, 'Rocky, 5 años, labrador');
    expect(result.pets).toEqual([{ name: 'Rocky', age: '5 años', breed: 'labrador' }]);
  });

  // Real live-test bug: sending pets one message at a time, each in this same
  // comma-triple shape, but with the age spoken as a WORD ("tres años", "ocho años") —
  // very common in voice dictation — instead of a digit. extractPetAge only recognized
  // digit-form ages, so the age silently fell through into breed instead ("Ramón — no
  // especificada — tres años, dobermana" in the final summary).
  it('regression — recognizes Spanish word-form ages ("tres años") instead of leaking them into breed', () => {
    const result = fallback(service, 'Bruna, diez años, criolla. Ramón, tres años, dobermana. Pancha, ocho años, cocker.');
    expect(result.pets).toEqual([
      { name: 'Bruna', age: '10 años', breed: 'criolla' },
      { name: 'Ramón', age: '3 años', breed: 'dobermana' },
      { name: 'Pancha', age: '8 años', breed: 'cocker' },
    ]);
  });

  // Real live-test bug (2026-07-26, screenshot): the user clarified "Solo es Bruna."
  // ("it's only Bruna" — i.e. there's just ONE pet, not two) right after describing
  // Bruna — but the trailing clause "Solo es Bruna" has no comma, so the old parser
  // accepted its leading capitalized word ("Solo") as a second pet's name with no age or
  // breed, corrupting the paid, issued policy with a phantom pet. A real pet-description
  // clause in this parser's own shape always has at least 2 comma-separated parts
  // (name + age/breed) — a lone comma-free clause is a side remark, not a pet.
  it('regression — "Solo es Bruna." (a clarifying remark, no comma) is never mistaken for a second pet', () => {
    const result = fallback(service, 'Bruna, 10 años, criollo. Solo es Bruna.');
    expect(result.pets).toEqual([{ name: 'Bruna', age: '10 años', breed: 'criollo' }]);
  });

  it('regression — a comma-free trailing remark ("Eso es todo.") is never mistaken for a second pet', () => {
    const result = fallback(service, 'Max, 3 años, labrador. Eso es todo.');
    expect(result.pets).toEqual([{ name: 'Max', age: '3 años', breed: 'labrador' }]);
  });
});

// postProcess must override Groq's own `pets` array when Groq under-counted a
// compound sentence — the SAME deterministic-wins-over-LLM policy already applied to
// petCount/petType above, now extended to the pets list itself since an undercount here
// corrupts who's actually insured on the final policy.
describe('GroqNlpService.postProcess — pets undercount override (2026-07-24 live bug)', () => {
  const service = makeService();
  const text = 'Bruna, 10 años, criollo. Ramón, 3 años, cocker. Pancha, 10 años, doberman.';

  function makeIntentWithPets(pets: { name: string; age: string | null; breed: string | null }[]) {
    return {
      productCategory: 'mascotas', petType: null, coverage: [], beneficiaries: 1,
      urgency: 'exploring', isAffirmative: false, isNegative: false, wantsAlternative: false,
      petResolution: null, pets,
    } as any;
  }

  it('overrides a 2-pet Groq result with the deterministic 3-pet extraction when Groq dropped one', () => {
    const groqIntent = makeIntentWithPets([
      { name: 'Ramón', age: '3 años', breed: 'cocker' },
      { name: 'Pancha', age: '10 años', breed: 'doberman' },
    ]);
    const result = postProcess(service, groqIntent, text);
    expect(result.pets).toEqual([
      { name: 'Bruna', age: '10 años', breed: 'criollo' },
      { name: 'Ramón', age: '3 años', breed: 'cocker' },
      { name: 'Pancha', age: '10 años', breed: 'doberman' },
    ]);
  });

  it('does not touch a Groq pets array that already has at least as many entries as the deterministic parser found', () => {
    const groqIntent = makeIntentWithPets([
      { name: 'Bruna', age: '10 años', breed: 'criollo' },
      { name: 'Ramón', age: '3 años', breed: 'cocker' },
      { name: 'Pancha', age: '10 años', breed: 'doberman' },
    ]);
    const result = postProcess(service, groqIntent, text);
    expect(result.pets).toEqual(groqIntent.pets);
  });

  it('leaves pets alone for a free-form single-pet message the deterministic parser cannot improve on', () => {
    const groqIntent = makeIntentWithPets([{ name: 'Rocky', age: '5 años', breed: 'labrador' }]);
    const result = postProcess(service, groqIntent, 'Rocky tiene 5 años y es labrador');
    expect(result.pets).toEqual([{ name: 'Rocky', age: '5 años', breed: 'labrador' }]);
  });

  // Real live-test regression introduced by the fix above: Groq's OWN prompt tells it to
  // use the singular petName/petAge/petBreed fields (not pets[]) for a message describing
  // ONE pet, and pets[] legitimately comes back empty in that case. The override must
  // never treat "deterministic found 1, Groq's pets[] has 0" as evidence of an undercount
  // — that's the expected shape for a single-pet message, and clobbering it with the
  // single-clause deterministic parser corrupts perfectly good data. Live bug: sending
  // pets one at a time ("Ramón, tres años, dobermana.") came back with age "no
  // especificada" and breed "tres años, dobermana" in the final summary — the
  // deterministic parser's OWN weaker single-clause read overwrote Groq's correct
  // singular-field extraction.
  it('regression — never overrides when Groq legitimately used the singular fields for a one-pet message (pets: [])', () => {
    const groqIntent = makeIntentWithPets([]);
    const result = postProcess(service, groqIntent, 'Ramón, tres años, dobermana.');
    expect(result.pets).toEqual([]);
  });
});

// Fuzz / property-based tests

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

// wantsAlternative extraction

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

// Real live-test bug (2026-07-25): user said "Otra opción." right after a quote was
// shown. Groq (the primary path, not the fallback) classified it as isAffirmative=true
// instead of wantsAlternative — the conversation jumped straight to phone verification /
// purchase confirmation instead of showing a different product. postProcess had no
// deterministic override for wantsAlternative at all (only the fallback path did), so a
// wrong LLM guess went straight through uncorrected.
describe('GroqNlpService.postProcess — wantsAlternative deterministic override (2026-07-25 live bug)', () => {
  const service = makeService();

  function wronglyAffirmative(): InsuranceIntent {
    return {
      productCategory: 'vida', petType: null, coverage: [], beneficiaries: 1,
      urgency: 'exploring', isAffirmative: true, isNegative: false,
      wantsAlternative: false, petResolution: null,
    };
  }

  it('regression — "Otra opción." forces wantsAlternative=true and isAffirmative=false even when Groq said isAffirmative=true', () => {
    const result = postProcess(service, wronglyAffirmative(), 'Otra opción.');
    expect(result.wantsAlternative).toBe(true);
    expect(result.isAffirmative).toBe(false);
  });

  it.each([
    'otro',
    'otra opción',
    'diferente',
    'muéstrame más',
    'cambia',
    'siguiente cotización',
    'hay otra',
  ])('"%s" forces wantsAlternative=true and isAffirmative=false via postProcess too', (text) => {
    const result = postProcess(service, wronglyAffirmative(), text);
    expect(result.wantsAlternative).toBe(true);
    expect(result.isAffirmative).toBe(false);
  });

  it('does not force wantsAlternative when the text has no alternative-request keyword', () => {
    const result = postProcess(service, wronglyAffirmative(), 'sí, me interesa');
    expect(result.wantsAlternative).toBe(false);
    expect(result.isAffirmative).toBe(true);
  });
});

// Real live-test bug (2026-07-26): "No, no quiero Ezequial porque ya tengo. Explícame de
// qué se trata." has no '?'/'¿' (ASR drops it), so the question-mark guardrail doesn't
// save it, and it names no alternative product, so wantsAlternativeText's override
// doesn't fire either. isAffirmativeText's bare 'quiero'/'me interesa' substrings have no
// negation guard at all — unlike every other keyword trap in this file — so this could
// leave isAffirmative=true on an explicit decline and route straight to phone-
// verification/KYC for the product just declined. Same override pattern as
// wantsAlternative just above: a deterministic decline phrase always wins.
describe('GroqNlpService.postProcess — negated desire deterministic override (2026-07-26 live bug)', () => {
  const service = makeService();

  function wronglyAffirmative(): InsuranceIntent {
    return {
      productCategory: 'vida', petType: null, coverage: [], beneficiaries: 1,
      urgency: 'exploring', isAffirmative: true, isNegative: false,
      wantsAlternative: false, petResolution: null,
    };
  }

  it('regression — "No, no quiero Ezequial porque ya tengo. Explícame de qué se trata." forces isAffirmative=false, isNegative=true even when Groq said isAffirmative=true', () => {
    const result = postProcess(service, wronglyAffirmative(), 'No, no quiero Ezequial porque ya tengo. Explícame de qué se trata.');
    expect(result.isAffirmative).toBe(false);
    expect(result.isNegative).toBe(true);
  });

  it.each([
    'no quiero eso',
    'no deseo continuar',
    'no me interesa ese plan',
  ])('"%s" forces isAffirmative=false, isNegative=true via postProcess too', (text) => {
    const result = postProcess(service, wronglyAffirmative(), text);
    expect(result.isAffirmative).toBe(false);
    expect(result.isNegative).toBe(true);
  });

  it('does not force the override when there is no negated-desire phrase (regression guard)', () => {
    const result = postProcess(service, wronglyAffirmative(), 'sí, quiero ese');
    expect(result.isAffirmative).toBe(true);
    expect(result.isNegative).toBe(false);
  });
});

// Real live-test bug (2026-07-26): "Quiero ese." (a clear, unambiguous confirmation, no
// question mark) got re-shown the same quote instead of advancing to phone verification.
// Every existing override in postProcess only ever turns isAffirmative OFF (question
// mark, wantsAlternative, denied desire) — nothing corrected Groq's own occasional
// under-detection back to true. fallbackIntent already trusts isAffirmativeText as its
// primary signal; the primary (Groq) path needed the same deterministic floor.
describe('GroqNlpService.postProcess — positive confirmation deterministic floor (2026-07-26 live bug)', () => {
  const service = makeService();

  function wronglyNegative(): InsuranceIntent {
    return {
      productCategory: 'vida', petType: null, coverage: [], beneficiaries: 1,
      urgency: 'exploring', isAffirmative: false, isNegative: false,
      wantsAlternative: false, petResolution: null,
    };
  }

  it('regression — "Quiero ese." forces isAffirmative=true even when Groq said isAffirmative=false', () => {
    const result = postProcess(service, wronglyNegative(), 'Quiero ese.');
    expect(result.isAffirmative).toBe(true);
  });

  it.each([
    'Dame ese',
    'Listo',
    'Confirmo',
  ])('"%s" also forces isAffirmative=true when Groq under-detected it', (text) => {
    const result = postProcess(service, wronglyNegative(), text);
    expect(result.isAffirmative).toBe(true);
  });

  it('does NOT force isAffirmative when the text is a genuine question ("¿Quiero ese?" stays false)', () => {
    const result = postProcess(service, wronglyNegative(), '¿Quiero ese?');
    expect(result.isAffirmative).toBe(false);
  });

  it('does NOT force isAffirmative when the text names an alternative request instead', () => {
    const result = postProcess(service, wronglyNegative(), 'Otra opción, por favor');
    expect(result.isAffirmative).toBe(false);
  });

  it('does NOT force isAffirmative when the text is a negated decline ("no quiero ese")', () => {
    const result = postProcess(service, wronglyNegative(), 'no quiero ese');
    expect(result.isAffirmative).toBe(false);
  });

  it('regression guard — still correctly overrides to false for an unambiguous alternative request even when Groq wrongly said true', () => {
    const wronglyAffirmative: InsuranceIntent = { ...wronglyNegative(), isAffirmative: true };
    const result = postProcess(service, wronglyAffirmative, 'Otra opción.');
    expect(result.isAffirmative).toBe(false);
    expect(result.wantsAlternative).toBe(true);
  });

  // Real live-test bug (2026-07-26, screenshot): the floor above requires
  // `!intent.wantsAlternative` to fire, but Groq occasionally ALSO misclassifies
  // "Quiero ese." with wantsAlternative=true — its own few-shot example for
  // wantsAlternative literally contains the phrase "no ese, otro", a plausible source of
  // confusion for an 8B model reading "ese" as wanting a DIFFERENT option. That blocked
  // the floor from ever correcting course, leaving the quote card re-shown identically
  // instead of advancing to phone verification. A deictic confirmation this unambiguous
  // must override wantsAlternative too, not just be blocked by it.
  it('regression — "Quiero ese." forces isAffirmative=true even when Groq ALSO wrongly set wantsAlternative=true', () => {
    const wronglyWantsAlternative: InsuranceIntent = { ...wronglyNegative(), wantsAlternative: true };
    const result = postProcess(service, wronglyWantsAlternative, 'Quiero ese.');
    expect(result.isAffirmative).toBe(true);
    expect(result.wantsAlternative).toBe(false);
  });

  it('regression — "dame ese"/"deme ese" also override a wrongly-set wantsAlternative=true', () => {
    const wronglyWantsAlternative: InsuranceIntent = { ...wronglyNegative(), wantsAlternative: true };
    expect(postProcess(service, wronglyWantsAlternative, 'Dame ese').isAffirmative).toBe(true);
    expect(postProcess(service, wronglyWantsAlternative, 'Deme ese').wantsAlternative).toBe(false);
  });
});

describe('GroqNlpService.fallbackIntent — negated desire deterministic override (2026-07-26 live bug)', () => {
  const service = makeService();

  it('regression — "No, no quiero Ezequial porque ya tengo. Explícame de qué se trata." → isAffirmative=false, isNegative=true', () => {
    const result = fallback(service, 'No, no quiero Ezequial porque ya tengo. Explícame de qué se trata.');
    expect(result.isAffirmative).toBe(false);
    expect(result.isNegative).toBe(true);
  });

  it.each([
    'no quiero eso',
    'no deseo continuar',
    'no me interesa ese plan',
  ])('"%s" → isAffirmative=false, isNegative=true', (text) => {
    const result = fallback(service, text);
    expect(result.isAffirmative).toBe(false);
    expect(result.isNegative).toBe(true);
  });

  // Regression guards — a positive, non-negated "quiero" must keep confirming exactly as
  // before; this is a scoped override, not a removal of 'quiero' as an affirmative signal.
  it.each([
    'sí quiero ese',
    'quiero comprarlo',
    'quiero ese',
  ])('"%s" still yields isAffirmative=true (no false positive from the new override)', (text) => {
    expect(fallback(service, text).isAffirmative).toBe(true);
  });
});

// petResolution extraction

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
    ['mi perrito', 'perro'],
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

// productCategory inference from petType

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
    expect(postProcess(service, noCategory(), 'no sé qué quiero todavía').productCategory).toBeNull();
  });

  // Real live-test bug (2026-07-26): this used to assert productCategory stays null for
  // "necesito proteger a mi familia" — true for MASCOTAS specifically (no pet keyword
  // here), but wrong to generalize: "familia" is (and always was, in fallbackIntent) a
  // real vida keyword. Tapping the F01 "❤️ Mi familia" button got "No logré entender
  // bien eso." instead of proceeding, because Groq itself sometimes fails to classify a
  // short emoji-prefixed label and this guardrail used to only ever infer 'mascotas',
  // never 'vida'/'asistencia'/'accidentes'. Now shares fallbackIntent's own keyword map.
  it('regression — infers productCategory vida from "familia" when Groq returns null (the F01 "Mi familia" button case)', () => {
    expect(postProcess(service, noCategory(), 'necesito proteger a mi familia').productCategory).toBe('vida');
  });

  it('does NOT override productCategory when Groq already set it', () => {
    const intent: InsuranceIntent = { ...noCategory(), productCategory: 'vida' };
    expect(postProcess(service, intent, 'mi gato').productCategory).toBe('vida');
  });
});

// petType inference when Groq returns productCategory=null (regression)
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

// isAffirmative question-mark guardrail (regression)
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

  // Real live-test bug (2026-07-24): during a pet-details correction loop, "¿Sí está
  // bien?" and "sí?" got forced to isAffirmative=false by this same guardrail — but
  // these are genuine confirmations phrased as a tag question (a common Spanish
  // pattern), not a follow-up question like "¿me interesan los descuentos?". The user
  // could never confirm and leave the correction loop, and the corrupted pet data
  // (a duplicated pet, a missing one) made it all the way into the final, paid policy.
  it('regression — a standalone "sí" is NOT overridden even with a trailing question mark ("sí?")', () => {
    expect(postProcess(service, affirmativeIntent(), 'sí?').isAffirmative).toBe(true);
  });

  it('regression — "¿Sí está bien?" (confirmation tag question) stays affirmative', () => {
    expect(postProcess(service, affirmativeIntent(), '¿Sí está bien?').isAffirmative).toBe(true);
  });

  it('still overrides when the question has no standalone sí/si word, even if it contains "si" as a substring', () => {
    // "asistencia" contains "si" as a substring but not as its own word — must not
    // accidentally exempt an unrelated question from the guardrail.
    const result = postProcess(service, affirmativeIntent(), '¿la asistencia veterinaria qué cubre?');
    expect(result.isAffirmative).toBe(false);
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

  it('regression — "¿Sí está bien?" stays affirmative in the fallback path too', () => {
    expect(fallback(service, '¿Sí está bien?').isAffirmative).toBe(true);
  });
});

// Colombian slang affirmatives (regression)
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

// Real live-test bug (2026-07-24): after a quote card, "Dame ese" (voice-transcribed,
// Colombian Spanish for "give me that one" — a clear purchase confirmation) was not
// recognized as an affirmative. handleQuotation's fallback branch then re-showed the
// IDENTICAL quote card instead of advancing to phone verification — reading to the user
// as the agent ignoring their confirmation and "showing another insurance".
describe('GroqNlpService.fallbackIntent — deictic confirmations ("dame ese", "quiero ese")', () => {
  const service = makeService();

  it.each([
    'Dame ese',
    'dame ese',
    'Deme ese',
    // "quiero ese" was named in this describe block's own title since 2026-07-24 but
    // never actually tested — a real gap, closed 2026-07-26.
    'Quiero ese',
    'quiero ese',
    'Quiero esa',
  ])('"%s" → isAffirmative true', (text) => {
    expect(fallback(service, text).isAffirmative).toBe(true);
  });

  it('"¿Quiero ese?" stays a genuine question, not a confirmation (not exempt from the question-mark rule, unlike a standalone "sí?")', () => {
    expect(fallback(service, '¿Quiero ese?').isAffirmative).toBe(false);
  });

  it('"no quiero ese" is an explicit decline, never forced to a confirmation', () => {
    const result = fallback(service, 'no quiero ese');
    expect(result.isAffirmative).toBe(false);
    expect(result.isNegative).toBe(true);
  });

  // Real live-test bug (2026-07-26, screenshot): the deictic-confirmation override must
  // win over wantsAlternativeText too — nothing in "quiero ese"/"dame ese" itself would
  // trip wantsAlternativeText, but this guards the override's own completeness the same
  // way the postProcess regression test does for the primary path.
  it('regression — the deictic confirmation also forces wantsAlternative to false', () => {
    expect(fallback(service, 'Quiero ese').wantsAlternative).toBe(false);
    expect(fallback(service, 'Dame ese').wantsAlternative).toBe(false);
  });
});

// Deterministic petCount extraction (2026-07-24 regression)
// Real live-test bug: "Tengo dos mascotas y yo." was quoted and charged for 3 mascotas,
// not 2 — petCount had zero deterministic validation, unlike petType/petResolution
// (both cross-checked against the raw text regardless of what the LLM returned).
// petCount directly multiplies the price (computeTotalPremium), so trusting an 8B
// model's free-form count has real financial impact. Same override policy as petType:
// an explicit, unambiguous count in the text always wins over whatever the LLM said.

describe('GroqNlpService.postProcess — deterministic petCount extraction', () => {
  const service = makeService();

  it('regression — overrides an LLM-hallucinated count when the text explicitly states a different one', () => {
    const intent = { ...baseMascotas(), petCount: 3 };
    expect(postProcess(service, intent, 'tengo dos mascotas y yo').petCount).toBe(2);
  });

  it('sets petCount from an explicit word-number when the LLM returned null', () => {
    const intent = { ...baseMascotas(), petCount: null };
    expect(postProcess(service, intent, 'tengo dos mascotas').petCount).toBe(2);
  });

  it('recognizes digit form ("4 mascotas")', () => {
    const intent = { ...baseMascotas(), petCount: null };
    expect(postProcess(service, intent, 'tengo 4 mascotas').petCount).toBe(4);
  });

  it('sums mixed species mentioned together ("un gato y dos perros" → 3)', () => {
    const intent = { ...baseMascotas(), petCount: null };
    expect(postProcess(service, intent, 'un gato y dos perros').petCount).toBe(3);
  });

  // Regression: postProcess mutates the intent object it's given (returns the same
  // reference), so reusing ONE intent object across two assertions in the same test lets
  // the second assertion coincidentally pass on the STALE value left by the first,
  // masking a real extraction failure. "una gata" never actually matched the old
  // masculine-only "gatos?" pattern — the second assertion below only ever passed
  // because the first call had already set petCount to 1. Each case now gets its own
  // fresh intent object.
  it('recognizes "un" as 1', () => {
    const intent = { ...baseMascotas(), petCount: null };
    expect(postProcess(service, intent, 'tengo un perro').petCount).toBe(1);
  });

  it('regression — recognizes "una" + a feminine noun ("gata") as 1, not just masculine "gato"', () => {
    const intent = { ...baseMascotas(), petCount: null };
    expect(postProcess(service, intent, 'tengo una gata').petCount).toBe(1);
  });

  // Real live-test bug (2026-07-24): "Somos dos perritos, una gata y yo." — neither
  // "perritos" (diminutive) nor "gata" (feminine) matched the old masculine/canonical-only
  // pattern, so this exact live message got NO deterministic count at all, falling back
  // fully to the LLM's unvalidated guess.
  it('regression — sums diminutive/feminine pet nouns together ("dos perritos, una gata" → 3)', () => {
    const intent = { ...baseMascotas(), petCount: null };
    expect(postProcess(service, intent, 'somos dos perritos, una gata y yo').petCount).toBe(3);
  });

  it('recognizes the "gatico"/"gatica" Colombian diminutive variant too', () => {
    const intent = { ...baseMascotas(), petCount: null };
    expect(postProcess(service, intent, 'tengo dos gaticas').petCount).toBe(2);
  });

  it('leaves the LLM value untouched when the text has no explicit count phrase', () => {
    const intent = { ...baseMascotas(), petCount: 1 };
    expect(postProcess(service, intent, 'mi perro está bien').petCount).toBe(1);
  });
});

describe('GroqNlpService.fallbackIntent — deterministic petCount extraction', () => {
  const service = makeService();

  it('regression — the fallback path never set petCount at all before this fix', () => {
    expect(fallback(service, 'tengo dos gatos').petCount).toBe(2);
  });

  it('sums mixed species in the fallback path too', () => {
    expect(fallback(service, 'un gato y dos perros').petCount).toBe(3);
  });

  it('returns null when no explicit count is stated', () => {
    expect(fallback(service, 'mi perro está bien').petCount).toBeNull();
  });
});

// Step 3: `dependents` extraction (2026-07-26)
// Not in Groq's JSON schema at all — this deterministic extraction is the ONLY source
// for this field in both the primary (postProcess) and fallback paths.
describe('GroqNlpService.fallbackIntent — dependents extraction', () => {
  const service = makeService();

  it('"vivo solo" → 0', () => {
    expect(fallback(service, 'vivo solo').dependents).toBe(0);
  });

  it('"no tengo hijos" → 0', () => {
    expect(fallback(service, 'no tengo hijos').dependents).toBe(0);
  });

  it('an explicit count with "hijos" → that number', () => {
    expect(fallback(service, 'tengo dos hijos').dependents).toBe(2);
  });

  it('an explicit digit count with "personas a cargo" → that number', () => {
    expect(fallback(service, 'tengo 3 personas a cargo').dependents).toBe(3);
  });

  it('a named family member with no explicit count → conservative floor of 1', () => {
    expect(fallback(service, 'vivo con mi esposa').dependents).toBe(1);
  });

  it('no dependents signal at all → null (never asked/answered)', () => {
    expect(fallback(service, 'quiero un seguro de vida').dependents).toBeNull();
  });
});

describe('GroqNlpService.postProcess — dependents extraction', () => {
  const service = makeService();

  it('sets dependents from the deterministic extractor regardless of what Groq returned', () => {
    const intent = baseMascotas();
    expect(postProcess(service, intent, 'tengo dos hijos').dependents).toBe(2);
  });

  it('"vivo solo" → 0 via postProcess too', () => {
    const intent = baseMascotas();
    expect(postProcess(service, intent, 'vivo solo').dependents).toBe(0);
  });

  it('no signal → null via postProcess too', () => {
    const intent = baseMascotas();
    expect(postProcess(service, intent, 'mi gato está bien').dependents).toBeNull();
  });
});

// Step 4: F01 button label → parser invariant
// The highest-value test for the hybrid-buttons feature: a label is a PROMISE the NLP
// parser must actually honor. Imports the SAME array AgentService presents as buttons
// (F01_CHOICES) — not a hand-copied duplicate — so this test breaks the moment the two
// drift apart. Calls fallbackIntent directly so it's deterministic and never hits the
// network (real risk found while designing this: isAffirmativeText's bare 'dame'/'todas'
// substrings and "no" inside "No estoy seguro" are exactly the kind of trap this guards).
describe('GroqNlpService.fallbackIntent — F01 button label invariant (Step 4)', () => {
  const service = makeService();

  const categoryLabels: [string, NonNullable<InsuranceIntent['productCategory']>][] = [
    ['❤️ Mi familia', 'vida'],
    ['🏥 Mi salud', 'asistencia'],
    ['🐾 Mi mascota', 'mascotas'],
    ['🤕 Accidentes', 'accidentes'],
  ];

  it.each(categoryLabels)('"%s" → productCategory "%s", isAffirmative=false, abandonIntent=false', (label, expectedCategory) => {
    const result = fallback(service, label.toLowerCase());
    expect(result.productCategory).toBe(expectedCategory);
    expect(result.isAffirmative).toBe(false);
    expect(result.abandonIntent).toBe(false);
  });

  it('"🤔 No estoy seguro" never confirms or abandons (its productCategory is deliberately null — no button forces a category)', () => {
    const result = fallback(service, '🤔 No estoy seguro'.toLowerCase());
    expect(result.isAffirmative).toBe(false);
    expect(result.abandonIntent).toBe(false);
  });

  it('every F01_CHOICES label is covered by this invariant (catches a label added without a matching test)', () => {
    const coveredLabels = [...categoryLabels.map(([label]) => label), '🤔 No estoy seguro'];
    expect(new Set(F01_CHOICES)).toEqual(new Set(coveredLabels));
  });
});

// Real live-test bug (2026-07-26, screenshot): tapping "❤️ Mi familia" got "No logré
// entender bien eso." plus the DISCOVERY question repeated verbatim, instead of
// proceeding with productCategory='vida'. The invariant above only ever proved
// fallbackIntent honors the F01 label promise — but Groq itself (the PRIMARY path,
// actually used whenever it's up) has zero prompt examples for these short
// emoji-prefixed labels and can fail to classify one on its own; postProcess's own
// productCategory guardrail used to only ever infer 'mascotas' in that case, leaving
// vida/asistencia/accidentes buttons with no floor to fall back on at all. This proves
// the SAME promise holds for postProcess when Groq returns productCategory=null.
describe('GroqNlpService.postProcess — F01 button label invariant, primary path (2026-07-26 regression)', () => {
  const service = makeService();

  function groqReturnedNull(): InsuranceIntent {
    return {
      productCategory: null, petType: null, coverage: [], beneficiaries: 1,
      urgency: 'exploring', isAffirmative: false, isNegative: false,
      wantsAlternative: false, petResolution: null,
    };
  }

  const categoryLabels: [string, NonNullable<InsuranceIntent['productCategory']>][] = [
    ['❤️ Mi familia', 'vida'],
    ['🏥 Mi salud', 'asistencia'],
    ['🐾 Mi mascota', 'mascotas'],
    ['🤕 Accidentes', 'accidentes'],
  ];

  it.each(categoryLabels)('"%s" → productCategory "%s" even when Groq itself returned null', (label, expectedCategory) => {
    const result = postProcess(service, groqReturnedNull(), label);
    expect(result.productCategory).toBe(expectedCategory);
  });

  it('does NOT force a category for "🤔 No estoy seguro" — no button forces a category', () => {
    expect(postProcess(service, groqReturnedNull(), '🤔 No estoy seguro').productCategory).toBeNull();
  });
});
