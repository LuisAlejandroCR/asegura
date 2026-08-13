// affiliate-lookup.service.ts: This script is for looking up an affiliate's full
// historical row by SERIE from the synthetic affiliate CSV, so the agent can honor
// "nunca preguntar lo que ya sabemos" (Diseño preguntas.docx, Nivel 1) for every signal
// Colsubsidio already has on file, not just income.
//
// Optional integration, same pattern as Wompi/Telegram/LLM: a missing file logs a warning
// and disables the feature, never crashes. The synthetic CSV lives at the PUBLIC repo root
// (docs/ is gitignored) so it deploys with the code. Path comes from an env var so the
// file can move without a code change.
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// 2026-07-26 feature request: "capture the complete row... so the agent will know all
// about the registered user" — every field is captured verbatim from the CSV (rule #12
// — never invented, always the literal value on file), even where nothing downstream
// reads it yet. Fields already wired into live scoring/DISCOVERY are documented as such;
// the rest are captured for context/persistence, ready for a future consumer.
export interface AffiliateRecord {
  // ── Already consumed live (QuotingService.budgetFromSalary, dependents question skip)
  rangoSalarial?: string;
  // "AFILLIADO SIN GRUPO_FAMILIAR" (no registered family group, ~58% of real rows)
  // confidently means dependents=0 — DISCOVERY's dependents question can be skipped
  // entirely. Other SEGMENTO_GRUPO_FAMILIAR values ("FAMILIA NUCLEAR INTEGRAL", etc.)
  // confirm a family EXISTS but not the exact count, so they're deliberately NOT mapped
  // to a number here (rule #12) — the question still gets asked for those.
  dependents?: number;
  // A real, already-known pet count — same "never ask what we already know" principle
  // as dependents above. Only present on rows where CONTACTADO="SI" and a pet product
  // was actually sold (see productoIdPrevio) — same confidence level as dependents.
  petCount?: number;

