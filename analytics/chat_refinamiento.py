# -*- coding: utf-8 -*-
"""
Capa de refinamiento por chat conversacional.

El motor batch (reglas_negocio.py) da una recomendación de arranque a partir de
lo que Colsubsidio ya sabe del afiliado (edad, familia, salario, etc.). Este
módulo toma esa recomendación y la afina con lo que el cliente responde en el
chat -- son datos que hoy no existen en ninguna columna de la base, solo se
consiguen preguntando directo. Por eso esto no se vectoriza sobre las 500k
filas: es una función pensada para correr una vez por conversación, en vivo.

Diseño: cada pregunta es independiente. Si el cliente no la responde,
el motor simplemente no aplica esa refinación y sigue con la recomendación
base, no debería bloquearse al esperar respuesta.
"""
from reglas_negocio import CATALOGO

# Catálogo de preguntas: qué se pregunta, qué tipo de respuesta se espera,
# y qué de la recomendación afina cada una. Pensado para que un chatbot pueda
# iterar sobre este diccionario y saber qué preguntar y en qué formato.
PREGUNTAS_CHAT = {
    "ya_tiene_seguro": {
        "pregunta": "¿Ya tienes algún seguro contratado (con Colsubsidio o con otra aseguradora)? ¿Cuál?",
        "tipo": "lista_texto",
        "afina": "Suprime la oferta principal si coincide con lo que ya tiene (nunca se re-ofrece un producto ya contratado)",
    },
    "num_hijos": {
        "pregunta": "¿Cuántos hijos tienes?",
        "tipo": "entero",
        "afina": "Sube de Vida básica a Vida+Ahorro si tiene 2+ hijos, aunque el salario no lo hubiera sugerido",
    },
    "tipo_vivienda": {
        "pregunta": "¿Vives en arriendo o en vivienda propia?",
        "tipo": "categorica",
        "valores": ["arriendo", "propia", "propia_hipoteca"],
        "afina": "Activa oferta de Seguro de hogar (con lo inicial solo se activa si usó crédito de vivienda CON Colsubsidio)",
    },
    "tiene_vehiculo": {
        "pregunta": "¿Tienes carro o moto?",
        "tipo": "categorica",
        "valores": ["ninguno", "carro", "moto", "ambos"],
        "afina": "Activa oferta de Seguro de movilidad (sin señal en la base batch)",
    },
    "trabajo_riesgo_fisico": {
        "pregunta": "¿Tu trabajo implica riesgo físico (construcción, transporte, entre otros)?",
        "tipo": "booleana",
        "afina": "Sube de Accidentes estándar a Accidentes premium, aunque el salario no lo hubiera sugerido",
    },
    "viaja_frecuente": {
        "pregunta": "¿Viajas seguido, nacional o internacional?",
        "tipo": "booleana",
        "afina": "Cambia la oferta secundaria de Asistencias médicas a Asistencias múltiples (incluye viaje)",
    },
    "tiene_mascota": {
        "pregunta": "¿Tienes perro o gato? ¿Cuántos de cada uno?",
        "tipo": "mascotas",  # respuesta esperada: {"perros": int, "gatos": int}
        "afina": "Activa Medicina prepagada por mascota (precio real x cantidad, cada mascota se cotiza aparte)",
    },
}


def preguntas_pendientes(respuestas: dict) -> list:
    """Qué preguntas le faltan a esta conversación -- útil para que el
    chatbot sepa qué preguntar a continuación."""
    return [k for k in PREGUNTAS_CHAT if k not in respuestas or respuestas[k] is None]


