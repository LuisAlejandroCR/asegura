// tools/index.ts: the capability registry both channels build from. Every entry is a pure
// function over injected deps, so the voice worker (no NestJS DI) constructs the same set.

export * from './types';
export * from './cotizar.tool';
export * from './validar-datos.tool';
export * from './consultar-afiliado.tool';
export * from './aseguramiento.tool';
export * from './emitir-poliza.tool';
export * from './generar-link-pago.tool';
export * from './seleccionar-producto.tool';
