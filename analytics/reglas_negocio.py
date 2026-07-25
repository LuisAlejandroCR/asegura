# -*- coding: utf-8 -*-
"""
Motor de reglas de negocio: producto principal + oferta secundaria + justificacion,
por afiliado. Esta capa es la que responde "por que a esta persona le muestro este
seguro y no otro" , no depende del cluster por las bajas métricas.

"""
import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Catalogo real de productos y precios 
# ---------------------------------------------------------------------------
CATALOGO = {
    "vida_basico":        {"producto": "Seguro de vida",                  "aseguradora": "Pan American Life", "desde_mes": 12000},
    "vida_ahorro":         {"producto": "Vida + Ahorro",                   "aseguradora": "BMI",               "desde_mes": 20000},
    "accidentes_std":      {"producto": "Accidentes personales",           "aseguradora": "MetLife",           "desde_mes": 18000},
    "accidentes_premium":  {"producto": "Accidentes personales (premium)", "aseguradora": "Chubb",              "desde_mes": 28100},
    "accidentes_exequial": {"producto": "Accidentes + Exequial",           "aseguradora": "Pan American Life", "desde_mes": 14000},
    "exequial":            {"producto": "Exequial",                        "aseguradora": "Grupo Recordar",     "desde_mes": 26000},
    "asist_medicas":       {"producto": "Asistencias médicas",             "aseguradora": "GEA",                "desde_mes": 16800},
    "asist_multiples":     {"producto": "Asistencias múltiples",           "aseguradora": "GEA",                "desde_mes": 20000},
    "asist_veterinaria":   {"producto": "Asistencia veterinaria",          "aseguradora": "GEA",                "desde_mes": 14500},
    "hogar":               {"producto": "Seguro de hogar",                 "aseguradora": "Por confirmar",      "desde_mes": None},
    # --- Agregados para el flujo de chat (requieren dato que solo se
    # consigue preguntando directo al cliente; no existen en la base batch) ---
    "vet_perro":           {"producto": "Medicina prepagada (perros)",     "aseguradora": "VetPlus",            "desde_mes": 96600},
    "vet_gato":            {"producto": "Medicina prepagada (gatos)",      "aseguradora": "VetPlus",            "desde_mes": 81800},
    "movilidad":           {"producto": "Seguro de movilidad (auto/moto)", "aseguradora": "Por confirmar",      "desde_mes": None},
}

PENSIONADO = "6.3 Pensionado"
CON_DEPENDIENTES = {
    "FAMILIA MONOPARENTAL", "FAMILIA MONOPARENTAL AMPLIADA",
    "FAMILIA NUCLEAR INTEGRAL", "FAMILIA NUCLEAR AMPLIADA", "PAREJA CONYUGAL",
}
SIN_GRUPO_FAMILIAR = "AFILLIADO SIN GRUPO_FAMILIAR"
INFORMAL = {"6.1 Facultativo", "6.2 Independiente"}

EDAD_MAYOR = "Mayor de 55 años"
EDAD_46_55 = "46 a 55 años"
SALARIO_ALTO_ORD = 5  # >= "Entre 3 y 4 SMLV"


def _tiene_dependientes(row):
    return row["SEGMENTO_GRUPO_FAMILIAR"] in CON_DEPENDIENTES


def _es_mayor_o_pensionado(row):
    return row["RANGO_EDAD"] in (EDAD_MAYOR,) or row["PIRAMIDE_NUEVA"] == PENSIONADO


