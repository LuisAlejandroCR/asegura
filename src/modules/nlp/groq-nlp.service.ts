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
  "coverage": ["palabras clave de lo que quiere proteger"],
  "beneficiaries": 1,
  "urgency": "immediate" | "exploring",
  "budget": null | number,
  "abandonIntent": false,
  "priceObjection": false,
  "isAffirmative": false,
  "isNegative": false,
  "wantsAlternative": false,
  "petResolution": null
}
petType solo aplica si productCategory es "mascotas". Reglas:
- Solo menciona gatos ("gato", "michi", "felino") → "gato"
- Solo menciona perros ("perro", "canino") → "perro"
- Menciona AMBOS (gato y perro en el mismo mensaje) → "mixto"
- No especifica → null

isAffirmative: true cuando el usuario expresa acuerdo, confirmación, interés positivo o deseo de continuar (ej: "sí", "claro", "me interesa", "quiero", "perfecto", "adelante", "todos", "todas", "hagámoslo", "confirmo", "listo", "dale", "me parece bien")
isNegative: true cuando el usuario expresa rechazo, deseo de cambiar, o desinterés (ej: "no", "paso", "otro", "otra", "diferente", "no me interesa", "quizás después", "ninguno")
Ambos pueden ser false si el mensaje es neutral o informativo.

wantsAlternative: true cuando el usuario quiere ver otra opción de seguro distinta (ej: "otro", "muéstrame más", "diferente", "hay otra opción", "cambia", "siguiente cotización", "no ese, otro")
petResolution: cuando el usuario responde a la pregunta "¿para el gato o los perros?":
- "gato" si menciona gato, gatita, michi, felino, la gata, el minino
- "perro" si menciona perro, lomito, canino, el peludo, mi perrita, mascota canina
- "all" si dice todos, para todos, los dos, ambos, para las dos mascotas
- null si no especifica o el mensaje no es una respuesta a esta pregunta`,
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
    if (intent.productCategory === 'mascotas') {
      const lower = text.toLowerCase();
      const hasCat = lower.includes('gato') || lower.includes('michi') || lower.includes('felino');
      const hasDog = lower.includes('perro') || lower.includes('canino');
      if (hasCat && hasDog) intent.petType = 'mixto';
      else if (hasCat) intent.petType = 'gato';
      else if (hasDog) intent.petType = 'perro';
      else if (intent.petType === 'mixto') intent.petType = null;
    }

    // Guardrail: keywords override LLM for petResolution
    const lower = text.toLowerCase();
    const hasCat = lower.includes('gato') || lower.includes('michi') || lower.includes('felino') || lower.includes('gatita') || lower.includes('minino');
    const hasDog = lower.includes('perro') || lower.includes('canino') || lower.includes('lomito') || lower.includes('peludo') || lower.includes('perrita');
    const hasAll = lower.includes('todos') || lower.includes('ambos') || lower.includes('los dos') || lower.includes('las dos') || lower.includes('para todos');

    if (hasCat && !hasDog) intent.petResolution = 'gato';
    else if (hasDog && !hasCat) intent.petResolution = 'perro';
    else if (hasAll) intent.petResolution = 'all';
    // else: keep LLM's petResolution (could be null or a contextual guess like "perro" for "lomito")

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
      isAffirmative: this.isAffirmativeText(lower),
      isNegative: this.isNegativeText(lower),
      wantsAlternative: this.wantsAlternativeText(lower),
      petResolution: this.extractPetResolution(lower),
    };
  }

  private isAffirmativeText(lower: string): boolean {
    const affirmatives = ['sí', 'si', 'claro', 'me interesa', 'quiero', 'perfecto', 'adelante',
      'todos', 'todas', 'ambos', 'hagámoslo', 'confirmo', 'listo', 'dale', 'me parece bien'];
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