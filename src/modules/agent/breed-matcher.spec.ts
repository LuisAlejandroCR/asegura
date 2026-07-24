import { matchBreed } from './breed-matcher';

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
});
