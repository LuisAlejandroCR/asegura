// groq-nlp.service.ts: the Groq implementation of INlpProvider, over Groq's OpenAI-compatible
// API. Deterministic post-processing corrects the model wherever the text itself is unambiguous.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { INlpProvider, InsuranceIntent } from './types';

// Tagged so extractIntent can retry a 429 once instead of falling straight to fallbackIntent().
class GroqRateLimitError extends Error {}

@Injectable()
export class GroqNlpService implements INlpProvider {
  private readonly logger = new Logger(GroqNlpService.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl = 'https://api.groq.com/openai/v1';

  constructor(private readonly config: ConfigService) {
    this.apiKey = config.get<string>('LLM_API_KEY', '');
    this.model = config.get<string>('LLM_MODEL', 'openai/gpt-oss-120b');

    // Every other optional integration warns at boot; this one used to stay silent either way.
    if (!this.apiKey) {
      this.logger.warn('LLM_API_KEY not set — NLP falls back to keyword-only matching, voice transcription disabled');
    }
  }

  get isEnabled(): boolean {
    return !!this.apiKey;
  }

  // One short fixed retry on a 429 — not a backoff library, latency matters in real-time chat.
  // Any other error still falls straight through to fallbackIntent().
  private static readonly RATE_LIMIT_RETRY_DELAY_MS = 2_500;

  async extractIntent(text: string, history?: Array<{ role: string; text: string }>): Promise<InsuranceIntent> {
    try {
      return await this.callGroq(text, history);
    } catch (err) {
      if (err instanceof GroqRateLimitError) {
        this.logger.warn(`Groq rate-limited, retrying once in ${GroqNlpService.RATE_LIMIT_RETRY_DELAY_MS}ms: ${err.message}`);
        await new Promise((resolve) => setTimeout(resolve, GroqNlpService.RATE_LIMIT_RETRY_DELAY_MS));
        try {
          return await this.callGroq(text, history);
        } catch (retryErr) {
          this.logger.warn(`Groq retry failed, using fallback: ${retryErr}`);
          return this.fallbackIntent(text);
        }
      }
      this.logger.warn(`Groq extraction failed, using fallback: ${err}`);
      return this.fallbackIntent(text);
    }
  }

  private async callGroq(text: string, history?: Array<{ role: string; text: string }>): Promise<InsuranceIntent> {
      const historyMessages = history?.slice(-10).map((h) => ({
        role: h.role === 'agent' ? 'assistant' : h.role,
        content: h.text,
      })) ?? [];
      this.logger.log(`callGroq: ${text.length} chars, ${historyMessages.length} history turns`);
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'system',
              content: `Eres un asistente de seguros. Extrae la intención del usuario en JSON.
Solo responde con JSON válido, sin markdown:
{
  "productCategory": "vida" | "hogar" | "accidentes" | "asistencia" | "mascotas" | null,
  "petType": "gato" | "perro" | "mixto" | null,
  "petCount": null,
  "coverage": ["palabras clave de lo que quiere proteger"],
  "beneficiaries": 1,
  "urgency": "immediate" | "exploring",
  "budget": null | number,
  "abandonIntent": false,
  "priceObjection": false,
  "isAffirmative": false,
  "isNegative": false,
  "wantsAlternative": false,
  "petResolution": null,
  "petName": null,
  "petAge": null,
  "petBreed": null,
  "pets": []
}
"asistencia" cubre lo que el usuario suele llamar "salud" o "seguro médico" — si el
usuario dice "salud", usa productCategory "asistencia", nunca inventes una categoría nueva.
petType solo aplica si productCategory es "mascotas". Reglas:
- Solo menciona gatos ("gato", "michi", "felino") → "gato"
- Solo menciona perros ("perro", "canino") → "perro"
- Menciona AMBOS (gato y perro en el mismo mensaje) → "mixto"
- No especifica → null

isAffirmative: true cuando el usuario expresa acuerdo, confirmación, interés positivo o deseo de continuar (ej: "sí", "claro", "me interesa", "quiero", "perfecto", "adelante", "todos", "todas", "hagámoslo", "confirmo", "listo", "dale", "me parece bien", "genera", "generalo", "procede", "procédele", "hágale", "vale", "dame ese", "deme ese" — estas dos últimas son formas comunes en Colombia de confirmar la opción que se le acaba de mostrar, no una pregunta)
isNegative: true cuando el usuario expresa rechazo, deseo de cambiar, o desinterés (ej: "no", "paso", "otro", "otra", "diferente", "no me interesa", "quizás después", "ninguno", "ningún otro", "no estoy interesado", "no gracias", "no, gracias")
Ambos pueden ser false si el mensaje es neutral o informativo.

abandonIntent: true SOLO cuando el usuario expresa una intención clara y deliberada de
terminar TODA la conversación (ej: "cancelar", "olvídalo", "ya no quiero nada", "salir",
"terminar", "déjalo así", "lo veo después/luego"). NUNCA lo actives solo porque el mensaje contiene la
palabra "no" — "no me interesa este" (rechaza UNA opción, usa isNegative en su lugar),
"no lo sé, ¿qué me ofreces?" (pide ayuda) y "se llama Bruno" (un nombre) NO son abandono.
Ante la duda, abandonIntent es false.

wantsAlternative: true cuando el usuario quiere ver otra opción de seguro distinta (ej: "otro", "muéstrame más", "diferente", "hay otra opción", "cambia", "siguiente cotización", "no ese, otro")
petCount: número total de mascotas mencionadas explícitamente (ej: "un gato y dos perros" → 3; "mi perro" → 1; si no especifica → null).
petResolution: cuando el usuario responde a la pregunta "¿para el gato o los perros?":
- "gato" si menciona gato, gatita, michi, felino, la gata, el minino
- "perro" si menciona perro, lomito, canino, el peludo, mi perrita, mascota canina
- "all" si dice todos, para todos, los dos, ambos, para las dos mascotas
- null si no especifica o el mensaje no es una respuesta a esta pregunta

petName, petAge, petBreed: cuando el usuario está describiendo UNA mascota específica en
respuesta a "¿nombre, edad y raza?" (ej: "se llama Max, tiene 3 años, es un labrador"):
- petName: el nombre propio de la mascota (ej: "Max"). null si no lo menciona.
- petAge: la edad tal como la dice, incluyendo la unidad (ej: "3 años", "8 meses"). null si no la menciona.
- petBreed: la raza (ej: "labrador", "criollo", "siamés"). null si no la menciona o dice que no sabe/es mestizo sin especificar.

pets: cuando el usuario describe UNA O VARIAS mascotas en el mismo mensaje en respuesta a
"¿nombre, edad y raza?" (ej: "Rocky tiene 5 años y es labrador, y Luna tiene 3 años y es
siamesa" → dos mascotas en un mensaje), retorna un array con un objeto {name, age, breed}
POR CADA mascota mencionada, en el orden en que las describe. Si describe una sola, el
array tiene un elemento. Si no describe ninguna mascota en este mensaje, retorna [].
Usa null dentro de cada objeto para el dato que no mencione (mismas reglas que petName/
petAge/petBreed arriba). No repitas la misma información también en los campos petName/
petAge/petBreed sueltos — cuando uses "pets", esos campos sueltos pueden quedar null.`,
            },
            ...historyMessages,
            { role: 'user', content: text },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        if (response.status === 429) {
          throw new GroqRateLimitError(`Groq API error: 429 ${body}`);
        }
        throw new Error(`Groq API error: ${response.status} ${body}`);
      }

