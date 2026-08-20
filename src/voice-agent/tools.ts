// tools.ts: the LiveKit wrappers for every capability the voice worker gained. Each one
// delegates to modules/agent/tools, so voice enforces the same rules as text — including
// Ley 1581, which is checked inside the shared logic rather than trusted to the prompt.
import { tool } from '@livekit/agents';
import { z } from 'zod';
import {
  ToolDeps, consultarAfiliadoLogic, emitirPolizaLogic, generarLinkPagoLogic,
  escalarAHumanoLogic, registrarAseguramientoLogic, registrarLeadLogic, registrarMascotasLogic,
  seleccionarProductoLogic, validarDatosLogic,
} from '../modules/agent/tools';
import { VoiceSessionState } from './session-state';

export function createAutorizarTool(state: VoiceSessionState) {
  return tool({
    name: 'autorizar',
    description:
      'Registra que la persona ACABA de autorizar en voz alta el tratamiento de sus datos (Ley 1581). ' +
      'Llámala solo cuando haya dicho que sí. Ninguna otra herramienta funciona antes de esto.',
    parameters: z.object({
      autoriza: z.boolean().describe('true si la persona autorizó, false si se negó.'),
    }),
    execute: async ({ autoriza }) => {
      state.merge({ autorizado: autoriza === true });
      return autoriza
        ? { ok: true, mensaje: 'Autorización registrada.' }
        : { ok: false, motivo: 'Sin autorización no se puede continuar. Despídete con amabilidad.' };
    },
  });
}

export function createConsultarAfiliadoTool(deps: Pick<ToolDeps, 'affiliates'>, state: VoiceSessionState) {
  return tool({
    name: 'consultar_afiliado',
    description:
      'Busca el perfil del afiliado de Colsubsidio por su ID para no preguntar lo que ya está en ficha. ' +
      'Si no aparece, sigue la conversación normalmente.',
    parameters: z.object({ serie: z.string().describe('El ID de afiliado que dictó la persona, solo dígitos.') }),
    execute: async ({ serie }) => {
      const result = consultarAfiliadoLogic(deps, state.context, { serie });
      if (result.ok && result.encontrado) {
        state.merge({
          serieId: serie,
          rangoSalarial: result.rangoSalarial,
          ...(result.mascotas !== undefined ? { petCount: result.mascotas } : {}),
        });
      }
      return result;
    },
  });
}

export function createCapturarDatosTool(state: VoiceSessionState) {
  return tool({
    name: 'capturar_datos',
    description:
      'Guarda la cédula, el nombre y el correo que la persona dictó. Envía cada dato apenas lo tengas. ' +
      'Si la herramienta responde que no pudo validar algo, vuelve a preguntar ESE dato.',
    parameters: z.object({
      cedula: z.string().nullable().optional().describe('Cédula dictada, solo dígitos.'),
      nombre: z.string().nullable().optional().describe('Nombre completo tal como lo dijo.'),
      email: z.string().nullable().optional().describe('Correo dictado; "arroba" y "punto" se aceptan en palabras.'),
      mensaje: z.string().optional().describe('Lo que dijo, tal cual.'),
      documentType: z.enum(['CC', 'CE', 'PEP', 'TI', 'NIP', 'NUIP']).optional()
        .describe('Qué documento dijo que es. Si no lo dijo, pregúntaselo — no lo supongas.'),
    }),
    execute: async (args) => {
      const result = validarDatosLogic({
        ...(args.cedula ? { cedula: args.cedula } : {}),
        ...(args.nombre ? { nombre: args.nombre } : {}),
        ...(args.email ? { email: args.email } : {}),
        ...(args.documentType ? { documentType: args.documentType } : {}),
        ...(args.mensaje ? { mensaje: args.mensaje } : {}),
      });
      if (result.ok) state.merge(result.datos);
      return result;
    },
  });
}

export function createEmitirPolizaTool(deps: Pick<ToolDeps, 'policies'>, state: VoiceSessionState) {
  return tool({
    name: 'emitir_poliza',
    description:
      'Emite la póliza con los datos ya capturados. Llámala solo después de leerle el resumen a la ' +
      'persona y de que confirme. Si responde que falta un dato, pídeselo.',
    parameters: z.object({}),
    execute: async () => {
      if (!state.conversationId) {
        return { ok: false, motivo: 'Esta sesión de voz no está ligada a una conversación, no puedo emitir.' };
      }
      const result = await emitirPolizaLogic(deps, state.conversationId, state.context);
      if (result.ok) state.merge({ policyId: result.policyId });
      return result;
    },
  });
}

