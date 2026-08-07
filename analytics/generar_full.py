# generar_full.py: runs the full analytics pipeline over the affiliate dataset —
# preprocess, KPrototypes clustering, business rules and channel/timing scoring.

import os
import time
import numpy as np
import pandas as pd
from preprocess import preprocess, CLUSTER_CAT_COLS, CLUSTER_ORD_COLS
from reglas_negocio import aplicar_reglas_vectorizado
from canal_timing import calcular_canal_y_timing
from kmodes.kprototypes import KPrototypes

SEED = 42
np.random.seed(SEED)

CSV_CANDIDATOS = [
    "Usos_Productos_Afiliados_SIMULADO.csv",
    "../Usos_Productos_Afiliados_SIMULADO.csv",
]
CSV_PATH = next((p for p in CSV_CANDIDATOS if os.path.exists(p)), CSV_CANDIDATOS[0])
OUTPUT_PATH = "afiliados_final.csv" if os.path.exists("preprocess.py") else "analytics/afiliados_final.csv"
print("Cargando:", CSV_PATH)

df_raw = pd.read_csv(CSV_PATH, sep=";")
df = preprocess(df_raw)
print("Filas totales:", len(df))

all_cols = CLUSTER_CAT_COLS + CLUSTER_ORD_COLS
cat_idx = [all_cols.index(c) for c in CLUSTER_CAT_COLS]

muestra_fit = df.sample(n=min(25000, len(df)), random_state=SEED).reset_index(drop=True)
X_fit = muestra_fit[all_cols].values

t0 = time.time()
kp = KPrototypes(n_clusters=6, init="Huang", n_init=2, random_state=SEED, n_jobs=1)
kp.fit(X_fit, categorical=cat_idx)
print(f"Fit KPrototypes ({len(muestra_fit)} filas): {time.time()-t0:.1f}s")

t0 = time.time()
X_full = df[all_cols].values
df["CLUSTER"] = kp.predict(X_full, categorical=cat_idx)
print(f"Predict sobre {len(df)} filas: {time.time()-t0:.1f}s")

t0 = time.time()
df_reglas = aplicar_reglas_vectorizado(df)
print(f"Reglas aplicadas: {time.time()-t0:.2f}s")

t0 = time.time()
df_final = calcular_canal_y_timing(df_reglas)
print(f"Canal/timing aplicado: {time.time()-t0:.2f}s")

df_final.to_csv(OUTPUT_PATH, sep=";", index=False)
print("Guardado", OUTPUT_PATH, ":", len(df_final), "filas")
