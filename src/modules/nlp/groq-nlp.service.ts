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
  "priceObjection": false
}
petType solo aplica si productCategory es "mascotas". Reglas:
- Solo menciona gatos ("gato", "michi", "felino") → "gato"
- Solo menciona perros ("perro", "canino") → "perro"
- Menciona AMBOS (gato y perro en el mismo mensaje) → "mixto"
- No especifica → null`,
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
    };
  }
}