def refinar_con_chat(recomendacion_base: dict, respuestas: dict) -> dict:
    """Toma el dict que devuelve score_afiliado() (recomendación base, con
    solo datos de la base batch) y lo afina con las respuestas del chat.

    respuestas: dict con las claves de PREGUNTAS_CHAT que el cliente ya
    contestó (puede venir incompleto, se afina solo con lo que haya).
    """
    out = dict(recomendacion_base)
    notas_chat = []
    ofertas_chat = []

    # 1) Supresión: no volver a ofrecer lo que ya tiene
    ya_tiene = respuestas.get("ya_tiene_seguro")
    if ya_tiene:
        ya_tiene_lower = [p.strip().lower() for p in ya_tiene]
        if out["PRODUCTO_PRINCIPAL"] and out["PRODUCTO_PRINCIPAL"].lower() in ya_tiene_lower:
            out["PRODUCTO_PRINCIPAL_SUPRIMIDO"] = out["PRODUCTO_PRINCIPAL"]
            out["PRODUCTO_PRINCIPAL"] = None
            out["ASEGURADORA_PRINCIPAL"] = None
            out["DESDE_MES_PRINCIPAL"] = None
            notas_chat.append(f"el cliente confirmó que ya tiene '{out['PRODUCTO_PRINCIPAL_SUPRIMIDO']}' contratado -> no se vuelve a ofrecer")

    # 2) Número de hijos: sube Vida básica -> Vida+Ahorro si son 2+
    num_hijos = respuestas.get("num_hijos")
    if num_hijos is not None and out.get("TIER") == 1 and out.get("PRODUCTO_PRINCIPAL") == CATALOGO["vida_basico"]["producto"]:
        if num_hijos >= 2:
            out["PRODUCTO_PRINCIPAL"] = CATALOGO["vida_ahorro"]["producto"]
            out["ASEGURADORA_PRINCIPAL"] = CATALOGO["vida_ahorro"]["aseguradora"]
            out["DESDE_MES_PRINCIPAL"] = CATALOGO["vida_ahorro"]["desde_mes"]
            notas_chat.append(f"confirmó {num_hijos} hijos -> se sube a Vida+Ahorro aunque el salario registrado no lo sugería")

    # 3) Tipo de vivienda: activa hogar sin depender del crédito Colsubsidio
    tipo_vivienda = respuestas.get("tipo_vivienda")
    if tipo_vivienda in ("propia", "propia_hipoteca"):
        ofertas_chat.append(CATALOGO["hogar"]["producto"])
        notas_chat.append("confirmó vivienda propia -> propenso a Seguro de hogar")

    # 4) Vehículo: activa movilidad
    tiene_vehiculo = respuestas.get("tiene_vehiculo")
    if tiene_vehiculo and tiene_vehiculo != "ninguno":
        ofertas_chat.append(CATALOGO["movilidad"]["producto"])
        notas_chat.append(f"confirmó tener {tiene_vehiculo} -> propenso a Seguro de movilidad (precio pendiente de catálogo real)")

    # 5) Riesgo físico laboral: sube Accidentes estándar -> premium
    riesgo = respuestas.get("trabajo_riesgo_fisico")
    if riesgo and out.get("PRODUCTO_PRINCIPAL") == CATALOGO["accidentes_std"]["producto"]:
        out["PRODUCTO_PRINCIPAL"] = CATALOGO["accidentes_premium"]["producto"]
        out["ASEGURADORA_PRINCIPAL"] = CATALOGO["accidentes_premium"]["aseguradora"]
        out["DESDE_MES_PRINCIPAL"] = CATALOGO["accidentes_premium"]["desde_mes"]
        notas_chat.append("confirmó trabajo de riesgo físico -> se sube a Accidentes premium aunque el salario registrado no lo sugería")

    # 6) Viaja frecuente: cambia asistencia médica -> múltiple
    viaja = respuestas.get("viaja_frecuente")
    if viaja and out.get("OFERTA_SECUNDARIA") == CATALOGO["asist_medicas"]["producto"]:
        out["OFERTA_SECUNDARIA"] = CATALOGO["asist_multiples"]["producto"]
        notas_chat.append("confirmó que viaja frecuente -> se cambia la asistencia secundaria a Asistencias múltiples")

    # 7) Mascotas: precio real x cantidad (cada mascota se cotiza aparte,
    # tal como funciona en la cotización real de Colsubsidio)
    mascotas = respuestas.get("tiene_mascota")
    if mascotas:
        perros = mascotas.get("perros", 0) or 0
        gatos = mascotas.get("gatos", 0) or 0
        detalle = []
        total_mes = 0
        if perros > 0:
            precio_unitario = CATALOGO["vet_perro"]["desde_mes"]
            subtotal = precio_unitario * perros
            detalle.append(f"{perros} perro(s) x ${precio_unitario:,}/mes = ${subtotal:,}/mes")
            total_mes += subtotal
        if gatos > 0:
            precio_unitario = CATALOGO["vet_gato"]["desde_mes"]
            subtotal = precio_unitario * gatos
            detalle.append(f"{gatos} gato(s) x ${precio_unitario:,}/mes = ${subtotal:,}/mes")
            total_mes += subtotal
        if detalle:
            ofertas_chat.append(f"Medicina prepagada mascotas: {'; '.join(detalle)} — total ${total_mes:,}/mes")
            notas_chat.append(f"confirmó {perros} perro(s) y {gatos} gato(s) -> cotización real por mascota, no un valor genérico")

    out["OFERTAS_CHAT"] = ofertas_chat if ofertas_chat else None
    out["JUSTIFICACION_CHAT"] = " | ".join(notas_chat) if notas_chat else None
    out["PREGUNTAS_PENDIENTES"] = preguntas_pendientes(respuestas)

    return out


if __name__ == "__main__":
    import pandas as pd
    from reglas_negocio import score_afiliado

    casado_3_hijos = pd.Series({
        "RANGO_EDAD": "36 a 45 años", "SEGMENTO_GRUPO_FAMILIAR": "FAMILIA NUCLEAR INTEGRAL",
        "PIRAMIDE_NUEVA": "2 Medianas", "RANGO_SALARIAL": "Entre 1.5 y 2 SMLV",
        "RANGO_SALARIAL_ORD": 2, "VIVIENDA": 0, "DROGUERIA": 1, "HOTELES": 0, "AGENCIAS": 0,
    })

    base = score_afiliado(casado_3_hijos)
    print("=== Recomendación base (solo datos batch) ===")
    for k, v in base.items():
        print(f"  {k}: {v}")

    respuestas = {
        "num_hijos": 3,
        "tiene_mascota": {"perros": 1, "gatos": 2},
        "tipo_vivienda": "arriendo",
        "trabajo_riesgo_fisico": True,
    }
    refinada = refinar_con_chat(base, respuestas)
    print("\n=== Recomendación refinada con respuestas de chat ===")
    for k, v in refinada.items():
        print(f"  {k}: {v}")
