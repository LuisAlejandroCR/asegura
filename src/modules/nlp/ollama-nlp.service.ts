import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { INlpProvider, InsuranceIntent } from './types';

@Injectable()
export class OllamaNlpService implements INlpProvider {
  private readonly logger = new Logger(OllamaNlpService.name);
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = config.get<string>('LLM_BASE_URL', 'http://localhost:11434');
    this.model = config.get<string>('LLM_MODEL', 'mistral');
  }

  async extractIntent(text: string): Promise<InsuranceIntent> {
    try {
      const { default: ollama } = await import('ollama');
      const response = await ollama.chat({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: `Eres un asistente de seguros. Extrae la intención del usuario en JSON.
Solo responde con JSON válido, sin markdown:
{
  "productCategory": "vida" | "hogar" | "accidentes" | "asistencia" | "mascotas" | null,
  "coverage": ["palabras clave de lo que quiere proteger"],
  "beneficiaries": 1,
  "urgency": "immediate" | "exploring",
  "budget": null | número,
  "abandonIntent": false,
  "priceObjection": false
}`,
          },
          { role: 'user', content: text },
        ],
        format: 'json',
        stream: false,
      });

      return JSON.parse(response.message.content) as InsuranceIntent;
    } catch (err) {
      this.logger.warn(`Ollama extraction failed, using fallback: ${err}`);
      return this.fallbackIntent(text);
    }
  }

  private fallbackIntent(text: string): InsuranceIntent {
    const lower = text.toLowerCase();
    const categories: Record<string, InsuranceIntent['productCategory']> = {
      vida: 'vida', hogar: 'hogar', casa: 'hogar',
      accidente: 'accidentes', asistencia: 'asistencia',
      mascota: 'mascotas', perro: 'mascotas', gato: 'mascotas',
      familia: 'vida', hijo: 'vida',
    };
    let category: InsuranceIntent['productCategory'] = null;
    for (const [key, val] of Object.entries(categories)) {
      if (lower.includes(key)) { category = val; break; }
    }
    return {
      productCategory: category,
      coverage: [],
      beneficiaries: 1,
      urgency: lower.includes('urgente') || lower.includes('ya') ? 'immediate' : 'exploring',
      abandonIntent: lower.includes('no') || lower.includes('después') || lower.includes('luego'),
      priceObjection: lower.includes('caro') || lower.includes('precio'),
    };
  }
}