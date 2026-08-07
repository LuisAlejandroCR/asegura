# -*- coding: utf-8 -*-
"""
Valida las salidas del motor (reglas_negocio.py + canal_timing.py) contra las
columnas de RESULTADO real (simulado) agregadas a Usos_Productos_Afiliados_SIMULADO.csv
en la Sesion 54 -- exactamente el dato que canal_timing.py pedia en su propio
docstring ("reemplazar los pesos en cuanto existan datos reales de conversion").

Requiere haber corrido generar_full.py primero (produce afiliados_final.csv).

PRODUCTO_KEY (claves internas de reglas_negocio.py) vs PRODUCTO_ID (IDs del
catalogo real en products.data.ts, usados por generate_simulated_affiliates.py
para poblar la columna PRODUCTO_ID) no comparten vocabulario -- este mapeo es
la unica pieza nueva de traduccion necesaria para poder comparar ambos.
"""
import pandas as pd

PRODUCTO_KEY_TO_ID = {
    "vida_basico": "vida",
    "vida_ahorro": "vida-ahorro",
    "accidentes_std": "accidentes-personales",
    "accidentes_premium": "accidentes-premium",
    "accidentes_exequial": "accidentes-exequial",
    "exequial": "exequial",
    "asist_medicas": "asistencias-medicas",
    "asist_multiples": "asistencias-multiples",
    "asist_veterinaria": "asistencia-veterinaria",
    "vet_perro": "medicina-prepagada-perros",
    "vet_gato": "medicina-prepagada-gatos",
    # "hogar" / "movilidad": sin equivalente en el catalogo en vivo (precio
    # "Por confirmar" en reglas_negocio.py) -- generate_simulated_affiliates.py
    # nunca los asigna como PRODUCTO_ID, por diseno (regla #12 de AGENTS.md:
    # solo precios reales).
}


