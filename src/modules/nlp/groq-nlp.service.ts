// groq-nlp.service.ts: Groq provider implementing INlpProvider using Groq's OpenAI-compatible API
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { INlpProvider, InsuranceIntent } from './types';

@Injectable()
export class GroqNlpService implements INlpProvider {
  private readonly logger = new Logger(GroqNlpService.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl = 'https://api.groq.com/openai/v1';

  constructor(private readonly config: ConfigService) {
    this.apiKey = config.get<string>('LLM_API_KEY', '');
    this.model = config.get<string>('LLM_MODEL', 'llama-3.1-8b-instant');

    // WompiService and TelegramAdapter both warn at boot when their required vars are
    // missing — this was the one optional integration that stayed silent either way, with
    // no way to confirm a Railway env var change took effect short of hitting /health.
    if (!this.apiKey) {
      this.logger.warn('LLM_API_KEY not set — NLP falls back to keyword-only matching, voice transcription disabled');
    }
  }

  async extractIntent(text: string): Promise<InsuranceIntent> {
    try {
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
            { role: 'user', content: text },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        }),
      });

      if (!response.ok) {
        throw new Error(`Groq API error: ${response.status} ${await response.text()}`);
      }

      const data = await response.json() as any;
      const content = data.choices[0].message.content;
      const intent = JSON.parse(content) as InsuranceIntent;
      return this.postProcess(intent, text);
    } catch (err) {
      this.logger.warn(`Groq extraction failed, using fallback: ${err}`);
      return this.fallbackIntent(text);
    }
  }

  private postProcess(intent: InsuranceIntent, text: string): InsuranceIntent {
    const lower = text.toLowerCase();
    // Real live-test bug (2026-07-26): "no tengo gatos" (a live correction, DENYING a
    // pet) matched the exact same substring check as actually having one — every
    // keyword test below was blind to a preceding negation. Strip explicit denial
    // phrases ("no tengo/tenía X", "sin X", "ningún/ninguna X") before any keyword
    // check in this method, so a correction no longer reads as a confirmation.
    const safeLower = GroqNlpService.stripDeniedPets(lower);
    // "gatica"/"gatita"/"minino" were only recognized a few lines below (hasCatExt, for
    // petResolution) — missing here silently overrode a correct mixto classification back
    // to a single species, dropping a pet entirely from a multi-pet quote (real bug).
    const hasCat = safeLower.includes('gato') || safeLower.includes('gata') || safeLower.includes('gatic') || safeLower.includes('michi') || safeLower.includes('felino') || safeLower.includes('minino');
    // "perrit" covers perrito/perrita/perritos/perritas — the extremely common
    // affectionate diminutive for dogs, especially in casual voice messages. Real
    // live-test bug: "Somos dos perritos, una gata y yo." matched no dog keyword at all
    // (not a substring of "perro"), silently classifying a mixed household as cats-only.
    const hasDog = safeLower.includes('perro') || safeLower.includes('perra') || safeLower.includes('canino') || safeLower.includes('perrit');

    // petType from keywords: runs when Groq already classified this as mascotas, OR when
    // Groq returned productCategory=null (ambiguous) and the text itself names a pet.
    // Regression: previously gated strictly on productCategory === 'mascotas', so a message
    // like "Tengo un gato, dos perros y yo solo." with Groq returning productCategory=null
    // left petType stuck at null — the mixto clarification never fired and the conversation
    // looped on the generic DISCOVERY question. Skip entirely when Groq set an unrelated,
    // explicit category (e.g. 'vida') — a passing mention of pets shouldn't hijack that.
    if (intent.productCategory === 'mascotas' || intent.productCategory == null) {
      if (hasCat && hasDog) intent.petType = 'mixto';
      else if (hasCat) intent.petType = 'gato';
      else if (hasDog) intent.petType = 'perro';
      else if (intent.petType === 'mixto') intent.petType = null;
    }
    const hasCatExt = hasCat || safeLower.includes('gatita') || safeLower.includes('minino');
    const hasDogExt = hasDog || safeLower.includes('lomito') || safeLower.includes('peludo') || safeLower.includes('perrita');
    const hasAll = safeLower.includes('todos') || safeLower.includes('ambos') || safeLower.includes('los dos') || safeLower.includes('las dos') || safeLower.includes('para todos');

    if (hasCatExt && !hasDogExt) intent.petResolution = 'gato';
    else if (hasDogExt && !hasCatExt) intent.petResolution = 'perro';
    else if (hasAll) intent.petResolution = 'all';
    // else: keep LLM's petResolution (could be null or a contextual guess like "perro" for "lomito")

    // Guardrail: infer productCategory when LLM returned null but petType or keywords are present.
    // LLMs often miss productCategory for short or context-dependent pet messages.
    if (!intent.productCategory) {
      if (intent.petType || hasCat || hasDog || safeLower.includes('mascota')) {
        intent.productCategory = 'mascotas';
      }
    }

    // Guardrail: a message containing a question mark is usually asking something, not
    // confirming. Substring keyword matching (e.g. "me interesan" contains "me interesa")
    // can make the LLM or fallback classify a genuine follow-up question as
    // isAffirmative=true, fast-forwarding straight to purchase confirmation when the user
    // hadn't actually confirmed anything.
    //
    // Real live-test bug (2026-07-24): this blanket rule also caught "¿Sí está bien?" and
    // "sí?" during a pet-details correction loop — Spanish routinely tags a confirmation
    // with a question mark ("sí?", "¿verdad?"), and this isn't the same thing as an
    // open-ended follow-up question. A message with its own standalone "sí"/"si" word is
    // exempted; "me interesan" still gets caught because "si" only appears as a substring
    // of "interesan", never as its own word.
    if (intent.isAffirmative && (text.includes('?') || text.includes('¿')) && !GroqNlpService.hasStandaloneSi(text)) {
      intent.isAffirmative = false;
    }

    // Real live-test bug: "Tengo dos mascotas y yo." was quoted and charged for 3
    // mascotas — petCount had no deterministic cross-check, unlike petType/petResolution
    // above, so an 8B model's miscount went straight through to the price
    // (computeTotalPremium multiplies basePremium by petCount). An explicit, unambiguous
    // count in the raw text always wins over whatever the LLM returned, same override
    // policy as petType/petResolution.
    const explicitPetCount = this.extractPetCountFromText(lower);
    if (explicitPetCount !== null) intent.petCount = explicitPetCount;

    // Real live-test bug: a 3-pet message ("Bruna, 10 años, criollo. Ramón, 3 años,
    // cocker. Pancha, 10 años, doberman.") came back from Groq with only 2 pets — Bruna
    // silently dropped by the LLM on a compound sentence. The corrupted list made it all
    // the way to the paid, issued policy. Same override policy as petCount above: only
    // ever wins when it found strictly MORE structured pets than Groq did, so it never
    // clobbers a correct LLM extraction of a shape this regex parser can't itself parse
    // (e.g. "Rocky tiene 5 años y es labrador" has no comma-triple clauses at all).
    //
    // Real regression this override itself caused: Groq's own prompt tells it to use the
    // singular petName/petAge/petBreed fields (not pets[]) for a message describing ONE
    // pet — pets: [] is the CORRECT shape there, not an undercount. Requiring more than
    // 1 deterministic pet keeps this override scoped to genuine multi-pet detections
    // (period-separated clauses); a single-pet message never gets its good Groq data
    // replaced by this parser's weaker single-clause read (which doesn't understand
    // Spanish word-form ages like "tres años", among other gaps).
    const deterministicPets = this.extractPetsFromText(text);
    if (deterministicPets.length > 1 && deterministicPets.length > (intent.pets?.length ?? 0)) {
      intent.pets = deterministicPets;
    }

    // Real live-test bug (2026-07-25): Groq classified "Otra opción." as
    // isAffirmative=true instead of wantsAlternative — the conversation jumped straight
    // to phone verification/purchase confirmation for the product the user was actually
    // trying to switch away from. Unlike petType/petCount/pets above, wantsAlternative had
    // no deterministic cross-check at all in this (primary) path — only fallbackIntent
    // did. The two are mutually exclusive by definition, so an explicit alternative-
    // request phrase always wins over the LLM's isAffirmative guess.
    if (this.wantsAlternativeText(lower)) {
      intent.wantsAlternative = true;
      intent.isAffirmative = false;
    }

    return intent;
  }

  // Sums every "<number> mascota(s)/perro(s)/gato(s)" phrase found — "un gato y dos
  // perros" must total 3, not just match the first phrase found (see Groq's own JSON
  // schema example in the system prompt above). Returns null when no explicit count
  // phrase is present at all, so callers can tell "no signal" apart from "zero pets".
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

  // Real live-test bug (2026-07-26): "No, pero no tengo gatos. No sé por qué pensaste
  // que tenía gatos..." — an explicit correction — kept getting read as CONFIRMING a
  // cat, because every pet-keyword check in this file was a bare substring test with no
  // awareness of a preceding negation. Strips "no tengo/tenía X", "sin X", and
  // "ningún/ninguna X" (X = a pet species word) before any keyword match runs, so a
  // denial no longer contains the species word for those checks to find.
  private static readonly DENIAL_PATTERN =
    /\b(?:no\s+ten(?:go|ía|ia)|sin|ning[uú]n|ninguna)\s+(?:un\s+|una\s+)?(?:gatos?|gatas?|perros?|perras?|mascotas?|caninos?|felinos?)\b/gi;

  private static stripDeniedPets(text: string): string {
    return text.replace(GroqNlpService.DENIAL_PATTERN, ' ');
  }

  // Real live-test bug (2026-07-24): "Somos dos perritos, una gata y yo." matched
  // nothing — the noun alternation only covered the masculine/canonical "perro(s)" and
  // "gato(s)" forms, missing the feminine ("perra", "gata") and the extremely common
  // diminutives ("perrito", "gatico"/"gatica" — a Colombian variant). This exact message
  // got no deterministic count at all, falling back fully to the LLM's unvalidated guess.
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
    const categories: Record<string, InsuranceIntent['productCategory']> = {
      vida: 'vida', hogar: 'hogar', casa: 'hogar',
      accidente: 'accidentes', asistencia: 'asistencia',
      // "salud" is the colloquial term for the catalog's "asistencia" (asistencia médica)
      // category — real live-test message "Ahora el de salud." got no category at all
      // without this alias, and just re-showed the previously quoted product unchanged.
      salud: 'asistencia',
      // "gatic" covers the "gatica"/"gatico" diminutives — a bare "gato"/"gata" substring
      // check misses them entirely (real bug: "una gatica" matched no category at all).
      mascota: 'mascotas', perro: 'mascotas', gato: 'mascotas', gata: 'mascotas', gatic: 'mascotas', michi: 'mascotas',
      familia: 'vida', hijo: 'vida',
    };
    let category: InsuranceIntent['productCategory'] = null;
    for (const [key, val] of Object.entries(categories)) {
      if (safeLower.includes(key)) { category = val; break; }
    }

    let petType: InsuranceIntent['petType'] = null;
    if (category === 'mascotas') {
      const hasCat = safeLower.includes('gato') || safeLower.includes('gata') || safeLower.includes('gatic') || safeLower.includes('michi') || safeLower.includes('felino') || safeLower.includes('minino');
      const hasDog = safeLower.includes('perro') || safeLower.includes('canino') || safeLower.includes('perrit');
      if (hasCat && hasDog) petType = 'mixto';
      else if (hasCat) petType = 'gato';
      else if (hasDog) petType = 'perro';
    }

    return {
      productCategory: category,
      petType,
      petCount: this.extractPetCountFromText(lower),
      coverage: [],
      beneficiaries: 1,
      urgency: lower.includes('urgente') || lower.includes('ya') ? 'immediate' : 'exploring',
      abandonIntent: this.isAbandonText(lower),
      priceObjection: lower.includes('caro') || lower.includes('precio'),
      // A question mark means the user is asking, not confirming — see postProcess for context.
      isAffirmative: this.isAffirmativeText(lower)
        && (!lower.includes('?') && !lower.includes('¿') || GroqNlpService.hasStandaloneSi(lower)),
      isNegative: this.isNegativeText(lower),
      wantsAlternative: this.wantsAlternativeText(lower),
      petResolution: this.extractPetResolution(lower),
      petName: this.extractPetName(text),
      petAge: this.extractPetAge(lower),
      // Breed recognition needs real NLP (no fixed breed dictionary here) — left null in
      // the fallback path; the primary Groq path extracts it directly from context.
      petBreed: null,
      // Real live-test bug: a 3-pet message ("Bruna, 10 años, criollo. Ramón, 3 años,
      // cocker. Pancha, 10 años, doberman.") uses a completely different shape than "se
      // llama X" — a period-separated list of "Name, age, breed" clauses. Falls back to
      // the single "se llama X" pattern above when nothing in that shape is found.
      pets: this.extractPetsFromText(text).length > 0
        ? this.extractPetsFromText(text)
        : (this.extractPetName(text) ? [{ name: this.extractPetName(text), age: this.extractPetAge(lower), breed: null }] : []),
    };
  }

  // Splits on periods into one clause per pet ("Bruna, 10 años, criollo. Ramón, 3 años,
  // cocker." → 2 clauses) and, within each clause, on commas ("Bruna" / "10 años" /
  // "criollo") — the exact shape used when a user rattles off several pets by voice in
  // one message. A leading capitalized word is the name; an "N años/meses" fragment is
  // the age; everything else left over is the breed. Real live-test bug: this shape
  // wasn't recognized at all before (extractPetName only matched "se llama X"), so a
  // 3-pet message silently lost one pet with no deterministic cross-check, unlike
  // petCount/petType above.
  private extractPetsFromText(text: string): { name: string; age: string | null; breed: string | null }[] {
    const clauses = text.split(/\.+/).map((c) => c.trim()).filter(Boolean);
    const pets: { name: string; age: string | null; breed: string | null }[] = [];
    for (const clause of clauses) {
      const parts = clause.split(',').map((p) => p.trim()).filter(Boolean);
      if (parts.length === 0) continue;
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

  // A deliberate, explicit signal to leave/stop the WHOLE conversation — real live-test
  // bug (2026-07-24): this used to be any message merely containing the substring "no"
  // ANYWHERE (matching "no lo sé, qué me ofreces?" — a request for help — "Bruno", and
  // any other unrelated text), which immediately ended the conversation via
  // processMessage's abandonIntent check, before the user ever got to say what they
  // wanted. Rejecting one specific product already has its own signal (isNegative /
  // wantsAlternative, handled per-state to show the next alternative) — abandonIntent
  // must be reserved for an unambiguous "I'm done", not overload plain "no".
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