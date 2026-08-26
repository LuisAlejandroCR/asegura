// web-return-url.ts: la URL de AseguraWeb a la que Wompi devuelve el navegador cuando el
// checkout termina — aprobado, rechazado o sin fondos. Una sola construcción para los tres
// motores (máquina de estados, router de tools y worker de voz): estaba escrita tres veces y
// la del worker era la única que podía quedarse en nada sin que nadie se enterara.
//
// Sin `redirect_url` Wompi deja a la persona en su propio recibo, en
// transaction-redirect.wompi.co, sin ningún camino de vuelta. Comprobado contra la API con una
// transacción real: `redirect_url: null` tanto en la transacción como en el link.

export type ModalidadWeb = 'voz' | 'texto';

export function urlDeRetorno(
  base: string | undefined,
  token: string | null | undefined,
  modalidad: ModalidadWeb = 'texto',
): string | undefined {
  if (!base || !token) return undefined;
  return `${base.replace(/\/$/, '')}/${modalidad}.html?token=${token}`;
}

// Qué falta, por nombre, cuando no se pudo construir. La degradación silenciosa es lo que dejó
// links de pago sin vuelta en producción durante días: el código estaba bien y la variable no
// estaba puesta en ESE servicio — las de Railway son por servicio, y el worker de voz es uno
// aparte del backend.
export function motivoSinUrlDeRetorno(
  base: string | undefined,
  token: string | null | undefined,
  conversationId?: string,
): string | undefined {
  const faltan: string[] = [];
  if (!base) faltan.push('WEB_APP_URL');
  if (!conversationId) faltan.push('la conversación ligada a esta sesión');
  if (base && conversationId && !token) faltan.push('JWT_SECRET (no se pudo firmar el token)');
  if (!faltan.length) return undefined;
  return `sin URL de retorno para Wompi: falta ${faltan.join(', ')}. ` +
    'El checkout va a terminar en el recibo de Wompi, sin vuelta a AseguraWeb.';
}
