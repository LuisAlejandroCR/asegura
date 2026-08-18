// affiliate-lookup.service.ts: looks up an affiliate's full historical row by SERIE in the
// synthetic CSV, so the agent never asks for something Colsubsidio already has on file.
// Optional: a missing file logs a warning and disables the feature instead of crashing.
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// Every field is captured verbatim from the CSV (rule #12), even where nothing downstream
// reads it yet. The ones already wired into scoring are marked below.
export interface AffiliateRecord {
  // ── Already consumed live (QuotingService.budgetFromSalary, dependents question skip)
  rangoSalarial?: string;
  // "AFILLIADO SIN GRUPO_FAMILIAR" (~58% of real rows) confidently means dependents=0. The
  // other segments confirm a family exists but not a count, so they map to no number.
  dependents?: number;
  // A pet count already on file — same "never ask what we already know" principle.
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
  // Outcome of a prior, non-Telegram commercial attempt; only on rows with CONTACTADO="SI".
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

  // SERIE is a sequential row number in this synthetic CSV, not a real Colsubsidio id.
  // trim() only: callers own normalization (agent.service.ts strips non-digits first).
  findBySerie(serie: string): AffiliateRecord | null {
    return this.bySerie.get(serie.trim()) ?? null;
  }

  private async load(): Promise<void> {
    // Repo root, which is what process.cwd() resolves to at runtime — nest-cli doesn't
    // relocate non-.ts assets.
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

    // Column-name → index map, not fixed positions: tolerates a narrower header (the unit
    // fixtures) and survives an upstream column reorder.
    let columnIndex: Record<string, number> = {};
    let serieIdx = -1;
    let isHeader = true;

    // split()/trim() return NEW strings per row: 500k rows held ~7.5M string objects for only
    // 372 distinct values. Heap 277 → 134 MB, and this runs pre-listen, so it gates the boot.
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
      // These two segments confirm at least 1 dependent, not a count — the caller may still ask.
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
