import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AffiliateLookupService } from './affiliate-lookup.service';

function makeConfig(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = { ...overrides };
  return { get: jest.fn((key: string, def?: unknown) => values[key] ?? def) } as any;
}

function writeTempCsv(rows: string[]): string {
  const filePath = path.join(os.tmpdir(), `affiliate-test-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
  fs.writeFileSync(filePath, rows.join('\r\n') + '\r\n', 'utf8');
  return filePath;
}

describe('AffiliateLookupService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads a small CSV and finds a record by SERIE', async () => {
    const csvPath = writeTempCsv([
      'SERIE;GENERO;RANGO_EDAD;RANGO_SALARIAL;CATEGORIA',
      '1;M;36 a 45 años;Entre 1 y 1.5 SMLV;A',
      '2;F;20 a 35 años;Entre 6 y 8 SMLV;B',
    ]);
    const service = new AffiliateLookupService(makeConfig({ AFFILIATE_CSV_PATH: csvPath }));
    await service.onApplicationBootstrap();

    expect(service.isEnabled()).toBe(true);
    expect(service.findBySerie('1')).toEqual({
      rangoSalarial: 'Entre 1 y 1.5 SMLV', genero: 'M', rangoEdad: '36 a 45 años', categoria: 'A',
    });
    expect(service.findBySerie('2')).toEqual({
      rangoSalarial: 'Entre 6 y 8 SMLV', genero: 'F', rangoEdad: '20 a 35 años', categoria: 'B',
    });

    fs.unlinkSync(csvPath);
  });

  it('returns null for a SERIE not present in the file', async () => {
    const csvPath = writeTempCsv([
      'SERIE;RANGO_SALARIAL',
      '1;Entre 1 y 1.5 SMLV',
    ]);
    const service = new AffiliateLookupService(makeConfig({ AFFILIATE_CSV_PATH: csvPath }));
    await service.onApplicationBootstrap();

    expect(service.findBySerie('999999')).toBeNull();

    fs.unlinkSync(csvPath);
  });

  it('trims whitespace around the looked-up SERIE', async () => {
    const csvPath = writeTempCsv([
      'SERIE;RANGO_SALARIAL',
      '42;Entre 4 y 6 SMLV',
    ]);
    const service = new AffiliateLookupService(makeConfig({ AFFILIATE_CSV_PATH: csvPath }));
    await service.onApplicationBootstrap();

    expect(service.findBySerie('  42  ')).toEqual({ rangoSalarial: 'Entre 4 y 6 SMLV' });

    fs.unlinkSync(csvPath);
  });

  it('skips a row with an empty SERIE instead of crashing', async () => {
    const csvPath = writeTempCsv([
      'SERIE;RANGO_SALARIAL',
      ';Entre 1 y 1.5 SMLV',
      '1;Entre 4 y 6 SMLV',
    ]);
    const service = new AffiliateLookupService(makeConfig({ AFFILIATE_CSV_PATH: csvPath }));
    await service.onApplicationBootstrap();

    expect(service.findBySerie('1')).toEqual({ rangoSalarial: 'Entre 4 y 6 SMLV' });

    fs.unlinkSync(csvPath);
  });

  it('leaves rangoSalarial unset when the column value is empty for that row', async () => {
    const csvPath = writeTempCsv([
      'SERIE;RANGO_SALARIAL',
      '1;',
    ]);
    const service = new AffiliateLookupService(makeConfig({ AFFILIATE_CSV_PATH: csvPath }));
    await service.onApplicationBootstrap();

    expect(service.findBySerie('1')).toEqual({});

    fs.unlinkSync(csvPath);
  });

  // Real deployment concern: docs/ (where the real CSV lives) is gitignored by the
  // public repo, so a Railway deploy without AFFILIATE_CSV_PATH configured (or without
  // the file present at all) must degrade gracefully, exactly like Wompi/LLM/Telegram
  // being unconfigured — never crash the app.
  it('disables gracefully (no throw) when the CSV file does not exist', async () => {
    const service = new AffiliateLookupService(makeConfig({ AFFILIATE_CSV_PATH: '/definitely/does/not/exist.csv' }));
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(service.isEnabled()).toBe(false);
    expect(service.findBySerie('1')).toBeNull();
  });

  it('disables gracefully when the header is malformed (missing SERIE column)', async () => {
    const csvPath = writeTempCsv([
      'GENERO;RANGO_SALARIAL',
      'M;Entre 1 y 1.5 SMLV',
    ]);
    const service = new AffiliateLookupService(makeConfig({ AFFILIATE_CSV_PATH: csvPath }));
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(service.isEnabled()).toBe(false);

    fs.unlinkSync(csvPath);
  });

  it('maps SEGMENTO_GRUPO_FAMILIAR="AFILLIADO SIN GRUPO_FAMILIAR" to dependents=0', async () => {
    const csvPath = writeTempCsv([
      'SERIE;GENERO;RANGO_EDAD;RANGO_SALARIAL;CATEGORIA;SEGMENTO_GRUPO_FAMILIAR',
      '10;F;20 a 35 años;Entre 6 y 8 SMLV;A;AFILLIADO SIN GRUPO_FAMILIAR',
    ]);
    const service = new AffiliateLookupService(makeConfig({ AFFILIATE_CSV_PATH: csvPath }));
    await service.onApplicationBootstrap();

    expect(service.findBySerie('10')).toEqual({
      rangoSalarial: 'Entre 6 y 8 SMLV', genero: 'F', rangoEdad: '20 a 35 años', categoria: 'A',
      segmentoGrupoFamiliar: 'AFILLIADO SIN GRUPO_FAMILIAR', dependents: 0,
    });

    fs.unlinkSync(csvPath);
  });

  it('does not set dependents for other SEGMENTO_GRUPO_FAMILIAR values (no invented count)', async () => {
    const csvPath = writeTempCsv([
      'SERIE;RANGO_SALARIAL;SEGMENTO_GRUPO_FAMILIAR',
      '1;Entre 1 y 1.5 SMLV;FAMILIA NUCLEAR INTEGRAL',
      '2;Entre 1 y 1.5 SMLV;PAREJA CONYUGAL',
      '3;Entre 1 y 1.5 SMLV;',
    ]);
    const service = new AffiliateLookupService(makeConfig({ AFFILIATE_CSV_PATH: csvPath }));
    await service.onApplicationBootstrap();

    expect(service.findBySerie('1')).toEqual({ rangoSalarial: 'Entre 1 y 1.5 SMLV', segmentoGrupoFamiliar: 'FAMILIA NUCLEAR INTEGRAL' });
    expect(service.findBySerie('2')).toEqual({ rangoSalarial: 'Entre 1 y 1.5 SMLV', segmentoGrupoFamiliar: 'PAREJA CONYUGAL' });
    expect(service.findBySerie('3')).toEqual({ rangoSalarial: 'Entre 1 y 1.5 SMLV' });

    fs.unlinkSync(csvPath);
  });

  it('sets only dependents (no rangoSalarial) when RANGO_SALARIAL is empty for that row', async () => {
    const csvPath = writeTempCsv([
      'SERIE;RANGO_SALARIAL;SEGMENTO_GRUPO_FAMILIAR',
      '1;;AFILLIADO SIN GRUPO_FAMILIAR',
    ]);
    const service = new AffiliateLookupService(makeConfig({ AFFILIATE_CSV_PATH: csvPath }));
    await service.onApplicationBootstrap();

    expect(service.findBySerie('1')).toEqual({ segmentoGrupoFamiliar: 'AFILLIADO SIN GRUPO_FAMILIAR', dependents: 0 });

    fs.unlinkSync(csvPath);
  });

  // 2026-07-26 feature request: "capture the complete row... so the agent will know all
  // about the registered user" — the SI/NO usage-history flags, EMPRESA_FOCO's "X"/blank
  // marker, CIUDAD_AFILIADO, and PET_COUNT (only meaningful alongside a prior sale).
  it('captures the full row: booleans (SI/NO), EMPRESA_FOCO ("X"/blank), city, and demographic fields', async () => {
    const csvPath = writeTempCsv([
      'SERIE;GENERO;RANGO_EDAD;RANGO_SALARIAL;CATEGORIA;SEGMENTO_GRUPO_FAMILIAR;SEGMENTO_POBLACIONAL;PIRAMIDE_NUEVA;EMPRESA_FOCO;CIUDAD_AFILIADO;HOTELES;PISCILAGO;DROGUERIA;AGENCIAS;VIVIENDA',
      '5;F;36 a 45 años;Entre 1 y 1.5 SMLV;A;AFILLIADO SIN GRUPO_FAMILIAR;Joven;3 Empresarial Top;X;BOGOTA D.C.;NO;SI;NO;NO;SI',
    ]);
    const service = new AffiliateLookupService(makeConfig({ AFFILIATE_CSV_PATH: csvPath }));
    await service.onApplicationBootstrap();

    expect(service.findBySerie('5')).toEqual({
      rangoSalarial: 'Entre 1 y 1.5 SMLV', genero: 'F', rangoEdad: '36 a 45 años', categoria: 'A',
      segmentoGrupoFamiliar: 'AFILLIADO SIN GRUPO_FAMILIAR', dependents: 0,
      segmentoPoblacional: 'Joven', piramideNueva: '3 Empresarial Top',
      empresaFoco: true, ciudadAfiliado: 'BOGOTA D.C.',
      hoteles: false, piscilago: true, drogueria: false, agencias: false, vivienda: true,
    });

    fs.unlinkSync(csvPath);
  });

  it('captures a prior sale record (CONTACTADO=SI) including PET_COUNT and previous product/premium', async () => {
    const csvPath = writeTempCsv([
      'SERIE;RANGO_SALARIAL;CONTACTADO;CANAL_CONTACTO;DIAS_PRIMERA_RESPUESTA;ESTADO_VENTA;CHURN_POSTERIOR;PRODUCTO_ID;PRIMA_MENSUAL;PET_COUNT',
      '1103;Entre 1 y 1.5 SMLV;SI;WhatsApp;7;active;NO;medicina-prepagada-gatos;81800;1',
    ]);
    const service = new AffiliateLookupService(makeConfig({ AFFILIATE_CSV_PATH: csvPath }));
    await service.onApplicationBootstrap();

    expect(service.findBySerie('1103')).toEqual({
      rangoSalarial: 'Entre 1 y 1.5 SMLV',
      contactado: true, canalContacto: 'WhatsApp', diasPrimeraRespuesta: 7,
      estadoVenta: 'active', churnPosterior: false,
      productoIdPrevio: 'medicina-prepagada-gatos', primaMensualPrevia: 81800, petCount: 1,
    });

    fs.unlinkSync(csvPath);
  });

  it('leaves petCount unset when CONTACTADO=NO (no prior sale, nothing to know)', async () => {
    const csvPath = writeTempCsv([
      'SERIE;RANGO_SALARIAL;CONTACTADO;PET_COUNT',
      '1;Entre 1 y 1.5 SMLV;NO;',
    ]);
    const service = new AffiliateLookupService(makeConfig({ AFFILIATE_CSV_PATH: csvPath }));
    await service.onApplicationBootstrap();

    expect(service.findBySerie('1')).toEqual({ rangoSalarial: 'Entre 1 y 1.5 SMLV', contactado: false });

    fs.unlinkSync(csvPath);
  });

  it('defaults to Usos_Productos_Afiliados_SIMULADO.csv at the repo root when AFFILIATE_CSV_PATH is unset', async () => {
    const expectedDefault = path.join(process.cwd(), 'Usos_Productos_Afiliados_SIMULADO.csv');
    // Intercept existsSync to prove the service asked for the right default path,
    // without actually parsing the real 500k-row file in a unit test.
    const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const service = new AffiliateLookupService(makeConfig());
    await service.onApplicationBootstrap();

    expect(existsSpy).toHaveBeenCalledWith(expectedDefault);
    expect(service.isEnabled()).toBe(false);
  });
});
