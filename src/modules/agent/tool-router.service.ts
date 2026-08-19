// tool-router.service.ts: drives the shared capabilities with an LLM loop instead of the
// hand-written state machine. Off unless AGENT_ROUTER=llm — the deterministic path in
// agent.service.ts stays the shipped one until this proves out on real conversations.
import { Injectable, Logger } from '@nestjs/common';
import { ChatTurn, INlpProvider, ToolSchema } from '../nlp/types';
import { ConversationContext } from './types';
import {
  ToolDeps, consultarAfiliadoLogic, cotizarLogic, emitirPolizaLogic,
  generarLinkPagoLogic, registrarAseguramientoLogic, registrarMascotasLogic,
  seleccionarProductoLogic, validarDatosLogic,
} from './tools';

// The model may call at most this many tools per user message: a loop that keeps calling is
// a bug, and a person waiting on a reply must never wait on an unbounded chain.
const MAX_TOOL_HOPS = 4;

export interface RouterReply {
  text: string;
  context: ConversationContext;
}

@Injectable()
export class ToolRouterService {
  private readonly logger = new Logger(ToolRouterService.name);

  // Kept beside the tool implementations on purpose: a schema that drifts from its logic is
  // how a model ends up calling something that cannot run.
  private static readonly SCHEMAS: ToolSchema[] = [
    {
      name: 'autorizar',
      description: 'Registra que la persona autorizó (o no) el tratamiento de sus datos, Ley 1581.',
      parameters: { type: 'object', properties: { autoriza: { type: 'boolean' } }, required: ['autoriza'] },
    },
    {
      name: 'consultar_afiliado',
      description: 'Busca el perfil del afiliado por su ID para no preguntar lo que ya está en ficha.',
      parameters: { type: 'object', properties: { serie: { type: 'string' } }, required: ['serie'] },
    },
    {
      name: 'cotizar',
      description: 'Única fuente de precios y productos. Nunca digas un precio que no venga de aquí.',
      parameters: {
        type: 'object',
        properties: {
          productCategory: { type: ['string', 'null'], enum: ['vida', 'hogar', 'accidentes', 'asistencia', 'mascotas', null] },
          dependents: { type: ['number', 'null'] },
          budget: { type: ['number', 'null'] },
          petType: { type: ['string', 'null'], enum: ['gato', 'perro', 'mixto', null] },
          mensaje: { type: 'string', description: 'El mensaje completo de la persona, tal cual lo dijo.' },
        },
        required: ['productCategory'],
      },
    },
    {
      name: 'seleccionar_producto',
      description:
        'Fija la cotización en una opción que YA se le ofreció a la persona — úsala cuando diga ' +
        '"la primera", "la anterior", "la más barata" o nombre un precio que ya escuchó. ' +
        'Solo acepta productos ya mostrados.',
      parameters: {
        type: 'object',
        properties: { productId: { type: 'string', description: 'El id del producto ya ofrecido.' } },
        required: ['productId'],
      },
    },
    {
      name: 'capturar_datos',
      description: 'Valida y guarda cédula, nombre y correo. Envía cada dato apenas lo tengas.',
      parameters: {
        type: 'object',
        properties: {
          cedula: { type: 'string', description: 'Solo los dígitos.' },
          nombre: { type: 'string' },
          email: { type: 'string' },
          mensaje: { type: 'string', description: 'El mensaje completo, para leer si es CC, CE, TI, NIP o NUIP.' },
        },
      },
    },
    {
      name: 'registrar_mascotas',
      description:
        'Guarda el nombre, la edad y la raza de CADA mascota que se va a asegurar. Sin esto no ' +
        'se puede emitir una póliza de mascotas — pídeselos una por una si hace falta.',
      parameters: {
        type: 'object',
        properties: {
          mascotas: {
            type: 'array',
            items: {
              type: 'object',
              properties: { nombre: { type: 'string' }, edad: { type: 'string' }, raza: { type: 'string' } },
              required: ['nombre', 'edad'],
            },
          },
        },
        required: ['mascotas'],
      },
    },
    {
      name: 'preguntas_aseguramiento',
      description:
        'Registra las respuestas de salud que exigen vida y los planes de medicina prepagada ' +
        'para mascotas. Sin esto no se puede emitir esos productos.',
      parameters: {
        type: 'object',
        properties: { respuestas: { type: 'string', description: 'Lo que respondió la persona sobre su estado de salud.' } },
        required: ['respuestas'],
      },
    },
    {
      name: 'emitir_poliza',
      description: 'Emite la póliza con los datos capturados, tras leer el resumen y recibir confirmación.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'generar_link_pago',
      description: 'Crea el link de pago de la póliza ya emitida.',
      parameters: { type: 'object', properties: {} },
    },
  ];

