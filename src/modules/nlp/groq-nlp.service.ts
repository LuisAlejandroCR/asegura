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
petType solo aplica si productCategory es "mascotas". Reglas:
- Solo menciona gatos ("gato", "michi", "felino") → "gato"
- Solo menciona perros ("perro", "canino") → "perro"
- Menciona AMBOS (gato y perro en el mismo mensaje) → "mixto"
- No especifica → null

isAffirmative: true cuando el usuario expresa acuerdo, confirmación, interés positivo o deseo de continuar (ej: "sí", "claro", "me interesa", "quiero", "perfecto", "adelante", "todos", "todas", "hagámoslo", "confirmo", "listo", "dale", "me parece bien", "genera", "generalo", "procede", "procédele", "hágale", "vale")
isNegative: true cuando el usuario expresa rechazo, deseo de cambiar, o desinterés (ej: "no", "paso", "otro", "otra", "diferente", "no me interesa", "quizás después", "ninguno")
Ambos pueden ser false si el mensaje es neutral o informativo.

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
    const hasCat = lower.includes('gato') || lower.includes('gata') || lower.includes('michi') || lower.includes('felino');
    const hasDog = lower.includes('perro') || lower.includes('perra') || lower.includes('canino');

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
    const hasCatExt = hasCat || lower.includes('gatita') || lower.includes('minino');
    const hasDogExt = hasDog || lower.includes('lomito') || lower.includes('peludo') || lower.includes('perrita');
    const hasAll = lower.includes('todos') || lower.includes('ambos') || lower.includes('los dos') || lower.includes('las dos') || lower.includes('para todos');

    if (hasCatExt && !hasDogExt) intent.petResolution = 'gato';
    else if (hasDogExt && !hasCatExt) intent.petResolution = 'perro';
    else if (hasAll) intent.petResolution = 'all';
    // else: keep LLM's petResolution (could be null or a contextual guess like "perro" for "lomito")

    // Guardrail: infer productCategory when LLM returned null but petType or keywords are present.
    // LLMs often miss productCategory for short or context-dependent pet messages.
    if (!intent.productCategory) {
      if (intent.petType || hasCat || hasDog || lower.includes('mascota')) {
        intent.productCategory = 'mascotas';
      }
    }

    // Guardrail: a message containing a question mark is asking something, not confirming.
    // Substring keyword matching (e.g. "me interesan" contains "me interesa") can make the LLM
    // or fallback classify a genuine follow-up question as isAffirmative=true, fast-forwarding
    // straight to purchase confirmation when the user hadn't actually confirmed anything.
    if (intent.isAffirmative && (text.includes('?') || text.includes('¿'))) {
      intent.isAffirmative = false;
    }

    return intent;
  }

  private fallbackIntent(text: string): InsuranceIntent {
    const lower = text.toLowerCase();
    const categories: Record<string, InsuranceIntent['productCategory']> = {
      vida: 'vida', hogar: 'hogar', casa: 'hogar',
      accidente: 'accidentes', asistencia: 'asistencia',
      mascota: 'mascotas', perro: 'mascotas', gato: 'mascotas', michi: 'mascotas',
      familia: 'vida', hijo: 'vida',
    };
    let category: InsuranceIntent['productCategory'] = null;
    for (const [key, val] of Object.entries(categories)) {
      if (lower.includes(key)) { category = val; break; }
    }

    let petType: InsuranceIntent['petType'] = null;
    if (category === 'mascotas') {
      const hasCat = lower.includes('gato') || lower.includes('michi') || lower.includes('felino');
      const hasDog = lower.includes('perro') || lower.includes('canino');
      if (hasCat && hasDog) petType = 'mixto';
      else if (hasCat) petType = 'gato';
      else if (hasDog) petType = 'perro';
    }

    return {
      productCategory: category,
      petType,
      coverage: [],
      beneficiaries: 1,
      urgency: lower.includes('urgente') || lower.includes('ya') ? 'immediate' : 'exploring',
      abandonIntent: lower.includes('no') || lower.includes('después') || lower.includes('luego'),
      priceObjection: lower.includes('caro') || lower.includes('precio'),
      // A question mark means the user is asking, not confirming — see postProcess for context.
      isAffirmative: this.isAffirmativeText(lower) && !lower.includes('?') && !lower.includes('¿'),
      isNegative: this.isNegativeText(lower),
      wantsAlternative: this.wantsAlternativeText(lower),
      petResolution: this.extractPetResolution(lower),
      petName: this.extractPetName(text),
      petAge: this.extractPetAge(lower),
      // Breed recognition needs real NLP (no fixed breed dictionary here) — left null in
      // the fallback path; the primary Groq path extracts it directly from context.
      petBreed: null,
      // Fallback only ever reliably extracts one pet per message (no multi-pet regex
      // splitting) — mirrors petName/petAge/petBreed as a single-element array so callers
      // can rely on `pets` uniformly regardless of whether Groq or the fallback ran.
      pets: this.extractPetName(text) ? [{ name: this.extractPetName(text), age: this.extractPetAge(lower), breed: null }] : [],
    };
  }

  private extractPetName(text: string): string | null {
    const match = text.match(/(?:se llama|llamad[oa]|nombre es)\s+([A-ZÁÉÍÓÚÑ][\wñáéíóúÁÉÍÓÚ]*)/i);
    return match ? match[1] : null;
  }

  private extractPetAge(lower: string): string | null {
    const match = lower.match(/(\d+)\s*años?/);
    return match ? `${match[1]} años` : null;
  }

  private isAffirmativeText(lower: string): boolean {
    const affirmatives = ['sí', 'si', 'claro', 'me interesa', 'quiero', 'perfecto', 'adelante',
      'todos', 'todas', 'ambos', 'hagámoslo', 'confirmo', 'listo', 'dale', 'me parece bien',
      // Colombian slang confirmations (real gap: "generalo" wasn't recognized, stalling payment)
      'genera', 'procede', 'procéde', 'hágale', 'vale'];
    return affirmatives.some((a) => lower.includes(a));
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
    const hasDog = lower.includes('perro') || lower.includes('canino') || lower.includes('lomito') || lower.includes('peludo') || lower.includes('perrita');
    const hasAll = lower.includes('todos') || lower.includes('ambos') || lower.includes('los dos') || lower.includes('las dos') || lower.includes('para todos');

    if (hasCat && !hasDog) return 'gato';
    if (hasDog && !hasCat) return 'perro';
    if (hasAll) return 'all';
    return null;
  }
}