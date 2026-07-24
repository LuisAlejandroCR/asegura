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
| **Propensión explicable** | Cada recomendación incluye una razón específica basada en el perfil del afiliado — no "por defecto" |
| **Oferta por perfil** | Un soltero y una familia de 3 ven productos, coberturas y razones distintas |
| **Transmite confianza** | Lenguaje conversacional, sin tecnicismos. El usuario siente que lo entienden |
| **Flujo autogestionado** | GREETING → póliza emitida en una sola conversación, sin intervención del equipo |

---

## ¿Cómo funciona?

```
Usuario escribe o envía nota de voz: "Quiero proteger a mi familia"
    ↓
El agente autoriza tratamiento de datos (Ley 1581)
    ↓
Pregunta sobre situación de vida y dependientes
    ↓
Recomienda el producto más adecuado con razón explícita
    ↓
Usuario confirma y paga (link Wompi, dentro del chat)
    ↓
Wompi confirma el pago automáticamente vía webhook — verificado, no autoreportado
    ↓
PDF de póliza enviado al chat, con QR de verificación
```

Sin formularios. Sin menús. Sin salir del chat. La confirmación de pago la valida Wompi directamente — nadie puede activar una póliza sin haber pagado realmente.

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
| Canal MVP | Telegram (grammy) |
| Canal futuro | WhatsApp Business API |
| Pagos | Wompi — Payment Links (sandbox) |
| Deploy | Railway (API) + Vercel (pitch web) |
| Dashboard | Metabase |

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

---

## Verificación de póliza

El PDF de cada póliza incluye un código QR que enlaza a su registro de auditoría — escaneable desde cualquier celular.

**Próximamente:** registro inmutable en Celo Mainnet vía el contrato `AseguraLedger.sol` (sin custodia de fondos, solo registro de eventos). Esta integración está construida y probada pero no forma parte del flujo activo todavía.

---

## Privacidad

La autorización de tratamiento de datos se solicita antes de consultar cualquier perfil (Ley 1581 de 2012). Sin autorización, el flujo no continúa. Los datos del afiliado no se almacenan fuera de Supabase y no se comparten con terceros.

---

## Licencia

MIT — aplica al contrato inteligente publicado en este repositorio.
La lógica de negocio, prompts y reglas del agente son privadas.