export function createGenerarLinkPagoTool(deps: Pick<ToolDeps, 'payments' | 'quoting'>, state: VoiceSessionState) {
  return tool({
    name: 'generar_link_pago',
    description:
      'Crea el link de pago de la póliza ya emitida. Dile a la persona que se lo dejas en el chat; ' +
      'nunca leas la URL en voz alta.',
    parameters: z.object({}),
    execute: async () => {
      const result = await generarLinkPagoLogic(deps, state.context, { policyId: state.context.policyId ?? '' });
      if (result.ok) state.merge({ checkoutUrl: result.checkoutUrl });
      return result;
    },
  });
}

export function createPreguntasAseguramientoTool(deps: Pick<ToolDeps, 'catalog'>, state: VoiceSessionState) {
  return tool({
    name: 'preguntas_aseguramiento',
    description:
      'Registra lo que la persona respondió sobre su estado de salud. Vida y los planes de ' +
      'medicina prepagada para mascotas no se pueden emitir sin esto — pregúntalo antes del resumen.',
    parameters: z.object({
      respuestas: z.string().describe('Lo que dijo sobre edad, enfermedades o historial clínico.'),
    }),
    execute: async ({ respuestas }) => {
      const result = registrarAseguramientoLogic(deps, state.context, { respuestas });
      if (result.ok) state.merge({ medicalInfoProvided: true, medicalInfo: respuestas });
      return result;
    },
  });
}

export function createSeleccionarProductoTool(deps: Pick<ToolDeps, 'quoting' | 'catalog'>, state: VoiceSessionState) {
  return tool({
    name: 'seleccionar_producto',
    description:
      'Fija la cotización en una opción que YA le ofreciste — cuando diga "la primera", ' +
      '"la anterior" o "la más barata". Solo acepta productos ya mostrados.',
    parameters: z.object({ productId: z.string().describe('El id del producto ya ofrecido.') }),
    execute: async ({ productId }) => {
      const result = seleccionarProductoLogic(deps, state.context, { productId });
      if (result.ok) state.merge({ quoteProductId: result.productId });
      return result;
    },
  });
}

export function createRegistrarMascotasTool(state: VoiceSessionState) {
  return tool({
    name: 'registrar_mascotas',
    description:
      'Guarda nombre, edad y raza de CADA mascota a asegurar. Sin esto no se emite una póliza ' +
      'de mascotas. Pregúntaselos de a una si es más natural.',
    parameters: z.object({
      mascotas: z.array(z.object({
        nombre: z.string(),
        edad: z.string(),
        raza: z.string().optional(),
      })),
    }),
    execute: async (args) => {
      const result = registrarMascotasLogic(state.context, args as never);
      if (result.ok) state.merge({ pets: result.mascotas });
      return result;
    },
  });
}

export function createEscalarTool(state: VoiceSessionState) {
  return tool({
    name: 'escalar_a_humano',
    description:
      'Entrega la llamada a una persona del equipo: si no puedes ayudar, si te lo piden, o ' +
      'ante un reclamo que no resuelves con las otras herramientas.',
    parameters: z.object({ motivo: z.string().describe('Por qué escalas, para quien atienda.') }),
    execute: async ({ motivo }) => {
      const result = escalarAHumanoLogic(state.context, { motivo });
      if (result.ok) state.merge({ escalatedReason: result.motivo });
      return result;
    },
  });
}

export function createRegistrarLeadTool(state: VoiceSessionState) {
  return tool({
    name: 'registrar_lead',
    description:
      'Guarda los datos de la persona para que el equipo la contacte, cuando no hay una opción ' +
      'en el catálogo para lo que necesita. Requiere nombre y un correo o un teléfono.',
    parameters: z.object({
      nombre: z.string().optional(),
      email: z.string().optional(),
      telefono: z.string().optional(),
      interes: z.string().optional().describe('Qué buscaba, para quien la contacte.'),
    }),
    execute: async (args) => {
      const result = registrarLeadLogic(state.context, args);
      if (result.ok) {
        state.merge({
          contactName: result.lead.nombre,
          contactEmail: result.lead.email,
          contactPhone: result.lead.telefono,
        });
      }
      return result;
    },
  });
}