def score_afiliado(row: pd.Series) -> dict:
    """Devuelve el producto principal, oferta secundaria y justificacion
    para UNA fila. Vectorizado aparte para el dataset completo (ver
    aplicar_reglas_vectorizado)."""

    dependientes = _tiene_dependientes(row)
    mayor_o_pensionado = _es_mayor_o_pensionado(row)
    informal = row["PIRAMIDE_NUEVA"] in INFORMAL
    salario_alto = row["RANGO_SALARIAL_ORD"] >= SALARIO_ALTO_ORD
    joven_activo = row["RANGO_EDAD"] in ("20 a 35 años", "36 a 45 años")

    razones = []
    producto_key = None
    tier = None

    # Tier 1: proteccion de dependientes (vida) -- gana si hay dependientes
    # Y la persona todavia esta en edad economicamente activa (no aplica si
    # ya es adulto mayor: ahi el tema pasa a ser exequial, Tier 2).
    if dependientes and row["RANGO_EDAD"] != EDAD_MAYOR:
        tier = 1
        if salario_alto or row["VIVIENDA"] == 1:
            producto_key = "vida_ahorro"
            razones.append(f"tiene grupo familiar con dependientes ({row['SEGMENTO_GRUPO_FAMILIAR']}) y capacidad de ahorro (salario {row['RANGO_SALARIAL']}" + (", crédito de vivienda vigente" if row["VIVIENDA"] == 1 else "") + ") -> se prioriza Vida+Ahorro sobre vida básica")
        else:
            producto_key = "vida_basico"
            razones.append(f"tiene grupo familiar con dependientes ({row['SEGMENTO_GRUPO_FAMILIAR']}) que dependen de su ingreso -> proteger ese ingreso ante fallecimiento es la necesidad más directa")

    # Tier 2: exequial / accidentes+exequial -- mayor de 55 o pensionado
    elif mayor_o_pensionado:
        tier = 2
        if dependientes:
            producto_key = "accidentes_exequial"
            razones.append(f"edad/segmento de riesgo alto ({row['RANGO_EDAD']}, pirámide {row['PIRAMIDE_NUEVA']}) y aún tiene grupo familiar a cargo -> combinado accidentes+exequial cubre both el imprevisto y el gasto funerario")
        else:
            producto_key = "exequial"
            razones.append(f"edad/segmento de riesgo alto ({row['RANGO_EDAD']}, pirámide {row['PIRAMIDE_NUEVA']}) sin grupo familiar que asuma el gasto funerario -> exequial evita dejar esa carga a la familia extendida o al Estado")

    # Tier 3: accidentes personales -- jovenes/adultos activos, especialmente
    # informales (sin ARL de un empleador tradicional)
    elif joven_activo:
        tier = 3
        producto_key = "accidentes_premium" if salario_alto else "accidentes_std"
        motivo_informal = " y su vínculo es informal/independiente (sin ARL de un empleador tradicional)" if informal else ""
        razones.append(f"edad económicamente activa ({row['RANGO_EDAD']}) sin dependientes registrados{motivo_informal} -> accidentes personales es la protección de mayor necesidad inmediata")

    # Tier 4 (fallback): resto de casos (ej. 46-55 sin dependientes, sin ser
    # aun 'mayor de 55') -> accidentes estandar como piso de proteccion
    else:
        tier = 4
        producto_key = "accidentes_std"
        razones.append(f"perfil sin dependientes registrados y aún no en rango de mayor riesgo actuarial ({row['RANGO_EDAD']}) -> se ofrece accidentes personales como piso de protección")

    # --- Oferta secundaria / cross-sell (no compite con la principal) ---
    secundarios = []
    if row["DROGUERIA"] == 1:
        sec_key = "asist_multiples" if (row["HOTELES"] == 1 or row["AGENCIAS"] == 1) else "asist_medicas"
        secundarios.append((sec_key, f"usa droguería Colsubsidio (consumo activo de salud) -> propenso a {CATALOGO[sec_key]['producto']}"))
    if row["VIVIENDA"] == 1:
        secundarios.append(("hogar", "ya usó crédito de vivienda Colsubsidio -> altísima propensión a seguro de hogar (precio pendiente de catálogo real)"))

    principal = CATALOGO[producto_key].copy()
    principal["tier"] = tier
    principal["justificacion"] = "; ".join(razones)
    principal["producto_key"] = producto_key

    return {
        "PRODUCTO_PRINCIPAL": principal["producto"],
        "ASEGURADORA_PRINCIPAL": principal["aseguradora"],
        "DESDE_MES_PRINCIPAL": principal["desde_mes"],
        "TIER": tier,
        "JUSTIFICACION": principal["justificacion"],
        "OFERTA_SECUNDARIA": "; ".join(f"{CATALOGO[k]['producto']}" for k, _ in secundarios) if secundarios else None,
        "JUSTIFICACION_SECUNDARIA": " | ".join(j for _, j in secundarios) if secundarios else None,
    }


