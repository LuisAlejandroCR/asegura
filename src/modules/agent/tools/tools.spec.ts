// tools.spec.ts: the shared capability layer — one implementation for text and voice. The
// Ley 1581 gate is asserted per tool, because in voice it used to be only a prompt rule.

import { ProductCatalog } from '../../quoting/product-catalog.service';
import { QuotingService } from '../../quoting/quoting.service';
import {
  NOT_AUTHORIZED, cotizarLogic, validarDatosLogic, consultarAfiliadoLogic,
  emitirPolizaLogic, generarLinkPagoLogic, registrarAseguramientoLogic, requiresUnderwriting,
} from './index';

const quoting = new QuotingService(new ProductCatalog());
const authorized = { autorizado: true };

describe('tools — Ley 1581 is a precondition, not an instruction', () => {
  it.each([
    ['consultarAfiliado', () => consultarAfiliadoLogic({}, {}, { serie: '42' })],
    ['emitirPoliza', () => emitirPolizaLogic({}, 'conv-1', {})],
    ['generarLinkPago', () => generarLinkPagoLogic({ quoting }, {}, { policyId: 'pol-1' })],
  ])('%s refuses without authorization', async (_name, call) => {
    const result = await call();
    expect(result).toEqual({ ok: false, motivo: NOT_AUTHORIZED });
  });
});

