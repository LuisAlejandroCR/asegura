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