      const data = await response.json() as any;
      const content = data.choices[0].message.content;
      const intent = JSON.parse(content) as InsuranceIntent;
      return this.postProcess(intent, text);
  }

  private postProcess(intent: InsuranceIntent, text: string): InsuranceIntent {
    const lower = text.toLowerCase();
    // Denial phrases are stripped before any keyword check: every check is a substring test,
    // so "no tengo gatos" would otherwise read as confirming a cat.
    const safeLower = GroqNlpService.stripDeniedPets(lower);
    // "gatica"/"minino" missing here silently overrode a correct mixto classification.
    const hasCat = safeLower.includes('gato') || safeLower.includes('gata') || safeLower.includes('gatic') || safeLower.includes('michi') || safeLower.includes('felino') || safeLower.includes('minino');
    // "perrit" covers perrito/perrita: neither is a substring of "perro".
    const hasDog = safeLower.includes('perro') || safeLower.includes('perra') || safeLower.includes('canino') || safeLower.includes('perrit');

    // Runs when Groq classified mascotas OR returned null and the text names a pet: gating
    // strictly on 'mascotas' left petType null and looped the DISCOVERY question. Skipped when
    // Groq set an unrelated explicit category, so a passing mention of pets can't hijack it.
    const hasAll = safeLower.includes('todos') || safeLower.includes('ambos')
      || safeLower.includes('los dos') || safeLower.includes('las dos') || safeLower.includes('para todos');
    if (intent.productCategory === 'mascotas' || intent.productCategory == null) {
      if (hasCat && hasDog) intent.petType = 'mixto';
      else if (hasCat) intent.petType = 'gato';
      else if (hasDog) intent.petType = 'perro';
      // "Ambos"/"todos"/"los dos" carry no cat/dog keyword, so nullifying here would drop a
      // correct mixto. Only nullify when the LLM invented mixto with nothing to support it.
      else if (intent.petType === 'mixto' && !hasAll) intent.petType = null;
    }
    const hasCatExt = hasCat || safeLower.includes('gatita') || safeLower.includes('minino');
    const hasDogExt = hasDog || safeLower.includes('lomito') || safeLower.includes('peludo') || safeLower.includes('perrita');
    if (hasCatExt && !hasDogExt) intent.petResolution = 'gato';
    else if (hasDogExt && !hasCatExt) intent.petResolution = 'perro';
    else if (hasAll) intent.petResolution = 'all';
    else if (hasCat && hasDog) intent.petResolution = null;
      // else: keep the LLM's petResolution — it may be a contextual guess like "perro" for "lomito".

    // Infer productCategory when the LLM returned null but petType or keywords are present.
    if (!intent.productCategory) {
      if (intent.petType || hasCat || hasDog || hasAll || safeLower.includes('mascota')) {
        intent.productCategory = 'mascotas';
      } else {
        // The same shared keyword map fallbackIntent uses, so a button tap Groq failed to
        // classify has a floor for vida/asistencia/accidentes too, not just mascotas.
        intent.productCategory = GroqNlpService.matchCategoryKeyword(safeLower);
      }
    }

    // A question mark usually means asking, not confirming — substring matching ("me interesan"
    // contains "me interesa") would fast-forward a genuine question to confirmation. A standalone
    // "sí"/"si" is exempt: Spanish routinely tags a real confirmation with "?".
    if (intent.isAffirmative && (text.includes('?') || text.includes('¿')) && !GroqNlpService.hasStandaloneSi(text)) {
      intent.isAffirmative = false;
    }

    // An explicit count in the raw text always wins, same override policy as petType.
    const explicitPetCount = this.extractPetCountFromText(lower);
    if (explicitPetCount !== null) intent.petCount = explicitPetCount;

    // Only overrides when the deterministic parse found strictly MORE pets than Groq, and more
    // than one — Groq's singular petName/petAge/petBreed is correct for a single pet.
    const deterministicPets = this.extractPetsFromText(text);
    if (deterministicPets.length > 1 && deterministicPets.length > (intent.pets?.length ?? 0)) {
      intent.pets = deterministicPets;
    }

    // Groq reads "Otra opción." as isAffirmative, jumping to confirm the product being left.
    if (this.wantsAlternativeText(lower)) {
      intent.wantsAlternative = true;
      intent.isAffirmative = false;
    }

    // "no quiero"/"no me interesa" could survive as isAffirmative on a bare 'quiero' substring.
    if (this.deniesDesireText(lower)) {
      intent.isAffirmative = false;
      intent.isNegative = true;
    }

    // Every override above only turns isAffirmative OFF. This is the floor that turns it back
    // ON when Groq misses a clear "Quiero ese.", respecting the negation guards above.
    if (
      !intent.isAffirmative
      && this.isAffirmativeText(lower)
      && (!text.includes('?') && !text.includes('¿') || GroqNlpService.hasStandaloneSi(text))
      && !intent.wantsAlternative
      && !this.deniesDesireText(lower)
    ) {
      intent.isAffirmative = true;
    }

    // Groq's own wantsAlternative example ("no ese, otro") makes it read "ese" as wanting a
    // DIFFERENT option, so this overrides wantsAlternative too — but "¿Quiero ese?" stays a question.
    if (
      this.isDeicticConfirmationText(text)
      && !text.includes('?') && !text.includes('¿')
      && !this.deniesDesireText(lower)
    ) {
      intent.isAffirmative = true;
      intent.wantsAlternative = false;
      intent.isNegative = false;
    }

    // Not in Groq's JSON schema — this deterministic extraction is the only source.
    intent.dependents = this.extractDependents(lower);

    return intent;
  }

  // Sums every "<number> mascota(s)/perro(s)/gato(s)" phrase. Returns null when no phrase is
  // present, so callers can tell "no signal" from "zero pets".
  private static readonly PET_NUMBER_WORDS: Record<string, number> = {
    un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
    seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  };

  // Shared by extractPetAge and the breed filter, so "tres años" is read like "3 años".
  private static readonly NUMBER_WORD_PATTERN = Object.keys(GroqNlpService.PET_NUMBER_WORDS).join('|');

  // A standalone "sí"/"si" means the '?' is a confirmation tag ("¿sí?"), not a real question.
  // Plain \b doesn't work: JS's \w isn't accent-aware, so "í" breaks a trailing boundary.
  private static hasStandaloneSi(text: string): boolean {
    return /(^|[^a-záéíóúñ])s[íi]($|[^a-záéíóúñ])/i.test(text);
  }

  // Every keyword check is a bare substring test, so denials are stripped first — otherwise
  // "no tengo gatos" reads as confirming a cat.
  private static readonly DENIAL_PATTERN =
    /\b(?:no\s+ten(?:go|ía|ia)|sin|ning[uú]n|ninguna)\s+(?:un\s+|una\s+)?(?:gatos?|gatas?|perros?|perras?|mascotas?|caninos?|felinos?)\b/gi;

  private static stripDeniedPets(text: string): string {
    return text.replace(GroqNlpService.DENIAL_PATTERN, ' ');
  }

  // Shared by fallbackIntent and postProcess: a button tap Groq failed to classify needs the
  // same keyword floor on the primary path.
  private static readonly CATEGORY_KEYWORDS: readonly [string, NonNullable<InsuranceIntent['productCategory']>][] = [
    ['vida', 'vida'], ['hogar', 'hogar'], ['casa', 'hogar'],
    ['accidente', 'accidentes'], ['asistencia', 'asistencia'],
    // "salud" is the colloquial name for the catalog's "asistencia" category.
    ['salud', 'asistencia'],
    // "gatic" covers the gatica/gatico diminutives, which a bare "gato" substring misses.
    ['mascota', 'mascotas'], ['perro', 'mascotas'], ['gato', 'mascotas'], ['gata', 'mascotas'], ['gatic', 'mascotas'], ['michi', 'mascotas'],
    ['familia', 'vida'], ['hijo', 'vida'],
  ];

  private static matchCategoryKeyword(safeLower: string): InsuranceIntent['productCategory'] {
    for (const [key, val] of GroqNlpService.CATEGORY_KEYWORDS) {
      if (safeLower.includes(key)) return val;
    }
    return null;
  }

  // ASR drops the '?', so the question-mark guard can't save an explicit decline, and
  // isAffirmativeText treats a bare 'quiero' as a confirmation. A decline always wins.
  private static readonly DENIED_DESIRE_PATTERN = /\bno\s+(?:quiero|deseo|me\s+interesa)\b/i;

  private deniesDesireText(lower: string): boolean {
    return GroqNlpService.DENIED_DESIRE_PATTERN.test(lower);
  }

  // "Quiero ese." is a common Colombian confirmation that Groq can misread as wantsAlternative.
  private static readonly DEICTIC_CONFIRMATION_PATTERN = /\b(?:dame|deme|quiero)\s+es[ae]\b/i;

  private isDeicticConfirmationText(text: string): boolean {
    return GroqNlpService.DEICTIC_CONFIRMATION_PATTERN.test(text);
  }

  // Not in Groq's JSON schema, so this is the ONLY source in both paths — no LLM half to override.
  private static readonly ZERO_DEPENDENTS_PATTERN =
    /\b(vivo\s+solo|vivo\s+sola|no\s+tengo\s+hijos|no\s+tengo\s+hijas|sin\s+hijos|ning[uú]n\s+hijo|ninguna\s+hija|nadie\s+depende|no\s+depende\s+nadie)\b/i;

  private static readonly DEPENDENTS_COUNT_PATTERN = new RegExp(
    `\\b(\\d+|${GroqNlpService.NUMBER_WORD_PATTERN})\\s+(hijos?|hijas?|personas?\\s+a\\s+cargo|dependientes?)\\b`, 'i',
  );

  // A named family member with no count ("mi esposa") is a real signal but not a countable
  // one: floor of 1, never more than the phrase itself supports (rule #12).
  private static readonly FAMILY_MENTION_PATTERN =
    /\b(mi\s+esposa|mi\s+esposo|mi\s+marido|mi\s+mujer|mi\s+mam[aá]|mi\s+pap[aá]|mis?\s+hijos?|mis?\s+hijas?|mi\s+familia|mi\s+pareja)\b/i;

  private extractDependents(lower: string): number | null {
    if (GroqNlpService.ZERO_DEPENDENTS_PATTERN.test(lower)) return 0;
    const countMatch = lower.match(GroqNlpService.DEPENDENTS_COUNT_PATTERN);
    if (countMatch) {
      const raw = countMatch[1];
      return /^\d+$/.test(raw) ? parseInt(raw, 10) : GroqNlpService.PET_NUMBER_WORDS[raw];
    }
    if (GroqNlpService.FAMILY_MENTION_PATTERN.test(lower)) return 1;
    return null;
  }

  // Covers feminine forms and diminutives — "Somos dos perritos, una gata y yo" matched nothing.
  private extractPetCountFromText(lower: string): number | null {
    const pattern = /\b(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(mascotas?|perr(?:os?|itos?|itas?|as?)|gat(?:os?|itos?|itas?|icos?|icas?|as?))\b/g;
    let total = 0;
    let found = false;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lower)) !== null) {
      found = true;
      const raw = match[1];
      total += /^\d+$/.test(raw) ? parseInt(raw, 10) : GroqNlpService.PET_NUMBER_WORDS[raw];
    }
    return found ? total : null;
  }

  private fallbackIntent(text: string): InsuranceIntent {
    const lower = text.toLowerCase();
    // Same negation fix as postProcess: "no tengo gatos" must not classify as mascotas.
    const safeLower = GroqNlpService.stripDeniedPets(lower);
    const category = GroqNlpService.matchCategoryKeyword(safeLower);

    let petType: InsuranceIntent['petType'] = null;
    if (category === 'mascotas') {
      const hasCat = safeLower.includes('gato') || safeLower.includes('gata') || safeLower.includes('gatic') || safeLower.includes('michi') || safeLower.includes('felino') || safeLower.includes('minino');
      const hasDog = safeLower.includes('perro') || safeLower.includes('canino') || safeLower.includes('perrit');
      if (hasCat && hasDog) petType = 'mixto';
      else if (hasCat) petType = 'gato';
      else if (hasDog) petType = 'perro';
    }

    // isAffirmativeText's bare 'quiero' has no negation guard, so an explicit decline wins here.
    const deniesDesire = this.deniesDesireText(lower);
    // "Quiero ese" also forces wantsAlternative and isNegative off. Same exclusions as postProcess.
    const isDeicticConfirmation = this.isDeicticConfirmationText(text)
      && !text.includes('?') && !text.includes('¿')
      && !deniesDesire;

    return {
      productCategory: category,
      petType,
      petCount: this.extractPetCountFromText(lower),
      coverage: [],
      beneficiaries: 1,
      urgency: lower.includes('urgente') || lower.includes('ya') ? 'immediate' : 'exploring',
      abandonIntent: this.isAbandonText(lower),
      priceObjection: lower.includes('caro') || lower.includes('precio'),
      dependents: this.extractDependents(lower),
      // A question mark means the user is asking, not confirming — see postProcess for context.
      isAffirmative: isDeicticConfirmation || (this.isAffirmativeText(lower)
        && (!lower.includes('?') && !lower.includes('¿') || GroqNlpService.hasStandaloneSi(lower))
        && !deniesDesire),
      isNegative: !isDeicticConfirmation && (this.isNegativeText(lower) || deniesDesire),
      wantsAlternative: !isDeicticConfirmation && this.wantsAlternativeText(lower),
      petResolution: this.extractPetResolution(lower),
      petName: this.extractPetName(text),
      petAge: this.extractPetAge(lower),
      // Breed recognition needs real NLP, so the fallback path leaves it null.
      petBreed: null,
      // A multi-pet message uses period-separated clauses, not "se llama X".
      pets: this.extractPetsFromText(text).length > 0
        ? this.extractPetsFromText(text)
        : (this.extractPetName(text) ? [{ name: this.extractPetName(text), age: this.extractPetAge(lower), breed: null }] : []),
    };
  }

  // One clause per pet, split on periods and then on commas ("Bruna" / "10 años" / "criollo")
  // — the shape people use when rattling off several pets by voice. At least 2 comma-separated
  // parts are required, or "Solo es Bruna" becomes a phantom pet named "Solo".
  private extractPetsFromText(text: string): { name: string; age: string | null; breed: string | null }[] {
    const clauses = text.split(/\.+/).map((c) => c.trim()).filter(Boolean);
    const pets: { name: string; age: string | null; breed: string | null }[] = [];
    for (const clause of clauses) {
      const parts = clause.split(',').map((p) => p.trim()).filter(Boolean);
      if (parts.length < 2) continue;
      const nameMatch = parts[0].match(/^([A-ZÁÉÍÓÚÑ][a-zA-Záéíóúñ]*)/);
      if (!nameMatch) continue;
      const age = this.extractPetAge(clause.toLowerCase());
      // A word-form age would otherwise leak the whole age clause into the breed.
      const ageTokenPattern = new RegExp(`^(?:\\d+|${GroqNlpService.NUMBER_WORD_PATTERN})\\s*(años?|meses?)$`, 'i');
      const remaining = parts.slice(1).filter((p) => !ageTokenPattern.test(p));
      const breed = remaining.length > 0 ? remaining.join(', ') : null;
      pets.push({ name: nameMatch[1], age, breed });
    }
    return pets;
  }

  private extractPetName(text: string): string | null {
    const match = text.match(/(?:se llama|llamad[oa]|nombre es)\s+([A-ZÁÉÍÓÚÑ][\wñáéíóúÁÉÍÓÚ]*)/i);
    return match ? match[1] : null;
  }

  // Word-form ages ("tres años") are common in voice dictation; digit-only matching let the
  // age leak into the breed field.
  private extractPetAge(lower: string): string | null {
    const match = lower.match(new RegExp(`\\b(\\d+|${GroqNlpService.NUMBER_WORD_PATTERN})\\s*años?\\b`));
    if (!match) return null;
    const raw = match[1];
    const value = /^\d+$/.test(raw) ? raw : GroqNlpService.PET_NUMBER_WORDS[raw];
    return `${value} años`;
  }

  private isAffirmativeText(lower: string): boolean {
    const affirmatives = ['sí', 'si', 'claro', 'me interesa', 'quiero', 'perfecto', 'adelante',
      'todos', 'todas', 'ambos', 'hagámoslo', 'confirmo', 'listo', 'dale', 'me parece bien',
      // Colombian slang confirmations (real gap: "generalo" wasn't recognized, stalling payment)
      'genera', 'procede', 'procéde', 'hágale', 'vale',
      // "Dame ese" is a common Colombian way to confirm a choice, not a request for more.
      'dame', 'deme'];
    return affirmatives.some((a) => lower.includes(a));
  }

  // Reserved for an unambiguous "I'm done": matching a bare "no" anywhere ended the
  // conversation on "no lo sé, qué me ofreces?" and even on the name "Bruno".
  private isAbandonText(lower: string): boolean {
    const exitPhrases = [
      'cancelar', 'olvídalo', 'olvidalo', 'ya no quiero', 'no quiero más', 'no quiero mas',
      'salir', 'terminar', 'después', 'luego',
    ];
    return exitPhrases.some((p) => lower.includes(p));
  }

  private isNegativeText(lower: string): boolean {
    const negatives = ['no', 'paso', 'otro', 'otra', 'diferente', 'no me interesa',
      'ninguno', 'ninguna', 'después', 'luego'];
    return negatives.some((a) => lower.includes(a));
  }

  private wantsAlternativeText(lower: string): boolean {
    const alternatives = ['otro', 'otra', 'diferente', 'muéstrame más', 'muestrame mas',
      'más opciones', 'mas opciones', 'cambia', 'cambiar', 'siguiente cotización',
      'siguiente opcion', 'hay otra', 'no ese'];
    return alternatives.some((a) => lower.includes(a));
  }

  private extractPetResolution(lower: string): 'gato' | 'perro' | 'all' | null {
    const hasCat = lower.includes('gato') || lower.includes('michi') || lower.includes('felino') || lower.includes('gatita') || lower.includes('minino');
    const hasDog = lower.includes('perro') || lower.includes('canino') || lower.includes('lomito') || lower.includes('peludo') || lower.includes('perrit');
    const hasAll = lower.includes('todos') || lower.includes('ambos') || lower.includes('los dos') || lower.includes('las dos') || lower.includes('para todos');

    if (hasCat && !hasDog) return 'gato';
    if (hasDog && !hasCat) return 'perro';
    if (hasAll) return 'all';
    return null;
  }
}