describe('cotizarLogic', () => {
  it('quotes from the real catalog', () => {
    const result = cotizarLogic(quoting, { productCategory: 'vida' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cotizacion.precioMensual).toBeGreaterThan(0);
  });

  // The live "no dije gatos" bug: with no species it must land on the species-agnostic plan,
  // never on a cat- or dog-only one picked by catalog order.
  it('quotes the species-agnostic plan for mascotas when no species is known', () => {
    const result = cotizarLogic(quoting, { productCategory: 'mascotas' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cotizacion.productId).toBe('asistencia-veterinaria');
      expect(result.cotizacion.productId).not.toMatch(/gatos|perros/);
    }
  });

  it('quotes the cat plan once the species is given', () => {
    const result = cotizarLogic(quoting, { productCategory: 'mascotas', petType: 'gato' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cotizacion.productId).toBe('medicina-prepagada-gatos');
  });
});

describe('validarDatosLogic', () => {
  it('accepts a dictated cedula and a spoken email', () => {
    const result = validarDatosLogic({ cedula: '1, 2, 3, 4, 5, 6, 7', email: 'juan arroba mail punto com' });
    expect(result).toEqual({ ok: true, datos: { cedula: '1234567', email: 'juan@mail.com' } });
  });

  it('rejects a cedula with thousands separators rather than silently changing it', () => {
    expect(validarDatosLogic({ cedula: '12.345.678' }).ok).toBe(false);
  });

  it('strips the preamble a person says before their name', () => {
    const result = validarDatosLogic({ nombre: 'mi nombre es Michelle Gómez' });
    expect(result).toEqual({ ok: true, datos: { nombre: 'Michelle Gómez' } });
  });

  it('rejects digits as a name', () => {
    expect(validarDatosLogic({ nombre: '2+2' }).ok).toBe(false);
  });
});

describe('consultarAfiliadoLogic', () => {
  it('is not an error when the lookup is disabled — the flow continues unenriched', () => {
    const deps = { affiliates: { isEnabled: () => false, findBySerie: () => null } };
    expect(consultarAfiliadoLogic(deps, authorized, { serie: '42' })).toEqual({ ok: true, encontrado: false });
  });

  it('returns the affiliate signals when the row exists', () => {
    const deps = {
      affiliates: { isEnabled: () => true, findBySerie: () => ({ rangoSalarial: 'Entre 4 y 6 SMLV', petCount: 3 }) },
    };
    expect(consultarAfiliadoLogic(deps, authorized, { serie: '42' })).toMatchObject({
      ok: true, encontrado: true, rangoSalarial: 'Entre 4 y 6 SMLV', mascotas: 3,
    });
  });

  it('rejects an out-of-range serie', () => {
    const deps = { affiliates: { isEnabled: () => true, findBySerie: () => null } };
    expect(consultarAfiliadoLogic(deps, authorized, { serie: '999999999' }).ok).toBe(false);
  });
});

describe('emitirPolizaLogic', () => {
  const policies = { issue: jest.fn().mockResolvedValue({ policyId: 'pol-1' }) };

  it('refuses before the data is captured, instead of issuing a half-filled policy', async () => {
    const result = await emitirPolizaLogic({ policies }, 'conv-1', { ...authorized });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.motivo).toContain('cédula');
    expect(policies.issue).not.toHaveBeenCalled();
  });

  it('issues once cedula, nombre and the quoted product are all present', async () => {
    const context = { ...authorized, cedula: '12345678', nombre: 'Juan Pérez', quoteProductId: 'vida' };
    await expect(emitirPolizaLogic({ policies }, 'conv-1', context)).resolves.toEqual({ ok: true, policyId: 'pol-1' });
  });
});

describe('generarLinkPagoLogic', () => {
  it('refuses when Wompi is not configured, rather than inventing a link', async () => {
    const deps = { quoting, payments: { isEnabled: false, createPaymentLink: jest.fn() } };
    const result = await generarLinkPagoLogic(deps, { ...authorized, productCategory: 'vida' }, { policyId: 'pol-1' });
    expect(result.ok).toBe(false);
  });

  // Money: two Wompi links for one policy are two possible charges.
  it('regresión — con un link vigente devuelve ese, no crea otro', async () => {
    const createPaymentLink = jest.fn();
    const deps = { quoting, payments: { isEnabled: true, createPaymentLink } };
    const context = { ...authorized, productCategory: 'vida', checkoutUrl: 'https://checkout.wompi.co/l/ya-existe' };

    const result = await generarLinkPagoLogic(deps, context, { policyId: 'pol-1' });

    expect(result).toEqual({ ok: true, checkoutUrl: 'https://checkout.wompi.co/l/ya-existe' });
    expect(createPaymentLink).not.toHaveBeenCalled();
  });

  it('prices the link from the catalog, never from an argument', async () => {
    const createPaymentLink = jest.fn().mockResolvedValue({ checkoutUrl: 'https://checkout.wompi.co/l/x' });
    const deps = { quoting, payments: { isEnabled: true, createPaymentLink } };
    const result = await generarLinkPagoLogic(deps, { ...authorized, productCategory: 'vida' }, { policyId: 'pol-1' });

    expect(result).toEqual({ ok: true, checkoutUrl: 'https://checkout.wompi.co/l/x' });
    expect(createPaymentLink).toHaveBeenCalledWith(expect.objectContaining({ amountCOP: expect.any(Number) }));
  });
});

// vida and the pet prepaid plans cannot be issued without underwriting answers. The rule sits
// in the contract, not the prompt — the same call made for Ley 1581.
describe('aseguramiento', () => {
  const catalog = new ProductCatalog();
  const deps = { catalog, policies: { issue: jest.fn().mockResolvedValue({ policyId: 'pol-1' }) } };
  const readyForVida = { ...authorized, cedula: '12345678', nombre: 'Juan Pérez', quoteProductId: 'vida' };

  beforeEach(() => deps.policies.issue.mockClear());

  it('sabe qué productos lo exigen y cuáles no', () => {
    expect(requiresUnderwriting({ catalog }, { quoteProductId: 'vida' })).toBe(true);
    expect(requiresUnderwriting({ catalog }, { quoteProductId: 'medicina-prepagada-gatos' })).toBe(true);
    expect(requiresUnderwriting({ catalog }, { quoteProductId: 'accidentes-personales' })).toBe(false);
  });

  it('regresión — emitirPoliza rechaza vida sin las respuestas de salud', async () => {
    const result = await emitirPolizaLogic(deps, 'conv-1', readyForVida);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.motivo).toContain('aseguramiento');
    expect(deps.policies.issue).not.toHaveBeenCalled();
  });

  it('emite vida una vez registradas', async () => {
    const result = await emitirPolizaLogic(deps, 'conv-1', { ...readyForVida, medicalInfoProvided: true });
    expect(result).toEqual({ ok: true, policyId: 'pol-1' });
  });

  it('un producto sin aseguramiento no queda bloqueado', async () => {
    const context = { ...authorized, cedula: '12345678', nombre: 'Juan Pérez', quoteProductId: 'accidentes-personales' };
    await expect(emitirPolizaLogic(deps, 'conv-1', context)).resolves.toEqual({ ok: true, policyId: 'pol-1' });
  });

  it('registrar exige una respuesta real, no una cadena vacía', () => {
    expect(registrarAseguramientoLogic({ catalog }, { ...readyForVida, respuestas: '' } as never, { respuestas: '' }).ok).toBe(false);
    expect(registrarAseguramientoLogic({ catalog }, readyForVida, { respuestas: 'Tengo 34 años, sin enfermedades.' }).ok).toBe(true);
  });

  it('no se registra sin autorización', () => {
    expect(registrarAseguramientoLogic({ catalog }, { quoteProductId: 'vida' }, { respuestas: 'ok' })).toMatchObject({ ok: false });
  });
});
