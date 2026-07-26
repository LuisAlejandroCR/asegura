// affiliate-lookup.service.ts: This script is for looking up an affiliate's historical
// signals (RANGO_SALARIAL, primarily) by SERIE from the synthetic affiliate CSV, so
// DISCOVERY can honor "nunca preguntar lo que ya sabemos" (Diseño preguntas.docx, Nivel
// 1) for income — the one signal the hackathon's DISCOVERY filter never asks directly.
//
// Optional integration, same pattern as Wompi/Telegram/LLM elsewhere in this codebase:
// a missing/misconfigured file logs a warning and disables the feature gracefully,
// never crashes the app. `docs/` (where the real CSV lives) is private-repo-only and
// gitignored by the public repo (see CLAUDE.md) — this reads from an env-configurable
// path specifically so a production deploy can point it at wherever the CSV actually
// lives, without requiring the file to be committed to the public repo.
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

export interface AffiliateRecord {
  rangoSalarial?: string;
}

@Injectable()
export class AffiliateLookupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AffiliateLookupService.name);
  private readonly bySerie = new Map<string, AffiliateRecord>();
  private loaded = false;

  constructor(private readonly config: ConfigService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.load();
  }

  isEnabled(): boolean {
    return this.loaded;
  }

  // SERIE in the synthetic CSV is a plain sequential row number (1..500000), not a real
  // Colsubsidio affiliate identifier — this is a hackathon proof-of-concept lookup
  // mechanism, not a production identity system. `serie.trim()` only (no digit-
  // stripping here) so callers control normalization; agent.service.ts strips
  // non-digits before calling this, matching cedula's "solo dígitos" convention.
  findBySerie(serie: string): AffiliateRecord | null {
    return this.bySerie.get(serie.trim()) ?? null;
  }

  private async load(): Promise<void> {
    const csvPath = this.config.get<string>(
      'AFFILIATE_CSV_PATH',
      path.join(process.cwd(), 'docs', 'Usos_Productos_Afiliados_SIMULADO.csv'),
    );
    if (!fs.existsSync(csvPath)) {
      this.logger.warn(
        `Affiliate CSV not found at ${csvPath} — affiliate lookup disabled (set AFFILIATE_CSV_PATH to enable)`,
      );
      return;
    }

    try {
      await this.parseFile(csvPath);
      this.loaded = true;
      this.logger.log(`Affiliate lookup loaded: ${this.bySerie.size} records from ${csvPath}`);
    } catch (err) {
      this.logger.warn(`Failed to load affiliate CSV — affiliate lookup disabled: ${err}`);
      this.bySerie.clear();
    }
  }

  private async parseFile(csvPath: string): Promise<void> {
    const rl = readline.createInterface({
      input: fs.createReadStream(csvPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    let serieIdx = -1;
    let rangoSalarialIdx = -1;
    let isHeader = true;

    for await (const rawLine of rl) {
      const line = rawLine.replace(/\r$/, '');
      if (!line) continue;
      const cols = line.split(';');

      if (isHeader) {
        serieIdx = cols.indexOf('SERIE');
        rangoSalarialIdx = cols.indexOf('RANGO_SALARIAL');
        isHeader = false;
        if (serieIdx === -1) {
          throw new Error('CSV header missing SERIE column');
        }
        continue;
      }

      const serie = cols[serieIdx]?.trim();
      if (!serie) continue;
      const record: AffiliateRecord = {};
      const rangoSalarial = rangoSalarialIdx >= 0 ? cols[rangoSalarialIdx]?.trim() : undefined;
      if (rangoSalarial) record.rangoSalarial = rangoSalarial;
      this.bySerie.set(serie, record);
    }
  }
}
