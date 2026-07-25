# Motor de hiperpersonalizacion de seguros -- prototipo Python

Prototipo de ciencia de datos (Python) para el motor de recomendacion de seguros:
segmentacion no supervisada, motor de reglas de negocio auditable, refinamiento por
chat conversacional y scoring de canal/timing. Construido sobre
`Usos_Productos_Afiliados_SIMULADO.csv` (500k filas sinteticas, en la raiz del repo).

Portado desde `feature/motor-python-hiperpersonalizacion` (prototipo original de
Maite Gómez) el 2026-07-25, con piezas nuevas: `generar_full.py` (orquestador
adaptado a este repo), `validar_calibracion.py` (valida las salidas del motor contra
las 8 columnas de RESULTADO real agregadas al CSV en la Sesion 54) y
`exportar_ofertas.py` (exporta un CSV de negocio, una fila por afiliado, con la
oferta principal/secundaria y su justificacion).

## Archivos

- `preprocess.py` -- limpieza y codificacion de variables (nulos como categoria
  propia, ordinales para edad/salario, bucketing de ciudad). Corre standalone
  (`python preprocess.py`) o importado desde `generar_full.py`.
- `reglas_negocio.py` -- el motor que decide: producto principal + oferta secundaria
  + justificacion textual por afiliado, con el catalogo real de precios
  (colsubsidio.com/seguros). Incluye version vectorizada para correr sobre 500k-1.5M
  filas en segundos. No depende de `CLUSTER` -- corre standalone leyendo
  `afiliados_prep.csv` (salida de `preprocess.py`), sin pasar por clustering.
- `chat_refinamiento.py` -- capa que ajusta la recomendacion base con respuestas de
  un chat conversacional (mascotas, numero de hijos, tipo de vivienda, vehiculo,
  riesgo laboral, frecuencia de viaje, seguros ya contratados). Cada pregunta es
  independiente: si el cliente solo contesta algunas, el motor usa lo que haya.
- `canal_timing.py` -- scoring de mejor canal de contacto (app propia / autogestion
  digital / asistido) y ventana de tiempo sugerida. Standalone lee
  `afiliados_con_oferta.csv` (salida de `reglas_negocio.py`).
- `clustering_comparacion.csv` -- resultados numericos de comparar los 4 algoritmos
  de clustering del prototipo original (silhouette score, tiempo, tamano de cluster).
- `generar_full.py` -- orquesta el pipeline completo: preprocess -> KPrototypes
  (fit sobre muestra de 25k, predict sobre las 500k) -> reglas_negocio -> canal_timing.
  Produce `afiliados_final.csv` (gitignored, ~280MB, se regenera en ~35s).
- `validar_calibracion.py` -- lee `afiliados_final.csv` y compara las predicciones
  del motor contra el resultado real (simulado): precision del producto principal
  vs. `PRODUCTO_ID` real, precision del canal predicho vs. `CANAL_CONTACTO` real,
  y tasa de conversion real por tier/cluster. Produce `CALIBRACION.md`.
- `exportar_ofertas.py` -- lee `afiliados_final.csv` y exporta `ofertas_clientes.csv`
  (gitignored, ~180MB): un subconjunto de columnas de negocio (SERIE, perfil,
  oferta principal/secundaria, justificacion, canal/timing) listo para compartir
  con el equipo comercial sin exponer las columnas internas del pipeline.

**No incluido en este repo** (disponible en `feature/motor-python-hiperpersonalizacion`
si se necesita para la narrativa del pitch): `motor_seguros_colsubsidio.ipynb`, el
notebook original con la comparacion completa de 4 algoritmos de clustering y el EDA
documentado paso a paso.

## Como correrlo

```bash
pip install pandas numpy scikit-learn kmodes
cd analytics
python generar_full.py        # ~35s sobre las 500k filas -> afiliados_final.csv
python validar_calibracion.py # -> CALIBRACION.md
python exportar_ofertas.py    # -> ofertas_clientes.csv (subset de negocio)
```

Cada script tambien corre standalone (`python preprocess.py`, `python
reglas_negocio.py`, `python canal_timing.py`) para depurar una etapa aislada --
cada uno lee el `.csv` que produce el paso anterior en la misma carpeta.

**Nota sobre `pyarrow`:** el prototipo original usaba `.parquet` para los archivos
intermedios/finales. En este repo `pyarrow` quedo bloqueado por una politica local
de Application Control (Windows) al cargar su DLL nativa -- todo el pipeline fue
adaptado para escribir `.csv` (`;`-delimitado, igual que el CSV fuente) en su lugar,
sin perdida de funcionalidad.

## Resultados de calibracion (2026-07-25)

Con el CSV enriquecido con columnas de resultado real (Sesion 54):

| Validacion | Resultado |
|---|---|
| `reglas_negocio.PRODUCTO_KEY` vs. `PRODUCTO_ID` real (afiliados convertidos) | 84.3% coincidencia exacta |
| `canal_timing.CANAL_TOUCH_INICIAL` vs. `CANAL_CONTACTO` real (afiliados contactados) | 24.8% coincidencia exacta |
| Tasa de conversion real por TIER / CLUSTER | ~7% pareja en todos los grupos |

El primer numero confirma que la logica de tiers de `reglas_negocio.py` SÍ quedo
preservada en la etiqueta sintetica de producto (no es 100% por diseno: el generador
aplica una excepcion aleatoria del 15% hacia productos de asistencia/mascotas). Los
otros dos numeros son planos porque el generador sintetico actual (`generate_simulated_
affiliates.py`) todavia asigna canal y probabilidad de conversion sin correlacionarlos
al perfil del afiliado -- quedan documentados como el proximo dato real que pedirle a
Colsubsidio para calibrar el motor de verdad (ver `CALIBRACION.md` para el detalle
completo y las notas de interpretacion).

## Relacion con la app en `src/`

Este es un prototipo de exploracion de datos y diseno de reglas de negocio,
independiente del backend NestJS en `src/modules/`. El nucleo de la logica de tiers
de `reglas_negocio.py` (dependientes/edad/ingreso) ya fue portado a TypeScript en
`src/modules/quoting/quoting.service.ts` (ver `descubrimientos/02-motor-reglas-
scoring.md`, seccion "Tiers de hiper-personalizacion"), reescrito para usar solo
las señales que la conversación real captura. Este motor Python sigue siendo la
pieza de exploracion/demo independiente -- no hay un microservicio Python en
produccion ni se llama desde `src/`.