  constructor(private readonly deps: ToolDeps) {}

  async handle(
    nlp: INlpProvider,
    conversationId: string,
    context: ConversationContext,
    systemPrompt: string,
    history: ChatTurn[],
    userText: string,
  ): Promise<RouterReply> {
    if (!nlp.chatWithTools) {
      throw new Error('This NLP provider cannot drive the tool router');
    }

    let ctx: ConversationContext = { ...context };
    const messages: ChatTurn[] = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userText },
    ];

    for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
      const answer = await nlp.chatWithTools(messages, ToolRouterService.SCHEMAS);
      if (!answer.toolCalls?.length) {
        return { text: answer.text ?? '', context: ctx };
      }

      messages.push({ role: 'assistant', content: answer.text ?? '', toolCalls: answer.toolCalls });
      for (const call of answer.toolCalls) {
        const { result, context: next } = await this.run(conversationId, ctx, call.name, call.args);
        ctx = next;
        messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result) });
      }
    }

    // Out of hops: answer with what is known rather than looping the person forever.
    this.logger.warn(`Tool router hit ${MAX_TOOL_HOPS} hops for conversation ${conversationId}`);
    const last = await nlp.chatWithTools(messages, []);
    return { text: last.text ?? '', context: ctx };
  }

  // Every branch returns a value the model can read back; nothing throws into the loop.
  private async run(
    conversationId: string,
    ctx: ConversationContext,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ result: unknown; context: ConversationContext }> {
    switch (name) {
      case 'autorizar': {
        const autoriza = args.autoriza === true;
        return { result: { ok: autoriza }, context: { ...ctx, autorizado: autoriza } };
      }
      case 'consultar_afiliado': {
        const result = consultarAfiliadoLogic(this.deps, ctx, { serie: String(args.serie ?? '') });
        if (result.ok && result.encontrado) {
          return {
            result,
            context: {
              ...ctx,
              serieId: String(args.serie ?? ''),
              rangoSalarial: result.rangoSalarial,
              ...(result.mascotas !== undefined ? { petCount: result.mascotas } : {}),
            },
          };
        }
        return { result, context: ctx };
      }
      case 'cotizar': {
        const result = cotizarLogic(this.deps.quoting, args as never, ctx);
        if (result.ok) {
          const id = result.cotizacion.productId;
          const shown = ctx.shownProductIds ?? [];
          return {
            result,
            context: {
              ...ctx,
              quoteProductId: id,
              productCategory: (args.productCategory as string) ?? ctx.productCategory,
              // Recorded so a later back-reference can only land on something already offered.
              shownProductIds: shown.includes(id) ? shown : [...shown, id],
            },
          };
        }
        return { result, context: ctx };
      }
      case 'seleccionar_producto': {
        const result = seleccionarProductoLogic(this.deps, ctx, { productId: String(args.productId ?? '') });
        return { result, context: result.ok ? { ...ctx, quoteProductId: result.productId } : ctx };
      }
      case 'capturar_datos': {
        const result = validarDatosLogic(args as never);
        return { result, context: result.ok ? { ...ctx, ...result.datos } : ctx };
      }
      case 'registrar_mascotas': {
        const result = registrarMascotasLogic(ctx, args as never);
        return { result, context: result.ok ? { ...ctx, pets: result.mascotas } : ctx };
      }
      case 'preguntas_aseguramiento': {
        const result = registrarAseguramientoLogic(this.deps, ctx, { respuestas: String(args.respuestas ?? '') });
        return {
          result,
          context: result.ok
            ? { ...ctx, medicalInfoProvided: true, medicalInfo: String(args.respuestas ?? '') }
            : ctx,
        };
      }
      case 'emitir_poliza': {
        const result = await emitirPolizaLogic(this.deps, conversationId, ctx);
        return { result, context: result.ok ? { ...ctx, policyId: result.policyId } : ctx };
      }
      case 'generar_link_pago': {
        const result = await generarLinkPagoLogic(this.deps, ctx, { policyId: ctx.policyId ?? '' });
        return { result, context: result.ok ? { ...ctx, checkoutUrl: result.checkoutUrl } : ctx };
      }
      default:
        return { result: { ok: false, motivo: `No existe una herramienta llamada ${name}.` }, context: ctx };
    }
  }
}
