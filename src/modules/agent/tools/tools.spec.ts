// tools.spec.ts: the shared capability layer — one implementation for text and voice. The
// Ley 1581 gate is asserted per tool, because in voice it used to be only a prompt rule.

import { ProductCatalog } from '../../quoting/product-catalog.service';
import { QuotingService } from '../../quoting/quoting.service';
import {
  NOT_AUTHORIZED, cotizarLogic, validarDatosLogic, consultarAfiliadoLogic,
  emitirPolizaLogic, generarLinkPagoLogic, registrarAseguramientoLogic, requiresUnderwriting,
  detectarTipoDocumento, seleccionarProductoLogic, detectarFueraDeCatalogo,
  registrarMascotasLogic, esProductoDeMascotas, registrarLeadLogic,
  tipoDocumentoDeclarado, TIPOS_DOCUMENTO, TIPOS_DOCUMENTO_OFRECIDOS,
} from './index';

const quoting = new QuotingService(new ProductCatalog());
const authorized = { autorizado: true };

describe('tools — Ley 1581 is a precondition, not an instruction', () => {
  it.each([
    ['consultarAfiliado', () => consultarAfiliadoLogic({}, {}, { serie: '42' })],
    ['emitirPoliza', () => emitirPolizaLogic({}, 'conv-1', {})],
    ['generarLinkPago', () => generarLinkPagoLogic({}, {}, { policyId: 'pol-1' })],
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
    // preguntarTipo comes along because nobody said which document it is.
    expect(result).toMatchObject({ ok: true, datos: { cedula: '1234567', documentType: 'CC', email: 'juan@mail.com' } });
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
  const catalogo = new ProductCatalog();
  const conPago = (createPaymentLink: jest.Mock) => ({
    catalog: catalogo,
    payments: { isEnabled: true, createPaymentLink },
  });
  const elegido = { ...authorized, quoteProductId: 'vida' };

  it('refuses when Wompi is not configured, rather than inventing a link', async () => {
    const deps = { catalog: catalogo, payments: { isEnabled: false, createPaymentLink: jest.fn() } };
    const result = await generarLinkPagoLogic(deps, elegido, { policyId: 'pol-1' });
    expect(result.ok).toBe(false);
  });

  // Money: two Wompi links for one policy are two possible charges.
  it('regresión — con un link vigente devuelve ese, no crea otro', async () => {
    const createPaymentLink = jest.fn();
    const context = { ...elegido, checkoutUrl: 'https://checkout.wompi.co/l/ya-existe' };

    const result = await generarLinkPagoLogic(conPago(createPaymentLink), context, { policyId: 'pol-1' });

    expect(result).toEqual({ ok: true, checkoutUrl: 'https://checkout.wompi.co/l/ya-existe' });
    expect(createPaymentLink).not.toHaveBeenCalled();
  });

  it('prices the link from the catalog, never from an argument', async () => {
    const createPaymentLink = jest.fn().mockResolvedValue({ checkoutUrl: 'https://checkout.wompi.co/l/x' });
    const result = await generarLinkPagoLogic(conPago(createPaymentLink), elegido, { policyId: 'pol-1' });

    expect(result).toEqual({ ok: true, checkoutUrl: 'https://checkout.wompi.co/l/x' });
    expect(createPaymentLink).toHaveBeenCalledWith(expect.objectContaining({ amountCOP: expect.any(Number) }));
  });

  // Reported from a live call on 2026-08-25: the sheet showed Asistencias múltiples at
  // $20.000 and Wompi charged $12.000 for Vida. This tool called bestQuote(), which re-runs
  // scoring and returns whatever wins NOW, while emitir_poliza issued the policy for the
  // pinned product — so the policy and the charge were for different things.
  it('regresión — cobra el producto elegido, no el que el motor prefiera ahora', async () => {
    const createPaymentLink = jest.fn().mockResolvedValue({ checkoutUrl: 'https://checkout.wompi.co/l/x' });
    // productCategory 'vida' is what bestQuote() would follow; the pinned product is another.
    const context = { ...authorized, productCategory: 'vida' as const, quoteProductId: 'asistencias-multiples' };

    await generarLinkPagoLogic(conPago(createPaymentLink), context, { policyId: 'pol-1' });

    expect(createPaymentLink).toHaveBeenCalledWith(
      expect.objectContaining({ productName: 'Asistencias múltiples' }),
    );
  });

  // Charging something nobody was shown is worse than not charging at all — the same call
  // the state machine made when it stopped falling back to a flat amount.
  it('se niega cuando no hay producto elegido, en vez de cobrar cualquier cosa', async () => {
    const createPaymentLink = jest.fn();
    const result = await generarLinkPagoLogic(
      conPago(createPaymentLink),
      { ...authorized, productCategory: 'vida' as const },
      { policyId: 'pol-1' },
    );

    expect(result.ok).toBe(false);
    expect(createPaymentLink).not.toHaveBeenCalled();
  });

  it('suma los productos de una compra múltiple, no cobra solo el primero', async () => {
    const createPaymentLink = jest.fn().mockResolvedValue({ checkoutUrl: 'https://checkout.wompi.co/l/x' });
    const context = { ...authorized, selectedProductIds: ['vida', 'asistencias-multiples'] };

    await generarLinkPagoLogic(conPago(createPaymentLink), context, { policyId: 'pol-1' });

    const [args] = createPaymentLink.mock.calls[0];
    expect(args.productName).toBe('2 seguros Colsubsidio');
    expect(args.amountCOP).toBe(32000);
  });

  // Without it Wompi's receipt is a dead end in every outcome — approved, rejected, no funds.
  it('pasa la URL de retorno a Wompi cuando la hay', async () => {
    const createPaymentLink = jest.fn().mockResolvedValue({ checkoutUrl: 'https://checkout.wompi.co/l/x' });

    await generarLinkPagoLogic(conPago(createPaymentLink), elegido, {
      policyId: 'pol-1',
      redirectUrl: 'https://asegura.example/voz.html?token=abc',
    });

    expect(createPaymentLink).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUrl: 'https://asegura.example/voz.html?token=abc' }),
    );
  });

  it('omite el campo cuando no hay URL de retorno, en vez de mandar undefined', async () => {
    const createPaymentLink = jest.fn().mockResolvedValue({ checkoutUrl: 'https://checkout.wompi.co/l/x' });

    await generarLinkPagoLogic(conPago(createPaymentLink), elegido, { policyId: 'pol-1' });

    expect(createPaymentLink.mock.calls[0][0]).not.toHaveProperty('redirectUrl');
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

// Migrated from the state machine's DATA_CAPTURE block: these rules used to live only there,
// so the router would have accepted an acknowledgement as a name and filed every document as
// a cedula de ciudadania.
describe('validarDatos — reglas migradas de DATA_CAPTURE', () => {
  it.each(['gracias', 'ok', 'listo', 'dale', 'bueno', 'ya'])(
    'regresión — "%s" es un acuse, no un nombre',
    (filler) => {
      expect(validarDatosLogic({ nombre: filler }).ok).toBe(false);
    },
  );

  it('un nombre real sigue pasando', () => {
    expect(validarDatosLogic({ nombre: 'Juan Pérez' })).toEqual({ ok: true, datos: { nombre: 'Juan Pérez' } });
  });

  it.each([
    ['12345678', 'CC'],
    ['mi cédula de extranjería 12345678', 'CE'],
    ['CE 12345678', 'CE'],
    ['tarjeta de identidad 12345678', 'TI'],
    ['TI 12345678', 'TI'],
    ['NUIP 12345678', 'NUIP'],
    ['NIP 12345678', 'NIP'],
    ['PEP 12345678', 'PEP'],
    ['mi permiso especial de permanencia 12345678', 'PEP'],
    // 'pep' dentro de otra palabra no es un tipo de documento.
    ['pepito 12345678', 'CC'],
  ])('%s se archiva como %s', (text, expected) => {
    expect(detectarTipoDocumento(text)).toBe(expected);
  });

  it('el tipo de documento se archiva junto con la cédula, no en otro turno', () => {
    expect(validarDatosLogic({ cedula: '12345678', mensaje: 'mi cédula de extranjería es 12345678' })).toEqual({
      ok: true,
      datos: { cedula: '12345678', documentType: 'CE' },
    });
  });

  it.each(['abc', '123', '12.345.678'])('regresión — "%s" no es una cédula válida', (bad) => {
    const result = validarDatosLogic({ cedula: bad });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.motivo).toContain('dígitos');
  });
});

// Migrated from QUOTE_PRESENTED's back-reference block: the machine resolved "la primera" and
// "prefiero la anterior" with regexes over shownProductIds. The model reads the transcript
// instead, but it may only pin the quote to something the person was actually offered —
// otherwise a back-reference silently becomes a different product at a different price.
describe('seleccionarProducto — solo entre lo ya ofrecido', () => {
  const catalog = new ProductCatalog();
  const deps = { quoting, catalog };
  const shown = { ...authorized, shownProductIds: ['asistencias-medicas', 'exequial'] };

  it('fija la cotización en una opción ya mostrada', () => {
    const result = seleccionarProductoLogic(deps, shown, { productId: 'exequial' });
    expect(result).toMatchObject({ ok: true, productId: 'exequial' });
    if (result.ok) expect(result.precioMensual).toBeGreaterThan(0);
  });

  it('regresión — rechaza un producto que nunca se ofreció', () => {
    const result = seleccionarProductoLogic(deps, shown, { productId: 'vida' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.motivo).toContain('ya ofrecidas');
  });

  it('sin nada ofrecido todavía, manda a cotizar', () => {
    const result = seleccionarProductoLogic(deps, authorized, { productId: 'vida' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.motivo).toContain('cotizar');
  });

  it('no funciona sin autorización', () => {
    expect(seleccionarProductoLogic(deps, { shownProductIds: ['vida'] }, { productId: 'vida' }).ok).toBe(false);
  });

  it('un id inexistente no se acepta aunque figure como mostrado', () => {
    const result = seleccionarProductoLogic(deps, { ...authorized, shownProductIds: ['inventado'] }, { productId: 'inventado' });
    expect(result.ok).toBe(false);
  });
});

// Migrated from the cross-sell block. The machine guards this with textual evidence of a
// category, because trusting the model's inference on a decline once produced a second payment
// link for the policy the person had just said was wrong. The router IS that inference, so the
// guard has to live in the tool.
describe('cotizar — no reofrece lo que la persona ya compró', () => {
  const bought = { ...authorized, purchasedProductIds: ['vida'] };

  it('regresión — rechaza cotizar un producto ya comprado y dice qué hacer', () => {
    const result = cotizarLogic(quoting, { productCategory: 'vida' }, bought);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.motivo).toContain('ya compró');
      expect(result.motivo).toContain('qué otra cosa');
    }
  });

  it('otra categoría sí se cotiza tras la compra — el cross-sell sigue vivo', () => {
    const result = cotizarLogic(quoting, { productCategory: 'mascotas', petType: 'gato' }, bought);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cotizacion.productId).toBe('medicina-prepagada-gatos');
  });

  it('sin contexto se comporta como antes — los llamadores viejos no cambian', () => {
    expect(cotizarLogic(quoting, { productCategory: 'vida' }).ok).toBe(true);
  });
});

// Migrated from DISCOVERY. The category enum only has the five Asegura sells, so the model is
// forced to pick one — without this guard a request for car insurance would be misclassified
// by construction and answered with an unrelated product, against rule #12.
describe('cotizar — lo que no está en el catálogo se dice, no se sustituye', () => {
  it.each([
    ['quiero un seguro para mi carro', 'vehículos'],
    ['seguro de moto', 'vehículos'],
    ['necesito el SOAT', 'vehículos'],
    ['un seguro para mi empresa', 'empresas'],
    ['algo para mi negocio', 'empresas'],
  ])('%s → %s', (mensaje, esperado) => {
    expect(detectarFueraDeCatalogo(mensaje)).toBe(esperado);
  });

  it('no se confunde con lo que sí vendemos', () => {
    for (const ok of ['seguro de vida', 'algo para mi gato', 'asistencia médica', 'accidentes personales']) {
      expect(detectarFueraDeCatalogo(ok)).toBeNull();
    }
  });

  it('regresión — cotizar rechaza y dice qué ofrecer en su lugar', () => {
    const result = cotizarLogic(quoting, { productCategory: 'accidentes', mensaje: 'quiero asegurar mi carro' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.motivo).toContain('no vende seguros de vehículos');
      expect(result.motivo).toContain('vida, accidentes');
    }
  });

  it('una petición normal sigue cotizando', () => {
    expect(cotizarLogic(quoting, { productCategory: 'vida', mensaje: 'quiero proteger a mi familia' }).ok).toBe(true);
  });
});

// Migrated from DATA_CAPTURE's per-pet block. The machine walks the pets one at a time; the
// model may gather them in any order, so the contract is the count and the fields — a policy
// issued without them prices on a number nobody confirmed and prints an empty table.
describe('registrarMascotas', () => {
  const catalog = new ProductCatalog();
  const dosGatos = { ...authorized, petCount: 2, quoteProductId: 'medicina-prepagada-gatos' };

  it('guarda las mascotas cuando llegan completas', () => {
    const result = registrarMascotasLogic(dosGatos, {
      mascotas: [{ nombre: 'Ramón', edad: '3', raza: 'criollo' }, { nombre: 'Luna', edad: '1' }],
    });
    expect(result).toEqual({
      ok: true,
      mascotas: [
        { name: 'Ramón', age: '3', breed: 'criollo' },
        { name: 'Luna', age: '1', breed: '' },
      ],
    });
  });

  it('regresión — faltando una mascota, dice cuántas faltan en vez de emitir a medias', () => {
    const result = registrarMascotasLogic(dosGatos, { mascotas: [{ nombre: 'Ramón', edad: '3' }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.motivo).toContain('2 mascota');
  });

  it('un acuse no es el nombre de una mascota', () => {
    const result = registrarMascotasLogic({ ...authorized, petCount: 1 }, { mascotas: [{ nombre: 'gracias', edad: '2' }] });
    expect(result.ok).toBe(false);
  });

  it('sin edad no se guarda', () => {
    const result = registrarMascotasLogic({ ...authorized, petCount: 1 }, { mascotas: [{ nombre: 'Ramón', edad: '' }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.motivo).toContain('Ramón');
  });

  it('reconoce los productos que exigen datos de mascota', () => {
    expect(esProductoDeMascotas({ catalog }, { quoteProductId: 'medicina-prepagada-gatos' })).toBe(true);
    expect(esProductoDeMascotas({ catalog }, { quoteProductId: 'asistencia-veterinaria' })).toBe(true);
    expect(esProductoDeMascotas({ catalog }, { quoteProductId: 'vida' })).toBe(false);
  });

  it('regresión — emitirPoliza rechaza una póliza de mascotas sin sus datos', async () => {
    const deps = { catalog, policies: { issue: jest.fn().mockResolvedValue({ policyId: 'pol-1' }) } };
    const context = { ...dosGatos, cedula: '12345678', nombre: 'Juan Pérez', medicalInfoProvided: true };
    const result = await emitirPolizaLogic(deps, 'conv-1', context);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.motivo).toContain('mascotas');
    expect(deps.policies.issue).not.toHaveBeenCalled();
  });

  it('con los datos, emite', async () => {
    const deps = { catalog, policies: { issue: jest.fn().mockResolvedValue({ policyId: 'pol-1' }) } };
    const context = {
      ...dosGatos, cedula: '12345678', nombre: 'Juan Pérez', medicalInfoProvided: true,
      pets: [{ name: 'Ramón', age: '3', breed: '' }, { name: 'Luna', age: '1', breed: '' }],
    };
    await expect(emitirPolizaLogic(deps, 'conv-1', context)).resolves.toEqual({ ok: true, policyId: 'pol-1' });
  });
});

// Migrated from 'lead capture after category exhaustion'. Notifying whoever picks it up is
// transport; what belongs in the contract is that the lead can actually be acted on.
describe('registrarLead', () => {
  it('reutiliza lo que la conversación ya sabe en vez de volver a preguntar', () => {
    const context = { ...authorized, nombre: 'Juan Pérez', email: 'juan@mail.com' };
    expect(registrarLeadLogic(context, {})).toEqual({
      ok: true,
      lead: { nombre: 'Juan Pérez', email: 'juan@mail.com' },
    });
  });

  it('regresión — un nombre sin forma de contacto no es un lead', () => {
    const result = registrarLeadLogic({ ...authorized }, { nombre: 'Juan Pérez' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.motivo).toContain('correo o un teléfono');
  });

  it('un teléfono solo alcanza', () => {
    const result = registrarLeadLogic({ ...authorized }, { nombre: 'Juan Pérez', telefono: '+573001112233' });
    expect(result).toMatchObject({ ok: true, lead: { telefono: '+573001112233' } });
  });

  it('valida el correo con la misma regla que el resto', () => {
    expect(registrarLeadLogic({ ...authorized }, { nombre: 'Juan Pérez', email: 'no-es-correo' }).ok).toBe(false);
  });

  it('acepta un correo dictado por voz', () => {
    const result = registrarLeadLogic({ ...authorized }, { nombre: 'Juan Pérez', email: 'juan arroba mail punto com' });
    expect(result).toMatchObject({ ok: true, lead: { email: 'juan@mail.com' } });
  });

  it('guarda qué buscaba, para quien la contacte', () => {
    const result = registrarLeadLogic({ ...authorized }, { nombre: 'Ana', telefono: '3001112233', interes: 'seguro de bicicleta' });
    expect(result).toMatchObject({ ok: true, lead: { interes: 'seguro de bicicleta' } });
  });

  it('no registra sin autorización', () => {
    expect(registrarLeadLogic({ nombre: 'Juan Pérez', email: 'juan@mail.com' } as never, {}).ok).toBe(false);
  });
});

describe('tipo de documento — se pregunta, no se asume', () => {
  it('un número pelado sigue quedando como CC, pero pide confirmarlo', () => {
    const result = validarDatosLogic({ cedula: '12345678' });
    expect(result).toMatchObject({ ok: true, datos: { documentType: 'CC' } });
    if (result.ok) {
      // Se ofrecen los tres que trae la gente; leer los seis en voz alta no es una pregunta.
      expect(result.preguntarTipo).toContain('cédula de ciudadanía');
      expect(result.preguntarTipo).toContain('cédula de extranjería');
      expect(result.preguntarTipo).toContain('PEP');
      expect(result.preguntarTipo).not.toContain('tarjeta de identidad');
    }
  });

  it('si la persona lo dijo, no vuelve a preguntar', () => {
    const result = validarDatosLogic({ cedula: '12345678', mensaje: 'mi cédula de extranjería es 12345678' });
    expect(result).toMatchObject({ ok: true, datos: { documentType: 'CE' } });
    if (result.ok) expect(result.preguntarTipo).toBeUndefined();
  });

  it('una respuesta explícita del modelo gana sobre la detección', () => {
    const result = validarDatosLogic({ cedula: '12345678', documentType: 'TI', mensaje: '12345678' });
    expect(result).toMatchObject({ ok: true, datos: { documentType: 'TI' } });
    if (result.ok) expect(result.preguntarTipo).toBeUndefined();
  });

  it('distingue "lo dijo" de "no lo dijo"', () => {
    expect(tipoDocumentoDeclarado('12345678')).toBeNull();
    expect(tipoDocumentoDeclarado('mi cc es 12345678')).toBe('CC');
    expect(tipoDocumentoDeclarado('cédula de ciudadanía')).toBe('CC');
  });

  it('se aceptan seis tipos, con CC primero por ser el más común', () => {
    expect(TIPOS_DOCUMENTO[0]).toBe('CC');
    expect(TIPOS_DOCUMENTO).toHaveLength(6);
    expect(TIPOS_DOCUMENTO).toContain('PEP');
  });

  it('se preguntan solo tres, aunque se acepten los seis', () => {
    expect(TIPOS_DOCUMENTO_OFRECIDOS).toEqual(['CC', 'CE', 'PEP']);
  });
});
