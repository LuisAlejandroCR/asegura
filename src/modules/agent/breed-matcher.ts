// breed-matcher.ts: fuzzy-matches noisy/mis-transcribed breed names against a dictionary
// of common pet breeds. Voice transcription regularly mangles breed names (e.g. Whisper
// transcribed "Cocker" as "caken") — this maps the noisy input back to the closest known
// breed when the two are close enough, and leaves the raw input alone otherwise (a
// genuinely unlisted or unrecognizable breed shouldn't be silently forced into the wrong
// common one).

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

// Valid answers, not "corrected" to a purebred name — but also not species-specific, so
// a pet with one of these breeds can't be classified by breed alone (see
// classifyPetsBySpecies below).
const AMBIGUOUS_BREEDS = ['Criollo', 'Mestizo', 'Común'];

const KNOWN_BREEDS = [...DOG_BREEDS, ...CAT_BREEDS, ...AMBIGUOUS_BREEDS];

// Fuzzy match is loose on purpose: breed is descriptive only (doesn't affect price,
// eligibility, or coverage in this catalog), so failing to fix an obviously garbled
// transcription and printing it verbatim on a legal document is the worse outcome.
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
  // No actual letters at all (pure digits/symbols) — never print raw garbage on the
  // final policy PDF, treat it the same as "not provided".
  if (!normalizedInput) return 'no especificada';

  let bestMatch: string | null = null;
  let bestScore = Infinity;

  for (const breed of KNOWN_BREEDS) {
    // Check the full breed name AND each individual word (e.g. "Cocker Spaniel" also
    // matches on just "Cocker") so a single-word transcription can still find it.
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

// Real live-test bug: a mixed household (1 cat + 2 dogs) issued two species-specific
// policies (medicina-prepagada-gatos/perros), but both final PDFs listed ALL 3 pets —
// PolicyService.issue() stored the whole context.pets array verbatim for every policy.
// Classifies each pet by its (already breed-matched) breed name: an exact dog/cat breed
// is unambiguous; an ambiguous breed (Criollo/Mestizo/Común, or a genuinely unrecognized
// one) falls back to whichever species still has unfilled slots per speciesCounts — so
// classification always lands on a real species instead of silently dropping a pet.
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
    // No species counts to fall back on (e.g. missing/zeroed speciesCounts) — default to
    // gato rather than throw; this only matters for a genuinely ambiguous breed on a
    // household this function otherwise can't classify at all.
    return 'gato';
  });
}

export { matchBreed, KNOWN_BREEDS, DOG_BREEDS, CAT_BREEDS, classifyPetsBySpecies };
