// breed-matcher.spec.ts: tests matchBreed and classifyPetsBySpecies against real
// voice-transcription noise, plus fuzz cases for garbage and unlisted breeds.

import { matchBreed, classifyPetsBySpecies, DOG_BREEDS, CAT_BREEDS } from './breed-matcher';

// Real live-test bug: a mixed household's final PDFs both listed all 3 pets instead of
// each policy only listing its own species — PolicyService.issue() needed a way to
// classify which of context.pets belongs to which species.
describe('classifyPetsBySpecies', () => {
  const petsFrom = (breeds: string[]) => breeds.map((breed, i) => ({ name: `P${i}`, age: '1 año', breed }));

  it('classifies exact dog breeds as perro and exact cat breeds as gato', () => {
    const pets = petsFrom(['Doberman', 'Siamés', 'Cocker Spaniel', 'Persa']);
    expect(classifyPetsBySpecies(pets)).toEqual(['perro', 'gato', 'perro', 'gato']);
  });

  it('regression — the exact real-world case: 1 cat (Criollo) + 2 dogs classifies correctly using speciesCounts', () => {
    const pets = petsFrom(['Criollo', 'Doberman', 'Cocker Spaniel']);
    expect(classifyPetsBySpecies(pets, { gato: 1, perro: 2 })).toEqual(['gato', 'perro', 'perro']);
  });

  it('INVARIANT: every pet is classified as gato or perro, never null/undefined, for any breed mix', () => {
    const allBreeds = [...DOG_BREEDS, ...CAT_BREEDS, 'Criollo', 'Mestizo', 'Común', 'Raza Desconocida'];
    for (let i = 0; i < 30; i++) {
      const count = 1 + Math.floor(Math.random() * 5);
      const breeds = Array.from({ length: count }, () => allBreeds[Math.floor(Math.random() * allBreeds.length)]);
      const pets = petsFrom(breeds);
      const result = classifyPetsBySpecies(pets, { gato: count, perro: count });
      expect(result).toHaveLength(count);
      for (const s of result) expect(['gato', 'perro']).toContain(s);
    }
  });
});

describe('matchBreed — real-world voice transcription noise', () => {
  it('regression — "caken" (Whisper mis-transcription of "Cocker") matches Cocker Spaniel', () => {
    expect(matchBreed('caken')).toMatch(/cocker/i);
  });

  it('matches "doberman" exactly (already correct)', () => {
    expect(matchBreed('doberman')).toMatch(/doberman/i);
  });

  it('matches minor typos like "labradr"', () => {
    expect(matchBreed('labradr')).toMatch(/labrador/i);
  });
});

describe('matchBreed — pass-through for valid non-breed-specific answers', () => {
  it.each(['criollo', 'criolla', 'mestizo', 'común', 'comun'])('"%s" is not mangled into an unrelated breed', (input) => {
    const result = matchBreed(input).toLowerCase();
    expect(result).toMatch(/criollo|criolla|mestizo|com[uú]n/);
  });
});

describe('matchBreed — edge cases', () => {
  it('returns "no especificada" for null', () => {
    expect(matchBreed(null)).toBe('no especificada');
  });

  it('returns "no especificada" for undefined', () => {
    expect(matchBreed(undefined)).toBe('no especificada');
  });

  it('returns "no especificada" for an empty string', () => {
    expect(matchBreed('')).toBe('no especificada');
  });

  it('does not throw for garbage input', () => {
    const garbage = ['   ', '!!!', '12345', 'a'.repeat(200), 'ñññ'];
    for (const g of garbage) {
      expect(() => matchBreed(g)).not.toThrow();
    }
  });

  // Real gap: a breed input with no actual letters (pure digits/symbols) fell through
  // to `input.trim()` and printed verbatim on the final policy PDF (e.g. breed: "12345").
  it.each(['12345', '!!!', '----', '$$$'])('returns "no especificada" for digit/symbol-only breed %j, not the raw input', (input) => {
    expect(matchBreed(input)).toBe('no especificada');
  });

  it('leaves a genuinely unlisted breed mostly unchanged rather than force-matching something wrong', () => {
    // "Xoloitzcuintle" is a real breed not in our common-breeds list — should not be
    // silently mangled into an unrelated common breed just because nothing matches well.
    const result = matchBreed('Xoloitzcuintle');
    expect(result.toLowerCase()).toContain('xolo');
  });
});

describe('matchBreed FUZZ', () => {
  it('is idempotent for already-exact known breed names', () => {
    const knownExamples = ['Labrador', 'Siamés', 'Bulldog', 'Poodle', 'Beagle'];
    for (const breed of knownExamples) {
      expect(matchBreed(breed).toLowerCase()).toContain(breed.toLowerCase().split(' ')[0]);
    }
  });

  it('never returns an empty string for non-empty input', () => {
    const inputs = ['x', 'zz', 'qwertyuiop', 'labra2dor', 'Pérez', '  perro  '];
    for (const input of inputs) {
      expect(matchBreed(input).length).toBeGreaterThan(0);
    }
  });

  it('a random digit/symbol-only string (no letters at all) always returns "no especificada" (50 random samples)', () => {
    const pool = '0123456789!@#$%^&*()_+-=';
    for (let i = 0; i < 50; i++) {
      const len = 1 + Math.floor(Math.random() * 20);
      let garbage = '';
      for (let j = 0; j < len; j++) garbage += pool[Math.floor(Math.random() * pool.length)];
      expect(matchBreed(garbage)).toBe('no especificada');
    }
  });
});
