import { validate } from './env.validation';

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    NODE_ENV: 'development',
    CORS_ORIGIN: 'http://localhost:3000',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    ...overrides,
  };
}

function withMockedExit() {
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const errorSpy = jest.spyOn(require('@nestjs/common').Logger, 'error').mockImplementation(() => undefined);
  return {
    exitSpy,
    errorSpy,
    restore: () => { exitSpy.mockRestore(); errorSpy.mockRestore(); },
  };
}

describe('env.validation — base required fields', () => {
  it('passes with only the required fields set', () => {
    const { exitSpy, restore } = withMockedExit();
    validate(baseConfig());
    expect(exitSpy).not.toHaveBeenCalled();
    restore();
  });

  it('exits when a required field (SUPABASE_URL) is missing', () => {
    const { exitSpy, restore } = withMockedExit();
    const config = baseConfig();
    delete (config as any).SUPABASE_URL;
    validate(config);
    expect(exitSpy).toHaveBeenCalledWith(1);
    restore();
  });
});

describe('env.validation — Wompi cross-field requirement', () => {
  // Regression: WOMPI_ENVIRONMENT/PRIVATE_KEY/EVENTS_SECRET were all independently
  // @IsOptional() — a typo'd or forgotten Railway env var name meant the app booted fine
  // but WompiService silently set `enabled = false`, so payment link creation failed at
  // the first real request instead of at startup where the operator would actually notice.
  it('exits when only WOMPI_ENVIRONMENT is set (partial Wompi config)', () => {
    const { exitSpy, restore } = withMockedExit();
    validate(baseConfig({ WOMPI_ENVIRONMENT: 'sandbox' }));
    expect(exitSpy).toHaveBeenCalledWith(1);
    restore();
  });

  it('exits when WOMPI_PRIVATE_KEY is set but WOMPI_EVENTS_SECRET is missing', () => {
    const { exitSpy, restore } = withMockedExit();
    validate(baseConfig({ WOMPI_ENVIRONMENT: 'sandbox', WOMPI_PRIVATE_KEY: 'prv_test_abc' }));
    expect(exitSpy).toHaveBeenCalledWith(1);
    restore();
  });

  it('passes when none of the Wompi vars are set (feature disabled entirely)', () => {
    const { exitSpy, restore } = withMockedExit();
    validate(baseConfig());
    expect(exitSpy).not.toHaveBeenCalled();
    restore();
  });

  it('passes when all three Wompi vars are set together', () => {
    const { exitSpy, restore } = withMockedExit();
    validate(baseConfig({
      WOMPI_ENVIRONMENT: 'sandbox', WOMPI_PRIVATE_KEY: 'prv_test_abc', WOMPI_EVENTS_SECRET: 'secret123',
    }));
    expect(exitSpy).not.toHaveBeenCalled();
    restore();
  });
});

describe('env.validation — Telegram webhook mode requirement', () => {
  // Regression: main.ts calls config.getOrThrow('TELEGRAM_WEBHOOK_SECRET') when HOST is
  // set (webhook mode) — that throw happens deep inside the unawaited bootstrap() call
  // with no .catch(), so a Railway deploy with HOST + TELEGRAM_BOT_TOKEN set but
  // TELEGRAM_WEBHOOK_SECRET forgotten crashes silently before the app ever binds to a
  // port. This must fail fast at startup with a clear message instead.
  it('exits when HOST is set but TELEGRAM_WEBHOOK_SECRET is missing', () => {
    const { exitSpy, restore } = withMockedExit();
    validate(baseConfig({ HOST: 'https://asegura-production.up.railway.app' }));
    expect(exitSpy).toHaveBeenCalledWith(1);
    restore();
  });

  it('passes when HOST is set and TELEGRAM_WEBHOOK_SECRET is also set', () => {
    const { exitSpy, restore } = withMockedExit();
    validate(baseConfig({
      HOST: 'https://asegura-production.up.railway.app',
      TELEGRAM_WEBHOOK_SECRET: 'a-random-secret',
    }));
    expect(exitSpy).not.toHaveBeenCalled();
    restore();
  });

  it('passes when HOST is not set (polling mode, no secret required)', () => {
    const { exitSpy, restore } = withMockedExit();
    validate(baseConfig());
    expect(exitSpy).not.toHaveBeenCalled();
    restore();
  });
});

describe('env.validation — Celo cross-field requirement', () => {
  it('exits when only CELO_RPC_URL is set (partial Celo config)', () => {
    const { exitSpy, restore } = withMockedExit();
    validate(baseConfig({ CELO_RPC_URL: 'https://forno.celo.org' }));
    expect(exitSpy).toHaveBeenCalledWith(1);
    restore();
  });

  it('passes when none of the Celo vars are set (feature disabled entirely)', () => {
    const { exitSpy, restore } = withMockedExit();
    validate(baseConfig());
    expect(exitSpy).not.toHaveBeenCalled();
    restore();
  });

  it('passes when all three Celo vars are set together', () => {
    const { exitSpy, restore } = withMockedExit();
    validate(baseConfig({
      CELO_RPC_URL: 'https://forno.celo.org',
      OPERATOR_PRIVATE_KEY: '0x' + '1'.repeat(64),
      POLICY_LEDGER_ADDRESS: '0x' + '2'.repeat(40),
    }));
    expect(exitSpy).not.toHaveBeenCalled();
    restore();
  });
});
