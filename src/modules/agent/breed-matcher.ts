// breed-matcher.ts: fuzzy-matches noisy or mis-transcribed breed names against a dictionary
// of common breeds (Whisper turns "Cocker" into "caken"), and leaves the raw input alone
// when nothing is close enough.

const DOG_BREEDS = [
  'Labrador', 'Golden Retriever', 'Pastor Alemán', 'Bulldog', 'Bulldog Francés',
  'Chihuahua', 'Poodle', 'Cocker Spaniel', 'Beagle', 'Boxer', 'Rottweiler',
  'Doberman', 'Dálmata', 'Husky Siberiano', 'Pug', 'Schnauzer', 'Shih Tzu',
  'Yorkshire Terrier', 'Pitbull', 'Salchicha', 'Border Collie', 'San Bernardo',
  'Gran Danés', 'Bichón', 'Maltés', 'Basset Hound', 'Akita', 'Chow Chow',
  'Xoloitzcuintle',
];

const CAT_BREEDS = [
  'Siamés', 'Persa', 'Angora', 'Bengalí', 'Maine Coon', 'Sphynx', 'Ragdoll',
  'Británico de pelo corto', 'Abisinio', 'Himalayo', 'Bombay', 'Azul Ruso',
];

// Valid answers, not "corrected" to a purebred name — but not species-specific either, so
// breed alone can't classify them (see classifyPetsBySpecies below).
const AMBIGUOUS_BREEDS = ['Criollo', 'Mestizo', 'Común'];

const KNOWN_BREEDS = [...DOG_BREEDS, ...CAT_BREEDS, ...AMBIGUOUS_BREEDS];

// Loose on purpose: breed is descriptive only (no effect on price, eligibility or coverage),
// so printing a garbled transcription on a legal document is the worse outcome.
const MATCH_THRESHOLD = 0.5;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, '')
    .trim();
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function matchBreed(input: string | null | undefined): string {
  if (!input || !input.trim()) return 'no especificada';

  const normalizedInput = normalize(input);
  // No letters at all: treat pure digits/symbols as "not provided" rather than print garbage.
  if (!normalizedInput) return 'no especificada';

  let bestMatch: string | null = null;
  let bestScore = Infinity;

  for (const breed of KNOWN_BREEDS) {
    // Match the full name and each word, so "Cocker" alone still finds "Cocker Spaniel".
    const candidates = [breed, ...breed.split(' ')];
    for (const candidate of candidates) {
      const normalizedCandidate = normalize(candidate);
      if (!normalizedCandidate) continue;
      const distance = levenshtein(normalizedInput, normalizedCandidate);
      const maxLen = Math.max(normalizedInput.length, normalizedCandidate.length);
      const score = maxLen === 0 ? 1 : distance / maxLen;
      if (score < bestScore) {
        bestScore = score;
        bestMatch = breed;
      }
    }
  }

  return bestMatch && bestScore <= MATCH_THRESHOLD ? bestMatch : input.trim();
}

// Classifies each pet by its already-matched breed so a species-restricted policy lists
// only its own pets. An ambiguous breed (Criollo/Mestizo) falls back to whichever species
// still has unfilled slots, so classification never drops a pet.
function classifyPetsBySpecies(
  pets: { name: string; age: string; breed: string }[],
  speciesCounts?: { gato?: number; perro?: number },
): ('gato' | 'perro')[] {
  const provisional: ('gato' | 'perro' | null)[] = pets.map((p) => {
    if (DOG_BREEDS.includes(p.breed)) return 'perro';
    if (CAT_BREEDS.includes(p.breed)) return 'gato';
    return null;
  });

  let gatoRemaining = (speciesCounts?.gato ?? 0) - provisional.filter((s) => s === 'gato').length;
  let perroRemaining = (speciesCounts?.perro ?? 0) - provisional.filter((s) => s === 'perro').length;

  return provisional.map((s) => {
    if (s) return s;
    if (gatoRemaining > 0) { gatoRemaining--; return 'gato'; }
    if (perroRemaining > 0) { perroRemaining--; return 'perro'; }
    // No counts to fall back on: default to gato rather than throw.
    return 'gato';
  });
}

export { matchBreed, KNOWN_BREEDS, DOG_BREEDS, CAT_BREEDS, classifyPetsBySpecies };
