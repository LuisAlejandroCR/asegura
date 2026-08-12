# Asegura

Agente conversacional para la venta automatizada de seguros Colsubsidio.
De "no sé qué seguro necesito" a "ya quedé asegurado" — sin asesor humano, en menos de 3 minutos.

Hackathon Colsubsidio × 30X · Julio 2026

---

## El problema

Comprar un seguro en Colsubsidio hoy exige hablar con un asesor: horarios restringidos, esperas, experiencias inconsistentes. El modelo no escala. Asegura lo reemplaza.

---

## ¿Qué hace?

Asegura es un agente que conversa en español (texto y voz), identifica la necesidad real del afiliado con base en su perfil, y cierra la venta dentro del chat:

| Criterio | Cómo lo resuelve Asegura |
|----------|--------------------------|
| **Propensión explicable** | Cada recomendación incluye una razón específica, priorizada según el perfil real — nunca "por defecto" |
| **Oferta por perfil** | Un soltero y una familia con dependientes ven productos, coberturas y razones distintas. Si eres afiliado Colsubsidio, tu historial ayuda a afinar la cotización aún más |
| **Transmite confianza** | Lenguaje conversacional, sin tecnicismos. El agente recuerda tu perfil entre conversaciones — no vuelves a empezar de cero cada vez |
| **Flujo autogestionado** | GREETING → póliza emitida en una sola conversación, sin intervención del equipo |

**Cómo conversa:** texto libre o nota de voz, siempre. En el primer filtro también ofrece botones rápidos de un toque — nunca obligatorios ni un menú tipo IVR; escribir o hablar libremente funciona igual en cualquier momento.

---

## ¿Cómo funciona?

```
Usuario escribe o envía nota de voz: "Quiero proteger a mi familia"
    ↓
El agente autoriza tratamiento de datos (Ley 1581)
    ↓
(Opcional) Si eres afiliado Colsubsidio, compartes tu ID → cotización más ajustada a tu perfil real
    ↓
Pregunta sobre tu situación de vida, dependientes y qué tan urgente es tu necesidad
    ↓
Recomienda el producto más adecuado con razón explícita, priorizada por relevancia
    ↓
Usuario confirma y paga (link Wompi, dentro del chat)
    ↓
Wompi confirma el pago automáticamente vía webhook — verificado, no autoreportado
    ↓
PDF de póliza enviado al chat, con QR de verificación
```

Sin formularios. Sin menús obligatorios. Sin salir del chat. La confirmación de pago la valida Wompi directamente — nadie puede activar una póliza sin haber pagado realmente. Si preguntas por algo fuera del catálogo (por ejemplo, seguro vehicular), el agente lo dice honestamente y te ofrece las alternativas reales disponibles, en vez de ignorar la pregunta. Si el agente no logra entenderte tras varios intentos, escala automáticamente la conversación a un asesor humano — nunca te deja atrapado repitiendo lo mismo.

---

## Productos disponibles (precios reales de colsubsidio.com/seguros)

| Producto | Aseguradora | Desde/mes |
|----------|-------------|-----------|
| Accidentes personales | MetLife | $18.000 |
| Accidentes personales (premium) | Chubb | $28.100 |
| Seguro de vida | Pan American Life | $12.000 |
| Asistencias múltiples | GEA | $20.000 |
| Exequial | Grupo Recordar | $26.000 |
| Accidentes + Exequial | Pan American Life | $14.000 |
| Vida + Ahorro | BMI | $20.000 |
| Asistencias médicas | GEA | $16.800 |
| Asistencia veterinaria | GEA | $14.500 |
| Medicina prepagada gatos | VetPlus | $81.800 |
| Medicina prepagada perros | VetPlus | $96.600 |

Los seguros de mascotas se cotizan por mascota: una familia con 3 mascotas ve el precio unitario y el total mensual real, no un valor genérico. Antes de emitir la póliza, el agente pide nombre, edad y raza de cada mascota — la póliza final las nombra individualmente, como un certificado real.

---

## Stack

| Capa | Tecnología |
|------|-----------|
| Backend | NestJS + TypeScript |
| NLP | Groq (llama-3.1-8b-instant) + Whisper (voz) |
| Base de datos | Supabase (Postgres) |
| Canal MVP | Telegram |
| Canal WhatsApp | Twilio WhatsApp Sandbox (pruebas internas) |
| Pagos | Wompi — Payment Links (sandbox) |
| Deploy | Railway (API) + Vercel (pitch web) |
| Dashboard | Metabase |
| Tests | 935 (unit + fuzz + invariant) |

---

## Canales

| Canal | Estado |
|-------|--------|
| Telegram (`t.me/asegura_bot`) | ✓ Disponible |
| WhatsApp Business | Próximamente |

---

## Demo

▶ **Escríbele al agente:** `t.me/asegura_bot`

▶ **Pitch web:** `https://asegura-app.vercel.app/`

▶ **Pitch video:** `https://www.youtube.com/watch?v=DP3Fhnv6wqY`

---

## Verificación de póliza

El PDF de cada póliza incluye un código QR que enlaza a su registro de auditoría — escaneable desde cualquier celular.

**Roadmap:** registro inmutable en Celo Mainnet para una capa adicional de auditoría pública

---

## Privacidad

La autorización de tratamiento de datos se solicita antes de consultar cualquier perfil (Ley 1581 de 2012). Sin autorización, el flujo no continúa.

**Nota sobre `Usos_Productos_Afiliados_SIMULADO.csv`:** es un dataset **sintético** generado para el hackathon — no contiene datos reales de afiliados de Colsubsidio. Se usa únicamente para probar la personalización del agente (segmento familiar, rango salarial, etc.) con un volumen de datos realista.

---

## Licencia

MIT.
La lógica de negocio, prompts y reglas del agente son privadas.
