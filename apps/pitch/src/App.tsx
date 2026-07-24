import './App.css';
import Reveal from './components/Reveal';
import CountUp from './components/CountUp';
import ChatDemo from './components/ChatDemo';
import WhyPicker from './components/WhyPicker';

function App() {
  return (
    <div className="app">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="hero">
        <div className="hero-glow" aria-hidden="true" />
        <div className="container hero-grid">
          <div className="hero-copy">
            <img src="/logo.svg" alt="Asegura" className="logo" />
            <h1>
              Venta de seguros
              <br />
              <span className="highlight">automatizada.</span>
            </h1>
            <p className="hero-lede">
              De <span className="mono">"no sé qué necesito"</span> a{' '}
              <span className="mono">"ya quedé asegurado"</span> — en 3 minutos, sin
              asesor, sin formularios.
            </p>
            <div className="hero-actions">
              <a
                href="https://t.me/asegura_bot"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-primary"
              >
                Escríbele al agente →
              </a>
              <a href="#problema" className="btn btn-secondary">
                ¿Cómo funciona? ↓
              </a>
            </div>
            <p className="hero-note">👉 Esta conversación es real — así responde el agente ahora mismo.</p>
          </div>
          <div className="hero-demo">
            <ChatDemo />
          </div>
        </div>
      </section>

      {/* ── El problema ──────────────────────────────────────────────────── */}
      <section id="problema" className="section problema">
        <div className="container">
          <Reveal><span className="section-label">Impacto en el reto · 30%</span></Reveal>
          <Reveal delay={60}><h2>El mercado de seguros en Colombia tiene un problema de distribución</h2></Reveal>

          <div className="stats-grid">
            <Reveal delay={0} className="stat-card">
              <span className="stat-number"><CountUp value="3.2%" /></span>
              <span className="stat-desc">
                Solo el 3.2% del PIB en primas de seguros (UNDP IRFF, 2022). Uno de los más bajos de LatAm.
              </span>
            </Reveal>
            <Reveal delay={60} className="stat-card">
              <span className="stat-number"><CountUp value="8.9B" />&nbsp;USD</span>
              <span className="stat-desc">
                Tamaño del mercado en 2026 (Skadden/GlobalData, mayo 2026)
              </span>
            </Reveal>
            <Reveal delay={120} className="stat-card">
              <span className="stat-number"><CountUp value="2.8M" /></span>
              <span className="stat-desc">
                Afiliados de Colsubsidio que HOY podrían comprar un seguro pero NO lo hacen (Semana, 2025)
              </span>
            </Reveal>
            <Reveal delay={180} className="stat-card">
              <span className="stat-number"><CountUp value="2.1%" /></span>
              <span className="stat-desc">
                De las primas son microseguros — el segmento masivo está desatendido (UNDP, 2022)
              </span>
            </Reveal>
            <Reveal delay={240} className="stat-card stat-card-highlight">
              <span className="stat-number"><CountUp value="0" /></span>
              <span className="stat-desc">
                Competidores en Colombia que cierran la venta de seguros SIN asesor humano
              </span>
            </Reveal>
          </div>

          <Reveal><h3>¿Por qué la gente NO compra seguros?</h3></Reveal>
          <Reveal delay={80}>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Barrera</th>
                    <th>Datos</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Depende de asesor humano</td>
                    <td>~8 clientes/día por asesor</td>
                  </tr>
                  <tr>
                    <td>No opera 24/7</td>
                    <td>Lunes a viernes, horario oficina</td>
                  </tr>
                  <tr>
                    <td>Precios no transparentes</td>
                    <td>Hay que llamar para saber cuánto</td>
                  </tr>
                  <tr>
                    <td>No entienden los productos</td>
                    <td>Jerga técnica: prima, deducible</td>
                  </tr>
                  <tr>
                    <td>Baja cultura de seguros</td>
                    <td>3.2% penetración vs 7%+ en Chile</td>
                  </tr>
                  <tr>
                    <td>Sin canal digital real</td>
                    <td>Todos redirigen a humano</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Reveal>

          <p className="sources">
            Fuentes: UNDP IRFF 2022, McKinsey LatAm Insurance 2025, AM Best Jun 2026, Skadden May 2026
          </p>

          <Reveal>
            <div className="reto-box">
              <strong>EL RETO:</strong> "Llevar al potencial cliente desde 'no sé qué seguro necesito'
              hasta 'ya quedé asegurado' sin interacción humana."
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── La solución ──────────────────────────────────────────────────── */}
      <section id="solucion" className="section solucion">
        <div className="container">
          <Reveal><span className="section-label">Innovación · 20%</span></Reveal>
          <Reveal delay={60}><h2>La solución: Asegura</h2></Reveal>
          <Reveal delay={100}>
            <p className="section-subtitle">
              Un agente conversacional que reemplaza al asesor humano
            </p>
          </Reveal>

          <div className="steps-grid">
            <Reveal delay={0} className="step-card">
              <span className="step-number">1</span>
              <h3>Identifica la necesidad</h3>
              <p>
                NLP en español. Texto + notas de voz. Sin menús ni formularios. Como hablar con un amigo.
              </p>
            </Reveal>
            <Reveal delay={100} className="step-card">
              <span className="step-number">2</span>
              <h3>Cotiza en tiempo real</h3>
              <p>
                Precio real de Colsubsidio. Con la aseguradora aliada. "Desde $X/mes" + por qué. Link de info en WebView.
              </p>
            </Reveal>
            <Reveal delay={200} className="step-card">
              <span className="step-number">3</span>
              <h3>Cierra la venta</h3>
              <p>
                Link de pago (Wompi). Póliza PDF con QR de verificación. Todo dentro del chat. Pago verificado por Wompi.
              </p>
            </Reveal>
          </div>

          <Reveal>
            <div className="innovation-box">
              <h3>Innovación</h3>
              <ul>
                <li>NLP conversacional (no menú IVR) — ningún competidor lo tiene</li>
                <li>Acepta voz en español (Whisper) — ningún competidor lo tiene</li>
                <li>Pago verificado vía webhook (no autoreportado) — ningún competidor lo tiene</li>
                <li>Precios reales desde el primer mensaje — la web de Colsubsidio no los muestra</li>
              </ul>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Explóralo: propensión explicable ────────────────────────────────── */}
      <section id="explora" className="section explora">
        <div className="container">
          <Reveal><span className="section-label">Propensión explicable</span></Reveal>
          <Reveal delay={60}><h2>Cada recomendación tiene una razón. Pruébalo tú mismo.</h2></Reveal>
          <Reveal delay={100}>
            <p className="section-subtitle">
              Elige tu situación — esta es exactamente la lógica que corre en producción,
              no una simulación aparte.
            </p>
          </Reveal>
          <Reveal delay={140}>
            <WhyPicker />
          </Reveal>
        </div>
      </section>

      {/* ── Viabilidad técnica ───────────────────────────────────────────── */}
      <section id="viabilidad" className="section viabilidad">
        <div className="container">
          <Reveal><span className="section-label">Viabilidad técnica · 20%</span></Reveal>
          <Reveal delay={60}><h2>Demo en vivo</h2></Reveal>

          <Reveal delay={100}>
            <div className="comparison-table">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th>Asegura</th>
                    <th>Falabella</th>
                    <th>SURA</th>
                    <th>MAPFRE</th>
                    <th>Configuro</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Venta completa en chat</td>
                    <td className="check">✓</td>
                    <td className="cross">✗</td>
                    <td className="cross">✗</td>
                    <td className="cross">✗</td>
                    <td className="cross">✗</td>
                  </tr>
                  <tr>
                    <td>24/7 sin asesor</td>
                    <td className="check">✓</td>
                    <td className="cross">✗</td>
                    <td className="cross">✗</td>
                    <td className="cross">✗</td>
                    <td className="cross">✗</td>
                  </tr>
                  <tr>
                    <td>{'< 3 minutos'}</td>
                    <td className="check">✓</td>
                    <td className="cross">✗</td>
                    <td className="cross">✗</td>
                    <td className="cross">✗</td>
                    <td className="cross">✗</td>
                  </tr>
                  <tr>
                    <td>Entiende voz</td>
                    <td className="check">✓</td>
                    <td className="cross">✗</td>
                    <td className="cross">✗</td>
                    <td className="cross">✗</td>
                    <td className="cross">✗</td>
                  </tr>
                  <tr>
                    <td>Explica por qué</td>
                    <td className="check">✓</td>
                    <td className="cross">✗</td>
                    <td className="cross">✗</td>
                    <td className="cross">✗</td>
                    <td className="cross">✗</td>
                  </tr>
                  <tr>
                    <td>Todo en el chat</td>
                    <td className="check">✓</td>
                    <td className="cross">✗</td>
                    <td className="cross">✗</td>
                    <td className="cross">✗</td>
                    <td className="cross">✗ (form externo)</td>
                  </tr>
                  <tr>
                    <td>Pago verificado</td>
                    <td className="check">✓</td>
                    <td className="cross">✗</td>
                    <td className="cross">✗</td>
                    <td className="cross">✗</td>
                    <td className="cross">✗</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Reveal>

          <Reveal>
            <div className="stack-box">
              <strong>Stack probado:</strong> NestJS + Groq + Wompi + Supabase + Telegram
              <br />
              <span className="muted">(todo open source o con sandbox disponible)</span>
            </div>
          </Reveal>

          <Reveal>
            <div className="qr-box">
              <img src="/qr-bot.svg" alt="QR del agente" className="qr-code" />
              <p>
                <strong>Próbalo ahora.</strong> Escanea y compra un seguro real.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Viabilidad de implementación ──────────────────────────────────── */}
      <section id="productos" className="section productos">
        <div className="container">
          <Reveal><span className="section-label">Viabilidad de implementación · 20%</span></Reveal>
          <Reveal delay={60}><h2>Productos reales + pagos reales</h2></Reveal>
          <Reveal delay={100}>
            <p className="section-subtitle">
              Estos son seguros REALES de Colsubsidio con precios REALES (julio 2026):
            </p>
          </Reveal>

          <div className="products-grid">
            {[
              ['🛡️', 'Accidentes personales', 'MetLife', '$18.000/mes'],
              ['💚', 'Seguro de vida', 'Pan American Life', '$12.000/mes'],
              ['🏠', 'Asistencias múltiples', 'GEA', '$20.000/mes'],
              ['⚰️', 'Exequial', 'Grupo Recordar', '$26.000/mes'],
              ['🛡️⚰️', 'Accidentes + Exequial', 'Pan American Life', '$14.000/mes'],
              ['💰', 'Vida + Ahorro', 'BMI', '$20.000/mes'],
              ['🏥', 'Asistencias médicas', 'GEA', '$16.800/mes'],
              ['🐾', 'Asistencia veterinaria', 'GEA', '$14.500/mes'],
              ['🐱', 'Medicina prepagada gatos', 'VetPlus', '$81.800/mes'],
              ['🐕', 'Medicina prepagada perros', 'VetPlus', '$96.600/mes'],
            ].map(([icon, name, insurer, price], i) => (
              <Reveal delay={(i % 5) * 50} className="product-card" key={name}>
                <span className="product-icon">{icon}</span>
                <span className="product-name">{name}</span>
                <span className="product-insurer">{insurer}</span>
                <span className="product-price">desde {price}</span>
              </Reveal>
            ))}
          </div>

          <Reveal>
            <div className="sandbox-info">
              <strong>20 transacciones reales</strong> registradas en Wompi sandbox.
              <br />
              Wompi cuenta activa con sandbox.
            </div>
          </Reveal>

          <Reveal>
            <blockquote className="key-quote">
              "Colsubsidio tiene estos seguros pero el usuario NO sabe cuánto cuestan hasta
              que habla con un asesor. Asegura se los muestra desde el primer mensaje.
              Transparencia desde el inicio — genera confianza y cierra ventas más rápido."
            </blockquote>
          </Reveal>
        </div>
      </section>

      {/* ── Verificación de póliza ────────────────────────────────────────── */}
      <section id="verificacion" className="section verificacion">
        <div className="container">
          <Reveal><h2>Verificación de póliza</h2></Reveal>
          <Reveal delay={60}>
            <p>
              Cada póliza incluye un código QR de verificación en el PDF.
              <br />
              El pago se confirma vía webhook de Wompi — no es autoreportado por el usuario.
            </p>
          </Reveal>
          <Reveal delay={100}>
            <p className="muted">
              Futuro: registro on-chain en Celo Mainnet para auditoría pública e inmutable.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── Visión futura ─────────────────────────────────────────────────── */}
      <section id="futuro" className="section futuro">
        <div className="container">
          <Reveal><h2>Visión futura</h2></Reveal>
          <Reveal delay={60}>
            <p>
              Con Open Finance y Open Insurance (Decreto 0368, 2025), las aseguradoras colombianas
              deben abrir sus datos por API.
            </p>
          </Reveal>
          <Reveal delay={100}><p>Asegura está diseñado para ese mundo:</p></Reveal>
          <Reveal delay={140}>
            <ul>
              <li><strong>Hoy:</strong> vende seguros de Colsubsidio sin asesor</li>
              <li><strong>Mañana:</strong> compara y vende de CUALQUIER aseguradora</li>
            </ul>
          </Reveal>

          <Reveal delay={180}>
            <div className="market-box">
              <strong>Mercado potencial:</strong>
              <br />
              1% de 2.8M afiliados × $18.000/mes promedio = $504M COP/mes en primas
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── CTA final ─────────────────────────────────────────────────────── */}
      <section id="cta" className="section cta">
        <div className="cta-glow" aria-hidden="true" />
        <div className="container">
          <Reveal><h2>¿Listo para asegurarte en 3 minutos?</h2></Reveal>

          <Reveal delay={80}>
            <div className="qr-box qr-box-large">
              <img src="/qr-bot.svg" alt="QR del agente" className="qr-code" />
              <p>
                Escanea con tu celular y compra un seguro ahora.
                <br />
                Un voluntario del público puede probarlo en vivo.
              </p>
            </div>
          </Reveal>

          <Reveal delay={140}>
            <a
              href="https://t.me/asegura_bot"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary btn-large"
            >
              Escríbele en Telegram →
            </a>
          </Reveal>

          <Reveal delay={180}>
            <p className="tagline">
              Sin app. Sin formularios. Sin asesor.
              <br />
              Solo una conversación.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <footer className="footer">
        <div className="container">
          <p>
            Asegura — Hackathon Colsubsidio × 30X · Julio 2026
          </p>
          <p className="footer-links">
            <a
              href="https://colsubsidio.com/transparencia-acceso-informacion/tratamiento-datos-personales"
              target="_blank"
              rel="noopener noreferrer"
            >
              Términos
            </a>
            {' · '}
            <a
              href="https://colsubsidio.com/transparencia-acceso-informacion/tratamiento-datos-personales"
              target="_blank"
              rel="noopener noreferrer"
            >
              Privacidad
            </a>
            {' · '}
            <a href="mailto:soporte@asegura.co">Soporte</a>
          </p>
          <p className="footer-stack">
            Powered by: Wompi · NestJS · Groq · Supabase
          </p>
        </div>
      </footer>
    </div>
  );
}

export default App;
