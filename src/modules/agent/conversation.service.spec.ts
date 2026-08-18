// conversation.service.spec.ts: tests ConversationService.findById — returns null
// rather than throwing when the row is missing or Supabase errors — and that the
// in-memory cache cannot grow without bound, since it holds PII.

import { ConversationService } from './conversation.service';
import { ConversationState } from './types';

function makeSupabaseMock(overrides: { data?: unknown; error?: unknown } = {}) {
  const maybeSingle = jest.fn().mockResolvedValue({ data: overrides.data ?? null, error: overrides.error ?? null });
  const eq = jest.fn().mockReturnValue({ maybeSingle });
  const select = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ select });
  return { db: { from } } as any;
}

describe('ConversationService.findById', () => {
  it('returns the conversation row when found — used by the Wompi webhook to resolve the Telegram user', () => {
    const row = {
      id: 'conv-1', user_id: '999888777', channel: 'telegram',
      state: ConversationState.PAYMENT, context: { quoteProductId: 'asistencia-veterinaria' },
      created_at: '2026-07-23T00:00:00Z', updated_at: '2026-07-23T00:00:00Z',
    };
    const supabase = makeSupabaseMock({ data: row });
    const service = new ConversationService(supabase);
    return service.findById('conv-1').then((result) => {
      expect(result).toEqual(row);
    });
  });

  it('returns null when the conversation does not exist', async () => {
    const supabase = makeSupabaseMock({ data: null, error: null });
    const service = new ConversationService(supabase);
    await expect(service.findById('missing')).resolves.toBeNull();
  });

  it('returns null (not throw) when Supabase errors', async () => {
    const supabase = makeSupabaseMock({ data: null, error: { message: 'boom' } });
    const service = new ConversationService(supabase);
    await expect(service.findById('conv-1')).resolves.toBeNull();
  });
});

// The cache used to be a plain Map with no TTL and no cap: every user ever seen stayed for
// the life of the process, cedula, nombre and correo included. On a 256 MB container that is
// a leak and a privacy problem at the same time.
describe('ConversationService — the cache cannot grow without bound', () => {
  // Returns a service whose findByUser always misses and whose create() hands back a row.
  function makeService() {
    const created: string[] = [];
    const supabase = {
      db: {
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
          insert: (row: any) => ({
            select: () => ({
              single: async () => {
                created.push(row.user_id);
                return { data: { id: `conv-${row.user_id}`, ...row, context: {} }, error: null };
              },
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
        }),
      },
    } as any;
    return { service: new ConversationService(supabase), created };
  }

  it('evicts the oldest entries instead of keeping every user forever', async () => {
    const { service, created } = makeService();
    const CAP = 500;

    for (let i = 0; i < CAP + 50; i++) {
      await service.getOrCreate(`user-${i}`, 'telegram');
    }
    expect(created).toHaveLength(CAP + 50);

    // The very first user fell out of the cache, so asking again hits the database again.
    await service.getOrCreate('user-0', 'telegram');
    expect(created).toHaveLength(CAP + 51);

    // The most recent one is still cached, so it does not.
    await service.getOrCreate(`user-${CAP + 49}`, 'telegram');
    expect(created).toHaveLength(CAP + 51);
  });

  it('forgets a conversation once its TTL passes, rather than holding the PII forever', async () => {
    jest.useFakeTimers();
    try {
      const { service, created } = makeService();
      await service.getOrCreate('user-a', 'telegram');
      expect(created).toHaveLength(1);

      await service.getOrCreate('user-a', 'telegram');
      expect(created).toHaveLength(1);

      jest.advanceTimersByTime(30 * 60_000 + 1);
      await service.getOrCreate('user-a', 'telegram');
      expect(created).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