def validar(df: pd.DataFrame) -> str:
    lines = []

    def p(s=""):
        lines.append(s)

    p("# Calibracion del motor Python vs. resultados reales (simulados)")
    p()
    p(f"Filas totales: {len(df):,}")
    p()

    # 1) Precision del producto principal (reglas_negocio) vs PRODUCTO_ID
    #    real, entre los afiliados efectivamente convertidos.
    activos = df[df["ESTADO_VENTA"] == "active"].copy()
    activos["PRODUCTO_KEY_MAPEADO"] = activos["PRODUCTO_KEY"].map(PRODUCTO_KEY_TO_ID)
    comparable = activos.dropna(subset=["PRODUCTO_KEY_MAPEADO"])
    aciertos = (comparable["PRODUCTO_KEY_MAPEADO"] == comparable["PRODUCTO_ID"]).sum()
    total_comparable = len(comparable)
    tasa = aciertos / total_comparable * 100 if total_comparable else 0.0

    p("## 1. Precision del producto principal (reglas_negocio.py) vs. compra real")
    p()
    p(f"- Afiliados convertidos (`ESTADO_VENTA=active`): {len(activos):,}")
    p(f"- De esos, con producto principal comparable al catalogo (excluye hogar/movilidad, sin precio real): {total_comparable:,}")
    p(f"- **Coincidencia exacta reglas_negocio.PRODUCTO_KEY == PRODUCTO_ID real: {aciertos:,} / {total_comparable:,} ({tasa:.1f}%)**")
    p()
    no_comparable = len(activos) - total_comparable
    if no_comparable:
        p(f"  ({no_comparable:,} conversiones fueron a productos de cross-sell/mascotas asignados con probabilidad "
           f"plana en el generador sintetico, sin correlacion demografica a validar contra reglas_negocio.py)")
    p()
    p("Nota: la tasa NO es 100% por diseno -- generate_simulated_affiliates.py aplica una excepcion aleatoria del "
      "15% hacia productos de asistencia/mascotas en el generador de PRODUCTO_ID, y no reproduce la condicion "
      "adicional de reglas_negocio.py que sube a Vida+Ahorro tambien por `VIVIENDA=1` (solo por ingreso alto). "
      "La cifra de arriba mide cuanto de la logica de tiers SI se preservo en la etiqueta sintetica.")
    p()

    # 2) Precision de canal_timing.py (CANAL_TOUCH_INICIAL) vs. el canal
    #    real por el que efectivamente se contacto al afiliado.
    contactados = df[df["CONTACTADO"] == "SI"].copy()
    aciertos_canal = (contactados["CANAL_TOUCH_INICIAL"] == contactados["CANAL_CONTACTO"]).sum()
    tasa_canal = aciertos_canal / len(contactados) * 100 if len(contactados) else 0.0

    p("## 2. Precision de canal_timing.py (CANAL_TOUCH_INICIAL) vs. canal real de contacto")
    p()
    p(f"- Afiliados contactados (`CONTACTADO=SI`): {len(contactados):,}")
    p(f"- **Coincidencia exacta canal predicho == canal real: {aciertos_canal:,} / {len(contactados):,} ({tasa_canal:.1f}%)**")
    p()
    p("Matriz canal predicho x canal real:")
    p()
    matriz = pd.crosstab(contactados["CANAL_TOUCH_INICIAL"], contactados["CANAL_CONTACTO"])
    p("```")
    p(matriz.to_string())
    p("```")
    p()
    p("Nota: canal_timing.py explicita en su propio docstring que sus pesos son 'una propuesta de diseno propia, "
      "con pesos razonados pero NO calibrados con datos reales'. El generador sintetico tampoco correlaciona "
      "CANAL_CONTACTO con las senales demograficas que usa canal_timing.py (usa pesos fijos WhatsApp 70% / Email "
      "20% / SMS 10%, sin importar el perfil) -- por eso la coincidencia aqui mide una correlacion de base "
      "(cuanto favorece WhatsApp cada lado), no una validacion real. Queda documentado como el proximo dato que "
      "hay que pedirle a Colsubsidio (historial real de canal-respuesta) para calibrar el modelo de verdad.")
    p()

    # 3) Tasa de conversion real por TIER (reglas_negocio) y por CLUSTER
    #    (KPrototypes) -- valida si el tier/cluster asignado correlaciona
    #    con mayor probabilidad de conversion real.
    p("## 3. Tasa de conversion real (ESTADO_VENTA=active) por TIER de reglas_negocio.py")
    p()
    conv_por_tier = df.groupby("TIER").apply(
        lambda g: (g["ESTADO_VENTA"] == "active").mean() * 100, include_groups=False
    )
    p("```")
    p(conv_por_tier.round(2).to_string())
    p("```")
    p()

    p("## 4. Tasa de conversion real por CLUSTER (KPrototypes)")
    p()
    conv_por_cluster = df.groupby("CLUSTER").apply(
        lambda g: (g["ESTADO_VENTA"] == "active").mean() * 100, include_groups=False
    )
    tam_cluster = df.groupby("CLUSTER").size()
    resumen_cluster = pd.DataFrame({
        "tamano": tam_cluster,
        "tasa_conversion_%": conv_por_cluster.round(2),
    })
    p("```")
    p(resumen_cluster.to_string())
    p("```")
    p()
    p("Nota: el generador sintetico asigna CONTACTADO/ESTADO_VENTA con una probabilidad plana (35%/20% activo), "
      "sin correlacionarla al cluster ni al tier -- por eso se espera que las tasas de conversion salgan "
      "estadisticamente parejas entre grupos (~7%) en esta version del dato. Esta seccion queda lista para "
      "mostrar diferencias reales en cuanto Colsubsidio comparta datos de conversion verdaderos, correlacionados "
      "con el perfil del afiliado.")
    p()

    return "\n".join(lines)


if __name__ == "__main__":
    df = pd.read_csv("afiliados_final.csv", sep=";")
    reporte = validar(df)
    print(reporte)
    with open("CALIBRACION.md", "w", encoding="utf-8") as f:
        f.write(reporte)
    print("\nGuardado analytics/CALIBRACION.md")
