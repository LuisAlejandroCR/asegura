// breed-matcher.ts: fuzzy-matches noisy/mis-transcribed breed names against a dictionary
// of common pet breeds. Voice transcription regularly mangles breed names (e.g. Whisper
// transcribed "Cocker" as "caken") — this maps the noisy input back to the closest known
// breed when the two are close enough, and leaves the raw input alone otherwise (a
// genuinely unlisted or unrecognizable breed shouldn't be silently forced into the wrong
// common one).

const KNOWN_BREEDS = [
  // Perros
  'Labrador', 'Golden Retriever', 'Pastor Alemán', 'Bulldog', 'Bulldog Francés',
  'Chihuahua', 'Poodle', 'Cocker Spaniel', 'Beagle', 'Boxer', 'Rottweiler',
  'Doberman', 'Dálmata', 'Husky Siberiano', 'Pug', 'Schnauzer', 'Shih Tzu',
  'Yorkshire Terrier', 'Pitbull', 'Salchicha', 'Border Collie', 'San Bernardo',
  'Gran Danés', 'Bichón', 'Maltés', 'Basset Hound', 'Akita', 'Chow Chow',
  'Xoloitzcuintle',
  // Gatos
  'Siamés', 'Persa', 'Angora', 'Bengalí', 'Maine Coon', 'Sphynx', 'Ragdoll',
  'Británico de pelo corto', 'Abisinio', 'Himalayo', 'Bombay', 'Azul Ruso',
  // Mestizo/mixto — respuestas válidas, no se "corrigen" a una raza pura
  'Criollo', 'Mestizo', 'Común',
];

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
  if (!normalizedInput) return input.trim();

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

export { matchBreed, KNOWN_BREEDS };
