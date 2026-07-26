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
    this.model = config.get<string>('LLM_MODEL', 'llama-3.1-8b-instant');

    // WompiService and TelegramAdapter both warn at boot when their required vars are
    // missing — this was the one optional integration that stayed silent either way, with
    // no way to confirm a Railway env var change took effect short of hitting /health.
    if (!this.apiKey) {
      this.logger.warn('LLM_API_KEY not set — NLP falls back to keyword-only matching, voice transcription disabled');
    }
  }

  // 2026-07-26 live-test bug: a real Groq free-tier TPM rate limit (429) hit mid-
  // conversation degraded that turn straight to fallbackIntent() — the weaker keyword-
  // only matcher — with zero attempt to recover, even though Groq's own error body says
  // "Please try again in 2.1s". One short, fixed retry (not a full backoff library —
  // this is a real-time chat, latency matters) recovers most of these momentary blips
  // before giving up. Any OTHER error (network, 5xx, malformed JSON) still falls
  // straight to the fallback on the first attempt, unchanged.
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
    const hasAll = safeLower.includes('todos') || safeLower.includes('ambos')
      || safeLower.includes('los dos') || safeLower.includes('las dos') || safeLower.includes('para todos');
    if (intent.productCategory === 'mascotas' || intent.productCategory == null) {
      if (hasCat && hasDog) intent.petType = 'mixto';
      else if (hasCat) intent.petType = 'gato';
      else if (hasDog) intent.petType = 'perro';
      // 2026-07-26 live-test bug: "Ambos" has no cat/dog keywords (hasCat=false,
      // hasDog=false) so the mixto-nullification above would silently drop Groq's
      // correct petType='mixto' — re-asking the question in a loop. "Ambos" (and
      // "todos", "los dos", "las dos", "para todos") all mean "both types", so
      // mixto is the right answer; only nullify when the LLM hallucinated a
      // mixto without textual support.
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
        // Real live-test bug (2026-07-26): this guardrail only ever covered mascotas —
        // an F01 button tap ("❤️ Mi familia", "🏥 Mi salud", "🤕 Accidentes") that Groq
        // itself failed to classify (no prompt example for these short emoji labels) had
        // no floor to fall back on for vida/asistencia/accidentes, silently falling
        // through to the generic "no logré entender" loop. Same shared keyword map
        // fallbackIntent already uses (and the F01 button label invariant test already
        // proves correct) — never trusted twice by two different implementations.
        intent.productCategory = GroqNlpService.matchCategoryKeyword(safeLower);
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

    // Real live-test bug (2026-07-26): a negated "no quiero"/"no me interesa" — an
    // explicit decline — was still occasionally left as isAffirmative=true (Groq
    // misclassification, or a bare 'quiero'/'me interesa' substring match with no
    // question mark to trigger the guard above). A deterministic decline always wins,
    // same override policy as wantsAlternativeText just above.
    if (this.deniesDesireText(lower)) {
      intent.isAffirmative = false;
      intent.isNegative = true;
    }

    // Real live-test bug (2026-07-26): every override above only ever turns
    // isAffirmative OFF — there was nothing to turn it back ON when Groq's own
    // classification simply misses a clear, unambiguous confirmation ("Quiero ese.", no
    // question mark), leaving a genuine "yes" stuck at false and the conversation
    // silently re-showing the same quote instead of advancing. fallbackIntent already
    // trusts isAffirmativeText as its primary signal; the primary (Groq) path deserves
    // the same deterministic floor, respecting every negation guard already computed
    // above (question mark, wantsAlternative, denied desire) so this can never
    // re-introduce one of those bugs.
    if (
      !intent.isAffirmative
      && this.isAffirmativeText(lower)
      && (!text.includes('?') && !text.includes('¿') || GroqNlpService.hasStandaloneSi(text))
      && !intent.wantsAlternative
      && !this.deniesDesireText(lower)
    ) {
      intent.isAffirmative = true;
    }

    // Real live-test bug (2026-07-26): the floor above still missed "Quiero ese." (no
    // question mark) — Groq itself occasionally classifies this as wantsAlternative
    // instead (its own few-shot example for wantsAlternative includes the phrase "no
    // ese, otro", which plausibly confuses the model into reading "ese" as wanting a
    // DIFFERENT option rather than confirming the one just shown), and the floor's own
    // `!intent.wantsAlternative` guard then blocks it from ever correcting course. This
    // always wins, overriding wantsAlternative too — but unlike a standalone "sí?", it is
    // NOT exempt from the question-mark rule: "¿Quiero ese?" stays a genuine question
    // (existing, deliberate behavior — see the test right below this comment's sibling in
    // the spec file), and "no quiero ese" stays an explicit decline, never a confirmation.
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

  // Real live-test bug (2026-07-26): tapping the F01 "❤️ Mi familia" button got "No
  // logré entender bien eso." plus the same DISCOVERY question repeated verbatim,
  // instead of proceeding with productCategory='vida'. Root cause: this exact
  // keyword→category map already existed, but ONLY inside fallbackIntent — proven
  // correct by the "F01 button label invariant" test (Step 4), which is the whole
  // reason these labels are trusted as a NLP-recognizable promise at all. postProcess
  // (the PRIMARY Groq path, actually exercised whenever Groq is up) never consulted it —
  // Groq's own system prompt has zero examples for these short emoji-prefixed labels, so
  // an "❤️ Mi familia" tap that Groq itself fails to classify had no deterministic floor
  // to fall back on, unlike mascotas (which already had one). Extracted here so BOTH
  // paths share the exact same mapping and can never drift apart again.
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

  // Real live-test bug (2026-07-26): "No, no quiero Ezequial porque ya tengo. Explícame de
  // qué se trata." has no '?'/'¿' (ASR drops it), so the existing question-mark guard
  // below doesn't save it, and it names no alternative-product phrase, so
  // wantsAlternativeText's override doesn't fire either. isAffirmativeText treats bare
  // 'quiero'/'me interesa' as confirmations with no negation guard — unlike every other
  // keyword trap already fixed in this file — so this explicit decline could leave
  // isAffirmative=true and route straight to phone-verification/KYC for the very product
  // just declined. Same override policy as wantsAlternativeText: a deterministic decline
  // phrase always wins over a bare substring match or an occasional Groq misclassification.
  private static readonly DENIED_DESIRE_PATTERN = /\bno\s+(?:quiero|deseo|me\s+interesa)\b/i;

  private deniesDesireText(lower: string): boolean {
    return GroqNlpService.DENIED_DESIRE_PATTERN.test(lower);
  }

  // Real live-test bug (2026-07-26): "Quiero ese." / "¿Quiero ese?" — a common Colombian
  // way to confirm the option just shown — got the quote card re-shown instead of
  // advancing, same family as "dame ese"/"deme ese" (already covered by
  // isAffirmativeText's substring list in the fallback path) but not reliably enough in
  // the primary Groq path, where the model can misclassify it as wantsAlternative
  // instead (see the override in postProcess for why). Matched on raw, case-preserved
  // text (not lowercased) since callers already pass either — `\b` word boundaries mean
  // case doesn't change what matches, only the `i` flag does.
  private static readonly DEICTIC_CONFIRMATION_PATTERN = /\b(?:dame|deme|quiero)\s+es[ae]\b/i;

  private isDeicticConfirmationText(text: string): boolean {
    return GroqNlpService.DEICTIC_CONFIRMATION_PATTERN.test(text);
  }

  // 2026-07-26 — deterministic answer extraction for the new DISCOVERY "¿cuántas
  // personas dependen de ti?" question (Step 3). Not in Groq's JSON schema at all (the
  // system prompt above was never extended for it), so this is the ONLY source for the
  // field in both the primary and fallback paths — same never-trust-the-model-alone
  // policy as petCount/petType, just with no LLM half to override in this case.
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
    const category = GroqNlpService.matchCategoryKeyword(safeLower);

    let petType: InsuranceIntent['petType'] = null;
    if (category === 'mascotas') {
      const hasCat = safeLower.includes('gato') || safeLower.includes('gata') || safeLower.includes('gatic') || safeLower.includes('michi') || safeLower.includes('felino') || safeLower.includes('minino');
      const hasDog = safeLower.includes('perro') || safeLower.includes('canino') || safeLower.includes('perrit');
      if (hasCat && hasDog) petType = 'mixto';
      else if (hasCat) petType = 'gato';
      else if (hasDog) petType = 'perro';
    }

    // Real live-test bug (2026-07-26): isAffirmativeText's bare 'quiero'/'me interesa'
    // substrings have no negation guard, unlike every other keyword trap in this file —
    // "no quiero Ezequial, explícame de qué se trata" has no '?' to trigger the guard
    // below, so it could leave isAffirmative=true on an explicit decline. Deterministic
    // override always wins, same policy as the DENIAL_PATTERN pet-species fix above.
    const deniesDesire = this.deniesDesireText(lower);
    // "Quiero ese"/"dame ese"/"deme ese" always wins — see the fuller comment on
    // isDeicticConfirmationText/postProcess for why this needs its own override even
    // though 'quiero'/'dame'/'deme' are already plain isAffirmativeText keywords: it also
    // forces wantsAlternative/isNegative off. Same two exclusions as postProcess: NOT
    // exempt from the question-mark rule ("¿Quiero ese?" stays a genuine question), and
    // never fires on an explicit decline ("no quiero ese").
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
  // Real live-test bug (2026-07-26): "Bruna, 10 años, criollo. Solo es Bruna." (the user
  // clarifying "it's only Bruna" — i.e. there's just ONE pet, not two) produced a phantom
  // SECOND pet named "Solo" — the trailing clause "Solo es Bruna" has no comma, so
  // `parts` was a single element, and the leading capitalized word of any clause ("Solo")
  // was accepted as a name with zero shape check beyond capitalization. This parser's own
  // documented shape is a comma-separated "name, age, breed" triple — a clause with fewer
  // than 2 comma-separated parts was never actually describing a pet in that shape at all,
  // it's a side remark. Requiring at least 2 parts rejects "Solo es Bruna" (1 part) while
  // still accepting "Bruna, 10 años, criollo" (3 parts) and a minimal "Max, labrador" (2
  // parts) — a lone name with no elaboration is already covered by extractPetName's
  // separate "se llama X" fallback, not this function.
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