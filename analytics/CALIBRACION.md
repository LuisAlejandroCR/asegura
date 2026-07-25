# Calibracion del motor Python vs. resultados reales (simulados)

Filas totales: 500,000

## 1. Precision del producto principal (reglas_negocio.py) vs. compra real

- Afiliados convertidos (`ESTADO_VENTA=active`): 35,098
- De esos, con producto principal comparable al catalogo (excluye hogar/movilidad, sin precio real): 35,098
- **Coincidencia exacta reglas_negocio.PRODUCTO_KEY == PRODUCTO_ID real: 29,602 / 35,098 (84.3%)**


Nota: la tasa NO es 100% por diseno -- generate_simulated_affiliates.py aplica una excepcion aleatoria del 15% hacia productos de asistencia/mascotas en el generador de PRODUCTO_ID, y no reproduce la condicion adicional de reglas_negocio.py que sube a Vida+Ahorro tambien por `VIVIENDA=1` (solo por ingreso alto). La cifra de arriba mide cuanto de la logica de tiers SI se preservo en la etiqueta sintetica.

## 2. Precision de canal_timing.py (CANAL_TOUCH_INICIAL) vs. canal real de contacto

- Afiliados contactados (`CONTACTADO=SI`): 175,288
- **Coincidencia exacta canal predicho == canal real: 43,556 / 175,288 (24.8%)**

Matriz canal predicho x canal real:

```
CANAL_CONTACTO       Email    SMS  WhatsApp
CANAL_TOUCH_INICIAL                        
Email                 7240   3636     24900
SMS                  20294  10128     71739
WhatsApp              7435   3728     26188
```

Nota: canal_timing.py explicita en su propio docstring que sus pesos son 'una propuesta de diseno propia, con pesos razonados pero NO calibrados con datos reales'. El generador sintetico tampoco correlaciona CANAL_CONTACTO con las senales demograficas que usa canal_timing.py (usa pesos fijos WhatsApp 70% / Email 20% / SMS 10%, sin importar el perfil) -- por eso la coincidencia aqui mide una correlacion de base (cuanto favorece WhatsApp cada lado), no una validacion real. Queda documentado como el proximo dato que hay que pedirle a Colsubsidio (historial real de canal-respuesta) para calibrar el modelo de verdad.

## 3. Tasa de conversion real (ESTADO_VENTA=active) por TIER de reglas_negocio.py

```
TIER
1    7.05
2    7.01
3    7.00
4    7.01
```

## 4. Tasa de conversion real por CLUSTER (KPrototypes)

```
         tamano  tasa_conversion_%
CLUSTER                           
0         88313               7.07
1         66864               6.95
2        104973               7.07
3         46354               6.95
4         73183               6.93
5        120313               7.06
```

Nota: el generador sintetico asigna CONTACTADO/ESTADO_VENTA con una probabilidad plana (35%/20% activo), sin correlacionarla al cluster ni al tier -- por eso se espera que las tasas de conversion salgan estadisticamente parejas entre grupos (~7%) en esta version del dato. Esta seccion queda lista para mostrar diferencias reales en cuanto Colsubsidio comparta datos de conversion verdaderos, correlacionados con el perfil del afiliado.
