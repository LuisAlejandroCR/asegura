import { UnauthorizedException } from '@nestjs/common';
import { SupabaseAuthGuard } from './auth.guard';

function makeContext(headers: Record<string, string> = {}) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as any;
}

function makeSupabase(getUserImpl: (token: string) => Promise<any>) {
  return { db: { auth: { getUser: jest.fn(getUserImpl) } } } as any;
}

describe('SupabaseAuthGuard', () => {
  it('allows a request with a valid Bearer token', async () => {
    const supabase = makeSupabase(async () => ({ data: { user: { id: 'u1' } }, error: null }));
    const guard = new SupabaseAuthGuard(supabase);
    const ctx = makeContext({ authorization: 'Bearer good-token' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(supabase.db.auth.getUser).toHaveBeenCalledWith('good-token');
  });

  it('attaches the resolved user onto the request', async () => {
    const user = { id: 'u1', email: 'juan@test.com' };
    const supabase = makeSupabase(async () => ({ data: { user }, error: null }));
    const guard = new SupabaseAuthGuard(supabase);
    const request: any = { headers: { authorization: 'Bearer good-token' } };
    const ctx = { switchToHttp: () => ({ getRequest: () => request }) } as any;
    await guard.canActivate(ctx);
    expect(request.user).toEqual(user);
  });

  it('rejects when there is no Authorization header at all', async () => {
    const supabase = makeSupabase(async () => ({ data: { user: null }, error: null }));
    const guard = new SupabaseAuthGuard(supabase);
    await expect(guard.canActivate(makeContext())).rejects.toThrow(UnauthorizedException);
    expect(supabase.db.auth.getUser).not.toHaveBeenCalled();
  });

  it('rejects a non-Bearer scheme (e.g. Basic auth)', async () => {
    const supabase = makeSupabase(async () => ({ data: { user: { id: 'u1' } }, error: null }));
    const guard = new SupabaseAuthGuard(supabase);
    const ctx = makeContext({ authorization: 'Basic dXNlcjpwYXNz' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an Authorization header with only a scheme and no token', async () => {
    const supabase = makeSupabase(async () => ({ data: { user: null }, error: null }));
    const guard = new SupabaseAuthGuard(supabase);
    const ctx = makeContext({ authorization: 'Bearer' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when Supabase returns an error', async () => {
    const supabase = makeSupabase(async () => ({ data: { user: null }, error: { message: 'invalid JWT' } }));
    const guard = new SupabaseAuthGuard(supabase);
    const ctx = makeContext({ authorization: 'Bearer expired-token' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when Supabase returns no error but also no user', async () => {
    const supabase = makeSupabase(async () => ({ data: { user: null }, error: null }));
    const guard = new SupabaseAuthGuard(supabase);
    const ctx = makeContext({ authorization: 'Bearer weird-token' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });
});
