import pandas as pd

cols_oferta = [
    "SERIE", "RANGO_EDAD", "SEGMENTO_GRUPO_FAMILIAR", "RANGO_SALARIAL",
    "PRODUCTO_PRINCIPAL", "ASEGURADORA_PRINCIPAL", "DESDE_MES_PRINCIPAL", "TIER", "JUSTIFICACION",
    "OFERTA_SECUNDARIA", "JUSTIFICACION_SECUNDARIA",
    "CANAL_GESTION", "CANAL_TOUCH_INICIAL", "VENTANA_CONTACTO",
]

df_final = pd.read_parquet("afiliados_final.parquet")
df_final[cols_oferta].to_csv("ofertas_clientes.csv", index=False)
print("Guardado ofertas_clientes.csv:", len(df_final), "filas")