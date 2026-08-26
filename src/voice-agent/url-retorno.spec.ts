// url-retorno.spec.ts: the URL Wompi returns the browser to after checkout. Reported from a
// live call — the receipt page was a dead end in every outcome because the voice path never
// sent a redirect_url, while the state machine always had.

import { construirUrlDeRetorno, urlDeRetornoConAviso } from './url-retorno';

const CONV = 'conv-abc';

describe('construirUrlDeRetorno', () => {
  it('apunta a voz.html con un token fresco', () => {
    const url = construirUrlDeRetorno(CONV, { WEB_APP_URL: 'https://asegura.example', JWT_SECRET: 's'.repeat(32) });

    expect(url).toContain('https://asegura.example/voz.html?token=');
  });

  it('no duplica la barra cuando WEB_APP_URL trae una al final', () => {
    const url = construirUrlDeRetorno(CONV, { WEB_APP_URL: 'https://asegura.example/', JWT_SECRET: 's'.repeat(32) });

    expect(url).not.toContain('//voz.html');
  });

  // Sin WEB_APP_URL no hay página a la que volver; mandar una URL rota es peor que no mandar
  // ninguna, porque Wompi la usaría igual.
  it('devuelve undefined sin WEB_APP_URL', () => {
    expect(construirUrlDeRetorno(CONV, { JWT_SECRET: 's'.repeat(32) })).toBeUndefined();
  });

  // Una llamada sin identidad no tiene conversación que retomar.
  it('devuelve undefined sin conversación', () => {
    expect(construirUrlDeRetorno(undefined, { WEB_APP_URL: 'https://asegura.example' })).toBeUndefined();
  });
});

// Verificado contra la API de Wompi: el link de la transacción de la captura salió con
// `redirect_url: null`. El código estaba bien; faltaba la variable en el servicio del worker
// —las de Railway son por servicio— y nada en los logs lo decía.
describe('urlDeRetornoConAviso', () => {
  it('dice qué variable falta en vez de devolver undefined en silencio', () => {
    const avisos: string[] = [];
    const url = urlDeRetornoConAviso(CONV, { JWT_SECRET: 's'.repeat(32) }, (m) => avisos.push(m));

    expect(url).toBeUndefined();
    expect(avisos.join(' ')).toContain('WEB_APP_URL');
  });

  it('nombra JWT_SECRET cuando es el token el que no se pudo firmar', () => {
    const avisos: string[] = [];
    urlDeRetornoConAviso(CONV, { WEB_APP_URL: 'https://asegura.example' }, (m) => avisos.push(m));

    expect(avisos.join(' ')).toContain('JWT_SECRET');
  });

  it('no avisa de nada cuando sí hay URL', () => {
    const avisos: string[] = [];
    const url = urlDeRetornoConAviso(
      CONV,
      { WEB_APP_URL: 'https://asegura.example', JWT_SECRET: 's'.repeat(32) },
      (m) => avisos.push(m),
    );

    expect(url).toContain('/voz.html?token=');
    expect(avisos).toHaveLength(0);
  });
});
