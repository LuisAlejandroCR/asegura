# -*- coding: utf-8 -*-
"""
Scoring de mejor canal y momento de contacto (next-best-channel + timing).

IMPORTANTE: no existe en esta base ninguna variable de
comportamiento digital real (ej. "transaccionó en canal digital el último mes"),
ni historial de respuesta por canal, ni fecha de eventos. Este scorecard es una
propuesta de diseño propia, con pesos razonados pero NO calibrados con datos
reales de conversión. Reemplazar los pesos en cuanto existan datos reales de
respuesta por canal, para esto mi sugerencia son modelos de propensión o aprendizaje reforzado como bandits contextuals.

Canales que supongo: app propia, asistido por persona,
autogestión digital (portal web), WhatsApp, email, SMS.
"""
import numpy as np
import pandas as pd

CANALES_GESTION = ["App propia", "Autogestión digital", "Asistido (persona)"]


def calcular_canal_y_timing(df: pd.DataFrame) -> pd.DataFrame:
    d = df.copy()

    # --- Score "App propia" ---
    score_app = pd.Series(0.0, index=d.index)
    score_app += d["RANGO_EDAD"].map({
        "Menor de 19 años": 3, "20 a 35 años": 3, "36 a 45 años": 1,
        "46 a 55 años": -1, "Mayor de 55 años": -2,
    }).fillna(0)
    score_app += (d["SEGMENTO_POBLACIONAL"] == "Joven") * 2
    score_app += (d["CIUDAD_BUCKET"] == "Bogota D.C.") * 1
    score_app += d["PIRAMIDE_NUEVA"].isin(["6.1 Facultativo", "6.2 Independiente"]) * 1

    # --- Score "Autogestión digital" (portal web, sin necesidad de app) ---
    score_auto = pd.Series(0.0, index=d.index)
    score_auto += d["RANGO_EDAD"].map({
        "Menor de 19 años": 1, "20 a 35 años": 2, "36 a 45 años": 2,
        "46 a 55 años": 1, "Mayor de 55 años": -1,
    }).fillna(0)
    score_auto += d["PIRAMIDE_NUEVA"].isin(["6.1 Facultativo", "6.2 Independiente"]) * 2  # horario flexible
    score_auto += (d["CIUDAD_BUCKET"] == "Fuera de Bogota") * 1  # menos oficinas cerca

    # --- Score "Asistido (persona)" ---
    score_asistido = pd.Series(0.0, index=d.index)
    score_asistido += d["RANGO_EDAD"].map({
        "Menor de 19 años": 0, "20 a 35 años": -1, "36 a 45 años": 0,
        "46 a 55 años": 2, "Mayor de 55 años": 3,
    }).fillna(0)
    score_asistido += (d["PIRAMIDE_NUEVA"] == "6.3 Pensionado") * 3
    score_asistido += (d["EMPRESA_FOCO"] == "X") * 1  # posible asesor de convenio
    score_asistido += (d.get("PRODUCTO_KEY", "") == "exequial") * 2  # producto sensible
    score_asistido += (d.get("PRODUCTO_KEY", "") == "accidentes_exequial") * 2
    score_asistido += (d["CIUDAD_BUCKET"] == "No informado") * 1  # dato de contacto digital incierto -> mas seguro un canal humano/generalista

    scores = pd.DataFrame({
        "App propia": score_app,
        "Autogestión digital": score_auto,
        "Asistido (persona)": score_asistido,
    })
    d["CANAL_GESTION"] = scores.idxmax(axis=1)
    d["CANAL_GESTION_SCORE"] = scores.max(axis=1)

    # --- Touch inicial de mensajeria: WhatsApp por defecto (mayor open-rate
    # tipico en Colombia); Email si el producto es "complejo" (requiere
    # entender coberturas largas: exequial, vida+ahorro, accidentes premium);
    # SMS como respaldo cuando la ciudad es "No informado" (no hay certeza
    # de que exista email/whatsapp validado, SMS es el minimo comun) ---
    producto_key = d.get("PRODUCTO_KEY", pd.Series("", index=d.index))
    productos_complejos = {"exequial", "accidentes_exequial", "vida_ahorro", "vida_basico"}
    es_complejo = producto_key.isin(productos_complejos)

    d["CANAL_TOUCH_INICIAL"] = np.select(
        [d["CIUDAD_BUCKET"] == "No informado", es_complejo],
        ["SMS", "Email"],
        default="WhatsApp",
    )

    # --- Timing: ventana sugerida de contacto ---
    # Sin fechas reales de evento, se usan las banderas de servicio como proxy
    # de "evento reciente" (supuesto explicito, a validar con timestamps reales)
    ventana = pd.Series("Sin disparador de evento detectado -> incluir en campaña mensual regular", index=d.index)
    just_timing = pd.Series("", index=d.index)

    m_vivienda = d["VIVIENDA"] == 1
    ventana = ventana.mask(m_vivienda, "0-30 días")
    just_timing = just_timing.mask(m_vivienda, "usó crédito de vivienda recientemente (proxy de evento de vida: compra de casa) -> momento de mayor receptividad para seguro de hogar")

    m_drogueria = (~m_vivienda) & (d["DROGUERIA"] == 1)
    ventana = ventana.mask(m_drogueria, "0-15 días")
    just_timing = just_timing.mask(m_drogueria, "uso activo de droguería (proxy de consumo de salud reciente) -> ventana corta antes de que el interés decaiga")

    m_pensionado = (~m_vivienda) & (~m_drogueria) & (d["PIRAMIDE_NUEVA"] == "6.3 Pensionado")
    ventana = ventana.mask(m_pensionado, "30-60 días")
    just_timing = just_timing.mask(m_pensionado, "transición a etapa pensionado -> ventana amplia, decisión reflexiva de producto exequial/vida")

    d["VENTANA_CONTACTO"] = ventana
    d["JUSTIFICACION_TIMING"] = just_timing.replace("", "sin evento proxy detectado en los datos disponibles; se sugiere incluir en la corrida mensual regular del motor")

    return d


if __name__ == "__main__":
    import time
    df = pd.read_parquet("afiliados_con_oferta.parquet")
    t0 = time.time()
    out = calcular_canal_y_timing(df)
    print("tiempo canal/timing:", time.time() - t0)
    print(out["CANAL_GESTION"].value_counts())
    print()
    print(out["CANAL_TOUCH_INICIAL"].value_counts())
    print()
    print(out["VENTANA_CONTACTO"].value_counts())
    out.to_parquet("afiliados_final.parquet", index=False)
    print("guardado afiliados_final.parquet")
