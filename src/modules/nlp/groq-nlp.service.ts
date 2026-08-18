// groq-nlp.service.ts: Groq provider implementing INlpProvider using Groq's OpenAI-compatible API
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { INlpProvider, InsuranceIntent } from './types';

// Tags a 429 specifically so extractIntent can retry once instead of falling straight to
// fallbackIntent() like any other Groq failure (network error, 5xx, malformed JSON).
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

    // WompiService and TelegramAdapter both warn at boot when their required vars are
    // missing — this was the one optional integration that stayed silent either way, with
    // no way to confirm a Railway env var change took effect short of hitting /health.
    if (!this.apiKey) {
      this.logger.warn('LLM_API_KEY not set — NLP falls back to keyword-only matching, voice transcription disabled');
    }
  }

  // Live bug: a Groq 429 mid-conversation degraded straight to the weaker fallbackIntent()
  // with zero retry, even though Groq's own error says "try again in 2.1s". One short
  // fixed retry (not a backoff library — latency matters in real-time chat) recovers most
  // blips. Any other error still falls straight to fallback, unchanged.
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
      this.logger.log(`callGroq text="${text.slice(0, 120)}"`);
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
    // Live bug: "no tengo gatos" (denying a pet) matched the same substring check as
    // having one — every keyword test was blind to a preceding negation. Strip denial
    // phrases before any keyword check so a correction doesn't read as confirmation.
    const safeLower = GroqNlpService.stripDeniedPets(lower);
    // "gatica"/"minino" missing here silently overrode a correct mixto classification.
    const hasCat = safeLower.includes('gato') || safeLower.includes('gata') || safeLower.includes('gatic') || safeLower.includes('michi') || safeLower.includes('felino') || safeLower.includes('minino');
    // "perrit" covers perrito/perrita — the common diminutive. Live bug: "dos perritos"
    // matched no dog keyword (not a substring of "perro"), classifying a mixed household as cats-only.
    const hasDog = safeLower.includes('perro') || safeLower.includes('perra') || safeLower.includes('canino') || safeLower.includes('perrit');

    // petType from keywords: runs when Groq classified mascotas, OR returned null
    // (ambiguous) and the text names a pet. Regression: gating strictly on
    // productCategory === 'mascotas' left petType stuck at null when Groq returned null,
    // looping on the generic DISCOVERY question. Skipped when Groq set an unrelated
    // explicit category — a passing mention of pets shouldn't hijack that.
    const hasAll = safeLower.includes('todos') || safeLower.includes('ambos')
      || safeLower.includes('los dos') || safeLower.includes('las dos') || safeLower.includes('para todos');
    if (intent.productCategory === 'mascotas' || intent.productCategory == null) {
      if (hasCat && hasDog) intent.petType = 'mixto';
      else if (hasCat) intent.petType = 'gato';
      else if (hasDog) intent.petType = 'perro';
      // Live bug: "Ambos" has no cat/dog keywords, so the nullification below would drop
      // Groq's correct petType='mixto' and re-ask in a loop. "Ambos"/"todos"/"los dos" all
      // mean "both types" — only nullify when the LLM hallucinated mixto with no support.
      else if (intent.petType === 'mixto' && !hasAll) intent.petType = null;
    }
    const hasCatExt = hasCat || safeLower.includes('gatita') || safeLower.includes('minino');
    const hasDogExt = hasDog || safeLower.includes('lomito') || safeLower.includes('peludo') || safeLower.includes('perrita');
    if (hasCatExt && !hasDogExt) intent.petResolution = 'gato';
    else if (hasDogExt && !hasCatExt) intent.petResolution = 'perro';
    else if (hasAll) intent.petResolution = 'all';
    else if (hasCat && hasDog) intent.petResolution = null;
    // else: keep LLM's petResolution (could be null or a contextual guess like "perro" for "lomito")

    // Guardrail: infer productCategory when LLM returned null but petType or keywords are present.
    // LLMs often miss productCategory for short or context-dependent pet messages.
    if (!intent.productCategory) {
      if (intent.petType || hasCat || hasDog || hasAll || safeLower.includes('mascota')) {
        intent.productCategory = 'mascotas';
      } else {
        // Live bug: this guardrail only ever covered mascotas — an F01 button tap Groq
        // failed to classify had no floor for vida/asistencia/accidentes, falling through
        // to the generic loop. Same shared keyword map fallbackIntent already uses.
        intent.productCategory = GroqNlpService.matchCategoryKeyword(safeLower);
      }
    }

    // Guardrail: a question mark usually means asking, not confirming. Substring matching
    // ("me interesan" contains "me interesa") can make isAffirmative=true fast-forward to
    // confirmation on a genuine question.
    // Live bug: this blanket rule also caught "sí?" during a correction loop — Spanish
    // routinely tags a confirmation with "?". A standalone "sí"/"si" word is exempted;
    // "me interesan" still gets caught since "si" only appears as a substring there.
    if (intent.isAffirmative && (text.includes('?') || text.includes('¿')) && !GroqNlpService.hasStandaloneSi(text)) {
      intent.isAffirmative = false;
    }

    // Live bug: "Tengo dos mascotas y yo." was quoted and charged for 3 — petCount had no
    // deterministic cross-check, so an 8B model's miscount went straight to the price.
    // An explicit count in the raw text always wins, same override policy as petType.
    const explicitPetCount = this.extractPetCountFromText(lower);
    if (explicitPetCount !== null) intent.petCount = explicitPetCount;

    // Live bug: a 3-pet message came back from Groq with only 2 — corrupting the issued
    // policy. Only overrides when it found strictly MORE structured pets than Groq, and
    // requires >1 (Groq's singular petName/petAge/petBreed is correct for ONE pet).
    const deterministicPets = this.extractPetsFromText(text);
    if (deterministicPets.length > 1 && deterministicPets.length > (intent.pets?.length ?? 0)) {
      intent.pets = deterministicPets;
    }

    // Live bug: Groq classified "Otra opción." as isAffirmative=true instead of
    // wantsAlternative, jumping to purchase confirmation for the product being switched
    // away from. Only fallbackIntent cross-checked this before; primary path now does too.
    if (this.wantsAlternativeText(lower)) {
      intent.wantsAlternative = true;
      intent.isAffirmative = false;
    }

    // Live bug: "no quiero"/"no me interesa" was still occasionally left isAffirmative=true
    // (a bare 'quiero' substring match with no '?' to trigger the guard above).
    if (this.deniesDesireText(lower)) {
      intent.isAffirmative = false;
      intent.isNegative = true;
    }

    // Live bug: every override above only turns isAffirmative OFF — nothing turned it
    // back ON when Groq simply misses a clear "Quiero ese." fallbackIntent already trusts
    // isAffirmativeText; the primary path deserves the same floor, respecting every
    // negation guard already computed above.
    if (
      !intent.isAffirmative
      && this.isAffirmativeText(lower)
      && (!text.includes('?') && !text.includes('¿') || GroqNlpService.hasStandaloneSi(text))
      && !intent.wantsAlternative
      && !this.deniesDesireText(lower)
    ) {
      intent.isAffirmative = true;
    }

    // Live bug: the floor above still missed "Quiero ese." — Groq's own wantsAlternative
    // example ("no ese, otro") plausibly confuses it into reading "ese" as wanting a
    // DIFFERENT option, and the floor's `!wantsAlternative` guard blocked correction.
    // This wins, overriding wantsAlternative too, but "¿Quiero ese?" stays a real question.
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

  // Sums every "<number> mascota(s)/perro(s)/gato(s)" phrase — "un gato y dos perros"
  // totals 3. Returns null with no phrase present, so callers can tell "no signal" apart
  // from "zero pets".
  private static readonly PET_NUMBER_WORDS: Record<string, number> = {
    un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
    seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  };

  // Shared regex fragment for both digit and Spanish word-form numbers — used by
  // extractPetAge and extractPetsFromText's breed filter so a spoken age like "tres
  // años" is recognized the same way a typed "3 años" already is.
  private static readonly NUMBER_WORD_PATTERN = Object.keys(GroqNlpService.PET_NUMBER_WORDS).join('|');

  // A standalone "sí"/"si" word means the question mark is a confirmation tag ("¿sí?",
  // "sí está bien?"), not a real question — "asistencia" must not match. Plain \b doesn't
  // work here: JS regex's \w (and therefore \b) isn't accent-aware, so "í" breaks a
  // trailing \b. Checking neighboring characters aren't Latin letters instead.
  private static hasStandaloneSi(text: string): boolean {
    return /(^|[^a-záéíóúñ])s[íi]($|[^a-záéíóúñ])/i.test(text);
  }

  // Live bug: "No, pero no tengo gatos..." — an explicit correction — kept getting read
  // as CONFIRMING a cat, since every keyword check was a bare substring test. Strips
  // denial phrases before any keyword match runs.
  private static readonly DENIAL_PATTERN =
    /\b(?:no\s+ten(?:go|ía|ia)|sin|ning[uú]n|ninguna)\s+(?:un\s+|una\s+)?(?:gatos?|gatas?|perros?|perras?|mascotas?|caninos?|felinos?)\b/gi;

  private static stripDeniedPets(text: string): string {
    return text.replace(GroqNlpService.DENIAL_PATTERN, ' ');
  }

  // Live bug: tapping "❤️ Mi familia" got "No logré entender" instead of vida. This
  // keyword→category map already existed but only inside fallbackIntent — postProcess
  // (the primary Groq path) never consulted it, so a tap Groq itself failed to classify
  // had no floor to fall back on. Extracted here so both paths share the same mapping.
  private static readonly CATEGORY_KEYWORDS: readonly [string, NonNullable<InsuranceIntent['productCategory']>][] = [
    ['vida', 'vida'], ['hogar', 'hogar'], ['casa', 'hogar'],
    ['accidente', 'accidentes'], ['asistencia', 'asistencia'],
    // "salud" is the colloquial term for the catalog's "asistencia" (asistencia médica)
    // category — real live-test message "Ahora el de salud." got no category at all
    // without this alias, and just re-showed the previously quoted product unchanged.
    ['salud', 'asistencia'],
    // "gatic" covers the "gatica"/"gatico" diminutives — a bare "gato"/"gata" substring
    // check misses them entirely (real bug: "una gatica" matched no category at all).
    ['mascota', 'mascotas'], ['perro', 'mascotas'], ['gato', 'mascotas'], ['gata', 'mascotas'], ['gatic', 'mascotas'], ['michi', 'mascotas'],
    ['familia', 'vida'], ['hijo', 'vida'],
  ];

  private static matchCategoryKeyword(safeLower: string): InsuranceIntent['productCategory'] {
    for (const [key, val] of GroqNlpService.CATEGORY_KEYWORDS) {
      if (safeLower.includes(key)) return val;
    }
    return null;
  }

  // Live bug: "No, no quiero Ezequial..." has no '?' (ASR drops it), so the question-mark
  // guard doesn't save it. isAffirmativeText treats bare 'quiero'/'me interesa' as
  // confirmations with no negation guard, so this decline could leave isAffirmative=true
  // and route to KYC for the product just declined. Deterministic decline always wins.
  private static readonly DENIED_DESIRE_PATTERN = /\bno\s+(?:quiero|deseo|me\s+interesa)\b/i;

  private deniesDesireText(lower: string): boolean {
    return GroqNlpService.DENIED_DESIRE_PATTERN.test(lower);
  }

  // Live bug: "Quiero ese." — a common Colombian confirmation — got the quote re-shown
  // instead of advancing; Groq can misclassify it as wantsAlternative (see postProcess).
  // Matched on raw text since `\b` boundaries don't need lowercasing, only the `i` flag does.
  private static readonly DEICTIC_CONFIRMATION_PATTERN = /\b(?:dame|deme|quiero)\s+es[ae]\b/i;

  private isDeicticConfirmationText(text: string): boolean {
    return GroqNlpService.DEICTIC_CONFIRMATION_PATTERN.test(text);
  }

  // Deterministic extraction for Step 3's "¿cuántas personas dependen de ti?". Not in
  // Groq's JSON schema, so this is the ONLY source in both paths — no LLM half to override.
  private static readonly ZERO_DEPENDENTS_PATTERN =
    /\b(vivo\s+solo|vivo\s+sola|no\s+tengo\s+hijos|no\s+tengo\s+hijas|sin\s+hijos|ning[uú]n\s+hijo|ninguna\s+hija|nadie\s+depende|no\s+depende\s+nadie)\b/i;

  private static readonly DEPENDENTS_COUNT_PATTERN = new RegExp(
    `\\b(\\d+|${GroqNlpService.NUMBER_WORD_PATTERN})\\s+(hijos?|hijas?|personas?\\s+a\\s+cargo|dependientes?)\\b`, 'i',
  );

  // A named family member with no explicit count ("mi esposa", "mi mamá") is a real
  // dependents signal but not a countable one on its own — a conservative floor of 1
  // (never invented beyond what the phrase itself supports, rule #12).
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

  // Live bug: "Somos dos perritos, una gata y yo." matched nothing — the noun alternation
  // only covered masculine/canonical forms, missing feminine and diminutives.
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
    // Same negation fix as postProcess above — "no tengo gatos" must not classify as
    // the mascotas category (or 'gato' species) just because "gato" appears as a
    // substring of the denial itself.
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

    // isAffirmativeText's bare 'quiero'/'me interesa' has no negation guard — an explicit
    // decline with no '?' could leave isAffirmative=true. Deterministic override wins.
    const deniesDesire = this.deniesDesireText(lower);
    // "Quiero ese" always wins even though it's already an isAffirmativeText keyword: it
    // also forces wantsAlternative/isNegative off. Same exclusions as postProcess.
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
      // Breed recognition needs real NLP (no fixed breed dictionary here) — left null in
      // the fallback path; the primary Groq path extracts it directly from context.
      petBreed: null,
      // A 3-pet message uses a different shape than "se llama X" — period-separated
      // "Name, age, breed" clauses. Falls back to the single pattern when none found.
      pets: this.extractPetsFromText(text).length > 0
        ? this.extractPetsFromText(text)
        : (this.extractPetName(text) ? [{ name: this.extractPetName(text), age: this.extractPetAge(lower), breed: null }] : []),
    };
  }

  // Splits on periods into one clause per pet, and within each clause on commas
  // ("Bruna" / "10 años" / "criollo") — the shape used when rattling off several pets by
  // voice. Leading capitalized word is the name, "N años/meses" is the age, the rest is
  // the breed. Live bug: this shape wasn't recognized before, so a 3-pet message lost one
  // pet with no cross-check.
  // Live bug: "Bruna, 10 años, criollo. Solo es Bruna." produced a phantom second pet
  // named "Solo" — a comma-less trailing clause was accepted as a name with zero shape
  // check. Requiring ≥2 comma-separated parts rejects "Solo es Bruna" while still
  // accepting real triples; a lone name is covered by extractPetName's own fallback.
  private extractPetsFromText(text: string): { name: string; age: string | null; breed: string | null }[] {
    const clauses = text.split(/\.+/).map((c) => c.trim()).filter(Boolean);
    const pets: { name: string; age: string | null; breed: string | null }[] = [];
    for (const clause of clauses) {
      const parts = clause.split(',').map((p) => p.trim()).filter(Boolean);
      if (parts.length < 2) continue;
      const nameMatch = parts[0].match(/^([A-ZÁÉÍÓÚÑ][a-zA-Záéíóúñ]*)/);
      if (!nameMatch) continue;
      const age = this.extractPetAge(clause.toLowerCase());
      // Real live-test bug: a word-form age ("tres años", "ocho años" — very common in
      // voice dictation) wasn't recognized by this digit-only filter, so the whole age
      // clause leaked into breed instead ("tres años, dobermana").
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

  // Real live-test bug: word-form ages ("tres años", "ocho años" — very common in voice
  // dictation) weren't recognized at all, only digit-form ("3 años") — the age silently
  // fell through and got absorbed into breed instead in the multi-pet clause parser.
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
      // Real live-test bug: "Dame ese" (voice-transcribed "give me that one", a common
      // Colombian way to confirm a choice from a quote) was not recognized as a
      // confirmation, causing the quote card to be re-shown identically instead of
      // advancing to phone verification.
      'dame', 'deme'];
    return affirmatives.some((a) => lower.includes(a));
  }

  // A deliberate signal to leave the WHOLE conversation. Live bug: this used to match any
  // message containing "no" ANYWHERE ("no lo sé, qué me ofreces?", "Bruno"), ending the
  // conversation before the user said what they wanted. Reserved for an unambiguous "I'm done".
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