def aplicar_reglas_vectorizado(df: pd.DataFrame) -> pd.DataFrame:
    """Version vectorizada (np.select)."""
    d = df.copy()

    dependientes = d["SEGMENTO_GRUPO_FAMILIAR"].isin(CON_DEPENDIENTES)
    mayor_o_pensionado = (d["RANGO_EDAD"] == EDAD_MAYOR) | (d["PIRAMIDE_NUEVA"] == PENSIONADO)
    informal = d["PIRAMIDE_NUEVA"].isin(INFORMAL)
    salario_alto = d["RANGO_SALARIAL_ORD"] >= SALARIO_ALTO_ORD
    joven_activo = d["RANGO_EDAD"].isin(["20 a 35 años", "36 a 45 años"])

    tier1 = dependientes & (d["RANGO_EDAD"] != EDAD_MAYOR)
    tier2 = (~tier1) & mayor_o_pensionado
    tier3 = (~tier1) & (~tier2) & joven_activo
    tier4 = ~(tier1 | tier2 | tier3)

    producto_key = np.select(
        [
            tier1 & (salario_alto | (d["VIVIENDA"] == 1)),
            tier1 & ~(salario_alto | (d["VIVIENDA"] == 1)),
            tier2 & dependientes,
            tier2 & ~dependientes,
            tier3 & salario_alto,
            tier3 & ~salario_alto,
            tier4,
        ],
        [
            "vida_ahorro", "vida_basico",
            "accidentes_exequial", "exequial",
            "accidentes_premium", "accidentes_std",
            "accidentes_std",
        ],
        default="accidentes_std",
    )

    tier = np.select([tier1, tier2, tier3, tier4], [1, 2, 3, 4], default=4)

    d["PRODUCTO_KEY"] = producto_key
    d["PRODUCTO_PRINCIPAL"] = d["PRODUCTO_KEY"].map(lambda k: CATALOGO[k]["producto"])
    d["ASEGURADORA_PRINCIPAL"] = d["PRODUCTO_KEY"].map(lambda k: CATALOGO[k]["aseguradora"])
    d["DESDE_MES_PRINCIPAL"] = d["PRODUCTO_KEY"].map(lambda k: CATALOGO[k]["desde_mes"])
    d["TIER"] = tier

    # Justificacion textual (se calcula vectorizado con np.select por partes,
    # concatenando fragmentos -- mas rapido que apply para 500k+ filas)
    razon_tier1_ahorro = ("tiene grupo familiar con dependientes (" + d["SEGMENTO_GRUPO_FAMILIAR"] +
                           ") y capacidad de ahorro (salario " + d["RANGO_SALARIAL"].astype(str) +
                           ") -> se prioriza Vida+Ahorro sobre vida básica")
    razon_tier1_basico = ("tiene grupo familiar con dependientes (" + d["SEGMENTO_GRUPO_FAMILIAR"] +
                           ") que dependen de su ingreso -> proteger ese ingreso ante fallecimiento es la necesidad más directa")
    razon_tier2_combo = ("edad/segmento de riesgo alto (" + d["RANGO_EDAD"] + ", pirámide " + d["PIRAMIDE_NUEVA"] +
                          ") y aún tiene grupo familiar a cargo -> combinado accidentes+exequial")
    razon_tier2_exeq = ("edad/segmento de riesgo alto (" + d["RANGO_EDAD"] + ", pirámide " + d["PIRAMIDE_NUEVA"] +
                         ") sin grupo familiar que asuma el gasto funerario -> exequial evita dejar esa carga a la familia extendida o al Estado")
    razon_tier3 = ("edad económicamente activa (" + d["RANGO_EDAD"] + ") sin dependientes registrados" +
                   np.where(informal, " y vínculo informal/independiente (sin ARL de un empleador tradicional)", "") +
                   " -> accidentes personales es la protección de mayor necesidad inmediata")
    razon_tier4 = ("perfil sin dependientes registrados y aún no en rango de mayor riesgo actuarial (" +
                   d["RANGO_EDAD"] + ") -> se ofrece accidentes personales como piso de protección")

    d["JUSTIFICACION"] = np.select(
        [
            tier1 & (salario_alto | (d["VIVIENDA"] == 1)),
            tier1 & ~(salario_alto | (d["VIVIENDA"] == 1)),
            tier2 & dependientes,
            tier2 & ~dependientes,
            tier3,
            tier4,
        ],
        [razon_tier1_ahorro, razon_tier1_basico, razon_tier2_combo, razon_tier2_exeq, razon_tier3, razon_tier4],
        default=razon_tier4,
    )

    # Oferta secundaria (cross-sell, no compite con la principal)
    sec_medica = np.where((d["HOTELES"] == 1) | (d["AGENCIAS"] == 1), "Asistencias múltiples", "Asistencias médicas")

    sec1_mask = d["DROGUERIA"] == 1
    sec2_mask = d["VIVIENDA"] == 1

    sec_list = np.where(sec1_mask, sec_medica, "")
    sec_list = np.where(sec2_mask, np.where(sec1_mask, sec_list + "; Seguro de hogar", "Seguro de hogar"), sec_list)
    d["OFERTA_SECUNDARIA"] = np.where(sec_list == "", None, sec_list)

    just1 = np.where(sec1_mask, "usa droguería Colsubsidio (consumo activo de salud) -> propenso a " + sec_medica, "")
    just2 = np.where(sec2_mask, "ya usó crédito de vivienda Colsubsidio -> alta propensión a seguro de hogar", "")
    just_combo = np.where((sec1_mask) & (sec2_mask), just1 + " | " + just2, np.where(sec1_mask, just1, just2))
    d["JUSTIFICACION_SECUNDARIA"] = np.where(just_combo == "", None, just_combo)

    return d


if __name__ == "__main__":
    df = pd.read_parquet("afiliados_clustered.parquet")
    import time
    t0 = time.time()
    out = aplicar_reglas_vectorizado(df)
    print("tiempo reglas vectorizado:", time.time() - t0)
    print(out["PRODUCTO_PRINCIPAL"].value_counts())
    print()
    print(out["TIER"].value_counts().sort_index())
    print()
    print(out["OFERTA_SECUNDARIA"].value_counts(dropna=False))
    out.to_parquet("afiliados_con_oferta.parquet", index=False)
    print("guardado afiliados_con_oferta.parquet")
