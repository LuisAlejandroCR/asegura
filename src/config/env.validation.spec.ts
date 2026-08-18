// env.validation.spec.ts: tests startup env validation — required fields, and the
// cross-field rules for Wompi and for Telegram webhook mode. The app must not boot
// with a half-configured integration.

import { validate } from './env.validation';

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    NODE_ENV: 'development',
    CORS_ORIGIN: 'http://localhost:3000',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    ...overrides,
  };
}

function withMockedExit() {
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const errorSpy = jest.spyOn(require('@nestjs/common').Logger, 'error').mockImplementation(() => undefined);
  // validate() repeats the reason via fs.writeSync(2, …) to survive process.exit();
  // silenced here so the invalid-config cases do not pollute the suite output.
  const writeSyncSpy = jest.spyOn(require('fs'), 'writeSync').mockImplementation(() => 0);
  return {
    exitSpy,
    errorSpy,
    writeSyncSpy,
    restore: () => { exitSpy.mockRestore(); errorSpy.mockRestore(); writeSyncSpy.mockRestore(); },
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
  // Regression: main.ts calls config.getOrThrow('TELEGRAM_WEBHOOK_SECRET') when
  // PUBLIC_URL is set (webhook mode) — that throw happens deep inside the unawaited
  // bootstrap() call with no .catch(), so a Railway deploy with PUBLIC_URL +
  // TELEGRAM_BOT_TOKEN set but TELEGRAM_WEBHOOK_SECRET forgotten crashes silently before
  // the app ever binds to a port. This must fail fast at startup with a clear message
  // instead. (Renamed from HOST to PUBLIC_URL — too generic a name, easy to confuse with
  // a bind-address convention used elsewhere.)
  it('exits when PUBLIC_URL is set but TELEGRAM_WEBHOOK_SECRET is missing', () => {
    const { exitSpy, restore } = withMockedExit();
    validate(baseConfig({ PUBLIC_URL: 'https://asegura-production.up.railway.app' }));
    expect(exitSpy).toHaveBeenCalledWith(1);
    restore();
  });

  it('passes when PUBLIC_URL is set and TELEGRAM_WEBHOOK_SECRET is also set', () => {
    const { exitSpy, restore } = withMockedExit();
    validate(baseConfig({
      PUBLIC_URL: 'https://asegura-production.up.railway.app',
      TELEGRAM_WEBHOOK_SECRET: 'a-random-secret',
    }));
    expect(exitSpy).not.toHaveBeenCalled();
    restore();
  });

  it('passes when PUBLIC_URL is not set (polling mode, no secret required)', () => {
    const { exitSpy, restore } = withMockedExit();
    validate(baseConfig());
    expect(exitSpy).not.toHaveBeenCalled();
    restore();
  });
});

// The Celo group was removed with the vars themselves: nothing read them since blockchain
// moved to future work, and a half-set group refused to boot for a feature that is gone.
describe('env.validation — removed config never blocks the boot', () => {
  it('ignores leftover Celo vars still set in a deployment', () => {
    const { exitSpy, restore } = withMockedExit();
    validate(baseConfig({ CELO_RPC_URL: 'https://forno.celo.org' }));
    expect(exitSpy).not.toHaveBeenCalled();
    restore();
  });
});
