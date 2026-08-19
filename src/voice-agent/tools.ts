// tools.ts: the LiveKit wrappers for every capability the voice worker gained. Each one
// delegates to modules/agent/tools, so voice enforces the same rules as text — including
// Ley 1581, which is checked inside the shared logic rather than trusted to the prompt.
import { tool } from '@livekit/agents';
import { z } from 'zod';
import {
  ToolDeps, consultarAfiliadoLogic, emitirPolizaLogic, generarLinkPagoLogic, validarDatosLogic,
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
    }),
    execute: async (args) => {
      const result = validarDatosLogic({
        ...(args.cedula ? { cedula: args.cedula } : {}),
        ...(args.nombre ? { nombre: args.nombre } : {}),
        ...(args.email ? { email: args.email } : {}),
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