  // ── Captured, persisted, not yet wired into any scoring rule (available for future use)
  genero?: string;
  rangoEdad?: string;
  categoria?: string;
  segmentoGrupoFamiliar?: string;
  segmentoPoblacional?: string;
  piramideNueva?: string;
  empresaFoco?: boolean;
  ciudadAfiliado?: string;
  hoteles?: boolean;
  piscilago?: boolean;
  drogueria?: boolean;
  agencias?: boolean;
  vivienda?: boolean;
  // Historical contact/sales outcome from a PRIOR (non-Telegram) commercial attempt —
  // only populated on rows where CONTACTADO="SI" in the source CSV.
  contactado?: boolean;
  canalContacto?: string;
  diasPrimeraRespuesta?: number;
  estadoVenta?: string;
  churnPosterior?: boolean;
  productoIdPrevio?: string;
  primaMensualPrevia?: number;
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
    // Repo root, not docs/ — the CSV is committed there (public, non-PII synthetic
    // data), which is what `process.cwd()` resolves to when the app runs (nest-cli
    // doesn't relocate non-.ts assets, same convention as pdf.service.ts's IMAGES_DIR).
    const csvPath = this.config.get<string>(
      'AFFILIATE_CSV_PATH',
      path.join(process.cwd(), 'Usos_Productos_Afiliados_SIMULADO.csv'),
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

    // Column-name → index map (not fixed positional indices) so the parser tolerates a
    // narrower header (e.g. this file's own unit tests, which use small fixture CSVs
    // with only a few columns) and stays correct if the real CSV's column order ever
    // changes upstream.
    let columnIndex: Record<string, number> = {};
    let serieIdx = -1;
    let isHeader = true;

    // split()/trim() return NEW strings per row: 500k rows held ~7.5M string objects for
    // only 372 distinct values (every column but SERIE is categorical). Heap 277 → 134 MB.
    // Matters because this runs pre-listen: running out kills the boot, not just the lookup.
    const pool = new Map<string, string>();
    const intern = (v: string): string => {
      const hit = pool.get(v);
      if (hit !== undefined) return hit;
      pool.set(v, v);
      return v;
    };

    const col = (cols: string[], name: string): string | undefined => {
      const i = columnIndex[name];
      if (i === undefined || i < 0) return undefined;
      const raw = cols[i]?.trim();
      return raw ? intern(raw) : raw;
    };
    const boolCol = (cols: string[], name: string): boolean | undefined => {
      const v = col(cols, name);
      return v === 'SI' ? true : v === 'NO' ? false : undefined;
    };
    const intCol = (cols: string[], name: string): number | undefined => {
      const v = col(cols, name);
      if (!v) return undefined;
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : undefined;
    };

    for await (const rawLine of rl) {
      const line = rawLine.replace(/\r$/, '');
      if (!line) continue;
      const cols = line.split(';');

      if (isHeader) {
        columnIndex = {};
        cols.forEach((name, i) => { columnIndex[name] = i; });
        serieIdx = columnIndex['SERIE'] ?? -1;
        isHeader = false;
        if (serieIdx === -1) {
          throw new Error('CSV header missing SERIE column');
        }
        continue;
      }

      const serie = cols[serieIdx]?.trim();
      if (!serie) continue;

      const record: AffiliateRecord = {};

      const rangoSalarial = col(cols, 'RANGO_SALARIAL');
      if (rangoSalarial) record.rangoSalarial = rangoSalarial;

      const segmentoFamiliar = col(cols, 'SEGMENTO_GRUPO_FAMILIAR');
      if (segmentoFamiliar) record.segmentoGrupoFamiliar = segmentoFamiliar;
      if (segmentoFamiliar === 'AFILLIADO SIN GRUPO_FAMILIAR') record.dependents = 0;
      // 2026-07-26 — these two segments confirm at least 1 dependent (conservative floor,
      // same as the NLP's FAMILY_MENTION_PATTERN). Unlike "AFILLIADO SIN GRUPO_FAMILIAR",
      // which means 0, they only confirm existence — the caller may still ask for a count.
      if (segmentoFamiliar === 'FAMILIA MONOPARENTAL' || segmentoFamiliar === 'FAMILIA NUCLEAR INTEGRAL') {
        record.dependents = 1;
      }

      const genero = col(cols, 'GENERO');
      if (genero) record.genero = genero;
      const rangoEdad = col(cols, 'RANGO_EDAD');
      if (rangoEdad) record.rangoEdad = rangoEdad;
      const categoria = col(cols, 'CATEGORIA');
      if (categoria) record.categoria = categoria;
      const segmentoPoblacional = col(cols, 'SEGMENTO_POBLACIONAL');
      if (segmentoPoblacional) record.segmentoPoblacional = segmentoPoblacional;
      const piramideNueva = col(cols, 'PIRAMIDE_NUEVA');
      if (piramideNueva) record.piramideNueva = piramideNueva;
      const empresaFoco = col(cols, 'EMPRESA_FOCO');
      if (empresaFoco) record.empresaFoco = empresaFoco === 'X';
      const ciudadAfiliado = col(cols, 'CIUDAD_AFILIADO');
      if (ciudadAfiliado) record.ciudadAfiliado = ciudadAfiliado;

      const hoteles = boolCol(cols, 'HOTELES');
      if (hoteles !== undefined) record.hoteles = hoteles;
      const piscilago = boolCol(cols, 'PISCILAGO');
      if (piscilago !== undefined) record.piscilago = piscilago;
      const drogueria = boolCol(cols, 'DROGUERIA');
      if (drogueria !== undefined) record.drogueria = drogueria;
      const agencias = boolCol(cols, 'AGENCIAS');
      if (agencias !== undefined) record.agencias = agencias;
      const vivienda = boolCol(cols, 'VIVIENDA');
      if (vivienda !== undefined) record.vivienda = vivienda;

      const contactado = boolCol(cols, 'CONTACTADO');
      if (contactado !== undefined) record.contactado = contactado;
      const canalContacto = col(cols, 'CANAL_CONTACTO');
      if (canalContacto) record.canalContacto = canalContacto;
      const diasPrimeraRespuesta = intCol(cols, 'DIAS_PRIMERA_RESPUESTA');
      if (diasPrimeraRespuesta !== undefined) record.diasPrimeraRespuesta = diasPrimeraRespuesta;
      const estadoVenta = col(cols, 'ESTADO_VENTA');
      if (estadoVenta) record.estadoVenta = estadoVenta;
      const churnPosterior = boolCol(cols, 'CHURN_POSTERIOR');
      if (churnPosterior !== undefined) record.churnPosterior = churnPosterior;
      const productoIdPrevio = col(cols, 'PRODUCTO_ID');
      if (productoIdPrevio) record.productoIdPrevio = productoIdPrevio;
      const primaMensualPrevia = intCol(cols, 'PRIMA_MENSUAL');
      if (primaMensualPrevia !== undefined) record.primaMensualPrevia = primaMensualPrevia;
      const petCount = intCol(cols, 'PET_COUNT');
      if (petCount !== undefined && petCount > 0) record.petCount = petCount;

      this.bySerie.set(serie, record);
    }
  }
}
