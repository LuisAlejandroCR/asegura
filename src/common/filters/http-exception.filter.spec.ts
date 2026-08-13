// http-exception.filter.spec.ts: a 4xx is the caller's mistake, so it must log as WARN
// without a stack; only 5xx (a real server fault) gets ERROR + stack. Before this, hitting
// an unrouted URL like GET / printed an ERROR with a 10-line Express stack, which buries
// genuine incidents in the noise.

import { Logger, NotFoundException, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { GlobalExceptionFilter } from './http-exception.filter';

function makeHost(method = 'GET', url = '/') {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ method, url }),
    }),
  } as any;
  return { host, status, json };
}

describe('GlobalExceptionFilter — log severity by status class', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('logs a 404 as WARN with no stack, never as ERROR', () => {
    const { host } = makeHost('GET', '/');
    new GlobalExceptionFilter().catch(new NotFoundException('Cannot GET /'), host);

    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    // Second arg would be the stack — a 4xx must not carry one.
    expect(warn.mock.calls[0][1]).toBeUndefined();
    expect(warn.mock.calls[0][0]).toContain('GET / → 404');
  });

  it('logs a 400 as WARN too', () => {
    const { host } = makeHost('POST', '/web-session/abc/message');
    new GlobalExceptionFilter().catch(new BadRequestException('bad payload'), host);

    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('logs a 500 HttpException as ERROR with its stack', () => {
    const { host } = makeHost('POST', '/webhooks/wompi');
    new GlobalExceptionFilter().catch(new InternalServerErrorException('boom'), host);

    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][1]).toEqual(expect.any(String));
  });

  it('logs a non-HttpException as ERROR 500 with its stack', () => {
    const { host } = makeHost('GET', '/health');
    new GlobalExceptionFilter().catch(new Error('unexpected'), host);

    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('→ 500');
    expect(error.mock.calls[0][1]).toEqual(expect.any(String));
  });
});

describe('GlobalExceptionFilter — client response is unchanged', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('still answers a 404 with the same JSON shape and never leaks a stack', () => {
    const { host, status, json } = makeHost('GET', '/nope');
    new GlobalExceptionFilter().catch(new NotFoundException('Cannot GET /nope'), host);

    expect(status).toHaveBeenCalledWith(404);
    const body = json.mock.calls[0][0];
    expect(body).toEqual({
      statusCode: 404,
      message: 'Cannot GET /nope',
      timestamp: expect.any(String),
      path: '/nope',
    });
    expect(JSON.stringify(body)).not.toContain('at ');
  });

  it('hides the real message of a non-HttpException from the client', () => {
    const { host, status, json } = makeHost('GET', '/boom');
    new GlobalExceptionFilter().catch(new Error('db password is hunter2'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json.mock.calls[0][0].message).toBe('Internal server error');
  });
});
