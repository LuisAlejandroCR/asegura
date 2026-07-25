# Motor de hiperpersonalizacion de seguros -- prototipo Python

Prototipo de ciencia de datos (Python) para el motor de recomendacion de seguros:
segmentacion no supervisada, motor de reglas de negocio auditable, refinamiento por
chat conversacional y scoring de canal/timing. Construido sobre
`Usos_Productos_Afiliados_SIMULADO.csv` (500k filas reales, en la raiz del repo).

## Archivos

- `motor_seguros_colsubsidio.ipynb` -- notebook principal con todo el analisis
  documentado: EDA, comparacion de 4 algoritmos de clustering (K-Modes, K-Prototypes,
  One-Hot+KMeans, One-Hot+PCA+KMeans), motor de reglas, ejemplo de contraste
  soltero-vs-casado-con-3-hijos, refinamiento por chat, scoring de canal/timing, y
  supuestos/limitaciones consolidados.
- `preprocess.py` -- limpieza y codificacion de variables (nulos como categoria
  propia, ordinales para edad/salario, bucketing de ciudad).
- `reglas_negocio.py` -- el motor que decide: producto principal + oferta secundaria
  + justificacion textual por afiliado, con el catalogo real de precios
  (colsubsidio.com/seguros). Incluye version vectorizada para correr sobre 500k-1.5M
  filas en segundos.
- `chat_refinamiento.py` -- capa que ajusta la recomendacion base con respuestas de
  un chat conversacional (mascotas, numero de hijos, tipo de vivienda, vehiculo,
  riesgo laboral, frecuencia de viaje, seguros ya contratados). Cada pregunta es
  independiente: si el cliente solo contesta algunas, el motor usa lo que haya.
- `canal_timing.py` -- scoring de mejor canal de contacto (app propia / autogestion
  digital / asistido) y ventana de tiempo sugerida.
- `clustering_comparacion.csv` -- resultados numericos de comparar los 4 algoritmos
  de clustering (silhouette score, tiempo, tamano de cluster).
- `generar_full.py` -- corre el pipeline completo (preprocess -> clustering ->
  reglas -> canal/timing) sobre las 500k-1.5M filas y guarda `afiliados_final.parquet`.
- `exportar_ofertas.py` -- lee `afiliados_final.parquet` y exporta `ofertas_clientes.csv`
  con una fila por afiliado (identificado por `SERIE`, nunca por posicion ni nombre)
  y su oferta principal, secundaria, canal y ventana de contacto.

## Como correrlo

1. `pip install pandas numpy scikit-learn kmodes pyarrow`
2. El CSV ya esta en la raiz del repo (`../Usos_Productos_Afiliados_SIMULADO.csv`);
   copialo o crea un symlink dentro de esta carpeta si vas a correr el notebook desde aqui.
3. Abre `motor_seguros_colsubsidio.ipynb` y corre todas las celdas.

**Nota:** el notebook committeado incluye los outputs ya ejecutados (graficos y
resultados de la seccion 7 sobre las 500k filas completas), para que se pueda revisar
sin tener que correrlo. Si lo vuelves a correr localmente, esos outputs se regeneran
con tus propios datos/entorno.

La seccion 7 del notebook usa un archivo `afiliados_final.parquet` con resultados
precomputados sobre las 500k filas completas (no incluido aqui por tamano -- se
regenera corriendo `generar_full.py`, que encadena `preprocess.py` -> clustering ->
`reglas_negocio.py` -> `canal_timing.py` sobre el CSV completo).

## Relacion con la app en `src/`

Este es un prototipo de exploracion de datos y diseno de reglas de negocio,
independiente del backend NestJS en `src/modules/`. Las reglas y el catalogo aqui
documentados pueden servir de referencia para `src/modules/quoting/` y
`src/modules/agent/`, pero no estan integrados automaticamente -- queda como
siguiente paso de equipo decidir si se portan a TypeScript o se exponen como
microservicio Python.
