"""
Preprocesamiento de la base Usos_Productos_Afiliados_SIMULADO.csv
para el motor de hiperpersonalizacion de seguros Colsubsidio.
"""
import pandas as pd
import numpy as np

RANGO_EDAD_ORDER = {
    "Menor de 19 años": 0,
    "20 a 35 años": 1,
    "36 a 45 años": 2,
    "46 a 55 años": 3,
    "Mayor de 55 años": 4,
}

RANGO_SALARIAL_ORDER = {
    "Menor al SMLV": 0,
    "Entre 1 y 1.5 SMLV": 1,
    "Entre 1.5 y 2 SMLV": 2,
    "Entre 2 y 2.5 SMLV": 3,
    "Entre 2.5 y 3 SMLV": 4,
    "Entre 3 y 4 SMLV": 5,
    "Entre 4 y 6 SMLV": 6,
    "Entre 6 y 8 SMLV": 7,
    "Entre 8 y 10 SMLV": 8,
    "Entre 10 y 20 SMLV": 9,
    "Entre 20 y 30 SMLV": 10,
    "Mayor a 30 SMLV": 11,
}


def load_raw(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, sep=";")
    return df


def bucket_ciudad(ciudad: str) -> str:
    if pd.isna(ciudad):
        return "No informado"
    if ciudad.strip().upper() == "BOGOTA D.C.":
        return "Bogota D.C."
    return "Fuera de Bogota"


def preprocess(df: pd.DataFrame) -> pd.DataFrame:
    d = df.copy()

    # Nulos como categoria propia explicita (no se imputan con moda para no
    # inventar informacion que no esta - queda trazable que "no se sabe").
    cat_fill_cols = [
        "RANGO_SALARIAL", "CATEGORIA", "SEGMENTO_GRUPO_FAMILIAR",
        "SEGMENTO_POBLACIONAL", "PIRAMIDE_NUEVA",
    ]
    for c in cat_fill_cols:
        d[c] = d[c].fillna("No informado")

    d["EMPRESA_FOCO"] = d["EMPRESA_FOCO"].apply(lambda x: "X" if pd.notna(x) else "No")
    d["CIUDAD_BUCKET"] = d["CIUDAD_AFILIADO"].apply(bucket_ciudad)

    for c in ["HOTELES", "PISCILAGO", "DROGUERIA", "AGENCIAS", "VIVIENDA"]:
        d[c] = (d[c].fillna("NO") == "SI").astype(int)

    d["RANGO_EDAD_ORD"] = d["RANGO_EDAD"].map(RANGO_EDAD_ORDER)
    # -1 marca "No informado": categoria propia, no se confunde con el
    # extremo real "Menor al SMLV" (que es 0).
    d["RANGO_SALARIAL_ORD"] = d["RANGO_SALARIAL"].map(RANGO_SALARIAL_ORDER).fillna(-1).astype(int)

    return d


CLUSTER_CAT_COLS = [
    "GENERO", "CATEGORIA", "SEGMENTO_GRUPO_FAMILIAR",
    "SEGMENTO_POBLACIONAL", "PIRAMIDE_NUEVA", "EMPRESA_FOCO", "CIUDAD_BUCKET",
]
CLUSTER_ORD_COLS = ["RANGO_EDAD_ORD", "RANGO_SALARIAL_ORD"]


if __name__ == "__main__":
    df = load_raw("Usos_Productos_Afiliados_SIMULADO.csv")
    d = preprocess(df)
    print(d.shape)
    print(d[CLUSTER_CAT_COLS + CLUSTER_ORD_COLS].isna().sum())
    print(d["CIUDAD_BUCKET"].value_counts())
    d.to_parquet("afiliados_prep.parquet", index=False)
    print("guardado afiliados_prep.parquet")
