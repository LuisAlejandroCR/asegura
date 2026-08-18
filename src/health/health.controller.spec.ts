// health.controller.spec.ts: /health is what Railway trusts to decide a deploy is alive, so
// every field here is a regression test against it reporting a state that isn't real.
import { HealthController } from './health.controller';

type QueryResult = { error: { message: string } | null };

function buildController(overrides: {
  query?: () => Promise<QueryResult> | never;
  llm?: boolean;
  telegram?: boolean;
  wompi?: boolean;
  jwt?: boolean;
  livekit?: boolean;
} = {}) {
  const query = overrides.query ?? (async () => ({ error: null }));
  const supabase = {
    db: { from: () => ({ select: () => ({ limit: query }) }) },
  } as any;

  return new HealthController(
    supabase,
    { isEnabled: overrides.llm ?? true } as any,
    { instance: (overrides.telegram ?? true) ? {} : null } as any,
    { isEnabled: overrides.wompi ?? true } as any,
    { isEnabled: overrides.livekit ?? true } as any,
    { isEnabled: overrides.jwt ?? true } as any,
  );
}

describe('HealthController — database', () => {
  // The Supabase SDK answers a rejected key or a missing table with an error object and no
  // throw, so a try/catch alone reported db:'ok' for a database that answered nothing useful.
  it('regression — reports error when the query returns an error object instead of throwing', async () => {
    const controller = buildController({ query: async () => ({ error: { message: 'relation does not exist' } }) });
    const result = await controller.check();
    expect(result.db).toBe('error');
    expect(result.status).toBe('degraded');
  });

  it('reports error when the query throws (transport failure)', async () => {
    const controller = buildController({ query: () => { throw new Error('ECONNREFUSED'); } });
    expect((await controller.check()).db).toBe('error');
  });

  it('reports ok when the query comes back clean', async () => {
    const result = await buildController().check();
    expect(result.db).toBe('ok');
    expect(result.status).toBe('ok');
  });
});

describe('HealthController — integrations', () => {
  // wompi used to read WOMPI_PUBLIC_KEY, which WompiService never consults: the real gate is
  // environment + private key + events secret. The two disagreed in production.
  it('regression — mirrors each service gate rather than an env var of its own', async () => {
    const result = await buildController({ llm: false, telegram: false, wompi: false, jwt: false, livekit: false }).check();
    expect(result).toMatchObject({
      llm: 'pending', telegram: 'pending', wompi: 'pending', jwt: 'pending', livekit: 'pending',
    });
  });

  it('reports every integration that is live', async () => {
    const result = await buildController().check();
    expect(result).toMatchObject({
      llm: 'configured', telegram: 'configured', wompi: 'configured', jwt: 'configured', livekit: 'configured',
    });
  });

  it('reports jwt and livekit, which the endpoint used to omit entirely', async () => {
    const result = await buildController();
    expect(Object.keys(await result.check())).toEqual(
      expect.arrayContaining(['jwt', 'livekit', 'timestamp']),
    );
  });
});
