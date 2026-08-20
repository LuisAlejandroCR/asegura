// tools.spec.ts: the voice wrappers pass the whole turn to the shared validator. Dropping
// documentType here filed every CE, PEP or TI as a cédula de ciudadanía on the voice channel
// while the text channel got it right.
import { createCapturarDatosTool } from './tools';
import { VoiceSessionState } from './session-state';

type Ejecutable = { execute: (args: Record<string, unknown>) => Promise<unknown> };

describe('capturar_datos en voz', () => {
  it('archiva el tipo de documento que el modelo capturó', async () => {
    const state = new VoiceSessionState('conv-1');
    const tool = createCapturarDatosTool(state) as unknown as Ejecutable;

    await tool.execute({ cedula: '12345678', documentType: 'PEP', mensaje: 'mi PEP es 12345678' });

    expect(state.context.documentType).toBe('PEP');
  });

  it('lee el tipo del turno cuando el modelo no lo manda aparte', async () => {
    const state = new VoiceSessionState('conv-1');
    const tool = createCapturarDatosTool(state) as unknown as Ejecutable;

    await tool.execute({ cedula: '12345678', mensaje: 'mi cédula de extranjería es 12345678' });

    expect(state.context.documentType).toBe('CE');
  });
});
