// agent.service.spec.ts: the conversation suite for AgentService — one describe per
// state (GREETING through COMPLETED) plus the regression cases from live testing.
// Each dated block names the real bug it locks down; keep that context when editing.

import { ConversationState, ConversationContext } from './types';
import { PRODUCTS } from '../quoting/products.data';
import { makeMessage, makeIntent, makeConversation, buildService } from './agent.service.test-helpers';

// Unsupported input (images, long audio)

describe('AgentService — unsupported input', () => {
  it('regression — an image gets an informative message instead of being silently ignored', async () => {
    const { service, telegram, nlp } = buildService({ state: ConversationState.DISCOVERY });
    telegram.normalize.mockResolvedValue({ ...makeMessage(''), unsupportedInput: 'image' });
    await service.handleMessage({});
    expect(telegram.sendText).toHaveBeenCalledWith('u1', expect.stringContaining('imágenes'));
    expect(nlp.extractIntent).not.toHaveBeenCalled();
  });

  it('regression — a too-long voice note gets an informative message instead of being silently ignored', async () => {
    const { service, telegram, nlp } = buildService({ state: ConversationState.DISCOVERY });
    telegram.normalize.mockResolvedValue({ ...makeMessage(''), unsupportedInput: 'audio_too_long' });
    await service.handleMessage({});
    expect(telegram.sendText).toHaveBeenCalledWith('u1', expect.stringContaining('cortos'));
    expect(nlp.extractIntent).not.toHaveBeenCalled();
  });

  it('does not persist any state change for unsupported input', async () => {
    const { service, telegram, conversations } = buildService({ state: ConversationState.DISCOVERY });
    telegram.normalize.mockResolvedValue({ ...makeMessage(''), unsupportedInput: 'image' });
    await service.handleMessage({});
    expect(conversations.saveState).not.toHaveBeenCalled();
  });
});

// GREETING state

describe('AgentService — GREETING', () => {
  // 2026-07-24 feedback: greeting + a full separate authorization paragraph read as a
  // wall of text before the user could say anything — combined into ONE short message;
  // the Ley 1581 disclosure is kept (legally required) but folded in, not its own message.
  it('sends one combined greeting + authorization message, not two separate ones', async () => {
    const { service, telegram, conversations } = buildService({ state: ConversationState.GREETING });
    telegram.normalize.mockResolvedValue(makeMessage('hola'));
    await service.handleMessage({});
    expect(telegram.sendText).toHaveBeenCalledTimes(1);
    const message = telegram.sendText.mock.calls[0][1] as string;
    expect(message).toContain('Asegura');
    expect(message).toContain('Ley 1581');
    // State must advance to AUTHORIZATION
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.AUTHORIZATION, expect.anything(),
    );
  });

  // 2026-07-26 feedback: "puedes responder por texto o audio" used to only appear two
  // turns later, in the affiliate-ID question — moved up so the very first message
  // already sets that expectation, before the user has committed to anything.
  it('the very first message already mentions text/audio are both fine', async () => {
    const { service, telegram } = buildService({ state: ConversationState.GREETING });
    telegram.normalize.mockResolvedValue(makeMessage('hola'));
    await service.handleMessage({});
    const message = telegram.sendText.mock.calls[0][1] as string;
    expect(message.toLowerCase()).toMatch(/texto|audio/);
  });

  it('regression — GREETING never skips the greeting message (¡Hola!)', async () => {
    const { service, telegram } = buildService({ state: ConversationState.GREETING });
    telegram.normalize.mockResolvedValue(makeMessage('/start'));
    await service.handleMessage({});
    const calls = telegram.sendText.mock.calls.map((c: any[]) => c[1] as string);
    const hasGreeting = calls.some((t) => t.includes('Asegura') && (t.includes('Hola') || t.includes('hola') || t.includes('asesor')));
    expect(hasGreeting).toBe(true);
  });

  it('authorization message contains a clickable in-chat link (Telegram WebView, not external browser)', async () => {
    const { service, telegram } = buildService({ state: ConversationState.GREETING });
    telegram.normalize.mockResolvedValue(makeMessage('/start'));
    await service.handleMessage({});
    const calls = telegram.sendText.mock.calls.map((c: any[]) => c[1] as string);
    const authMsg = calls.find((t) => t.includes('Ley 1581'));
    expect(authMsg).toBeDefined();
    // Link must be Telegram Markdown format [text](url) — opens in WebView, user never leaves the chat
    expect(authMsg).toMatch(/\[.*?\]\(https?:\/\/.*?\)/);
    expect(authMsg).toContain('colsubsidio.com');
  });
});

// AUTHORIZATION state

describe('AgentService — AUTHORIZATION', () => {
  // 2026-07-26 affiliate CSV lookup — "sí" no longer jumps straight to DISCOVERY. It now
  // asks a one-shot affiliate-ID question first (see the "affiliate ID lookup" describe
  // block below for that second step), staying in AUTHORIZATION meanwhile.
  it('"sí" stays in AUTHORIZATION and asks for the affiliate ID next, with autorizado:true', async () => {
    const { service, telegram, conversations } = buildService({ state: ConversationState.AUTHORIZATION });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.AUTHORIZATION,
      expect.objectContaining({ autorizado: true, awaitingAffiliateId: true, discoveryFilter: true }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('Ingresa tu ID');
    // 2026-07-26 feedback: the text/audio reassurance already appeared in GREETING
    // (message 1) — repeating it here, two turns later, would be redundant.
    expect(sentText).not.toMatch(/texto o audio/i);
  });

  // Real live-test feedback (2026-07-26): a RETURNING affiliate — serieId already known
  // from a successful lookup in an earlier conversation, surviving a restart via
  // persistent memory — got asked "Ingresa tu ID..." all over again instead of skipping
  // straight to DISCOVERY with an honest acknowledgment.
  it('regression — "sí" skips the affiliate-ID question and goes straight to DISCOVERY when serieId is already known', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.AUTHORIZATION,
      context: { serieId: '42', rangoSalarial: 'Entre 4 y 6 SMLV' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    // Reaches DISCOVERY with F01 choices attached, so this dispatches via sendChoices,
    // not sendText (same convention as the affiliate-lookup "found" path).
    const sentText = telegram.sendChoices.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('Ingresa tu ID');
    expect(sentText).toContain('Ya te habías afiliado a Colsubsidio');
    expect(sentText).toContain('Tienes familia');
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.awaitingAffiliateId).toBeUndefined();
    expect(savedContext.autorizado).toBe(true);
    expect(savedContext.discoveryFilter).toBe(true);
    const savedState = conversations.saveState.mock.calls[0]?.[1] as ConversationState;
    expect(savedState).toBe(ConversationState.DISCOVERY);
  });

  it('a genuinely fresh user (no serieId known yet) still asks for the affiliate ID — unchanged behavior', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.AUTHORIZATION,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('Ingresa tu ID');
  });

  it('"si" (without accent) also authorizes', async () => {
    const { service, telegram, conversations } = buildService({ state: ConversationState.AUTHORIZATION });
    telegram.normalize.mockResolvedValue(makeMessage('si'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.AUTHORIZATION, expect.objectContaining({ autorizado: true }),
    );
  });

  it('regression — voice "Sí." (with punctuation) authorizes correctly', async () => {
    // Bug: Whisper transcribes " Sí." → after normalize: "sí." → failed === 'sí'
    // Fix: punctuation stripped before comparison
    const { service, telegram, conversations } = buildService({ state: ConversationState.AUTHORIZATION });
    telegram.normalize.mockResolvedValue(makeMessage(' Sí.'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.AUTHORIZATION, expect.objectContaining({ autorizado: true }),
    );
  });

  it('regression — voice "Sí!" (exclamation) authorizes correctly', async () => {
    const { service, telegram, conversations } = buildService({ state: ConversationState.AUTHORIZATION });
    telegram.normalize.mockResolvedValue(makeMessage('Sí!'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.AUTHORIZATION, expect.objectContaining({ autorizado: true }),
    );
  });

  it('"no" transitions to REJECTED', async () => {
    const { service, telegram, conversations } = buildService({ state: ConversationState.AUTHORIZATION });
    telegram.normalize.mockResolvedValue(makeMessage('no'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.REJECTED, expect.objectContaining({ autorizado: false }),
    );
  });

  it('random non-sí text re-prompts instead of rejecting', async () => {
    const { service, telegram, conversations } = buildService({ state: ConversationState.AUTHORIZATION });
    telegram.normalize.mockResolvedValue(makeMessage('quizás'));
    await service.handleMessage({});
    expect(conversations.saveState).not.toHaveBeenCalled(); // stays in AUTHORIZATION
  });
});

// Affiliate ID lookup (2026-07-26)
// "sí" asks a one-shot affiliate-ID question before DISCOVERY starts — a decline, an
// unrecognized ID, or the lookup being disabled (missing CSV) all proceed to DISCOVERY
// identically, just without the rangoSalarial boost. F01 hybrid buttons move here too
// (Step 4, 2026-07-26) — the real first moment DISCOVERY actually begins.
describe('AgentService — affiliate ID lookup', () => {
  it('a decline ("no") proceeds to DISCOVERY with F01 buttons, no rangoSalarial set', async () => {
    const { service, telegram, conversations, affiliateLookup } = buildService({
      state: ConversationState.AUTHORIZATION,
      context: { autorizado: true, awaitingAffiliateId: true, discoveryFilter: true },
    });
    telegram.normalize.mockResolvedValue(makeMessage('no'));
    await service.handleMessage({});
    expect(affiliateLookup.findBySerie).not.toHaveBeenCalled();
    expect(telegram.sendChoices).toHaveBeenCalledTimes(1);
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.rangoSalarial).toBeUndefined();
    expect(savedContext.awaitingAffiliateId).toBeUndefined();
    expect(conversations.saveState).toHaveBeenCalledWith('conv-1', ConversationState.DISCOVERY, expect.anything());
  });

  it('a valid ID that matches a real record sets rangoSalarial and acknowledges finding the profile', async () => {
    const { service, telegram, conversations, affiliateLookup } = buildService({
      state: ConversationState.AUTHORIZATION,
      context: { autorizado: true, awaitingAffiliateId: true, discoveryFilter: true },
    });
    affiliateLookup.isEnabled.mockReturnValue(true);
    affiliateLookup.findBySerie.mockReturnValue({ rangoSalarial: 'Entre 4 y 6 SMLV' });
    telegram.normalize.mockResolvedValue(makeMessage('42'));
    await service.handleMessage({});
    expect(affiliateLookup.findBySerie).toHaveBeenCalledWith('42');
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.rangoSalarial).toBe('Entre 4 y 6 SMLV');
    expect(savedContext.serieId).toBe('42');
    // Reaches DISCOVERY with F01 choices attached, so this dispatches via sendChoices,
    // not sendText (see handleMessage's dispatch order).
    const sentText = telegram.sendChoices.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('¡Encontré tu perfil!');
  });

  it('a record with dependents=0 (SEGMENTO_GRUPO_FAMILIAR="AFILLIADO SIN GRUPO_FAMILIAR") merges it and pre-marks askedDependents, so DISCOVERY never re-asks', async () => {
    const { service, telegram, conversations, affiliateLookup } = buildService({
      state: ConversationState.AUTHORIZATION,
      context: { autorizado: true, awaitingAffiliateId: true, discoveryFilter: true },
    });
    affiliateLookup.isEnabled.mockReturnValue(true);
    affiliateLookup.findBySerie.mockReturnValue({ rangoSalarial: 'Entre 6 y 8 SMLV', dependents: 0, segmentoGrupoFamiliar: 'AFILLIADO SIN GRUPO_FAMILIAR' });
    telegram.normalize.mockResolvedValue(makeMessage('10'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.dependents).toBe(0);
    expect(savedContext.askedDependents).toBe(true);
    expect(savedContext.rangoSalarial).toBe('Entre 6 y 8 SMLV');
  });

  it('a record with ONLY dependents set (no rangoSalarial) is still merged, not silently dropped', async () => {
    const { service, telegram, conversations, affiliateLookup } = buildService({
      state: ConversationState.AUTHORIZATION,
      context: { autorizado: true, awaitingAffiliateId: true, discoveryFilter: true },
    });
    affiliateLookup.isEnabled.mockReturnValue(true);
    affiliateLookup.findBySerie.mockReturnValue({ dependents: 0, segmentoGrupoFamiliar: 'AFILLIADO SIN GRUPO_FAMILIAR' });
    telegram.normalize.mockResolvedValue(makeMessage('10'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.dependents).toBe(0);
    expect(savedContext.askedDependents).toBe(true);
    expect(savedContext.rangoSalarial).toBeUndefined();
  });

  // 2026-07-26 feature request: "capture the complete row... so the agent will know all
  // about the registered user" — the FULL record persists as affiliateProfile, and a
  // known petCount pre-fills context.petCount (same precedent as dependents above).
  it('captures the FULL affiliate record as affiliateProfile and pre-fills petCount from it', async () => {
    const { service, telegram, conversations, affiliateLookup } = buildService({
      state: ConversationState.AUTHORIZATION,
      context: { autorizado: true, awaitingAffiliateId: true, discoveryFilter: true },
    });
    const fullRecord = {
      rangoSalarial: 'Entre 1 y 1.5 SMLV', genero: 'F', rangoEdad: '20 a 35 años', categoria: 'A',
      ciudadAfiliado: 'LA MESA', productoIdPrevio: 'medicina-prepagada-gatos',
      primaMensualPrevia: 81800, petCount: 1,
    };
    affiliateLookup.isEnabled.mockReturnValue(true);
    affiliateLookup.findBySerie.mockReturnValue(fullRecord);
    telegram.normalize.mockResolvedValue(makeMessage('1103'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.affiliateProfile).toEqual(fullRecord);
    expect(savedContext.petCount).toBe(1);
  });

  it('a record found with fields OTHER than rangoSalarial/dependents/petCount is still enriched, not dropped', async () => {
    const { service, telegram, conversations, affiliateLookup } = buildService({
      state: ConversationState.AUTHORIZATION,
      context: { autorizado: true, awaitingAffiliateId: true, discoveryFilter: true },
    });
    affiliateLookup.isEnabled.mockReturnValue(true);
    affiliateLookup.findBySerie.mockReturnValue({ genero: 'M', ciudadAfiliado: 'BOGOTA D.C.' });
    telegram.normalize.mockResolvedValue(makeMessage('7'));
    await service.handleMessage({});
    // Reaches DISCOVERY with F01 choices attached, so this dispatches via sendChoices,
    // not sendText (same convention as the sibling "valid ID" test above).
    const sentText = telegram.sendChoices.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('¡Encontré tu perfil!');
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.affiliateProfile).toEqual({ genero: 'M', ciudadAfiliado: 'BOGOTA D.C.' });
  });

  it('does NOT overwrite an already-known petCount with a stale looked-up value', async () => {
    const { service, telegram, conversations, affiliateLookup } = buildService({
      state: ConversationState.AUTHORIZATION,
      context: { autorizado: true, awaitingAffiliateId: true, discoveryFilter: true, petCount: 3 },
    });
    affiliateLookup.isEnabled.mockReturnValue(true);
    affiliateLookup.findBySerie.mockReturnValue({ petCount: 1 });
    telegram.normalize.mockResolvedValue(makeMessage('1103'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.petCount).toBe(3);
  });

  it('a looked-up dependents=0 causes DISCOVERY to skip the dependents question on the very next turn', async () => {
    const { service, telegram, affiliateLookup } = buildService({
      state: ConversationState.AUTHORIZATION,
      context: { autorizado: true, awaitingAffiliateId: true, discoveryFilter: true },
    });
    affiliateLookup.isEnabled.mockReturnValue(true);
    affiliateLookup.findBySerie.mockReturnValue({ rangoSalarial: 'Entre 6 y 8 SMLV', dependents: 0 });
    telegram.normalize.mockResolvedValue(makeMessage('10'));
    await service.handleMessage({});

    // Next turn: user states a category-bearing need. The dependents question must
    // NOT reappear, since it was already answered (via lookup) for this conversation.
    const { service: service2, telegram: telegram2 } = buildService({
      state: ConversationState.DISCOVERY,
      context: {
        autorizado: true,
        discoveryFilter: true,
        rangoSalarial: 'Entre 6 y 8 SMLV',
        dependents: 0,
        askedDependents: true,
      },
      intent: makeIntent({ productCategory: 'vida' }),
    });
    telegram2.normalize.mockResolvedValue(makeMessage('quiero un seguro de vida'));
    await service2.handleMessage({});
    const sentText = (telegram2.sendText.mock.calls[0]?.[1] ?? telegram2.sendChoices.mock.calls[0]?.[1]) as string;
    expect(sentText).not.toContain('¿Cuántas personas dependen de ti económicamente?');
  });

  it('an ID with no matching record proceeds to DISCOVERY normally, without a crash or a false "found" message', async () => {
    const { service, telegram, conversations, affiliateLookup } = buildService({
      state: ConversationState.AUTHORIZATION,
      context: { autorizado: true, awaitingAffiliateId: true, discoveryFilter: true },
    });
    affiliateLookup.isEnabled.mockReturnValue(true);
    affiliateLookup.findBySerie.mockReturnValue(null);
    // 300000 is well within the real CSV's 1..500000 SERIE range but has no fixture match.
    telegram.normalize.mockResolvedValue(makeMessage('300000'));
    await service.handleMessage({});
    const sentText = telegram.sendChoices.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('¡Encontré tu perfil!');
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.rangoSalarial).toBeUndefined();
    expect(conversations.saveState).toHaveBeenCalledWith('conv-1', ConversationState.DISCOVERY, expect.anything());
  });

  it('a spoken ID dictated digit-by-digit ("1, 2, 3, 4, 5, 6.") is joined before lookup, same convention as cédula', async () => {
    const { service, telegram, affiliateLookup } = buildService({
      state: ConversationState.AUTHORIZATION,
      context: { autorizado: true, awaitingAffiliateId: true, discoveryFilter: true },
    });
    affiliateLookup.isEnabled.mockReturnValue(true);
    affiliateLookup.findBySerie.mockReturnValue(null);
    // Digits joined to "123456" — within the 1..500000 SERIE range (unlike the full
    // 9-digit dictation this test used before the range check existed).
    telegram.normalize.mockResolvedValue(makeMessage('1, 2, 3, 4, 5, 6.'));
    await service.handleMessage({});
    expect(affiliateLookup.findBySerie).toHaveBeenCalledWith('123456');
  });

  it('does not even attempt a lookup when the service is disabled (no CSV configured) — degrades to DISCOVERY silently', async () => {
    const { service, telegram, affiliateLookup } = buildService({
      state: ConversationState.AUTHORIZATION,
      context: { autorizado: true, awaitingAffiliateId: true, discoveryFilter: true },
    });
    // affiliateLookup.isEnabled defaults to false in the test helper
    telegram.normalize.mockResolvedValue(makeMessage('42'));
    await service.handleMessage({});
    expect(affiliateLookup.findBySerie).not.toHaveBeenCalled();
    expect(telegram.sendChoices).toHaveBeenCalledTimes(1);
  });

  it('a truly empty reply (no digits, not a decline) proceeds to DISCOVERY anyway — never loops forever on silence', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.AUTHORIZATION,
      context: { autorizado: true, awaitingAffiliateId: true, discoveryFilter: true },
    });
    // A literally empty msg.text bails out of handleMessage entirely before reaching
    // this gate (see the `!msg.text && !msg.contact && !msg.photo` guard) — so to
    // actually exercise the `!rawText.trim()` branch of `declines`, the message needs to
    // be non-empty but reduce to nothing once punctuation is stripped (same trim/strip
    // agent.service.ts applies to every incoming message before routing it).
    telegram.normalize.mockResolvedValue(makeMessage('...'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DISCOVERY, expect.anything(),
    );
  });

  // Real live-test bug (2026-07-26, screenshot): a non-numeric, non-"no" answer
  // ("Juan" — voice misheard the ID question, or a genuine misunderstanding) used to be
  // silently treated as an implicit decline, advancing to DISCOVERY without ever
  // telling the user their answer didn't make sense. Only digits or an explicit "no"
  // may pass this gate now.
  it('regression — a non-numeric, non-"no" reply ("Juan") is rejected and re-asked, never silently let through', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.AUTHORIZATION,
      context: { autorizado: true, awaitingAffiliateId: true, discoveryFilter: true },
    });
    telegram.normalize.mockResolvedValue(makeMessage('Juan'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/número entre 1 y 500/);
    // Nothing persisted — the conversation stays exactly where it was, so this same
    // gate re-fires on the user's next message (never silently lets them continue).
    expect(conversations.saveState).not.toHaveBeenCalled();
  });

  it('the same gate re-fires correctly on the very next message after a rejected non-numeric reply', async () => {
    // Simulates the real live-test sequence: "Juan" (rejected) then a real ID.
    const { service, telegram, affiliateLookup } = buildService({
      state: ConversationState.AUTHORIZATION,
      context: { autorizado: true, awaitingAffiliateId: true, discoveryFilter: true },
    });
    affiliateLookup.isEnabled.mockReturnValue(true);
    affiliateLookup.findBySerie.mockReturnValue(null);
    telegram.normalize.mockResolvedValue(makeMessage('42'));
    await service.handleMessage({});
    expect(affiliateLookup.findBySerie).toHaveBeenCalledWith('42');
    const sentText = telegram.sendChoices.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('número entre 1 y 500');
  });

  // 2026-07-26 clarification: SERIE is a row number into the real affiliate CSV
  // (1..500000, matching its ~500K rows) — a value outside that range can never match a
  // real row, so it's rejected the same way a non-numeric reply is, instead of wasting a
  // lookup call on a value that's guaranteed to miss.
  describe('regression — SERIE out of the real CSV\'s 1..500000 range is rejected, never looked up', () => {
    it.each(['0', '500001', '999999999'])('rejects "%s" and re-asks without calling findBySerie', async (badSerie) => {
      const { service, telegram, conversations, affiliateLookup } = buildService({
        state: ConversationState.AUTHORIZATION,
        context: { autorizado: true, awaitingAffiliateId: true, discoveryFilter: true },
      });
      affiliateLookup.isEnabled.mockReturnValue(true);
      telegram.normalize.mockResolvedValue(makeMessage(badSerie));
      await service.handleMessage({});
      expect(affiliateLookup.findBySerie).not.toHaveBeenCalled();
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      expect(sentText.toLowerCase()).toMatch(/número entre 1 y 500/);
      expect(conversations.saveState).not.toHaveBeenCalled();
    });

    it.each(['1', '500000', '42'])('accepts "%s" as within range and proceeds to lookup', async (goodSerie) => {
      const { service, telegram, affiliateLookup } = buildService({
        state: ConversationState.AUTHORIZATION,
        context: { autorizado: true, awaitingAffiliateId: true, discoveryFilter: true },
      });
      affiliateLookup.isEnabled.mockReturnValue(true);
      affiliateLookup.findBySerie.mockReturnValue(null);
      telegram.normalize.mockResolvedValue(makeMessage(goodSerie));
      await service.handleMessage({});
      expect(affiliateLookup.findBySerie).toHaveBeenCalledWith(goodSerie);
      const sentText = telegram.sendChoices.mock.calls[0]?.[1] as string;
      expect(sentText).not.toContain('número entre 1 y 500');
    });
  });

  // 2026-07-26 Step 4 — F01 hybrid-filter buttons presented once the affiliate-ID step
  // resolves. A tap is a shortcut over the NLP path, never a replacement — free
  // text/voice stay fully valid (rule #10).
  it('presents the F01 hybrid buttons via sendChoices once the ID step resolves', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.AUTHORIZATION,
      context: { autorizado: true, awaitingAffiliateId: true, discoveryFilter: true },
    });
    telegram.normalize.mockResolvedValue(makeMessage('no'));
    await service.handleMessage({});
    expect(telegram.sendChoices).toHaveBeenCalledTimes(1);
    const [userId, text, choices] = telegram.sendChoices.mock.calls[0];
    expect(userId).toBe('u1');
    expect(typeof text).toBe('string');
    expect(choices.length).toBeGreaterThan(0);
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.discoveryFilter).toBe(true);
  });
});

// Real live-test bug (2026-07-26, screenshot): tapping "❤️ Mi familia" returned an
// "asistencia" category product ("Asistencias médicas familiares") as the FIRST quote
// instead of a vida product. Exhaustive testing against the real QuotingService found no
// realistic signal combination where a related category outscores an exact match (see
// quoting.service.spec.ts), so this isn't a scoring bug — the more likely cause is Groq
// itself confidently misclassifying a short emoji-prefixed button label, which the
// existing null-only guardrail (Sesión 72) never corrects. A button tap is an exact,
// known string with zero ambiguity — F01_CATEGORY_MAP now forces the category
// deterministically, overriding both a stale already-set productCategory AND whatever
// the NLP layer returned for this exact turn.
describe('AgentService — F01 button taps deterministically force productCategory (2026-07-26)', () => {
  it('regression — "❤️ Mi familia" overrides an already-set, stale productCategory from an earlier turn', async () => {
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      // Stale from an earlier, ambiguous turn — must NOT survive the button tap.
      context: { productCategory: 'asistencia', coverage: ['familia'] },
      intent: makeIntent({ productCategory: 'asistencia' }), // simulates Groq also getting it wrong
    });
    const vidaProduct = PRODUCTS.find((p) => p.category === 'vida')!;
    quoting.bestQuote.mockReturnValue({
      product: vidaProduct,
      score: { reasons: [], matchScore: 40, monthlyPremium: vidaProduct.basePremium, priority: 'medium', productId: vidaProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('❤️ Mi familia'));
    await service.handleMessage({});
    expect(quoting.bestQuote).toHaveBeenCalledWith(expect.objectContaining({ productCategory: 'vida' }));
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.productCategory).toBe('vida');
  });

  it.each([
    ['❤️ Mi familia', 'vida'],
    ['🏥 Mi salud', 'asistencia'],
    ['🐾 Mi mascota', 'mascotas'],
    ['🤕 Accidentes', 'accidentes'],
  ])('regression — "%s" forces productCategory "%s" even when the NLP layer returns something else entirely', async (label, expectedCategory) => {
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: null }), // simulates Groq failing to classify
    });
    // Mascotas short-circuits to the species-clarification question before ever calling
    // bestQuote — for the other 3, a real match must be mocked so the quote succeeds
    // (an unmocked/failed bestQuote() resets productCategory to undefined, which would
    // make this assertion pass for the wrong reason).
    const matchingProduct = PRODUCTS.find((p) => p.category === expectedCategory);
    if (matchingProduct) {
      quoting.bestQuote.mockReturnValue({
        product: matchingProduct,
        score: { reasons: [], matchScore: 40, monthlyPremium: matchingProduct.basePremium, priority: 'medium', productId: matchingProduct.id },
      });
    }
    telegram.normalize.mockResolvedValue(makeMessage(label));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.productCategory).toBe(expectedCategory);
  });

  it('"🤔 No estoy seguro" still never forces a category — unchanged behavior', async () => {
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { productCategory: 'vida' }, // even a stale one stays untouched by this button
      intent: makeIntent({ productCategory: null }),
    });
    const vidaProduct = PRODUCTS.find((p) => p.category === 'vida')!;
    quoting.bestQuote.mockReturnValue({
      product: vidaProduct,
      score: { reasons: [], matchScore: 40, monthlyPremium: vidaProduct.basePremium, priority: 'medium', productId: vidaProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('🤔 No estoy seguro'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.productCategory).toBe('vida'); // untouched, not cleared either
  });

  it('a normal free-text message (not an exact button label) still only fills in when productCategory was empty — unchanged behavior', async () => {
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { productCategory: 'asistencia' },
      intent: makeIntent({ productCategory: 'vida' }), // a real category mention in free text
    });
    const asistenciaProduct = PRODUCTS.find((p) => p.category === 'asistencia')!;
    quoting.bestQuote.mockReturnValue({
      product: asistenciaProduct,
      score: { reasons: [], matchScore: 40, monthlyPremium: asistenciaProduct.basePremium, priority: 'medium', productId: asistenciaProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('también quiero un seguro de vida'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.productCategory).toBe('asistencia'); // free text never overrides an in-progress category
  });
});

// KYC — phone verification via Telegram's native contact-share button
// 2026-07-24 feedback: "simple KYC to know the user is real... Telegram autocomplete as
// autoconfirmation and avoid user leave the chat" — confirmed approach is Telegram's
// native request_contact button (no SMS/Twilio provider), fired once at the very start
// of DATA_CAPTURE, before any other question.

describe('AgentService — KYC phone verification gate', () => {
  it('"sí" in QUOTE_PRESENTED requests phone verification instead of the first data-capture question when not yet verified', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: PRODUCTS[0].id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(telegram.sendContactRequest).toHaveBeenCalledTimes(1);
    expect(telegram.sendText).not.toHaveBeenCalled();
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ awaitingPhoneVerification: true }),
    );
  });

  it('skips phone verification when already verified from an earlier purchase in the same conversation', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: PRODUCTS[0].id, phoneVerified: true, verifiedPhone: '+573001234567' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(telegram.sendContactRequest).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/documento de identidad|cédula/);
  });

  it('sharing contact while awaiting verification marks phoneVerified and asks for a selfie next (not the real question yet)', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { awaitingPhoneVerification: true },
    });
    telegram.normalize.mockResolvedValue({
      ...makeMessage(''),
      contact: { phoneNumber: '+573001234567', firstName: 'Juan' },
    });
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({
        phoneVerified: true,
        verifiedPhone: '+573001234567',
        awaitingPhoneVerification: undefined,
        awaitingSelfie: true,
      }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/selfie|foto/);
    expect(sentText.toLowerCase()).not.toMatch(/documento de identidad|cédula/);
  });

  // 2026-07-24 feedback: the contact-share confirmation gets a "big" Telegram reaction
  // (a much larger animated burst) on the shared-contact message itself.
  it('reacts to the shared-contact message with a big reaction', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { awaitingPhoneVerification: true },
    });
    telegram.normalize.mockResolvedValue({
      ...makeMessage(''),
      contact: { phoneNumber: '+573001234567', firstName: 'Juan' },
      messageId: 321,
    });
    await service.handleMessage({});
    expect(telegram.reactToMessage).toHaveBeenCalledWith('u1', 321, expect.any(String), true);
  });

  // Real bug found 2026-07-24 (confirmed independently by a live test session and a
  // teammate's findings report): this used to re-show the exact same "toca el botón"
  // prompt forever for ANY typed reply that wasn't the contact-share — a genuine
  // demo-killing infinite loop ("no me interesa" / "cobertura familiar" / random text
  // all got the identical response, permanently). The button is shown once, at the
  // QUOTE_PRESENTED -> DATA_CAPTURE transition; if the very next message still isn't a
  // contact-share, this cosmetic KYC step must be skipped rather than asked again — it
  // must never be allowed to block a real sale.
  it('regression — typing instead of sharing contact skips phone verification and moves on (never loops)', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { awaitingPhoneVerification: true },
    });
    telegram.normalize.mockResolvedValue(makeMessage('no me interesa'));
    await service.handleMessage({});
    expect(telegram.sendContactRequest).not.toHaveBeenCalled();
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ awaitingPhoneVerification: undefined, phoneVerified: false }),
    );
  });
});

// KYC — cosmetic selfie step (2026-07-24, simulated identity confirmation)
// User feedback: "let user know that the camera will open, take the selfie immediately,
// simulate a KYC as cosmetic and let the user know it was successfully approved... this
// is possible with a third-party service integrated into the chat to avoid false
// identity" (a future, real integration). This step does NOT perform any real face
// matching or liveness check — any photo received counts as "confirmed".

describe('AgentService — KYC cosmetic selfie step', () => {
  // Same "never loop forever" fix as phone verification above — this is a cosmetic,
  // simulated step and must never block a real sale.
  it('regression — typing instead of sending a photo skips the selfie step and moves on (never loops)', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { phoneVerified: true, awaitingSelfie: true },
    });
    telegram.normalize.mockResolvedValue(makeMessage('no gracias'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ awaitingSelfie: undefined, selfieProvided: false }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/cédula|documento de identidad/);
  });

  it('a photo marks selfieProvided and proceeds to the real first question (cédula)', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { phoneVerified: true, awaitingSelfie: true },
    });
    telegram.normalize.mockResolvedValue({ ...makeMessage(''), photo: { width: 1080, height: 1080 } });
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ selfieProvided: true, awaitingSelfie: undefined }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/cédula|documento de identidad/);
  });

  it('mascotas purchase: a photo proceeds to the first pet question, not cédula', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { phoneVerified: true, awaitingSelfie: true, productCategory: 'mascotas', petCount: 2 },
    });
    telegram.normalize.mockResolvedValue({ ...makeMessage(''), photo: { width: 1080, height: 1080 } });
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('1 de 2');
    expect(sentText).not.toContain('dígitos');
  });

  // 2026-07-24 feedback: "is there a way to confirm that the image is a selfie, is ok if
  // is not high resolution" — no real face detection (stays a cosmetic simulation), but
  // a suspiciously tiny image (icon/sticker-shaped, not an actual camera photo) gets one
  // gentle retry ask instead of being silently accepted as "confirmed".
  describe('KYC selfie — tiny-image sanity guard (never blocks a sale)', () => {
    it('a suspiciously tiny image asks to retry once instead of accepting it as the selfie', async () => {
      const { service, telegram, conversations } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { phoneVerified: true, awaitingSelfie: true },
      });
      telegram.normalize.mockResolvedValue({ ...makeMessage(''), photo: { width: 40, height: 40 } });
      await service.handleMessage({});
      const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
      expect(savedContext.selfieProvided).toBeFalsy();
      expect(savedContext.awaitingSelfie).toBe(true);
      expect(savedContext.selfieRetryAsked).toBe(true);
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      expect(sentText.toLowerCase()).toMatch(/pequeñ/);
    });

    it('regression — a SECOND tiny image is accepted anyway (never loops forever, same as every other KYC gate)', async () => {
      const { service, telegram, conversations } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { phoneVerified: true, awaitingSelfie: true, selfieRetryAsked: true },
      });
      telegram.normalize.mockResolvedValue({ ...makeMessage(''), photo: { width: 40, height: 40 } });
      await service.handleMessage({});
      expect(conversations.saveState).toHaveBeenCalledWith(
        'conv-1', ConversationState.DATA_CAPTURE,
        expect.objectContaining({ selfieProvided: true, awaitingSelfie: undefined }),
      );
    });

    it('a normal-sized photo is accepted immediately, no retry ask', async () => {
      const { service, telegram, conversations } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { phoneVerified: true, awaitingSelfie: true },
      });
      telegram.normalize.mockResolvedValue({ ...makeMessage(''), photo: { width: 1080, height: 1080 } });
      await service.handleMessage({});
      expect(conversations.saveState).toHaveBeenCalledWith(
        'conv-1', ConversationState.DATA_CAPTURE,
        expect.objectContaining({ selfieProvided: true }),
      );
    });
  });

  // 2026-07-24 feedback: "is there a way to show an animated successfully check pass
  // inside the chat?" — sends the real branded success-checkmark video when the selfie
  // is confirmed, instead of just a text-only reaction.
  it('sends the branded success animation when the selfie is confirmed', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { phoneVerified: true, awaitingSelfie: true },
    });
    telegram.normalize.mockResolvedValue({ ...makeMessage(''), photo: { width: 1080, height: 1080 }, messageId: 555 });
    await service.handleMessage({});
    expect(telegram.sendAnimation).toHaveBeenCalledWith('u1', expect.stringContaining('identity-confirmed.mp4'));
  });

  it('does not re-trigger once selfieProvided is already true', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { phoneVerified: true, selfieProvided: true },
    });
    telegram.normalize.mockResolvedValue(makeMessage('123456789'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).not.toMatch(/selfie/);
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ cedula: '123456789' }),
    );
  });
});

// DATA_CAPTURE flow

describe('AgentService — DATA_CAPTURE sequential flow', () => {
  it('invalid cédula (letters) shows error and stays in DATA_CAPTURE', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage('abc'));
    await service.handleMessage({});
    expect(conversations.saveState).not.toHaveBeenCalledWith(
      expect.anything(), ConversationState.PAYMENT, expect.anything(),
    );
    const textArg = telegram.sendText.mock.calls[0][1] as string;
    expect(textArg).toContain('dígitos');
  });

  it('invalid cédula (too short) shows error', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage('123'));
    await service.handleMessage({});
    const textArg = telegram.sendText.mock.calls[0][1] as string;
    expect(textArg).toContain('dígitos');
  });

  it('valid cédula (8 digits) saves cedula to context', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage('12345678'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ cedula: '12345678' }),
    );
  });

  it('regression — a bare number defaults documentType to CC (backward compatible)', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage('12345678'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ cedula: '12345678', documentType: 'CC' }),
    );
  });

  it('detects "CE" (cédula de extranjería) from the message', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage('CE 123456789'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ cedula: '123456789', documentType: 'CE' }),
    );
  });

  it('detects "tarjeta de identidad" (TI) from the message', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage('mi tarjeta de identidad es 1002345678'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ cedula: '1002345678', documentType: 'TI' }),
    );
  });

  it('detects "cédula de extranjería" (spelled out) as CE', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage('mi cédula de extranjería es 987654321'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ cedula: '987654321', documentType: 'CE' }),
    );
  });

  it('detects "NUIP" from the message', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage('NUIP 1122334455'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ cedula: '1122334455', documentType: 'NUIP' }),
    );
  });

  it('regression — context.cedula persists when capturing nombre', async () => {
    // Bug: returning {text, context: newContext} without cedula dropped it
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('Juan Pérez'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ cedula: '12345678', nombre: 'Juan Pérez' }),
    );
  });

  it('regression — context persists when capturing email', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('juan@email.com'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@email.com' }),
    );
  });

  it('regression — a filler/acknowledgment word is never captured as the nombre', async () => {
    // Real live-test bug: after providing cédula, the user's next voice message was an
    // acknowledgment ("Gracias.") to the bot's own prior response, transcribed and
    // captured verbatim as the customer's full name — corrupting the rest of the flow
    // (the actual name then got captured as the "email" in the following turn).
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('Gracias.'));
    await service.handleMessage({});
    expect(conversations.saveState).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.objectContaining({ nombre: expect.anything() }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/nombre/i);
  });

  // Real bug: a saved conversation context showed "nombre": "2+2" accepted as a valid
  // full name — no field ever rejected digits or symbols. A name must contain only
  // letters (incl. Spanish accents/ñ), spaces, apostrophes and hyphens.
  describe('regression — nombre rejects digits and special characters', () => {
    const invalidNames = ['2+2', '12345', 'Juan123', '!!!', 'Juan@Perez', '<script>', '****', '   ', '.', 'a'];

    it.each(invalidNames)('rejects %j as a nombre and re-asks without saving it', async (badName) => {
      const { service, telegram, conversations } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { cedula: '12345678' },
      });
      telegram.normalize.mockResolvedValue(makeMessage(badName));
      await service.handleMessage({});
      expect(conversations.saveState).not.toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.objectContaining({ nombre: expect.anything() }),
      );
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      expect(sentText).toMatch(/nombre/i);
    });

    const validNames = ['Juan Pérez', 'María José Gómez-Ruiz', "D'Angelo Niño", 'Ana', 'José Ñuñez'];

    it.each(validNames)('accepts %j as a valid nombre', async (goodName) => {
      const { service, telegram, conversations } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { cedula: '12345678' },
      });
      telegram.normalize.mockResolvedValue(makeMessage(goodName));
      await service.handleMessage({});
      expect(conversations.saveState).toHaveBeenCalledWith(
        'conv-1', ConversationState.DATA_CAPTURE,
        expect.objectContaining({ nombre: goodName }),
      );
    });
  });

  // Real bug confirmed live in the production Supabase policies table: a policy's
  // nombre column literally contained "Mi nombre es Michelle Gómez Gómez" — NAME_REGEX
  // allows it (it's all letters/spaces, no digits/symbols) so it passed validation and
  // was stored verbatim, preamble included. A user answering "¿Cuál es tu nombre
  // completo?" naturally often restates the question as a lead-in.
  describe('regression — a self-introduction preamble is stripped before the nombre is stored', () => {
    const cases: [string, string][] = [
      ['Mi nombre es Michelle Gómez Gómez', 'Michelle Gómez Gómez'],
      ['mi nombre completo es Juan Pérez', 'Juan Pérez'],
      ['Me llamo Ana María', 'Ana María'],
      ['Yo soy José Ñuñez', 'José Ñuñez'],
      ['Soy Juan Pérez', 'Juan Pérez'],
      ['Juan Pérez', 'Juan Pérez'], // no preamble at all — must pass through unchanged
    ];

    it.each(cases)('stores %j as %j', async (spoken, expectedNombre) => {
      const { service, telegram, conversations } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { cedula: '12345678' },
      });
      telegram.normalize.mockResolvedValue(makeMessage(spoken));
      await service.handleMessage({});
      expect(conversations.saveState).toHaveBeenCalledWith(
        'conv-1', ConversationState.DATA_CAPTURE,
        expect.objectContaining({ nombre: expectedNombre }),
      );
    });

    it('a preamble alone with no actual name left still rejects, it does not save an empty nombre', async () => {
      const { service, telegram, conversations } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { cedula: '12345678' },
      });
      telegram.normalize.mockResolvedValue(makeMessage('Me llamo'));
      await service.handleMessage({});
      expect(conversations.saveState).not.toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.objectContaining({ nombre: expect.anything() }),
      );
    });
  });

  it('regression — text without a valid email format is never captured as the email', async () => {
    // Real live-test bug: once nombre was wrongly set to "Gracias." (see above), the
    // NEXT message ("Juan Pérez.") got captured as the email with zero format
    // validation — no '@', no domain, nothing. The user's later attempts to fix "just
    // the email" then had no effect because the underlying corruption was in nombre.
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('Juan Pérez.'));
    await service.handleMessage({});
    expect(conversations.saveState).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.objectContaining({ email: expect.anything() }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/correo|email/i);
  });

  it('accepts a well-formed email at step 3', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('juan.perez@email.com'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ email: 'juan.perez@email.com' }),
    );
  });

  // Real live-test bug: a voice message dictating an email says "arroba" for @ and
  // "punto" for . (standard Spanish spoken-email convention) — the literal transcription
  // has neither symbol, so it failed the /\S+@\S+\.\S+/ shape check entirely.
  describe('regression — spoken email dictation ("arroba"/"punto") is normalized before validating', () => {
    it.each([
      ['Juan arroba gmail punto com', 'Juan@gmail.com'],
      ['juan arroba gmail punto com.', 'juan@gmail.com'],
      ['juan punto perez arroba gmail punto com', 'juan.perez@gmail.com'],
      // Live-test report: Whisper sometimes transcribes a well-known domain's ".com"
      // literally instead of spelling out "punto com" — "arroba" alone must still be
      // enough to normalize into a valid, storable email.
      ['Juan arroba gmail.com', 'Juan@gmail.com'],
    ])('"%s" is normalized to a valid email and stored as "%s"', async (spoken, expected) => {
      const { service, telegram, conversations } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { cedula: '12345678', nombre: 'Juan Pérez' },
      });
      telegram.normalize.mockResolvedValue(makeMessage(spoken));
      await service.handleMessage({});
      expect(conversations.saveState).toHaveBeenCalledWith(
        'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ email: expected }),
      );
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      expect(sentText).not.toMatch(/correo electrónico\?/i);
    });
  });

  // Real live-test bug (2026-07-26): "juan.gmail.com" dictated by voice (the user never
  // said "arroba" at all) failed the shape check 3 times in a row with the exact same
  // re-ask, no hint as to why. normalizeSpokenEmail can't invent an @ that was never
  // said — but the retry prompt can at least tell the user to say it next time.
  describe('email dictation with no "arroba" at all gets a helpful hint', () => {
    it('adds the "di arroba" hint when the text has no @ at all, even after normalization', async () => {
      const { service, telegram } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { cedula: '12345678', nombre: 'Juan Pérez' },
      });
      telegram.normalize.mockResolvedValue(makeMessage('juan.gmail.com'));
      await service.handleMessage({});
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      expect(sentText).toContain('¿Cuál es tu correo electrónico?');
      expect(sentText.toLowerCase()).toContain('arroba');
    });

    it('does NOT add the hint for a malformed-but-attempted email that already has an @', async () => {
      const { service, telegram } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { cedula: '12345678', nombre: 'Juan Pérez' },
      });
      telegram.normalize.mockResolvedValue(makeMessage('juan@gmailcom'));
      await service.handleMessage({});
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      expect(sentText).toContain('¿Cuál es tu correo electrónico?');
      expect(sentText.toLowerCase()).not.toContain('recuerda decir');
    });
  });

  it('regression — "falta el correo" at confirmation is recognized as a correction request naming email', async () => {
    // Real live-test bug: "falta el correo" / "correo falta" did not match any keyword
    // in the correction-trigger list (corregir/cambiar/editar/está mal/equivocad) and
    // the message fell through to a generic "no logré entender" acknowledgment instead
    // of resetting the email field.
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'wrong@test.com' },
      intent: makeIntent({ isNegative: false, isAffirmative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('falta el correo'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ cedula: '12345678', nombre: 'Juan Pérez', email: undefined }),
    );
  });

  it('regression — bare "no" at confirmation asks WHICH field is wrong instead of resetting everything', async () => {
    // Real live-test bug: bare "no" immediately wiped cédula+nombre+email and forced a
    // full restart. The user's very next message (a filler word, not a cédula) then got
    // misread as a cédula attempt and failed validation. Ask first, reset only on answer.
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan', email: 'j@test.com' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('no'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ cedula: '12345678', nombre: 'Juan', email: 'j@test.com', awaitingCorrectionField: true }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/cédula|nombre|correo/i);
  });

  it('answering "nombre" after the which-field question resets only nombre', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan', email: 'j@test.com', awaitingCorrectionField: true },
    });
    telegram.normalize.mockResolvedValue(makeMessage('el nombre'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ cedula: '12345678', nombre: undefined, email: 'j@test.com', awaitingCorrectionField: undefined }),
    );
  });

  it('answering "correo" after the which-field question resets only email', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan', email: 'j@test.com', awaitingCorrectionField: true },
    });
    telegram.normalize.mockResolvedValue(makeMessage('el correo'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ cedula: '12345678', nombre: 'Juan', email: undefined, awaitingCorrectionField: undefined }),
    );
  });

  it('re-asks when the which-field answer does not name a recognizable field', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan', email: 'j@test.com', awaitingCorrectionField: true },
    });
    telegram.normalize.mockResolvedValue(makeMessage('mmh no sé'));
    await service.handleMessage({});
    expect(conversations.saveState).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.objectContaining({ cedula: undefined }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/cédula|nombre|correo/i);
  });

  it('regression — correcting just the name only resets nombre, not cedula/email too', async () => {
    // Real live-test bug: "Corrigé mi nombre, es Juan Pérez" forced the user to redo
    // cédula AND correo just to fix a one-word name typo — a needlessly clunky UX.
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pere', email: 'juan@test.com' },
      intent: makeIntent({ isNegative: false, isAffirmative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Corrigé mi nombre, es Juan Pérez'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ cedula: '12345678', nombre: undefined, email: 'juan@test.com' }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('nombre completo');
  });

  it('correcting just the email only resets email', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'wrong@test.com' },
      intent: makeIntent({ isNegative: false, isAffirmative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('cambia mi correo, está mal'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ cedula: '12345678', nombre: 'Juan Pérez', email: undefined }),
    );
  });

  it('regression — a genuinely unclear message at confirmation gets an acknowledgment, not a silent repeat', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com' },
      intent: makeIntent({ isNegative: false, isAffirmative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('mmh no sé qué decir'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/no logré entender|no entendí/i);
  });

  it('regression — "sí" at confirmation never attaches a PDF (only the post-payment webhook may)', async () => {
    // Real bug: the user received a "policy PDF" the moment they confirmed DATA_CAPTURE,
    // before ever paying. The only PDF now comes from wompi-webhook.controller.ts.
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com' },
      intent: makeIntent({ isAffirmative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(telegram.sendDocument).not.toHaveBeenCalled();
  });

  it('regression — "sí" at confirmation asks the payment method (no separate "listo?" confirmation) instead of generating the link right away', async () => {
    // User feedback: "¿Listo para generar tu link de pago?" was an unnecessary second
    // confirmation. The payment-method question below is a deliberate, newly-requested
    // addition (a genuine choice, not redundant friction) — it must not resurrect the
    // old "listo?" wording, and it must not call Wompi until the method is chosen.
    const { service, telegram, wompi, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com', quoteProductId: PRODUCTS[0].id },
      intent: makeIntent({ isAffirmative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(wompi.createPaymentLink).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/tarjeta colsubsidio/);
    expect(sentText).not.toContain('¿Listo para generar');
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.objectContaining({ awaitingPaymentMethodChoice: true }),
    );
  });

  it('regression — aborts instead of charging a hardcoded fallback amount when no product resolves', async () => {
    // Real gap found in a hardcoded-values audit: createPaymentLinkFlow used to fall
    // back to a flat, arbitrary $20.000 COP charge via Wompi whenever no product could
    // be resolved (e.g. a stale/invalid quoteProductId survived into DATA_CAPTURE with
    // no matching catalog entry) — a customer could be charged an amount unrelated to
    // anything they were ever quoted. Must abort — no policy is issued in this state
    // either, so there is nothing legitimate to charge for.
    const { service, telegram, wompi, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com' }, // no quoteProductId at all
      intent: makeIntent({ isAffirmative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(wompi.createPaymentLink).not.toHaveBeenCalled();
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DISCOVERY, expect.anything(),
    );
  });

  it('persists checkoutUrl and wompi_link_id in the same turn as answering the payment method question', async () => {
    const { service, telegram, conversations, policy } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com', policyId: 'pol-1',
        quoteProductId: PRODUCTS[0].id, awaitingPaymentMethodChoice: true,
      },
      intent: makeIntent({}),
    });
    telegram.normalize.mockResolvedValue(makeMessage('el link de pago'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.PAYMENT, expect.objectContaining({ checkoutUrl: 'https://checkout.wompi.co/l/test' }),
    );
    expect(policy.updateStatus).toHaveBeenCalledWith('pol-1', 'pending_payment', expect.objectContaining({ wompi_link_id: 'link-test' }));
  });
});

// Conditional underwriting (2026-07-24 business feedback)
// "Seguro de vida" and both "Medicina prepagada" (gatos/perros) products need age,
// pre-existing illnesses, and clinical history before they can be sold — everything
// else in the catalog is direct-sell (cédula/nombre/correo only).

describe('AgentService — conditional underwriting gate', () => {
  it('regression — a product requiring underwriting asks for medical info instead of jumping to the final confirmation', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez', quoteProductId: 'vida' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('juan@email.com'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/edad|enfermedad|historial/i);
    expect(sentText).not.toMatch(/¿todo listo|confirmar|sí.*continuar/i);
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ email: 'juan@email.com', awaitingMedicalInfo: true }),
    );
  });

  // 2026-07-24 clarification: the generic "edad, enfermedad, historial clínico" question
  // is only fully correct for a HUMAN product (vida) — a human's age is never captured
  // anywhere else in the flow. For a PET product (medicina-prepagada-gatos/perros), the
  // pet's age is ALWAYS already captured by the Step-0 per-pet loop (name/edad/raza)
  // before this gate is ever reached, so re-asking it is redundant; there's also no
  // "historial clínico" question for a pet, only whether it has a preexisting illness —
  // and the question must name the actual pet(s) by name, not speak generically.
  it('regression — a pet product asks only about illness, names the pet, and never re-asks age', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', quoteProductId: 'medicina-prepagada-gatos',
        productCategory: 'mascotas', petCount: 1,
        pets: [{ name: 'Michi', age: '3 años', breed: 'Criollo' }],
      },
    });
    telegram.normalize.mockResolvedValue(makeMessage('juan@email.com'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/enfermedad/i);
    expect(sentText).not.toMatch(/\bedad\b/i);
    expect(sentText).not.toMatch(/historial/i);
    expect(sentText).toContain('Michi');
  });

  it('regression — a multi-pet purchase names every pet in the underwriting question', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', quoteProductId: 'medicina-prepagada-gatos',
        productCategory: 'mascotas', petCount: 2,
        pets: [
          { name: 'Michi', age: '3 años', breed: 'Criollo' },
          { name: 'Luna', age: '2 años', breed: 'Siamés' },
        ],
      },
    });
    telegram.normalize.mockResolvedValue(makeMessage('juan@email.com'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('Michi');
    expect(sentText).toContain('Luna');
  });

  it('a human product (vida) keeps the full edad/enfermedad/historial question', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez', quoteProductId: 'vida' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('juan@email.com'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/edad/i);
    expect(sentText).toMatch(/enfermedad/i);
    expect(sentText).toMatch(/historial/i);
  });

  it('a product that does NOT require underwriting skips medical questions and goes straight to confirmation', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Juan Pérez', quoteProductId: 'exequial' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('juan@email.com'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toMatch(/edad|enfermedad|historial/i);
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.email).toBe('juan@email.com');
    expect(savedContext.awaitingMedicalInfo).toBeFalsy();
  });

  it('regression — after the medical-info question, any reply is accepted (never loops) and the flow proceeds to the final confirmation', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@email.com',
        quoteProductId: 'vida', awaitingMedicalInfo: true,
      },
    });
    telegram.normalize.mockResolvedValue(makeMessage('35 años, sin enfermedades preexistentes'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({
        medicalInfo: '35 años, sin enfermedades preexistentes',
        medicalInfoProvided: true,
        awaitingMedicalInfo: undefined,
      }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/sí/i); // final confirmation summary, ready for payment
  });

  it('regression — a bare "no" while awaiting medical info is stored as the answer, not misread as abandon/correction', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@email.com',
        quoteProductId: 'vida', awaitingMedicalInfo: true,
      },
      intent: makeIntent({ isNegative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('no'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ medicalInfo: 'no', medicalInfoProvided: true }),
    );
  });
});

// Payment method choice (2026-07-24 feedback)
// "at the end let user choose if they want to pay with Tarjeta Colsubsidio or Link de
// pago" — both route to the exact same real Wompi checkout link (no new payment rail,
// nothing faked): Wompi already accepts card payments, so this is a wording/framing
// choice, not a second payment integration. Deliberately does NOT claim the payment
// already succeeded before it actually has — that would be dishonest to the user.

describe('AgentService — payment method choice (Tarjeta Colsubsidio vs Link de pago)', () => {
  // Real bug found 2026-07-24, same root cause as the KYC infinite-loop fixes above:
  // this used to re-ask the same question forever for any unclear answer. Defaults to
  // the plain link de pago (the always-available, no-ambiguity option) instead of
  // looping — this must never be allowed to strand a purchase that's otherwise ready.
  it('regression — defaults to link de pago and proceeds when the answer names neither option (never loops)', async () => {
    const { service, telegram, wompi, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com',
        quoteProductId: PRODUCTS[0].id, awaitingPaymentMethodChoice: true,
      },
      intent: makeIntent({}),
    });
    telegram.normalize.mockResolvedValue(makeMessage('mmh no sé'));
    await service.handleMessage({});
    expect(wompi.createPaymentLink).toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('checkout.wompi.co');
  });

  it('"link de pago" generates the same real Wompi link as always', async () => {
    const { service, telegram, wompi } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com',
        quoteProductId: PRODUCTS[0].id, awaitingPaymentMethodChoice: true,
      },
      intent: makeIntent({}),
    });
    telegram.normalize.mockResolvedValue(makeMessage('link de pago'));
    await service.handleMessage({});
    expect(wompi.createPaymentLink).toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('checkout.wompi.co');
    expect(sentText.toLowerCase()).not.toMatch(/coincidencia|emparejamos/);
  });

  // Real live-test bug: nothing told the user the chat stays open/available while a real
  // Wompi payment link is still pending — ties to the 34-minute PAYMENT_CLOSE_DELAY_MS
  // fix (reminder.service.ts) so the user isn't surprised the conversation didn't close.
  it('reassures the user the conversation stays available while a payment link is pending', async () => {
    const { service, telegram, wompi } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com',
        quoteProductId: PRODUCTS[0].id, awaitingPaymentMethodChoice: true,
      },
      intent: makeIntent({}),
    });
    telegram.normalize.mockResolvedValue(makeMessage('link de pago'));
    await service.handleMessage({});
    expect(wompi.createPaymentLink).toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/se mantiene disponible|sigue disponible|puedes cerrar/);
  });

  it('the "link still active" re-show also reassures the chat stays available', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.PAYMENT,
      context: { checkoutUrl: 'https://checkout.wompi.co/l/test123', quoteProductId: PRODUCTS[0].id },
      intent: makeIntent({ isNegative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿ya casi?'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/se mantiene disponible|sigue disponible/);
  });

  it('"Tarjeta Colsubsidio" generates the exact same real Wompi link, with themed copy, not a faked instant success', async () => {
    const { service, telegram, wompi } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com',
        quoteProductId: PRODUCTS[0].id, awaitingPaymentMethodChoice: true,
      },
      intent: makeIntent({}),
    });
    telegram.normalize.mockResolvedValue(makeMessage('tarjeta colsubsidio'));
    await service.handleMessage({});
    expect(wompi.createPaymentLink).toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    // Same real link as the other path — nothing about the payment is faked
    expect(sentText).toContain('checkout.wompi.co');
    // Themed copy acknowledges the card choice, but must not claim the payment is
    // already done before the user has actually paid via the link.
    expect(sentText.toLowerCase()).toMatch(/tarjeta colsubsidio/);
    expect(sentText.toLowerCase()).not.toMatch(/pago exitoso|pago realizado|ya pagaste|pago fue exitoso/);
  });

  // 2026-07-24 feedback: "Tarjeta Colsubsidio" has no real API/sandbox of its own (unlike
  // Wompi) — precisely BECAUSE there's nothing real to show for it, the "match found"
  // moment gets the real branded success-checkmark video. The real Wompi link is still
  // generated and sent exactly as before — this never skips or fakes the actual payment.
  it('sends the branded success animation when "Tarjeta Colsubsidio" is chosen, same real Wompi link underneath', async () => {
    const { service, telegram, wompi } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com',
        quoteProductId: PRODUCTS[0].id, awaitingPaymentMethodChoice: true,
      },
      intent: makeIntent({}),
    });
    telegram.normalize.mockResolvedValue({ ...makeMessage('tarjeta colsubsidio'), messageId: 777 });
    await service.handleMessage({});
    expect(telegram.sendAnimation).toHaveBeenCalledWith('u1', expect.stringContaining('payment-received.mp4'));
    expect(wompi.createPaymentLink).toHaveBeenCalled();
  });

  it('does NOT send the animation when "link de pago" is chosen instead', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com',
        quoteProductId: PRODUCTS[0].id, awaitingPaymentMethodChoice: true,
      },
      intent: makeIntent({}),
    });
    telegram.normalize.mockResolvedValue({ ...makeMessage('link de pago'), messageId: 778 });
    await service.handleMessage({});
    expect(telegram.sendAnimation).not.toHaveBeenCalled();
  });
});

// DATA_CAPTURE — per-pet detail collection (name, age, breed)

describe('AgentService — DATA_CAPTURE per-pet details for mascotas', () => {
  it('asks for the first pet\'s details before asking for cédula', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { productCategory: 'mascotas', petCount: 2 },
      intent: makeIntent({ productCategory: 'mascotas' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('listo'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('1 de 2');
    expect(sentText).not.toContain('dígitos'); // must not ask for cédula yet
  });

  it('saves the first pet and asks for the second when petCount=2', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { productCategory: 'mascotas', petCount: 2 },
      intent: makeIntent({ productCategory: 'mascotas', petName: 'Max', petAge: '3 años', petBreed: 'labrador' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('se llama Max, tiene 3 años, es un labrador'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ pets: [{ name: 'Max', age: '3 años', breed: 'Labrador' }] }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('2 de 2');
  });

  it('regression — accepts multiple pets described in a single message, per user request', async () => {
    // User feedback: "the pet data should be ask in one audio or text and split as needed
    // into the flow" — when Groq extracts several pets from one message, absorb all of
    // them at once instead of forcing one message per pet.
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { productCategory: 'mascotas', petCount: 2 },
      intent: makeIntent({
        productCategory: 'mascotas',
        pets: [
          { name: 'Rocky', age: '5 años', breed: 'Labrador' },
          { name: 'Luna', age: '3 años', breed: 'Siamés' },
        ],
      }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Rocky tiene 5 años y es labrador, y Luna tiene 3 años y es siamesa'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({
        pets: [
          { name: 'Rocky', age: '5 años', breed: 'Labrador' },
          { name: 'Luna', age: '3 años', breed: 'Siamés' },
        ],
      }),
    );
    // All pets collected in one turn — shows the confirmation summary next
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('Rocky');
    expect(sentText).toContain('Luna');
  });

  it('absorbs as many pets as fit when the message describes more than petCount', async () => {
    const { service, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { productCategory: 'mascotas', petCount: 1 },
      intent: makeIntent({
        productCategory: 'mascotas',
        pets: [
          { name: 'Rocky', age: '5 años', breed: 'Labrador' },
          { name: 'Luna', age: '3 años', breed: 'Siamés' },
        ],
      }),
    });
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ pets: [{ name: 'Rocky', age: '5 años', breed: 'Labrador' }] }),
    );
  });

  // Real gap: a pet name is a free-text field just like the human nombre — an NLP
  // mis-extraction of a digit/symbol "name" (e.g. "2") must not be pushed into pets[]
  // and end up on the final policy PDF.
  it('regression — a digit/symbol-only extracted petName is rejected, re-asks instead of saving it', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { productCategory: 'mascotas', petCount: 1, pets: [] },
      intent: makeIntent({ productCategory: 'mascotas', petName: '2', petAge: '5 años', petBreed: 'criollo' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('se llama 2, tiene 5 años, es criollo'));
    await service.handleMessage({});
    expect(conversations.saveState).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      expect.objectContaining({ pets: expect.arrayContaining([expect.objectContaining({ name: '2' })]) }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/mascota/i);
  });

  // Real live-test bug (2026-07-24): a 3-pet voice message ("Bruna...Ramón...Pancha...")
  // had Bruna silently dropped by the NLP extraction (fixed separately in
  // groq-nlp.service.ts). The user, believing all 3 pets were already given, was asked
  // for a "missing" 3rd pet and re-stated Pancha's details again — which got pushed as a
  // literal duplicate entry, corrupting the final paid, issued policy. This guard is the
  // second line of defense: even if the NLP still under-extracts for some other message,
  // re-stating an already-collected pet's exact name must never create a duplicate.
  it('regression — re-stating an already-collected pet name does not create a duplicate entry', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        productCategory: 'mascotas', petCount: 3,
        pets: [
          { name: 'Ramón', age: '3 años', breed: 'Cocker Spaniel' },
          { name: 'Pancha', age: '10 años', breed: 'Doberman' },
        ],
      },
      intent: makeIntent({ productCategory: 'mascotas', petName: 'Pancha', petAge: '10 años', petBreed: 'doberman' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Pancha, 10 años, Doberman'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.pets).toHaveLength(2);
    expect(savedContext.pets).toEqual([
      { name: 'Ramón', age: '3 años', breed: 'Cocker Spaniel' },
      { name: 'Pancha', age: '10 años', breed: 'Doberman' },
    ]);
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/ya tengo a pancha|ya la tengo|diferente/i);
  });

  it('shows a confirmation summary (not cédula yet) once all pets are collected', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { productCategory: 'mascotas', petCount: 1, pets: [] },
      intent: makeIntent({ productCategory: 'mascotas', petName: 'Rocky', petAge: '5 años', petBreed: 'criollo' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('se llama Rocky, tiene 5 años, es criollo'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('Rocky');
    expect(sentText).toContain('5 años');
    expect(sentText).not.toContain('dígitos'); // does not ask for cédula yet
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({
        pets: [{ name: 'Rocky', age: '5 años', breed: 'Criollo' }],
        petsAwaitingConfirmation: true,
      }),
    );
  });

  it('regression — a mis-transcribed breed ("caken") is normalized to the closest known breed when captured', async () => {
    const { service, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { productCategory: 'mascotas', petCount: 1, pets: [] },
      intent: makeIntent({ productCategory: 'mascotas', petName: 'Maylo', petAge: '10 años', petBreed: 'caken' }),
    });
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.pets?.[0].breed.toLowerCase()).toContain('cocker');
  });

  it('"sí" at the pets confirmation proceeds to asking for cédula', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        productCategory: 'mascotas', petCount: 1,
        pets: [{ name: 'Rocky', age: '5 años', breed: 'Criollo' }],
        petsAwaitingConfirmation: true,
      },
      intent: makeIntent({ isAffirmative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('dígitos');
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ petsAwaitingConfirmation: undefined }),
    );
  });

  it('regression — correcting one pet\'s field by name only updates that pet, not the whole list', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        productCategory: 'mascotas', petCount: 2,
        pets: [
          { name: 'Rocky', age: '5 años', breed: 'Doberman' },
          { name: 'Bruna', age: '10 años', breed: 'Criollo' },
        ],
        petsAwaitingConfirmation: true,
      },
      intent: makeIntent({ isAffirmative: false, petName: 'Bruna', petAge: '8 años' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Bruna tiene 8 años, no 10'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({
        pets: [
          { name: 'Rocky', age: '5 años', breed: 'Doberman' },
          { name: 'Bruna', age: '8 años', breed: 'Criollo' },
        ],
        petsAwaitingConfirmation: true,
      }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('8 años');
  });

  it('regression — a garbage-shaped extracted petName never overwrites an already-valid pet name during correction', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        productCategory: 'mascotas', petCount: 1,
        pets: [{ name: 'Rocky', age: '5 años', breed: 'Doberman' }],
        petsAwaitingConfirmation: true,
      },
      // Single-pet household — targetIndex falls back to 0, so a garbage petName must
      // not silently rename "Rocky" to "2".
      intent: makeIntent({ isAffirmative: false, petName: '2', petAge: '6 años' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('tiene 6 años'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({
        pets: [{ name: 'Rocky', age: '6 años', breed: 'Doberman' }],
      }),
    );
  });

  // Real live-test bug (2026-07-24): a 3-pet message ("Bruna... Ramón... Pancha...")
  // came back with Pancha duplicated and Bruna missing. Every correction attempt by name
  // ("Pancha, 10 años, Cocker") always matched the FIRST "Pancha", never the duplicate;
  // ordinal attempts ("el tercero es Ramón...") were not understood at all. The corrupted
  // data made it all the way into the final, paid, issued policy PDF.
  it('regression — a name matching two pets asks which one instead of silently updating the first', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        productCategory: 'mascotas', petCount: 3,
        pets: [
          { name: 'Ramón', age: '3 años', breed: 'Doberman' },
          { name: 'Pancha', age: '10 años', breed: 'Cocker Spaniel' },
          { name: 'Pancha', age: '10 años', breed: 'Cocker Spaniel' },
        ],
        petsAwaitingConfirmation: true,
      },
      intent: makeIntent({ isAffirmative: false, petName: 'Pancha', petAge: '10 años' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Pancha, 10 años, Cocker'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/2 mascotas llamadas.*Pancha/i);
    // Nothing changed yet — must not silently guess which "Pancha" was meant
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    if (savedContext) expect(savedContext.pets).toHaveLength(3);
  });

  it('regression — an ordinal reference ("el tercero") targets that pet by position, not by name lookup', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        productCategory: 'mascotas', petCount: 3,
        pets: [
          { name: 'Ramón', age: '3 años', breed: 'Doberman' },
          { name: 'Pancha', age: '10 años', breed: 'Cocker Spaniel' },
          { name: 'Pancha', age: '10 años', breed: 'Cocker Spaniel' },
        ],
        petsAwaitingConfirmation: true,
      },
      // "Ramón" here also matches pets[0] by name — the ordinal must win so the THIRD
      // slot (the actual duplicate) gets corrected, not the already-correct first one.
      intent: makeIntent({ isAffirmative: false, petName: 'Bruna', petAge: '10 años', petBreed: 'Criolla' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('el tercero es Bruna, 10 años, criolla'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext?.pets?.[0]).toEqual({ name: 'Ramón', age: '3 años', breed: 'Doberman' });
    expect(savedContext?.pets?.[2].name).toBe('Bruna');
  });

  it('supports "la segunda" (feminine ordinal) targeting the second pet', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        productCategory: 'mascotas', petCount: 2,
        pets: [
          { name: 'Rocky', age: '5 años', breed: 'Doberman' },
          { name: 'Luna', age: '2 años', breed: 'Siamés' },
        ],
        petsAwaitingConfirmation: true,
      },
      intent: makeIntent({ isAffirmative: false, petAge: '3 años' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('la segunda tiene 3 años'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext?.pets?.[1].age).toBe('3 años');
    expect(savedContext?.pets?.[0].age).toBe('5 años');
  });

  it('asks for clarification when a correction at pets confirmation does not name a known pet', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        productCategory: 'mascotas', petCount: 1,
        pets: [{ name: 'Rocky', age: '5 años', breed: 'Doberman' }],
        petsAwaitingConfirmation: true,
      },
      intent: makeIntent({ isAffirmative: false, petName: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('mmh no está bien'));
    await service.handleMessage({});
    // pets stays unchanged — nothing was actually corrected, just re-prompted
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    if (savedContext) {
      expect(savedContext.pets).toEqual([{ name: 'Rocky', age: '5 años', breed: 'Doberman' }]);
    }
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/cuál mascota|nombre de la mascota/);
  });

  it('defaults age/breed to "no especificada" when the user only gives a name', async () => {
    const { service, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { productCategory: 'mascotas', petCount: 1 },
      intent: makeIntent({ productCategory: 'mascotas', petName: 'Luna', petAge: null, petBreed: null }),
    });
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE,
      expect.objectContaining({ pets: [{ name: 'Luna', age: 'no especificada', breed: 'no especificada' }] }),
    );
  });

  it('re-asks without advancing when no pet name is extracted from the message', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { productCategory: 'mascotas', petCount: 1, pets: [] },
      intent: makeIntent({ productCategory: 'mascotas', petName: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('mmh no sé'));
    await service.handleMessage({});
    // pets stays empty — no pet was actually captured, just re-prompted
    expect(conversations.saveState).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.objectContaining({ pets: expect.arrayContaining([expect.anything()]) }),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('1 de 1');
  });

  it('does not trigger the pet-detail loop for non-mascotas products', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { productCategory: 'vida' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('12345678'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('mascota');
  });
});

// PAYMENT — webhook is the source of truth, chat "sí" no longer confirms

describe('AgentService — PAYMENT webhook-driven confirmation', () => {
  it('regression — charges the correct multiplied total for multi-pet households, not the flat single-pet price', async () => {
    // Real bug: the chat quote correctly showed "$14.500/mes por mascota, Total para 3
    // mascotas: $43.500/mes", but the actual Wompi charge used the flat basePremium —
    // under-charging by 2/3 for a 3-pet household.
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!; // basePremium 14500
    const { service, telegram, wompi } = buildService({
      state: ConversationState.PAYMENT,
      context: { policyId: 'pol-1', quoteProductId: petProduct.id, productCategory: 'mascotas', petCount: 3 },
      intent: makeIntent({ isAffirmative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(wompi.createPaymentLink).toHaveBeenCalledWith(
      expect.objectContaining({ amountCOP: 43500 }),
    );
  });

  it('creating a payment link persists wompi_link_id on the policy record', async () => {
    // The webhook can only find our policy via payment_link_id (Wompi has no
    // "reference" create-parameter) — it must be persisted the moment the link exists.
    const { service, telegram, policy, wompi } = buildService({
      state: ConversationState.PAYMENT,
      context: { policyId: 'pol-1', quoteProductId: PRODUCTS[0].id },
      intent: makeIntent({ isAffirmative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(wompi.createPaymentLink).toHaveBeenCalled();
    expect(policy.updateStatus).toHaveBeenCalledWith(
      'pol-1', 'pending_payment', expect.objectContaining({ wompi_link_id: 'link-test' }),
    );
  });

  it('regression — "sí" after checkoutUrl exists does NOT issue the policy or advance state', async () => {
    // Trusting the user's word was the bug: anyone could type "sí" without paying and
    // get a policy issued + registered on-chain. Only the Wompi webhook may do that now.
    const { service, telegram, conversations } = buildService({
      state: ConversationState.PAYMENT,
      context: { policyId: 'pol-1', checkoutUrl: 'https://checkout.wompi.co/l/test' },
      intent: makeIntent({ isAffirmative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(conversations.saveState).not.toHaveBeenCalledWith(
      expect.anything(), ConversationState.POLICY_ISSUED, expect.anything(),
    );
  });

  it('"sí" after checkoutUrl exists gives a waiting acknowledgment, not a repeated payment prompt', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.PAYMENT,
      context: { policyId: 'pol-1', checkoutUrl: 'https://checkout.wompi.co/l/test' },
      intent: makeIntent({ isAffirmative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    // Must not tell the user to say "sí" again — the webhook confirms automatically now
    expect(sentText).not.toMatch(/escríbeme.*sí/i);
  });

  it('"no" after checkoutUrl exists still abandons (unchanged behavior)', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.PAYMENT,
      context: { policyId: 'pol-1', checkoutUrl: 'https://checkout.wompi.co/l/test' },
      intent: makeIntent({ isNegative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('no'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.ABANDONED, expect.anything(),
    );
  });
});

// abandonIntent vs. an already-completed purchase
// Real live-test bug (confirmed directly in the production Supabase conversations
// table): two conversations that had ALREADY completed a real, Wompi-approved purchase
// ended up with state='abandoned' after the customer later declined to buy anything
// more. processMessage's top-level abandonIntent check fires for any state except
// GREETING/QUOTE_PRESENTED — including the post-purchase DISCOVERY follow-up — with no
// awareness a policy already exists. "Abandoned before buying anything" and "bought
// something, then declined more" must never share a conversation status.
describe('AgentService — abandonIntent after an already-completed purchase', () => {
  it('regression — abandonIntent ends as COMPLETED, not ABANDONED, when hasCompletedPurchase is true', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com', hasCompletedPurchase: true },
      intent: makeIntent({ abandonIntent: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Ya no quiero nada más, olvídalo.'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.COMPLETED, expect.anything(),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toMatch(/cuando quieras retomar/i);
  });

  it('abandonIntent still abandons normally when no purchase was ever completed', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ abandonIntent: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Olvídalo, ya no quiero nada.'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.ABANDONED, expect.anything(),
    );
  });
});

// QUOTE_PRESENTED — no-repeat invariant

// QUOTE_PRESENTED — back-reference resolution (2026-07-26 live bug)
// "Prefiero la anterior.", "Quiero la primera opción que me ofreciste.", "la que vale
// 16.800", "¿alguna más económica?" all reference a SPECIFIC already-shown product (or a
// cheaper one among them) -- none had a handler before this fix; they either fell
// through to a blind re-show of the CURRENT product, or (worse) got matched as a false
// confirmation of it via a bare "quiero" substring.
describe('AgentService — QUOTE_PRESENTED back-reference resolution', () => {
  const asistenciasMedicas = PRODUCTS.find((p) => p.id === 'asistencias-medicas')!; // $16.800
  const asistenciasMultiples = PRODUCTS.find((p) => p.id === 'asistencias-multiples')!; // $20.000
  const exequial = PRODUCTS.find((p) => p.id === 'exequial')!; // $26.000

  it('regression — "la primera opción que me ofreciste" goes back to the FIRST shown product, not the current one', async () => {
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: {
        quoteProductId: exequial.id,
        shownProductIds: [asistenciasMedicas.id, asistenciasMultiples.id, exequial.id],
      },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    quoting.score.mockReturnValue([
      { productId: asistenciasMedicas.id, matchScore: 60, reasons: ['Para ti'], monthlyPremium: asistenciasMedicas.basePremium, priority: 'high' },
    ]);
    telegram.normalize.mockResolvedValue(makeMessage('Quiero la primera opción que me ofreciste.'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(asistenciasMedicas.name);
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.quoteProductId).toBe(asistenciasMedicas.id);
  });

  it('regression — "prefiero la anterior" goes back to the SECOND-TO-LAST shown product', async () => {
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: {
        quoteProductId: exequial.id,
        shownProductIds: [asistenciasMedicas.id, asistenciasMultiples.id, exequial.id],
      },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    quoting.score.mockReturnValue([]);
    telegram.normalize.mockResolvedValue(makeMessage('Prefiero la anterior.'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.quoteProductId).toBe(asistenciasMultiples.id);
  });

  it('regression — naming the exact price of a DIFFERENT shown product goes back to THAT one, not a blind confirmation of the current one', async () => {
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: {
        quoteProductId: asistenciasMultiples.id, // $20.000, currently on screen
        shownProductIds: [asistenciasMedicas.id, asistenciasMultiples.id],
      },
      // Simulates the real bug: Groq/fallback classified "quiero" as isAffirmative=true,
      // which would otherwise have confirmed the WRONG ($20.000) product.
      intent: makeIntent({ isAffirmative: true, productCategory: null }),
    });
    quoting.score.mockReturnValue([]);
    telegram.normalize.mockResolvedValue(makeMessage('Quiero la que vale 16.800.'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    // Must go back to the $16.800 product, NOT advance to phone verification for the
    // $20.000 one that was on screen.
    expect(savedContext.quoteProductId).toBe(asistenciasMedicas.id);
    expect(savedContext.awaitingPhoneVerification).toBeUndefined();
  });

  it('"¿alguna más económica?" goes back to the cheapest already-shown product, cheaper than the current one', async () => {
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: {
        quoteProductId: exequial.id, // $26.000
        shownProductIds: [asistenciasMedicas.id, asistenciasMultiples.id, exequial.id],
      },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    quoting.score.mockReturnValue([]);
    telegram.normalize.mockResolvedValue(makeMessage('¿Alguna más económica?'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.quoteProductId).toBe(asistenciasMedicas.id); // the cheapest of the two already shown
  });

  it('does not fire when the reference resolves to the CURRENT product (falls through to isAffirmative normally)', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: asistenciasMedicas.id, shownProductIds: [asistenciasMedicas.id] },
      intent: makeIntent({ isAffirmative: true, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí, quiero la primera opción'));
    await service.handleMessage({});
    // isAffirmative still advances normally (phone verification), since "la primera
    // opción" resolves to the product ALREADY on screen -- nothing to go back to.
    expect(telegram.sendContactRequest).toHaveBeenCalledTimes(1);
  });

  it('does not fire for an ordinary message with no reference pattern and no price (existing behavior untouched)', async () => {
    const { service, telegram, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: asistenciasMultiples.id, shownProductIds: [asistenciasMedicas.id, asistenciasMultiples.id] },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿cuánto dura la cobertura?'));
    await service.handleMessage({});
    expect(quoting.score).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(asistenciasMultiples.name); // neutral re-show of current, unchanged
  });
});

// QUOTE_PRESENTED — category exhaustion no longer resets to DISCOVERY
// Real live-test bug (2026-07-26): resetting productCategory/coverage and transitioning
// to DISCOVERY when a category runs out of unseen options let the NEXT ambiguous
// message's hallucinated productCategory silently start a brand-new, unrelated quote (an
// "asistencia" shopper ended up with "vida"). Staying anchored in QUOTE_PRESENTED means
// back-reference resolution and the cross-sell-defer check both keep working.
describe('AgentService — QUOTE_PRESENTED category exhaustion stays anchored', () => {
  it('regression — exhausting a category stays in QUOTE_PRESENTED, keeps productCategory/coverage/quoteProductId, and offers the waitlist', async () => {
    const p1 = PRODUCTS[0];
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: p1.id, shownProductIds: [p1.id], productCategory: 'accidentes', coverage: ['protección'] },
      intent: makeIntent({ wantsAlternative: true, productCategory: null }),
    });
    quoting.score.mockReturnValue([
      { productId: p1.id, matchScore: 80, reasons: [], monthlyPremium: p1.basePremium, priority: 'high' },
    ]);
    telegram.normalize.mockResolvedValue(makeMessage('otra'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    // Live-test feedback (2026-07-26): once a category's alternatives run out, offer to
    // capture contact info (a real lead) instead of a dead end — applies to any category,
    // not only mascotas.
    expect(sentText).toContain('¿Te interesa?');
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.quoteProductId).toBe(p1.id);
    expect(savedContext.productCategory).toBe('accidentes');
    expect(savedContext.coverage).toEqual(['protección']);
    expect(savedContext.awaitingContactConsent).toBe(true);
    const savedState = conversations.saveState.mock.calls[0]?.[1] as ConversationState;
    expect(savedState).toBe(ConversationState.QUOTE_PRESENTED);
  });

});

// Lead capture — waitlist offer when a category's alternatives run out
// Real live-test bug (2026-07-26, "flow is broken"): awaitingContactConsent was set by
// handleQuotation (category exhaustion, above) but only ever CHECKED inside
// `case ConversationState.AUTHORIZATION` in processMessage — unreachable, since the
// conversation stays anchored in QUOTE_PRESENTED with no nextState change. The reply to
// "¿te interesa?" silently fell through to handleQuotation's normal logic instead, with
// no working answer path at all. Fixed by checking the flag at the top of handleQuotation
// itself. This whole flow (consent → name → email → phone → admin notification → end
// chat) had ZERO test coverage before this round — the gap that let it ship broken.
describe('AgentService — lead capture after category exhaustion', () => {
  it('"sí" to the waitlist offer moves to DATA_CAPTURE and asks for a name', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: PRODUCTS[0].id, productCategory: 'accidentes', awaitingContactConsent: true },
      intent: makeIntent({ isAffirmative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('¿cuál es tu nombre?');
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.awaitingContactConsent).toBeUndefined();
    expect(savedContext.awaitingContactName).toBe(true);
    const savedState = conversations.saveState.mock.calls[0]?.[1] as ConversationState;
    expect(savedState).toBe(ConversationState.DATA_CAPTURE);
  });

  it('"no" to the waitlist offer ends the chat politely (ABANDONED)', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: PRODUCTS[0].id, awaitingContactConsent: true },
      intent: makeIntent({ isNegative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('no'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.ABANDONED, expect.anything(),
    );
  });

  it('"no" to the waitlist offer ends in COMPLETED (not ABANDONED) when a purchase already happened this conversation', async () => {
    const { service, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: PRODUCTS[0].id, awaitingContactConsent: true, hasCompletedPurchase: true },
      intent: makeIntent({ isNegative: true }),
    });
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.COMPLETED, expect.anything(),
    );
  });

  it('an unclear reply to the waitlist offer re-asks instead of silently falling through to normal quote handling', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: PRODUCTS[0].id, awaitingContactConsent: true },
      intent: makeIntent({ isAffirmative: false, isNegative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('mmh no sé'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('¿Te interesa?');
    expect(conversations.saveState).not.toHaveBeenCalled();
  });

  it('end-to-end: consent → name → email → phone captures the lead, notifies ADMIN_CHAT_ID, and ends the chat', async () => {
    // Step 1: consent
    const { service: s1, conversations: c1 } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: PRODUCTS[0].id, productCategory: 'accidentes', awaitingContactConsent: true },
      intent: makeIntent({ isAffirmative: true }),
    });
    await s1.handleMessage({});
    const ctxAfterConsent = c1.saveState.mock.calls[0]?.[2] as ConversationContext;

    // Step 2: name
    const { service: s2, telegram: t2, conversations: c2 } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: ctxAfterConsent,
    });
    t2.normalize.mockResolvedValue(makeMessage('Camila Rojas'));
    await s2.handleMessage({});
    const sentText2 = t2.sendText.mock.calls[0]?.[1] as string;
    expect(sentText2).toContain('correo electrónico');
    const ctxAfterName = c2.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(ctxAfterName.contactName).toBe('Camila Rojas');
    expect(ctxAfterName.awaitingContactEmail).toBe(true);

    // Step 3: email
    const { service: s3, telegram: t3, conversations: c3 } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: ctxAfterName,
    });
    t3.normalize.mockResolvedValue(makeMessage('camila@example.com'));
    await s3.handleMessage({});
    const sentText3 = t3.sendText.mock.calls[0]?.[1] as string;
    expect(sentText3).toContain('número de teléfono');
    const ctxAfterEmail = c3.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(ctxAfterEmail.contactEmail).toBe('camila@example.com');
    expect(ctxAfterEmail.awaitingContactPhone).toBe(true);

    // Step 4: phone — captures the lead, notifies ADMIN_CHAT_ID, ends the chat
    const { service: s4, telegram: t4, conversations: c4, config: config4 } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: ctxAfterEmail,
    });
    config4.get.mockImplementation((key: string) => (key === 'ADMIN_CHAT_ID' ? '999999' : undefined));
    t4.normalize.mockResolvedValue(makeMessage('3001234567'));
    await s4.handleMessage({});
    // notifyAdminLead is fired (not awaited) before the user-facing reply, so it's the
    // FIRST sendText call in mock-call order — find the user's own reply by chat id.
    const userCall = t4.sendText.mock.calls.find((call) => call[0] === 'u1');
    const sentText4 = userCall?.[1] as string;
    expect(sentText4).toContain('Listo');
    const ctxAfterPhone = c4.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(ctxAfterPhone.contactPhone).toBe('3001234567');
    expect(ctxAfterPhone.awaitingContactPhone).toBeUndefined();
    const savedState4 = c4.saveState.mock.calls[0]?.[1] as ConversationState;
    expect(savedState4).toBe(ConversationState.ABANDONED);

    const adminCall = t4.sendText.mock.calls.find((call) => call[0] === '999999');
    expect(adminCall).toBeDefined();
    const adminText = adminCall![1] as string;
    expect(adminText).toContain('Camila Rojas');
    expect(adminText).toContain('camila@example.com');
    expect(adminText).toContain('3001234567');
    expect(adminText).toContain('accidentes');
  });

  it('an invalid phone (fewer than 7 digits) is rejected and re-asked, never captured as-is', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { contactName: 'Camila Rojas', contactEmail: 'camila@example.com', awaitingContactPhone: true },
    });
    telegram.normalize.mockResolvedValue(makeMessage('123'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('al menos 7 dígitos');
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.contactPhone).toBeUndefined();
    expect(savedContext.awaitingContactPhone).toBe(true);
  });

  it('does not notify ADMIN_CHAT_ID when it is not configured — degrades silently', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { contactName: 'Camila Rojas', contactEmail: 'camila@example.com', awaitingContactPhone: true },
    });
    telegram.normalize.mockResolvedValue(makeMessage('3001234567'));
    await service.handleMessage({});
    // Only the user's own chat id (u1) receives a message — no separate admin call.
    expect(telegram.sendText).toHaveBeenCalledTimes(1);
  });

  // Real live-test bug (2026-07-26, screenshot): a RETURNING customer (nombre/email
  // already known — the greeting itself says "Ya tengo parte de tu perfil de una
  // conversación anterior") still got asked "¿cuál es tu nombre?" then "¿cuál es tu
  // correo?" from scratch when accepting the waitlist offer, instead of reusing what's
  // already known — the exact "nunca preguntar lo que ya sabemos" violation the
  // affiliate-ID/persistent-memory features exist to prevent elsewhere.
  describe('regression — never re-asks for name/email/phone already known from an earlier purchase', () => {
    it('skips straight to asking for email when nombre is already known', async () => {
      const { service, telegram, conversations } = buildService({
        state: ConversationState.QUOTE_PRESENTED,
        context: {
          quoteProductId: PRODUCTS[0].id, awaitingContactConsent: true,
          nombre: 'Juan Pérez', hasCompletedPurchase: true,
        },
        intent: makeIntent({ isAffirmative: true }),
      });
      telegram.normalize.mockResolvedValue(makeMessage('sí'));
      await service.handleMessage({});
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      expect(sentText).not.toContain('¿cuál es tu nombre?');
      expect(sentText).toContain('correo electrónico');
      const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
      expect(savedContext.contactName).toBe('Juan Pérez');
      expect(savedContext.awaitingContactName).toBeUndefined();
      expect(savedContext.awaitingContactEmail).toBe(true);
    });

    it('skips straight to asking for phone when BOTH nombre and email are already known', async () => {
      const { service, telegram, conversations } = buildService({
        state: ConversationState.QUOTE_PRESENTED,
        context: {
          quoteProductId: PRODUCTS[0].id, awaitingContactConsent: true,
          nombre: 'Juan Pérez', email: 'juan@test.com', hasCompletedPurchase: true,
        },
        intent: makeIntent({ isAffirmative: true }),
      });
      telegram.normalize.mockResolvedValue(makeMessage('sí'));
      await service.handleMessage({});
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      expect(sentText).not.toContain('¿cuál es tu nombre?');
      expect(sentText).not.toContain('¿Cuál es tu correo electrónico?');
      expect(sentText).toContain('número de teléfono');
      const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
      expect(savedContext.contactName).toBe('Juan Pérez');
      expect(savedContext.contactEmail).toBe('juan@test.com');
      expect(savedContext.awaitingContactPhone).toBe(true);
    });

    it('skips ALL the way to notifying + ending the chat when nombre, email, and verifiedPhone are all already known', async () => {
      const { service, telegram, conversations, config } = buildService({
        state: ConversationState.QUOTE_PRESENTED,
        context: {
          quoteProductId: PRODUCTS[0].id, awaitingContactConsent: true,
          nombre: 'Juan Pérez', email: 'juan@test.com', verifiedPhone: '+573001234567',
          hasCompletedPurchase: true, productCategory: 'accidentes',
        },
        intent: makeIntent({ isAffirmative: true }),
      });
      config.get.mockImplementation((key: string) => (key === 'ADMIN_CHAT_ID' ? '999999' : undefined));
      telegram.normalize.mockResolvedValue(makeMessage('sí'));
      await service.handleMessage({});
      const userCall = telegram.sendText.mock.calls.find((call) => call[0] === 'u1');
      expect(userCall?.[1] as string).toContain('Listo');
      const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
      expect(savedContext.contactPhone).toBe('+573001234567');
      const savedState = conversations.saveState.mock.calls[0]?.[1] as ConversationState;
      expect(savedState).toBe(ConversationState.COMPLETED); // hasCompletedPurchase was true
      const adminCall = telegram.sendText.mock.calls.find((call) => call[0] === '999999');
      expect(adminCall?.[1] as string).toContain('Juan Pérez');
    });

    it('a fresh customer (nothing known yet) still asks for name first — unchanged behavior', async () => {
      const { service, telegram } = buildService({
        state: ConversationState.QUOTE_PRESENTED,
        context: { quoteProductId: PRODUCTS[0].id, awaitingContactConsent: true },
        intent: makeIntent({ isAffirmative: true }),
      });
      telegram.normalize.mockResolvedValue(makeMessage('sí'));
      await service.handleMessage({});
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      expect(sentText).toContain('¿cuál es tu nombre?');
    });
  });
});

// Real live-test bug (2026-07-26, screenshot): a voice-dictated email kept failing the
// same way 4 times in a row — Whisper's punctuation model inserts a comma right after a
// spoken filler word ("arroba," instead of clean trailing whitespace), and the original
// `\s+arroba\s+`/`\s+punto\s+` patterns required LITERAL whitespace on both sides, so the
// comma silently broke the match and left "arroba" un-converted to "@".
describe('AgentService — normalizeSpokenEmail handles ASR-inserted commas around "arroba"/"punto"', () => {
  it.each([
    ['juan arroba, gmail punto com', 'juan@gmail.com'],
    ['juan arroba gmail punto, com', 'juan@gmail.com'],
    ['juan, arroba gmail, punto, com', 'juan@gmail.com'],
  ])('"%s" is normalized to a valid email despite the stray commas', async (spoken, expected) => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { contactName: 'Camila Rojas', awaitingContactEmail: true },
    });
    telegram.normalize.mockResolvedValue(makeMessage(spoken));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.contactEmail).toBe(expected);
    expect(savedContext.awaitingContactPhone).toBe(true);
  });
});

describe('AgentService — QUOTE_PRESENTED category exhaustion stays anchored (continued)', () => {
  it('regression — end-to-end: after exhaustion, "quiero la primera opción" correctly goes back instead of hallucinating a new category', async () => {
    const asistenciasMedicas = PRODUCTS.find((p) => p.id === 'asistencias-medicas')!;
    const exequial = PRODUCTS.find((p) => p.id === 'exequial')!;
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED, // where exhaustion leaves it now, per the fix above
      context: {
        quoteProductId: exequial.id,
        shownProductIds: [asistenciasMedicas.id, exequial.id],
        productCategory: 'asistencia',
      },
      // Simulates a hallucinated, unrelated category the LLM might guess from this vague
      // phrase — must NOT win over the deterministic back-reference.
      intent: makeIntent({ productCategory: 'vida' }),
    });
    quoting.score.mockReturnValue([]);
    telegram.normalize.mockResolvedValue(makeMessage('Quiero la primera opción que me ofreciste.'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.quoteProductId).toBe(asistenciasMedicas.id);
    expect(savedContext.productCategory).toBe('asistencia'); // unchanged, never hijacked to 'vida'
  });
});

describe('AgentService — QUOTE_PRESENTED no-repeat on "otro"', () => {
  it('regression — "otro" uses shownProductIds to skip already-shown products', async () => {
    const p1 = PRODUCTS[0];
    const p2 = PRODUCTS[1];
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: {
        quoteProductId: p1.id,
        shownProductIds: [p1.id],
        productCategory: 'accidentes',
      },
    });
    telegram.normalize.mockResolvedValue(makeMessage('otro'));
    quoting.score.mockReturnValue([
      { productId: p1.id, matchScore: 80, reasons: [], monthlyPremium: p1.basePremium, priority: 'high' },
      { productId: p2.id, matchScore: 60, reasons: [], monthlyPremium: p2.basePremium, priority: 'medium' },
    ]);
    await service.handleMessage({});
    // Should transition to p2, not p1 again
    const saveCall = conversations.saveState.mock.calls[0];
    if (saveCall) {
      const savedContext = saveCall[2] as ConversationContext;
      expect(savedContext.quoteProductId).toBe(p2.id);
      expect(savedContext.shownProductIds).toContain(p1.id);
      expect(savedContext.shownProductIds).toContain(p2.id);
    }
  });

  it('regression — shownProductIds grows monotonically across "otro" calls', async () => {
    const p1 = PRODUCTS[0];
    const p2 = PRODUCTS[1];
    const p3 = PRODUCTS[2];
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: p1.id, shownProductIds: [p1.id] },
    });
    telegram.normalize.mockResolvedValue(makeMessage('otra opción'));
    quoting.score.mockReturnValue([
      { productId: p1.id, matchScore: 90, reasons: [], monthlyPremium: 0, priority: 'high' },
      { productId: p2.id, matchScore: 70, reasons: [], monthlyPremium: 0, priority: 'high' },
      { productId: p3.id, matchScore: 50, reasons: [], monthlyPremium: 0, priority: 'medium' },
    ]);
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    if (savedContext?.shownProductIds) {
      // shownProductIds must contain previous + new product
      expect(savedContext.shownProductIds.length).toBeGreaterThan(1);
      expect(savedContext.shownProductIds).toContain(p1.id);
    }
  });

  // Real live-test bug: after declining a cross-sell quote with a plain "No, está bien.",
  // the agent kept cycling to ANOTHER alternative product instead of letting the user go
  // — the OLD code treated `isNegative` exactly like `wantsAlternative` (any "no" always
  // meant "show me something else"). AGENTS.md's own UX rule says a "no" gets an
  // alternative OR a polite close — only "alternative" was ever implemented. A bare
  // decline (isNegative, no explicit "show me more") must now end politely instead.
  it('regression — a plain decline ("No, está bien.") ends politely instead of cycling to another product', async () => {
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: PRODUCTS[0].id, shownProductIds: [PRODUCTS[0].id] },
      intent: makeIntent({ isNegative: true, wantsAlternative: false, isAffirmative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('No, está bien.'));
    await service.handleMessage({});
    expect(quoting.score).not.toHaveBeenCalled();
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.ABANDONED, expect.anything(),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/aquí estoy|cuando quieras/);
  });

  // Real live-test bug (2026-07-25): same bug class as the "stuck at abandoned despite
  // completed purchase" fix (task #78) — but via a DIFFERENT code path that fix never
  // touched. Task #78 only patched the top-level abandonIntent check, which explicitly
  // skips QUOTE_PRESENTED (line ~135). A plain decline of a POST-PURCHASE cross-sell
  // quote ("No, está bien.") goes through THIS branch instead (added by task #71), which
  // unconditionally set nextState=ABANDONED with no hasCompletedPurchase check at all —
  // so a customer who already has an active, paid policy and simply declines to buy a
  // second one gets their conversation marked 'abandoned' again.
  it('regression — a plain decline of a post-purchase cross-sell ends in COMPLETED, not ABANDONED, when hasCompletedPurchase is true', async () => {
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: PRODUCTS[0].id, shownProductIds: [PRODUCTS[0].id], hasCompletedPurchase: true },
      intent: makeIntent({ isNegative: true, wantsAlternative: false, isAffirmative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('No, está bien.'));
    await service.handleMessage({});
    expect(quoting.score).not.toHaveBeenCalled();
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.COMPLETED, expect.anything(),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).not.toMatch(/entendido\. cuando quieras retomar/);
  });

  it('regression — a plain decline still ends in ABANDONED when hasCompletedPurchase is not set (no prior purchase)', async () => {
    const { service, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: PRODUCTS[0].id, shownProductIds: [PRODUCTS[0].id] },
      intent: makeIntent({ isNegative: true, wantsAlternative: false, isAffirmative: false }),
    });
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.ABANDONED, expect.anything(),
    );
  });

  // Real live-test bug (screenshot, 2026-07-25/26): "No, pero no tengo gatos. No sé por
  // qué pensaste que tenía gatos..." while a gato-specific quote was showing got the
  // IDENTICAL quote card re-shown verbatim — this nuanced, multi-clause correction
  // didn't trip Groq's own isAffirmative/isNegative/wantsAlternative classification
  // (simulated here with a neutral intent, matching what actually shipped), so nothing
  // caught it and it fell through to the generic re-show. An explicit "no tengo <the
  // species just quoted>" must now pivot back to DISCOVERY instead, regardless of what
  // the LLM classified the message as.
  describe('QUOTE_PRESENTED — explicit denial of the currently-quoted pet species (2026-07-26 live bug)', () => {
    it('regression — "no tengo gatos" while a gato quote is showing pivots to DISCOVERY instead of re-showing the same quote', async () => {
      const { service, telegram, conversations, quoting } = buildService({
        state: ConversationState.QUOTE_PRESENTED,
        context: { quoteProductId: 'medicina-prepagada-gatos', productCategory: 'mascotas', petType: 'gato' },
        intent: makeIntent({ isNegative: false, isAffirmative: false, wantsAlternative: false }),
      });
      telegram.normalize.mockResolvedValue(makeMessage('no, pero no tengo gatos. no sé por qué pensaste que tenía gatos'));
      await service.handleMessage({});
      expect(quoting.score).not.toHaveBeenCalled();
      expect(conversations.saveState).toHaveBeenCalledWith(
        'conv-1',
        ConversationState.DISCOVERY,
        expect.objectContaining({ petType: undefined, quoteProductId: undefined }),
      );
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      expect(sentText).not.toMatch(/gatos/i);
    });

    it('regression — "no tengo perros" while a perro quote is showing also pivots to DISCOVERY', async () => {
      const { service, telegram, conversations } = buildService({
        state: ConversationState.QUOTE_PRESENTED,
        context: { quoteProductId: 'medicina-prepagada-perros', productCategory: 'mascotas', petType: 'perro' },
        intent: makeIntent({ isNegative: false, isAffirmative: false, wantsAlternative: false }),
      });
      telegram.normalize.mockResolvedValue(makeMessage('no tengo perros'));
      await service.handleMessage({});
      expect(conversations.saveState).toHaveBeenCalledWith(
        'conv-1', ConversationState.DISCOVERY, expect.anything(),
      );
    });

    it('does not fire when the species mentioned matches what is already quoted ("sí, tengo un gato")', async () => {
      const { service, conversations } = buildService({
        state: ConversationState.QUOTE_PRESENTED,
        context: { quoteProductId: 'medicina-prepagada-gatos', productCategory: 'mascotas', petType: 'gato' },
        intent: makeIntent({ isAffirmative: true }),
      });
      await service.handleMessage({});
      expect(conversations.saveState).not.toHaveBeenCalledWith(
        'conv-1', ConversationState.DISCOVERY, expect.anything(),
      );
    });
  });

  // Real live-test bug (screenshot, 2026-07-25): user said "salir" then "terminar" right
  // after a quote was shown, and got the IDENTICAL quote card re-shown verbatim both
  // times, with zero acknowledgment. Root cause: handleQuotation never checked
  // intent.abandonIntent at all — and the top-level abandonIntent check in
  // processMessage explicitly excludes QUOTE_PRESENTED (it has its own richer branching
  // for isAffirmative/isNegative/wantsAlternative), so an unambiguous exit word fell
  // through every branch to the neutral catch-all at the bottom, which just re-shows the
  // quote unchanged.
  it('regression — "salir" ends the conversation instead of re-showing the same quote', async () => {
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: PRODUCTS[0].id },
      intent: makeIntent({ abandonIntent: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('salir'));
    await service.handleMessage({});
    expect(quoting.score).not.toHaveBeenCalled();
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.ABANDONED, expect.anything(),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain(PRODUCTS[0].name);
  });

  it('regression — abandonIntent in QUOTE_PRESENTED ends in COMPLETED, not ABANDONED, when hasCompletedPurchase is true', async () => {
    const { service, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: PRODUCTS[0].id, hasCompletedPurchase: true },
      intent: makeIntent({ abandonIntent: true }),
    });
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.COMPLETED, expect.anything(),
    );
  });

  it('regression — explicitly asking for another option ("otra opción") still cycles to an alternative product, not a polite close', async () => {
    const p1 = PRODUCTS[0];
    const p2 = PRODUCTS[1];
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: p1.id, shownProductIds: [p1.id] },
      intent: makeIntent({ isNegative: true, wantsAlternative: true, isAffirmative: false }),
    });
    quoting.score.mockReturnValue([
      { productId: p1.id, matchScore: 80, reasons: [], monthlyPremium: p1.basePremium, priority: 'high' },
      { productId: p2.id, matchScore: 60, reasons: [], monthlyPremium: p2.basePremium, priority: 'medium' },
    ]);
    telegram.normalize.mockResolvedValue(makeMessage('muéstrame otra opción'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.QUOTE_PRESENTED, expect.objectContaining({ quoteProductId: p2.id }),
    );
  });

  it('"sí" in QUOTE_PRESENTED transitions to DATA_CAPTURE', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: PRODUCTS[0].id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.DATA_CAPTURE, expect.anything(),
    );
  });

  it('regression — neutral question re-shows the real quoted product, not a generic placeholder', async () => {
    // Bug: a neutral/unclear message (not affirmative/negative/alternative) in QUOTE_PRESENTED
    // fell through to the generic STATE_RESPONSES[QUOTE_PRESENTED] placeholder
    // ("🛡️ Seguro de mascotas / 💰 Desde precio accesible/mes") instead of re-showing the
    // actual quoted product with its real name and price.
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    const { service, telegram } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: petProduct.id, productCategory: 'mascotas', petCount: 3 },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿Ese es el único plan?'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(petProduct.name);
    expect(sentText).not.toContain('precio accesible');
  });

  // Real live-test bug: a genuinely unparseable message ("2+2", sent live by two
  // different users) silently got the exact same quote card re-shown with zero
  // acknowledgment — indistinguishable from a legitimate follow-up question. Only a
  // message with NO letters at all (never true for a real Spanish question) gets a
  // clarification prefix — the regression above ("¿Ese es el único plan?", a real
  // question) must keep being answered with a plain, unprefixed re-show.
  it('regression — a message with no letters at all ("2+2") gets a clarification prefix, not a silent re-show', async () => {
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    const { service, telegram } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: petProduct.id, productCategory: 'mascotas', petCount: 3 },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('2+2'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/no entendí|no logré entender/i);
    expect(sentText).toContain(petProduct.name);
  });
});

// QUOTE_PRESENTED / DISCOVERY — out-of-catalog category mentions
// Real bug independently confirmed by both a live test session and a teammate's
// findings report: asking for a category we don't sell ("vehicular", "seguro vehicular")
// silently re-showed the unrelated, already-quoted product verbatim (Seguro de vida,
// twice, identically) instead of honestly saying we don't offer it. The agent must never
// silently pretend an unrelated stale quote answers a genuinely different question.

describe('AgentService — QUOTE_PRESENTED honest response to an out-of-catalog category', () => {
  it('regression — "vehicular" does not silently re-show the unrelated current quote', async () => {
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const { service, telegram, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: vidaProduct.id, productCategory: 'vida' },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('vehicular'));
    await service.handleMessage({});
    expect(quoting.bestQuote).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain(vidaProduct.name);
    expect(sentText.toLowerCase()).toMatch(/no tengo|no ofrecemos|no cuento con/);
  });

  it('regression — "seguro vehicular" (fuller phrasing) is also recognized as out-of-catalog', async () => {
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const { service, telegram } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: vidaProduct.id, productCategory: 'vida' },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('seguro vehicular'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain(vidaProduct.name);
  });

  it('still re-shows the current quote for a genuinely neutral follow-up (no regression on the real product name test above)', async () => {
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const { service, telegram } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: vidaProduct.id, productCategory: 'vida' },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿cuánto dura la cobertura?'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(vidaProduct.name);
  });

  // Real live-test bug: asistencias-multiples genuinely covers "Asistencia vehículo" —
  // asking about THAT coverage while it's on screen must not get the same "no tengo
  // seguros de vehículos" denial as someone asking for a dedicated car-insurance policy.
  it('regression — does NOT deny vehicle coverage when the shown product already includes "Asistencia vehículo"', async () => {
    const asistenciasMultiples = PRODUCTS.find(p => p.id === 'asistencias-multiples')!;
    const { service, telegram } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: asistenciasMultiples.id, productCategory: 'asistencia' },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿la asistencia también cubre si se vara mi vehículo?'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).not.toMatch(/no tengo seguros de vehículos/);
  });

  it('still denies a genuinely unrelated vehicle request when nothing shown covers it (e.g. a vida quote)', async () => {
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const { service, telegram } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: vidaProduct.id, productCategory: 'vida' },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿y tienen seguro para mi carro?'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/no tengo|no ofrecemos|no cuento con/);
  });
});

// QUOTE_PRESENTED — explain/compare meta-questions (2026-07-26 live bug)
// "¿Cuál es mejor?" / "Cuéntame más de ellos" / "Explícame de qué se trata" carry no
// affirmative/negative/alternative signal, so they used to fall through to the same
// truncated quote card being silently re-shown every time — read by the user as "it just
// pushes the most complete option no matter what I ask". These must get the actual
// product detail instead.
describe('AgentService — QUOTE_PRESENTED explain/compare meta-questions', () => {
  it.each([
    '¿Cuál es mejor?',
    'Cuéntame más de ellos',
    'Explícame de qué se trata',
    '¿Qué beneficios tiene?',
    '¿Cuál de todos es mejor para mi?',
  ])('"%s" answers with the real product detail, not the truncated quote-card re-show', async (text) => {
    const product = PRODUCTS.find((p) => p.coverages.length >= 3)!;
    const { service, telegram } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: product.id, shownProductIds: [product.id] },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage(text));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(product.name);
    expect(sentText).not.toContain('Tu cotización personalizada'); // proves it's NOT the neutral re-show
    for (const coverage of product.coverages) {
      expect(sentText).toContain(coverage); // full list, not formatQuote's top-3 truncation
    }
  });

  it('names the other already-shown product when more than one was presented this session', async () => {
    const p1 = PRODUCTS[0];
    const p2 = PRODUCTS[1];
    const { service, telegram } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: p1.id, shownProductIds: [p1.id, p2.id] },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿cuál es mejor?'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(p2.name);
  });

  it('does not name any other product when only one has been shown', async () => {
    const p1 = PRODUCTS[0];
    const { service, telegram } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: p1.id, shownProductIds: [p1.id] },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('cuéntame más'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('También te mostré');
  });

  it('does NOT fire when there is no current product (falls through to the generic placeholder)', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: {},
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿cuál es mejor?'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('También te mostré');
    expect(sentText).not.toContain('Ver detalles');
  });
});

// QUOTE_PRESENTED — cross-sell for the human owner

describe('AgentService — QUOTE_PRESENTED cross-sell for personal coverage', () => {
  it('regression — asking about coverage "para mí" during a pet quote defers it instead of abandoning the pending purchase', async () => {
    // 2026-07-24 "restore the flow": a quote in progress must never be abandoned for a
    // cross-sell mention — real live-test bug, repeated across many live sessions: "para
    // mí, qué hay" during an UNCONFIRMED mascotas quote used to immediately replace it
    // with a different product, so the mascotas purchase was silently dropped before
    // ever reaching payment ("continue offering products when I already chose"). Now it
    // acknowledges, keeps the pet quote pending, and defers the follow-up until after
    // this purchase is paid (see wompi-webhook.controller.ts).
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: petProduct.id, productCategory: 'mascotas', petType: 'gato', petCount: 1 },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Me interesan mascotas y para mí ¿qué hay?'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(petProduct.name);
    expect(sentText.toLowerCase()).toMatch(/confirmamos|sí/);
    // Stays on the pet quote — the purchase in progress is never interrupted
    const saveCall = conversations.saveState.mock.calls[0];
    expect(saveCall?.[1]).toBe(ConversationState.QUOTE_PRESENTED);
    expect(saveCall?.[2].quoteProductId).toBe(petProduct.id);
    expect(saveCall?.[2]).toHaveProperty('pendingCrossSell');
  });

  it('does not trigger cross-sell when the current quote is not a pet product', async () => {
    const humanProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const { service, telegram } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: humanProduct.id, productCategory: 'vida' },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('y para mí ¿qué más hay?'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(humanProduct.name);
  });

  it('regression — cross-sell takes priority even when isAffirmative is true (real live-test bug)', async () => {
    // Real bug: "Quiero ser mascotas, muéstrame ese de salud de accidentes para mí."
    // contains "quiero" (an isAffirmative trigger word) with no question mark, so
    // isAffirmative won a race against cross-sell detection and sent the user straight
    // to DATA_CAPTURE for the PET quote — completely ignoring the "para mí" request.
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: petProduct.id, productCategory: 'mascotas', petCount: 3 },
      intent: makeIntent({ isAffirmative: true, isNegative: false, wantsAlternative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Quiero, muéstrame ese de salud de accidentes para mí.'));
    await service.handleMessage({});
    expect(conversations.saveState).not.toHaveBeenCalledWith(
      expect.anything(), ConversationState.DATA_CAPTURE, expect.anything(),
    );
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/vida|accidentes|asistencia/);
  });

  it('regression — remembers the named category as the deferred follow-up instead of losing it', async () => {
    // The cross-sell message often already names a specific category (e.g. "muéstrame
    // ese de salud de accidentes para mí" → 'accidentes') — that information must not be
    // thrown away just because it's deferred; it becomes context.pendingCrossSell so the
    // post-purchase follow-up offers THAT category specifically, not a generic "algo más?".
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    const { service, telegram, quoting, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: petProduct.id, productCategory: 'mascotas', petCount: 3 },
      intent: makeIntent({ isAffirmative: true, isNegative: false, wantsAlternative: false, productCategory: 'accidentes' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Quiero ser mascotas, muéstrame ese de salud de accidentes para mí.'));
    await service.handleMessage({});
    expect(quoting.bestQuote).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(petProduct.name);
    const saveCall = conversations.saveState.mock.calls[0];
    expect(saveCall?.[1]).toBe(ConversationState.QUOTE_PRESENTED);
    expect(saveCall?.[2].quoteProductId).toBe(petProduct.id);
    expect(saveCall?.[2].pendingCrossSell).toBe('accidentes');
  });
});

describe('AgentService — QUOTE_PRESENTED explicit category mention defers, does not abandon the quote', () => {
  it('regression — naming a different category by name defers it instead of replacing the pending quote', async () => {
    // 2026-07-24 "restore the flow": while viewing an "asistencia" quote, "quiero ver
    // seguro de vida" used to immediately REPLACE it — the asistencia purchase was
    // abandoned mid-flow, before ever reaching payment. Now it's deferred: the current
    // quote stays pending, and the named category becomes the post-purchase follow-up.
    const asistenciaProduct = PRODUCTS.find(p => p.category === 'asistencia')!;
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: asistenciaProduct.id, productCategory: 'asistencia' },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: 'vida' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Quiero ver seguro de vida.'));
    await service.handleMessage({});
    expect(quoting.bestQuote).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(asistenciaProduct.name);
    const saveCall = conversations.saveState.mock.calls[0];
    expect(saveCall?.[1]).toBe(ConversationState.QUOTE_PRESENTED);
    expect(saveCall?.[2].quoteProductId).toBe(asistenciaProduct.id);
    expect(saveCall?.[2].pendingCrossSell).toBe('vida');
  });

  it('regression — defers even when isAffirmative is also true (a category name is not a confirmation)', async () => {
    const asistenciaProduct = PRODUCTS.find(p => p.category === 'asistencia')!;
    const { service, telegram, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: asistenciaProduct.id, productCategory: 'asistencia' },
      intent: makeIntent({ isAffirmative: true, isNegative: false, wantsAlternative: false, productCategory: 'vida' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Quiero ver seguro de vida.'));
    await service.handleMessage({});
    expect(quoting.bestQuote).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(asistenciaProduct.name);
  });

  it('does not switch when the named category matches the currently quoted product', async () => {
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const { service, telegram, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: vidaProduct.id, productCategory: 'vida' },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: 'vida' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿el de vida cubre incapacidad?'));
    await service.handleMessage({});
    expect(quoting.bestQuote).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(vidaProduct.name);
  });

  it('regression — a plain confirmation reaches DATA_CAPTURE even if the LLM spuriously sets productCategory with no category actually named in the text', async () => {
    // Real live-test bug: "Sí, quiero esa." confirmed a shown quote, but the LLM
    // sometimes returns a productCategory value anyway despite the message naming no
    // category at all — this used to hijack a clear purchase confirmation into an
    // unwanted category switch, and DATA_CAPTURE was never reached ("after confirm,
    // keeps offering more insurance").
    const asistenciaProduct = PRODUCTS.find(p => p.category === 'asistencia')!;
    const { service, telegram, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      // phoneVerified: true — this test is about the category-hijack bug, not KYC; the
      // phone-verification gate itself is covered by 'AgentService — KYC phone
      // verification gate' above.
      context: { quoteProductId: asistenciaProduct.id, productCategory: 'asistencia', phoneVerified: true },
      intent: makeIntent({ isAffirmative: true, isNegative: false, wantsAlternative: false, productCategory: 'vida' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Sí, quiero esa.'));
    await service.handleMessage({});
    expect(quoting.bestQuote).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/documento de identidad|cédula/);
  });
});

// DISCOVERY — mixed pets clarification

describe('AgentService — DISCOVERY mixed pets', () => {
  it('regression — mixto petType triggers clarification question', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: 'mascotas', petType: 'mixto' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('tengo un gato y dos perros'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0][1] as string;
    expect(sentText).toContain('gato');
    expect(sentText).toContain('perros');
    // Must save mixto context (not transition to QUOTE_PRESENTED yet)
    expect(conversations.saveState).not.toHaveBeenCalledWith(
      expect.anything(), ConversationState.QUOTE_PRESENTED, expect.anything(),
    );
  });

  // Live bug (2026-08-18, Telegram voice): "Tengo dos perros y un gato." already answers
  // the breakdown question, and the counts ARE captured from it — but the mixto branch
  // asked "¿Cuántos gatos y cuántos perros tienes?" anyway, so the user had to repeat
  // themselves. The context assertion in the test below this one never caught it because
  // it checks the saved counts, not the reply the person actually reads.
  it('regression — counts stated in the SAME message that reveals a mixed household are not asked for again', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: 'mascotas', petType: 'mixto', petCount: 3 }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Tengo dos perros y un gato'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toMatch(/cuántos gatos y cuántos perros/i);
    expect(sentText).toContain('1 gato');
    expect(sentText).toContain('2 perros');
    expect(sentText).toMatch(/para todos/i);
  });

  it('regression — "para todos" without species counts asks for quantity breakdown instead of quoting', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: 'mixto', productCategory: 'mascotas' },
      intent: makeIntent({ productCategory: 'mascotas', petResolution: 'all' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('para todos'));
    await service.handleMessage({});
    // Should stay in DISCOVERY and ask for quantity breakdown (not quote a single product)
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('gatos');
    expect(sentText).toContain('perros');
    expect(conversations.saveState).not.toHaveBeenCalledWith(
      expect.anything(), ConversationState.QUOTE_PRESENTED, expect.anything(),
    );
  });

  // Real live-test bug: a genuinely mixed household (2 dogs + 1 cat) got quoted a
  // SINGLE product (medicina-prepagada-gatos, cat-only) multiplied by the TOTAL pet
  // count (3) — charging the 2 dogs at the cat rate. The user explicitly rejected it:
  // "eso no es para gatos, para los perros que hay". A mixto household with an explicit
  // per-species count must be quoted as BOTH species-specific products, each priced
  // against its OWN count, not one product against the combined total.
  it('regression — a mixed household (2 dogs + 1 cat) is quoted BOTH species products at their own per-species price, not one product x total count', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: 'mascotas', petType: 'mixto', petCount: 3 }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Tengo dos perros, una gata y yo.'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.petSpeciesCounts).toEqual({ gato: 1, perro: 2 });

    // Second turn: "para todos" should now build a combined multi-species quote instead
    // of picking a single product via bestQuote.
    const { service: service2, telegram: telegram2, conversations: conversations2 } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: 'mixto', productCategory: 'mascotas', petCount: 3, petSpeciesCounts: { gato: 1, perro: 2 } },
      intent: makeIntent({ productCategory: 'mascotas', petResolution: 'all' }),
    });
    telegram2.normalize.mockResolvedValue(makeMessage('para todos'));
    await service2.handleMessage({});
    const sentText = telegram2.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('gatos');
    expect(sentText).toContain('perros');
    expect(sentText).toContain('81.800');
    expect(sentText).toContain('96.600');
    // 1 cat x 81.800 + 2 dogs x 96.600 = 275.000 — never the old wrong total (3 x 81.800 = 245.400)
    expect(sentText).toContain('275.000');
    expect(sentText).not.toContain('245.400');
    const savedContext2 = conversations2.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext2.selectedProductIds).toEqual(
      expect.arrayContaining(['medicina-prepagada-gatos', 'medicina-prepagada-perros']),
    );
  });

  // Real live-test bug (2026-07-26, screenshot): "Ambos." → agent asks "¿cuántos gatos y
  // cuántos perros tienes?" → user answers "Una gata y dos perros." (both counts in ONE
  // message) — but the NLP layer also classified this same message's petResolution as
  // 'perro' (mentioning "perros" read as a species choice, not a count-question answer),
  // which narrowed straight to a SINGLE product (medicina-prepagada-perros x2) and
  // silently dropped the cat from the quote entirely — no combined quote, no ask, the cat
  // just vanished. Giving counts for BOTH species in one message is itself unambiguous
  // evidence the user wants BOTH insured, regardless of what petResolution says — the
  // correct next step is the "gatos, perros, o todos?" question (restored below, this
  // is the flow that worked this morning), never a silent narrow to one species.
  it('regression — reporting both species counts in one message ("Una gata y dos perros") asks gatos/perros/todos, never silently narrows to a single species', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: 'mixto', productCategory: 'mascotas' },
      // Simulates the real misclassification: petResolution='perro' even though the
      // message also names "una gata" — the exact NLP quirk that caused the live bug.
      intent: makeIntent({ productCategory: 'mascotas', petResolution: 'perro' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Una gata y dos perros.'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('¿Quieres el seguro para los gatos, los perros, o para todos?');
    expect(sentText).toContain('1 gato');
    expect(sentText).toContain('2 perros');
    expect(sentText).not.toContain('Tu cotización personalizada');
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.petSpeciesCounts).toEqual({ gato: 1, perro: 2 });
    expect(savedContext.petType).toBe('mixto'); // never narrowed away by the misread petResolution
  });

  // Same bug as above, but split across TWO messages instead of one — completing a
  // partial count ("un gato" then "dos perros") also mentions the completing species,
  // which can equally get petResolution misread as a narrowing ('perro') rather than a
  // count supplement. The fix must clear it based on the MERGED per-species counts
  // (both known after this turn), not just on what the current message alone mentioned.
  it('regression — completing a split count answer ("un gato" then "dos perros") asks gatos/perros/todos, even if the 2nd message\'s petResolution is misread as a single species', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: 'mixto', productCategory: 'mascotas', petSpeciesCounts: { gato: 1, perro: 0 } },
      intent: makeIntent({ productCategory: 'mascotas', petResolution: 'perro' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('dos perros'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('¿Quieres el seguro para los gatos, los perros, o para todos?');
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.petSpeciesCounts).toEqual({ gato: 1, perro: 2 });
    expect(savedContext.petType).toBe('mixto');
  });

  // The individual-vs-ambos question's answer is handled by the petResolution branches
  // above on the NEXT turn — "para todos" builds the combined quote.
  it('"para todos" after the gatos/perros/todos question quotes BOTH species products, each at its own per-species price', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: 'mixto', productCategory: 'mascotas', petSpeciesCounts: { gato: 1, perro: 2 } },
      intent: makeIntent({ productCategory: 'mascotas', petResolution: 'all' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('para todos'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('gatos');
    expect(sentText).toContain('perros');
    expect(sentText).toContain('275.000');
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.selectedProductIds).toEqual(
      expect.arrayContaining(['medicina-prepagada-gatos', 'medicina-prepagada-perros']),
    );
  });

  // Real live-test bug (2026-07-26): after the correct combined mixed-species quote
  // above, "otro" searched for a totally unrelated THIRD product (e.g.
  // asistencia-veterinaria) and priced it against the raw cross-species petCount (3) —
  // wrong total, AND a consent mismatch: saying "sí" right after would silently confirm
  // the ORIGINAL 2-product purchase, not the different product just shown.
  it('regression — "otro" during an active mixed-species purchase re-shows the combined quote instead of a 3rd unrelated product', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: {
        quoteProductId: 'medicina-prepagada-gatos',
        selectedProductIds: ['medicina-prepagada-gatos', 'medicina-prepagada-perros'],
        shownProductIds: ['medicina-prepagada-gatos', 'medicina-prepagada-perros'],
        petCount: 3,
        petSpeciesCounts: { gato: 1, perro: 2 },
        productCategory: 'mascotas',
      },
      intent: makeIntent({ wantsAlternative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('otro'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('gatos');
    expect(sentText).toContain('perros');
    expect(sentText).toContain('275.000');
    expect(sentText).not.toContain('asistencia veterinaria');
    expect(sentText).not.toContain('43.500');
    // Never touched selectedProductIds — no accidental context change from a re-show.
    expect(conversations.saveState).not.toHaveBeenCalled();
  });

  it('regression — an unclear reply during an active mixed-species purchase re-shows the combined quote, not a single mispriced product', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: {
        quoteProductId: 'medicina-prepagada-gatos',
        selectedProductIds: ['medicina-prepagada-gatos', 'medicina-prepagada-perros'],
        shownProductIds: ['medicina-prepagada-gatos', 'medicina-prepagada-perros'],
        petCount: 3,
        petSpeciesCounts: { gato: 1, perro: 2 },
        productCategory: 'mascotas',
      },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Ayudro?'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('gatos');
    expect(sentText).toContain('perros');
    expect(sentText).toContain('275.000');
    // The old bug: single product (gatos, $81.800) x total cross-species count (3).
    expect(sentText).not.toContain('245.400');
  });

  // Real live-test bug (2026-07-26, screenshot): after narrowing a mixto household
  // ("1 gato + 1 perro") down to "solo gato" (petType: 'gato'), asking for "otro"
  // surfaced asistencia-veterinaria (eligibility.pet: 'any') priced against the STALE
  // combined petCount (2) instead of the narrowed single species (1) — the transcript
  // showed "📊 Total para 2 mascotas: $29.000/mes" for a quote the user explicitly asked
  // to be "solo para el gato" (just the cat). petCountForProduct only special-cased
  // gato/perro-RESTRICTED products; an 'any'-eligibility product fell through to the raw
  // combined petCount, ignoring the narrowing entirely.
  it('regression — an "otro" alternative with eligibility.pet="any" respects a narrowed single-species petType, not the stale combined petCount', async () => {
    const gatoProduct = PRODUCTS.find(p => p.id === 'medicina-prepagada-gatos')!;
    const vetProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    expect(vetProduct.eligibility.pet).toBe('any');
    const { service, telegram, quoting } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: {
        quoteProductId: gatoProduct.id,
        shownProductIds: [gatoProduct.id],
        petType: 'gato', // narrowed from mixto via "solo gato"
        petCount: 2, // stale combined total from the original "un gato y un perro"
        petSpeciesCounts: { gato: 1, perro: 1 },
        productCategory: 'mascotas',
      },
      intent: makeIntent({ wantsAlternative: true }),
    });
    quoting.score.mockReturnValue([
      { productId: vetProduct.id, matchScore: 70, reasons: ['Desde $14.500/mes'], monthlyPremium: vetProduct.basePremium, priority: 'medium' },
    ]);
    telegram.normalize.mockResolvedValue(makeMessage('otro'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('$14.500/mes por mascota');
    expect(sentText).not.toContain('Total para');
    expect(sentText).not.toContain('29.000');
  });

  it('"el gato" after mixto clarification sets petType gato', async () => {
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: 'mixto', productCategory: 'mascotas' },
      intent: makeIntent({ productCategory: 'mascotas', petResolution: 'gato' }),
    });
    const gatoProduct = PRODUCTS.find(p => p.id === 'medicina-prepagada-gatos')!;
    quoting.bestQuote.mockReturnValue({ product: gatoProduct, score: { reasons: ['Para gatos'], matchScore: 80, monthlyPremium: gatoProduct.basePremium, priority: 'high', productId: gatoProduct.id } });
    telegram.normalize.mockResolvedValue(makeMessage('el gato'));
    await service.handleMessage({});
    const saveCall = conversations.saveState.mock.calls[0];
    if (saveCall) {
      const savedContext = saveCall[2] as ConversationContext;
      // petType should be resolved to gato (not remain mixto)
      expect(savedContext.petType).not.toBe('mixto');
    }
  });
});

// QUOTE_PRESENTED — switching species after narrowing a mixed-species quote
// Real live-test bug (2026-07-26, screenshot): "solo perros" worked (narrowed the
// combined gato+perro quote down to just perros), but a FOLLOW-UP "solo gato" — trying
// to switch to the OTHER species — just re-showed the SAME perros quote, and asking to
// see "todos" (both) again didn't restore the combined quote either. Root cause: the
// switching guard gated on `context.selectedProductIds.length > 1`, true only for the
// ORIGINAL combined quote — once narrowed to one species, selectedProductIds.length
// becomes 1, so the guard never fired again for any later switch. This describe block
// had zero test coverage before this fix — the gap that let it ship broken.
describe('AgentService — QUOTE_PRESENTED switching species in a mixed household', () => {
  it('regression — "solo gato" after already narrowing to "solo perros" switches to the cat quote, not a repeat of perros', async () => {
    const gatoProduct = PRODUCTS.find(p => p.id === 'medicina-prepagada-gatos')!;
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: {
        quoteProductId: 'medicina-prepagada-perros',
        selectedProductIds: ['medicina-prepagada-perros'], // already narrowed to perros
        shownProductIds: ['medicina-prepagada-gatos', 'medicina-prepagada-perros'],
        petType: 'perro',
        petSpeciesCounts: { gato: 1, perro: 2 },
        productCategory: 'mascotas',
      },
      intent: makeIntent({ petResolution: 'gato' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('solo el gato'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(gatoProduct.name);
    expect(sentText).toContain('81.800');
    expect(sentText).not.toContain('96.600');
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.petType).toBe('gato');
    expect(savedContext.selectedProductIds).toEqual(['medicina-prepagada-gatos']);
    expect(savedContext.quoteProductId).toBe('medicina-prepagada-gatos');
  });

  it('regression — "todos" after narrowing to a single species restores the combined quote for both', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: {
        quoteProductId: 'medicina-prepagada-perros',
        selectedProductIds: ['medicina-prepagada-perros'],
        shownProductIds: ['medicina-prepagada-gatos', 'medicina-prepagada-perros'],
        petType: 'perro',
        petSpeciesCounts: { gato: 1, perro: 2 },
        productCategory: 'mascotas',
      },
      intent: makeIntent({ petResolution: 'all' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('quiero ver todos de nuevo'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('gatos');
    expect(sentText).toContain('perros');
    expect(sentText).toContain('275.000');
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.selectedProductIds).toEqual(
      expect.arrayContaining(['medicina-prepagada-gatos', 'medicina-prepagada-perros']),
    );
  });

  it('switching species from the ORIGINAL combined quote still works (unchanged behavior)', async () => {
    const perroProduct = PRODUCTS.find(p => p.id === 'medicina-prepagada-perros')!;
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: {
        quoteProductId: 'medicina-prepagada-gatos',
        selectedProductIds: ['medicina-prepagada-gatos', 'medicina-prepagada-perros'],
        shownProductIds: ['medicina-prepagada-gatos', 'medicina-prepagada-perros'],
        petSpeciesCounts: { gato: 1, perro: 2 },
        productCategory: 'mascotas',
      },
      intent: makeIntent({ petResolution: 'perro' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('solo los perros'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(perroProduct.name);
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.selectedProductIds).toEqual(['medicina-prepagada-perros']);
  });
});

// DATA_CAPTURE — pet-count collection respects a narrowed single-species purchase
// Real live-test bug (2026-07-26, screenshot): after narrowing a mixed household ("1
// gata + 2 perros") down to "solo perros", the per-pet details summary still showed 3
// pets (Bruna the cat included) instead of 2 (only the dogs) — firstDataCaptureQuestion
// and the pet-collection loop both used the raw combined context.petCount as "how many
// pets to collect", the same bug class already fixed for pricing (petCountForProduct)
// but never applied to pet-name collection.
describe('AgentService — DATA_CAPTURE pet count respects species narrowing', () => {
  it('regression — after narrowing to "solo perros", only 2 pets (not the combined 3) are asked for', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        selectedProductIds: ['medicina-prepagada-perros'],
        quoteProductId: 'medicina-prepagada-perros',
        petSpeciesCounts: { gato: 1, perro: 2 },
        petCount: 3, // stale combined total from before narrowing
        productCategory: 'mascotas',
        phoneVerified: true, selfieProvided: true,
      },
      intent: makeIntent({ pets: [{ name: 'Ramón', age: '3 años', breed: 'doberman' }] }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Ramón, 3 años, doberman.'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('mascota 2 de 2');
    expect(sentText).not.toContain('de 3');
  });

  it('regression — a combined (unnarrowed) purchase still asks for the full 3 pets (unchanged behavior)', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        selectedProductIds: ['medicina-prepagada-gatos', 'medicina-prepagada-perros'],
        quoteProductId: 'medicina-prepagada-gatos',
        petSpeciesCounts: { gato: 1, perro: 2 },
        petCount: 3,
        productCategory: 'mascotas',
        phoneVerified: true, selfieProvided: true,
      },
      intent: makeIntent({ pets: [{ name: 'Bruna', age: '10 años', breed: 'criollo' }] }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Bruna, 10 años, criollo.'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('mascota 2 de 3');
  });

  // Cross-sell combo (vida + a pet product) must never count the non-pet product
  // toward "how many pets to collect" — regression guard for the fix's own scoping.
  it('regression — a vida+mascotas cross-sell combo counts only the pet product\'s own pets, not one extra for vida', async () => {
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const { service, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {
        selectedProductIds: [vidaProduct.id, 'asistencia-veterinaria'],
        quoteProductId: vidaProduct.id,
        petCount: 1,
        pets: [{ name: 'Max', age: '3 años', breed: 'Labrador' }],
        cedula: '123456789', nombre: 'Juan Pérez', email: 'juan@test.com',
      },
      intent: makeIntent({ isAffirmative: true }),
    });
    await service.handleMessage({});
    // With 1 pet already collected and totalPetsForPurchase correctly excluding the
    // vida product, this must proceed past pet-collection (to cédula/name/email, already
    // set here, straight to confirmation) instead of getting stuck asking for a 2nd pet.
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.pets).toEqual([{ name: 'Max', age: '3 años', breed: 'Labrador' }]);
  });
});

// DISCOVERY — productCategory inference + ages loop regression

describe('AgentService — DISCOVERY productCategory inference', () => {
  it('infers productCategory mascotas from petType gato when NLP does not extract it', async () => {
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      // petType already resolved to gato (post-mixto clarification), productCategory NOT set
      context: { petType: 'gato', coverage: ['medicina veterinaria'], beneficiaries: 1 },
      intent: makeIntent({ productCategory: null, petResolution: null }),
    });
    const gatoProduct = PRODUCTS.find(p => p.id === 'medicina-prepagada-gatos')!;
    quoting.bestQuote.mockReturnValue({
      product: gatoProduct,
      score: { reasons: ['Para gatos'], matchScore: 80, monthlyPremium: gatoProduct.basePremium, priority: 'high', productId: gatoProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('10 años mi gata'));
    await service.handleMessage({});
    // Should advance to QUOTE_PRESENTED, not loop on ages question
    expect(quoting.bestQuote).toHaveBeenCalled();
    const saveCall = conversations.saveState.mock.calls[0];
    expect(saveCall?.[1]).toBe(ConversationState.QUOTE_PRESENTED);
  });

  it('regression — ages answer does not loop back to ages question', async () => {
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      // All three discovery answers given: coverage, beneficiaries, productCategory via petType
      context: { petType: 'gato', coverage: ['medicina veterinaria'], beneficiaries: 2 },
      intent: makeIntent({ productCategory: null }),
    });
    const gatoProduct = PRODUCTS.find(p => p.id === 'medicina-prepagada-gatos')!;
    quoting.bestQuote.mockReturnValue({
      product: gatoProduct,
      score: { reasons: ['Para gatos'], matchScore: 80, monthlyPremium: gatoProduct.basePremium, priority: 'high', productId: gatoProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('10 años mi gata, 7 años mi perro y 33 años'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    // Must NOT repeat the ages question
    expect(sentText).not.toContain('rango de edades');
    // Must present a quote
    expect(sentText).toContain(gatoProduct.name);
  });

  it('no match found — sends redirect message instead of repeating ages', async () => {
    const { service, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: 'gato', coverage: ['medicina veterinaria'], beneficiaries: 1 },
      intent: makeIntent({ productCategory: null }),
    });
    quoting.bestQuote.mockReturnValue(null);
    telegram.normalize.mockResolvedValue(makeMessage('10 años'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('rango de edades');
    expect(sentText).toContain('diferente');
  });
});

// DISCOVERY — catalog-honesty bridge (2026-07-26, Step 5)
// "Quiero asegurar mi carro" during DISCOVERY had no branch at all — no vehicular/
// empresa product exists, so it silently extracted no category and looped forever on
// the generic tier-1 question. QUOTE_PRESENTED already had this exact check
// (detectOutOfCatalogCategory); DISCOVERY never did.
describe('AgentService — DISCOVERY catalog-honesty bridge', () => {
  it('regression — "quiero asegurar mi carro" gives an honest redirect instead of looping', async () => {
    const { service, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('quiero asegurar mi carro'));
    await service.handleMessage({});
    expect(quoting.bestQuote).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/no tengo seguros de vehículos/);
    expect(sentText.toLowerCase()).toMatch(/vida, accidentes, asistencia médica y mascotas/);
  });

  it('"mi empresa necesita un seguro" also redirects honestly', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('mi empresa necesita un seguro'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/no tengo seguros de empresas/);
  });

  it('does NOT hijack a real life story that happens to contain "empresa" once a real category already matched', async () => {
    const { service, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: 'vida' }),
    });
    const vidaProduct = PRODUCTS.find((p) => p.category === 'vida')!;
    quoting.bestQuote.mockReturnValue({
      product: vidaProduct,
      score: { reasons: [], matchScore: 40, monthlyPremium: vidaProduct.basePremium, priority: 'medium', productId: vidaProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('tengo dos hijos y una empresa'));
    await service.handleMessage({});
    expect(quoting.bestQuote).toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toMatch(/no tengo seguros de empresas/i);
  });

  it('still asks the normal tier-1 question for genuinely unrelated/unclear text (no regression)', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('hola quiero saber más'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toMatch(/no tengo seguros de/i);
  });
});

// DISCOVERY — pet count + quote clarity

describe('AgentService — DISCOVERY pet count and quote pricing', () => {
  // petType: 'perro' below — these 3 tests are about petCount/pricing propagation, not
  // species resolution, so species is already known going in. The "species unknown"
  // case (which used to quote blind) is its own describe block below.
  it('petCount from intent is saved to context', async () => {
    const { service, conversations, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: 'perro', coverage: ['medicina veterinaria'], productCategory: 'mascotas' },
      intent: makeIntent({ productCategory: 'mascotas', petCount: 3 }),
    });
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    quoting.bestQuote.mockReturnValue({ product: petProduct, score: { reasons: ['Para mascotas'], matchScore: 60, monthlyPremium: petProduct.basePremium, priority: 'high', productId: petProduct.id } });
    telegram.normalize.mockResolvedValue(makeMessage('para todos'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext?.petCount).toBe(3);
  });

  it('quote for pet product always labels price as "por mascota"', async () => {
    const { service, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: 'perro', coverage: ['medicina veterinaria'], productCategory: 'mascotas', petCount: 3 },
      intent: makeIntent({ productCategory: 'mascotas' }),
    });
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    quoting.bestQuote.mockReturnValue({ product: petProduct, score: { reasons: ['Para mascotas'], matchScore: 60, monthlyPremium: petProduct.basePremium, priority: 'high', productId: petProduct.id } });
    telegram.normalize.mockResolvedValue(makeMessage('para todos'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('por mascota');
  });

  it('quote for pet product with petCount=3 shows total monthly price', async () => {
    const { service, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: 'perro', coverage: ['medicina veterinaria'], productCategory: 'mascotas', petCount: 3 },
      intent: makeIntent({ productCategory: 'mascotas' }),
    });
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!; // basePremium: 14500
    quoting.bestQuote.mockReturnValue({ product: petProduct, score: { reasons: ['Para mascotas'], matchScore: 60, monthlyPremium: petProduct.basePremium, priority: 'high', productId: petProduct.id } });
    telegram.normalize.mockResolvedValue(makeMessage('para todos'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('43.500'); // 14500 × 3
    expect(sentText).toContain('3 mascotas');
  });

  it('quote for pet product includes note that coverage is for pets, not the owner', async () => {
    const { service, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: 'gato', coverage: ['medicina veterinaria'], productCategory: 'mascotas', petCount: 1 },
      intent: makeIntent({ productCategory: 'mascotas', petType: 'gato' }),
    });
    const petProduct = PRODUCTS.find(p => p.id === 'medicina-prepagada-gatos')!;
    quoting.bestQuote.mockReturnValue({ product: petProduct, score: { reasons: ['Para gatos'], matchScore: 80, monthlyPremium: petProduct.basePremium, priority: 'high', productId: petProduct.id } });
    telegram.normalize.mockResolvedValue(makeMessage('el gato'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/mascota|para ti|también/);
  });
});

// DISCOVERY — must know species before quoting mascotas
// Real live-test gap: "Tengo dos mascotas y yo." went straight to a quote without the
// agent ever learning cat/dog/mixed. The real catalog has species-restricted products
// (medicina-prepagada-gatos / medicina-prepagada-perros) alongside a generic one —
// quoting blind risks missing the more specific, better-matching product and skips the
// per-profile personalization judges look for ("¿por qué este seguro para esta persona?").

describe('AgentService — DISCOVERY asks species before quoting mascotas', () => {
  it('regression — "Tengo dos mascotas y yo" asks cat/dog/mixed instead of quoting blind', async () => {
    const { service, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: 'mascotas', petType: null, petCount: 2 }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('tengo dos mascotas y yo'));
    await service.handleMessage({});
    expect(quoting.bestQuote).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText.toLowerCase()).toMatch(/gatos.*perros|perros.*gatos/);
  });

  it('does not ask again once species is already known', async () => {
    const { service, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: 'perro', productCategory: 'mascotas' },
      intent: makeIntent({ productCategory: 'mascotas' }),
    });
    const petProduct = PRODUCTS.find(p => p.id === 'medicina-prepagada-perros')!;
    quoting.bestQuote.mockReturnValue({ product: petProduct, score: { reasons: [], matchScore: 60, monthlyPremium: petProduct.basePremium, priority: 'high', productId: petProduct.id } });
    telegram.normalize.mockResolvedValue(makeMessage('cuánto cuesta'));
    await service.handleMessage({});
    expect(quoting.bestQuote).toHaveBeenCalled();
  });

  it('does not block the existing mixto (which-pet) clarification, which already implies species is known', async () => {
    const { service, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: 'mascotas', petType: 'mixto' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('tengo un gato y un perro'));
    await service.handleMessage({});
    expect(quoting.bestQuote).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    // 2026-08-18: this asserted "¿Cuántos gatos" — but the message already states both
    // counts, so re-asking them was the repeated-question bug. The guarantee this test
    // exists for is unchanged: the species gate must not swallow the mixto path into a
    // blind quote (bestQuote above). It now lands on the which-pet clarification, which
    // is what the test name says it protects.
    expect(sentText).toMatch(/los gatos, los perros, o para todos/i);
  });
});

// DISCOVERY — unclear/unextractable message acknowledgment

describe('AgentService — DISCOVERY unclear message handling', () => {
  it('regression — message with no extractable signal gets an acknowledgment, not a silent verbatim repeat', async () => {
    // Simulates a short/unclear voice transcription (e.g. "mmh", static, mumbling) —
    // NLP extracts nothing. Repeating the exact same question with no acknowledgment
    // reads as the agent ignoring the user, breaking the "transmite confianza" criterion.
    const { service, telegram } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({}),
    });
    telegram.normalize.mockResolvedValue(makeMessage('mmh no sé'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toMatch(/no logré entender|no te entendí|no entendí bien/i);
  });

  // Real live-test bug: a user answering plain "no" to the opening question ("¿Tienes
  // familia o personas que dependen de ti?...") got the exact same question repeated
  // verbatim (the generic "no logré entender" fallback) instead of a warm pivot toward
  // covering the person themselves — "no dependents" is a valid, common answer.
  it('regression — a plain "no" to the opening discovery question pivots to personal coverage instead of repeating it', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ isNegative: true, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('no'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toMatch(/no logré entender/i);
    expect(sentText).not.toContain('¿Tienes familia');
    expect(sentText.toLowerCase()).toMatch(/protegerte a ti mismo|tu salud|tu ingreso/);
  });

  it('a plain "no" mid-conversation (progress already made) does NOT trigger the personal-coverage pivot', async () => {
    // Guard: the pivot is scoped to fresh/early DISCOVERY only — once productCategory is
    // already known, a later "no" must go through the normal alternative/decline handling
    // elsewhere, not this opening-question-specific reframe.
    const { service, telegram } = buildService({
      state: ConversationState.DISCOVERY,
      context: { productCategory: 'vida', coverage: ['protección'] },
      intent: makeIntent({ isNegative: true, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('no'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toMatch(/protegerte a ti mismo/i);
  });

  // Real live-test bug (2026-07-26, screenshot): the symmetric case to the "no" pivot
  // above was missing — "Sí?" answering "¿Tienes familia o personas que dependen de ti?"
  // names no category on its own, so it fell through to "No logré entender bien eso."
  // plus the ENTIRE compound question repeated verbatim, reading as the agent ignoring a
  // clear "yes" answer. The user's next message ("1 millón") likely came from genuinely
  // mistaking "tu ingreso" (a category to protect) for a request to state an income
  // figure — a confusion made worse by getting stuck on the same repeated question with
  // no acknowledgment or clearer ask.
  it('regression — "Sí?" to the opening discovery question pivots to a direct category ask instead of repeating the full question', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ isAffirmative: true, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('Sí?'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toMatch(/no logré entender/i);
    expect(sentText).not.toContain('¿Tienes familia');
    expect(sentText.toLowerCase()).toMatch(/tu salud|tu ingreso/);
  });

  it('an affirmative mid-conversation (progress already made) does NOT trigger the opening-question pivot', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DISCOVERY,
      context: { productCategory: 'vida', coverage: ['protección'] },
      intent: makeIntent({ isAffirmative: true, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('¡Perfecto! ¿Qué es lo que más te preocupa proteger');
  });

  it('does not show the "no entendí" acknowledgment when partial progress was made', async () => {
    // productCategory was extracted this turn (progress) even though coverage/beneficiaries
    // are still missing — this must NOT be treated as an unclear/no-signal message.
    const { service, telegram } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: 'vida' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('quiero un seguro de vida'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toMatch(/no logré entender|no te entendí|no entendí bien/i);
  });

  it('regression — quotes a named category even when coverage is empty (fallback NLP never fills coverage)', async () => {
    // Real live-test bug: GroqNlpService.fallbackIntent() (used whenever Groq is
    // unreachable, e.g. LLM_API_KEY unset) always returns coverage: [] — it has no
    // keyword extraction for coverage at all. hasEnoughInfo required BOTH productCategory
    // AND coverage.length, so a clear category signal ("vida, accidentes y asistencia
    // médica") got stuck re-asking the same generic DISCOVERY question forever, even
    // though QuotingService.evaluateProduct only needs productCategory to score a
    // product > 0 — coverage is a scoring bonus there, never a hard requirement.
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const { service, telegram, quoting, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: 'vida', coverage: [] }),
    });
    quoting.bestQuote.mockReturnValue({
      product: vidaProduct,
      score: { reasons: [], matchScore: 40, monthlyPremium: vidaProduct.basePremium, priority: 'medium', productId: vidaProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('vida, accidentes y asistencia médica'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(vidaProduct.name);
    const saveCall = conversations.saveState.mock.calls[0];
    expect(saveCall?.[1]).toBe(ConversationState.QUOTE_PRESENTED);
  });

  it('regression — attempts a quote instead of looping forever on the unanswerable "ages" question', async () => {
    // Real live-test bug: once coverage and beneficiaries are both known (usually from a
    // spurious Groq default — its schema example shows "beneficiaries": 1) but
    // productCategory was never extracted, STATE_RESPONSES[DISCOVERY] asks "¿En qué rango
    // de edades están?" forever — no field in the intent schema captures a human
    // beneficiary's age (only petAge, for pets), and QuotingService never uses ages at
    // all, so this question can NEVER be answered. Live conversation looped 4+ turns on
    // exactly this ("todos", pet ages, "yo tengo 33", family ages) with productCategory
    // stuck at null the entire time.
    const anyProduct = PRODUCTS[0];
    const { service, telegram, quoting, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { coverage: ['todos'], beneficiaries: 1 },
      intent: makeIntent({ productCategory: null, coverage: [], beneficiaries: 1 }),
    });
    quoting.bestQuote.mockReturnValue({
      product: anyProduct,
      score: { reasons: [], matchScore: 20, monthlyPremium: anyProduct.basePremium, priority: 'low', productId: anyProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('Un perrito tiene 7 años, otro 3 y la gatita tiene 10, yo tengo 33.'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('rango de edades');
    const saveCall = conversations.saveState.mock.calls[0];
    expect(saveCall?.[1]).toBe(ConversationState.QUOTE_PRESENTED);
  });

  // Real live-test bug (2026-07-26, screenshot): the guard above required BOTH coverage
  // AND beneficiaries before attempting a best-effort quote — matching the OLD "rango de
  // edades" text's own trigger condition from before the 2026-07-26 cleanup that swapped
  // its copy for "¿Cuántas personas son en tu familia o grupo familiar?" but left this
  // guard's condition untouched. Coverage getting set WITHOUT beneficiaries (e.g. a vague
  // "proteger a mi familia" message) fell through this gap straight to that dead text —
  // confirmed live: it has no functional handler for its own answer at all.
  it('regression — attempts a quote instead of showing the dead "cuántas personas en tu familia" text when coverage is known but beneficiaries never was', async () => {
    const anyProduct = PRODUCTS[0];
    const { service, telegram, quoting, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { coverage: ['familia'] }, // beneficiaries deliberately never set
      intent: makeIntent({ productCategory: null, coverage: [] }),
    });
    quoting.bestQuote.mockReturnValue({
      product: anyProduct,
      score: { reasons: [], matchScore: 20, monthlyPremium: anyProduct.basePremium, priority: 'low', productId: anyProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('quiero proteger a mi familia'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('grupo familiar');
    const saveCall = conversations.saveState.mock.calls[0];
    expect(saveCall?.[1]).toBe(ConversationState.QUOTE_PRESENTED);
  });
});

// DISCOVERY — dependents question (2026-07-26 Step 3)
// Gated on `discoveryFilter`, set ONLY in the AUTHORIZATION→isAffirmative branch — every
// hand-built context in the existing suite never sets it, so this MUST be a strict
// opt-in with zero effect on any test that predates this feature.
describe('AgentService — DISCOVERY dependents question (Step 3)', () => {
  // Firewall test, written first per the plan: without discoveryFilter, behavior is
  // BYTE-FOR-BYTE the pre-Step-3 immediate-quote path.
  it('firewall — without discoveryFilter, quotes immediately exactly as before (no dependents question)', async () => {
    const vidaProduct = PRODUCTS.find((p) => p.category === 'vida')!;
    const { service, telegram, quoting, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: 'vida' }),
    });
    quoting.bestQuote.mockReturnValue({
      product: vidaProduct,
      score: { reasons: [], matchScore: 40, monthlyPremium: vidaProduct.basePremium, priority: 'medium', productId: vidaProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('quiero un seguro de vida'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(vidaProduct.name);
    expect(sentText).not.toContain('dependen de ti');
    expect(conversations.saveState).toHaveBeenCalledWith('conv-1', ConversationState.QUOTE_PRESENTED, expect.anything());
  });

  it('asks the dependents question once, before quoting, when discoveryFilter is set and category is non-mascotas', async () => {
    const { service, telegram, quoting, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { discoveryFilter: true },
      intent: makeIntent({ productCategory: 'vida' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('quiero un seguro de vida'));
    await service.handleMessage({});
    expect(quoting.bestQuote).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('dependen de ti');
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.askedDependents).toBe(true);
  });

  it('does NOT ask the dependents question for a mascotas category (does not change the recommendation)', async () => {
    const { service, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { discoveryFilter: true, petType: 'gato', coverage: ['medicina veterinaria'] },
      intent: makeIntent({ productCategory: 'mascotas', petType: 'gato' }),
    });
    quoting.bestQuote.mockReturnValue({
      product: PRODUCTS.find((p) => p.id === 'medicina-prepagada-gatos')!,
      score: { reasons: [], matchScore: 60, monthlyPremium: 1000, priority: 'high', productId: 'medicina-prepagada-gatos' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('quiero seguro para mi gato'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('dependen de ti');
  });

  it('proceeds to quote on the NEXT turn regardless of whether the answer parsed (never-loop-forever contract)', async () => {
    const vidaProduct = PRODUCTS.find((p) => p.category === 'vida')!;
    const { service, telegram, quoting, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { discoveryFilter: true, askedDependents: true, productCategory: 'vida' },
      intent: makeIntent({ productCategory: 'vida', dependents: null }),
    });
    quoting.bestQuote.mockReturnValue({
      product: vidaProduct,
      score: { reasons: [], matchScore: 40, monthlyPremium: vidaProduct.basePremium, priority: 'medium', productId: vidaProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('no sé qué decirte'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith('conv-1', ConversationState.QUOTE_PRESENTED, expect.anything());
  });

  it('captures dependents=0 ("vivo solo") and does not re-ask, still proceeds to quote', async () => {
    const vidaProduct = PRODUCTS.find((p) => p.category === 'vida')!;
    const { service, telegram, quoting, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { discoveryFilter: true, askedDependents: true, productCategory: 'vida' },
      intent: makeIntent({ productCategory: 'vida', dependents: 0 }),
    });
    quoting.bestQuote.mockReturnValue({
      product: vidaProduct,
      score: { reasons: [], matchScore: 40, monthlyPremium: vidaProduct.basePremium, priority: 'medium', productId: vidaProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('vivo solo'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.dependents).toBe(0);
  });

  it('captures dependents>0 and derives beneficiaries so the family reason can also wake', async () => {
    const vidaProduct = PRODUCTS.find((p) => p.category === 'vida')!;
    const { service, telegram, quoting, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { discoveryFilter: true, askedDependents: true, productCategory: 'vida' },
      intent: makeIntent({ productCategory: 'vida', dependents: 2 }),
    });
    quoting.bestQuote.mockReturnValue({
      product: vidaProduct,
      score: { reasons: [], matchScore: 40, monthlyPremium: vidaProduct.basePremium, priority: 'medium', productId: vidaProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('tengo dos hijos'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.dependents).toBe(2);
    expect(savedContext.beneficiaries).toBe(3);
  });

  it('does not re-ask when askedDependents is already true, even mid-conversation', async () => {
    const { service, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { discoveryFilter: true, askedDependents: true, productCategory: 'vida', dependents: 2 },
      intent: makeIntent({ productCategory: 'vida' }),
    });
    quoting.bestQuote.mockReturnValue({
      product: PRODUCTS.find((p) => p.category === 'vida')!,
      score: { reasons: [], matchScore: 40, monthlyPremium: 1000, priority: 'medium', productId: 'vida' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('sigo aquí'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('dependen de ti');
  });
});

// DISCOVERY — urgency capture (2026-07-26, Matriz 2 C05)
// Already inferred by the NLP layer from words like "urgente"/"ya" — no new question,
// just wiring an existing-but-dead field into context and, from there, into scoring.
describe('AgentService — DISCOVERY urgency capture', () => {
  it('captures urgency=immediate into context and passes it through to the quote', async () => {
    const vidaProduct = PRODUCTS.find((p) => p.category === 'vida')!;
    const { service, telegram, quoting, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: 'vida', urgency: 'immediate' }),
    });
    quoting.bestQuote.mockReturnValue({
      product: vidaProduct,
      score: { reasons: [], matchScore: 40, monthlyPremium: vidaProduct.basePremium, priority: 'medium', productId: vidaProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('necesito un seguro urgente'));
    await service.handleMessage({});
    expect(quoting.bestQuote).toHaveBeenCalledWith(expect.objectContaining({ urgency: 'immediate' }));
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.urgency).toBe('immediate');
  });

  it('a later "immediate" signal overrides an earlier "exploring" one in the same conversation', async () => {
    const vidaProduct = PRODUCTS.find((p) => p.category === 'vida')!;
    const { service, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { productCategory: 'vida', urgency: 'exploring' },
      intent: makeIntent({ productCategory: 'vida', urgency: 'immediate' }),
    });
    quoting.bestQuote.mockReturnValue({
      product: vidaProduct,
      score: { reasons: [], matchScore: 40, monthlyPremium: vidaProduct.basePremium, priority: 'medium', productId: vidaProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('en realidad lo necesito ya'));
    await service.handleMessage({});
    expect(quoting.bestQuote).toHaveBeenCalledWith(expect.objectContaining({ urgency: 'immediate' }));
  });

  it('does not overwrite an already-captured "immediate" with a later "exploring"', async () => {
    const vidaProduct = PRODUCTS.find((p) => p.category === 'vida')!;
    const { service, telegram, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { productCategory: 'vida', urgency: 'immediate' },
      intent: makeIntent({ productCategory: 'vida', urgency: 'exploring' }),
    });
    quoting.bestQuote.mockReturnValue({
      product: vidaProduct,
      score: { reasons: [], matchScore: 40, monthlyPremium: vidaProduct.basePremium, priority: 'medium', productId: vidaProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('cuéntame más'));
    await service.handleMessage({});
    expect(quoting.bestQuote).toHaveBeenCalledWith(expect.objectContaining({ urgency: 'immediate' }));
  });
});

// DISCOVERY — lost-context resilience

describe('AgentService — DISCOVERY lost-context resilience', () => {
  it('regression — ages answer with lost petType (coverage set) does not re-trigger mixto loop', async () => {
    // Simulates context.petType being lost (e.g., server restart wiped cache) but
    // coverage survived in DB. Without the guard, intent.petType='mixto' would cause
    // the clarification question to fire again indefinitely.
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { petType: null, coverage: ['medicina veterinaria'], productCategory: null },
      intent: makeIntent({ productCategory: 'mascotas', petType: 'mixto' }),
    });
    const petProduct = PRODUCTS.find(p => p.id === 'asistencia-veterinaria')!;
    quoting.bestQuote.mockReturnValue({
      product: petProduct,
      score: { reasons: ['Para mascotas'], matchScore: 60, monthlyPremium: petProduct.basePremium, priority: 'high', productId: petProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('10 años mi gata, 7 años mi perro y 33 yo'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('familia de mascotas');
    expect(sentText).not.toContain('Para cuál');
    const saveCall = conversations.saveState.mock.calls[0];
    if (saveCall) expect(saveCall[1]).toBe(ConversationState.QUOTE_PRESENTED);
  });
});

// Post-purchase cross-sell decline (2026-07-24 live bug)
// After a purchase, wompi-webhook.controller.ts asks "¿Quieres proteger algo más?" and
// resets the conversation to DISCOVERY. A decline ("No, está bien así.") used to fall
// through DISCOVERY's generic "no entendí" acknowledgment — the agent literally
// ignoring a clear, polite "I'm done" right after a purchase.
describe('AgentService — DISCOVERY polite decline of the post-purchase cross-sell offer', () => {
  it('regression — declining ends the conversation politely instead of "no entendí"', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com', awaitingCrossSellResponse: true },
      intent: makeIntent({ isNegative: true }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('No, está bien así.'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toMatch(/no logré entender/i);
    expect(sentText.toLowerCase()).toMatch(/gracias|perfecto|hasta luego|aquí estoy|cuando quieras/);
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.COMPLETED, expect.objectContaining({ awaitingCrossSellResponse: undefined }),
    );
  });

  // Real live-test bug: Groq's isNegative classification has no prompt example covering
  // elliptical negations like these, and misclassified both as isNegative=false — the
  // decline went unrecognized, the one-shot awaitingCrossSellResponse flag was consumed
  // anyway, and the conversation kept cycling (generic "no entendí" re-ask) instead of
  // ending on the very first "no". A message that starts with the standalone word "no"
  // is an unambiguous decline regardless of what the LLM extracted.
  it.each([
    'No, ningún otro. Gracias.',
    'No, no estoy interesado en ningún.',
  ])('regression — %j ends the conversation even when Groq misclassifies isNegative as false', async (spoken) => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com', awaitingCrossSellResponse: true },
      intent: makeIntent({ isNegative: false, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage(spoken));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toMatch(/no logré entender/i);
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.COMPLETED, expect.objectContaining({ awaitingCrossSellResponse: undefined }),
    );
  });

  // Real live-test bug (2026-07-25): user answered the cross-sell offer with "terminar",
  // and the question "came back" instead of ending. Root cause traced to groq-nlp.service.ts:
  // before this fix "terminar" wasn't in either the Groq prompt's abandonIntent examples or
  // the fallback isAbandonText list, so intent.abandonIntent came back false — meaning the
  // top-level abandonIntent check in processMessage (which already has the correct
  // hasCompletedPurchase → COMPLETED branching from an earlier fix) never fired, and
  // "terminar" fell through to handleDiscovery's clearlyDeclines check (isNegative ||
  // /^no\b/), which it also doesn't match (it's an exit word, not a negation). This test
  // covers the full path with abandonIntent now correctly true — the actual gap was in NLP
  // classification, already fixed in groq-nlp.service.ts (see the "terminar" additions there).
  it('regression — "terminar" (abandonIntent, not isNegative) ends the conversation via the top-level check instead of re-asking', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com', awaitingCrossSellResponse: true, hasCompletedPurchase: true },
      intent: makeIntent({ isNegative: false, abandonIntent: true, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('terminar'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toMatch(/no logré entender/i);
    expect(sentText).not.toContain('¿Quieres proteger algo más?');
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.COMPLETED, expect.anything(),
    );
  });

  it('regression — bare "no" also ends the cross-sell offer politely (not just longer phrasings)', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com', awaitingCrossSellResponse: true, hasCompletedPurchase: true },
      intent: makeIntent({ isNegative: true, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('no'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toMatch(/no logré entender/i);
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.COMPLETED, expect.objectContaining({ awaitingCrossSellResponse: undefined }),
    );
  });

  it('does not end the conversation when the user names a new category instead of declining', async () => {
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: { cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com', awaitingCrossSellResponse: true },
      intent: makeIntent({ productCategory: 'vida' }),
    });
    const vidaProduct = PRODUCTS.find(p => p.id === 'vida')!;
    quoting.bestQuote.mockReturnValue({
      product: vidaProduct,
      score: { reasons: ['Para vida'], matchScore: 60, monthlyPremium: vidaProduct.basePremium, priority: 'high', productId: vidaProduct.id },
    });
    telegram.normalize.mockResolvedValue(makeMessage('sí, quiero uno de vida'));
    await service.handleMessage({});
    expect(conversations.saveState).not.toHaveBeenCalledWith(
      expect.anything(), ConversationState.COMPLETED, expect.anything(),
    );
  });

  // Real live-test bug (2026-07-26): "No, la póliza está mal." is an unambiguous decline
  // with ZERO real category words in it -- but Groq occasionally hallucinates SOME
  // productCategory from text like this anyway. The old check trusted intent.productCategory
  // directly, so the hallucination silently defeated the decline, cleared the one-shot flag,
  // and let the conversation fall through into re-quoting the stale quoteProductId still in
  // context -- which is how a customer who said their policy was WRONG ended up with a
  // second Wompi payment link for the exact same product. Fixed: only a real, deterministic
  // category mention in the TEXT itself (not the LLM's unfounded guess) can override a decline.
  it('regression — a decline with a hallucinated productCategory but no real category words still ends politely, not falls through to re-quote', async () => {
    const { service, telegram, conversations, quoting } = buildService({
      state: ConversationState.DISCOVERY,
      context: {
        cedula: '12345678', nombre: 'Juan Pérez', email: 'juan@test.com',
        awaitingCrossSellResponse: true, quoteProductId: 'vida-ahorro', hasCompletedPurchase: true,
      },
      // Simulates Groq hallucinating a category from text that names none at all.
      intent: makeIntent({ isNegative: true, productCategory: 'vida' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('No, la póliza está mal.'));
    await service.handleMessage({});
    expect(quoting.bestQuote).not.toHaveBeenCalled();
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toMatch(/no logré entender/i);
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.COMPLETED, expect.objectContaining({ awaitingCrossSellResponse: undefined }),
    );
  });
});

describe('AgentService FUZZ — cédula validation', () => {
  const validCedulas = ['100000', '1234567', '12345678', '123456789', '1234567890'];
  const invalidCedulas = ['', '12345', '12345678901', 'abc', '1234 5678', '123-456', '12.345.678'];

  it.each(validCedulas)('valid cédula "%s" passes validation (6-10 digits)', async (cedula) => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage(cedula));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext?.cedula).toBe(cedula);
  });

  it.each(invalidCedulas)('invalid cédula "%s" is rejected', async (cedula) => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage(cedula));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    // Either saveState was not called (if no context change) or cedula is not set
    if (savedContext) {
      expect(savedContext.cedula).toBeUndefined();
    }
  });
});

// Real live-test bug: dictating a cédula digit-by-digit by voice ("uno, dos, tres...")
// gets transcribed with commas between each individual digit ("1, 2, 3, 4, 5, 6, 7, 8,
// 9") — the existing \b\d{6,10}\b regex needs a CONTIGUOUS digit run, so this never
// matched at all. Must NOT affect the existing, intentionally-rejected typed-formatted
// cases ("12.345.678", "1234 5678") — those use multi-digit groups, not lone digits.
describe('AgentService — cédula dictated digit-by-digit with commas (2026-07-24 live bug)', () => {
  it.each([
    ['1, 2, 3, 4, 5, 6, 7, 8, 9', '123456789'],
    ['1, 2, 3, 4, 5, 6', '123456'],
    ['1,2,3,4,5,6,7,8,9,0', '1234567890'],
  ])('joins spoken lone digits "%s" into "%s"', async (spoken, expected) => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage(spoken));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext?.cedula).toBe(expected);
  });

  it('regression — still rejects a typed formatted cédula with period thousand-separators ("12.345.678")', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage('12.345.678'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext | undefined;
    if (savedContext) expect(savedContext.cedula).toBeUndefined();
  });

  it('regression — still rejects a typed cédula with a single space-separated group ("1234 5678")', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: {},
    });
    telegram.normalize.mockResolvedValue(makeMessage('1234 5678'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext | undefined;
    if (savedContext) expect(savedContext.cedula).toBeUndefined();
  });
});

describe('AgentService FUZZ — confirmation variants', () => {
  const confirmVariants = ['sí', 'si', 'Sí', 'Si', 'SÍ', 'SI', 'Sí.', 'sí!', 'sí,', ' sí '];

  // 2026-07-26: "sí" no longer jumps straight to DISCOVERY — it asks a one-shot
  // affiliate-ID question first (see "AgentService — affiliate ID lookup"), so this
  // fuzz now confirms each variant is recognized as isAffirmative (autorizado:true),
  // not the full two-step transition to DISCOVERY.
  it.each(confirmVariants)('"%s" is treated as confirmation in AUTHORIZATION', async (text) => {
    const { service, telegram, conversations } = buildService({ state: ConversationState.AUTHORIZATION });
    telegram.normalize.mockResolvedValue(makeMessage(text));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith(
      'conv-1', ConversationState.AUTHORIZATION,
      expect.objectContaining({ autorizado: true, awaitingAffiliateId: true }),
    );
  });
});

// 2026-07-24: "not let user record integers or special characters in fields where it's
// not allowed" — random-input fuzzing for the nombre field, on top of the fixed-list
// regression tests above.
describe('AgentService FUZZ — nombre never accepts digits/symbols', () => {
  function randomGarbageName(): string {
    const pool = '0123456789!@#$%^&*()_+=<>{}[]';
    const len = 1 + Math.floor(Math.random() * 15);
    let out = '';
    for (let i = 0; i < len; i++) out += pool[Math.floor(Math.random() * pool.length)];
    return out;
  }

  function randomValidSpanishName(): string {
    // No single-character syllables here (e.g. a lone "a") — isValidHumanName correctly
    // requires length >= 2, and a random single-letter word would make this generator
    // occasionally produce a name the real validator (correctly) rejects, flaking the test.
    const syllables = ['ma', 'ra', 'lo', 'fer', 'nan', 'do', 'gar', 'cí', 'lu', 'pe', 'rez', 'sán', 'chez', 'ñu'];
    const wordCount = 1 + Math.floor(Math.random() * 3);
    const words: string[] = [];
    for (let w = 0; w < wordCount; w++) {
      const sylCount = 1 + Math.floor(Math.random() * 3);
      let word = '';
      for (let s = 0; s < sylCount; s++) word += syllables[Math.floor(Math.random() * syllables.length)];
      words.push(word.charAt(0).toUpperCase() + word.slice(1));
    }
    return words.join(' ');
  }

  it('never accepts a random digit/symbol string as nombre (50 random samples)', async () => {
    for (let i = 0; i < 50; i++) {
      const garbage = randomGarbageName();
      const { service, telegram, conversations } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { cedula: '12345678' },
      });
      telegram.normalize.mockResolvedValue(makeMessage(garbage));
      await service.handleMessage({});
      const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext | undefined;
      expect(savedContext?.nombre).toBeUndefined();
    }
  });

  it('always accepts a random letters-only Spanish-shaped name (50 random samples)', async () => {
    for (let i = 0; i < 50; i++) {
      const name = randomValidSpanishName();
      const { service, telegram, conversations } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { cedula: '12345678' },
      });
      telegram.normalize.mockResolvedValue(makeMessage(name));
      await service.handleMessage({});
      const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext | undefined;
      expect(savedContext?.nombre).toBe(name);
    }
  });
});

// INVARIANT: the conditional-underwriting question (age/illness/clinical history) must
// appear if and only if the quoted product's catalog entry has requiresUnderwriting —
// swept across the ENTIRE real catalog so a future product addition/removal can't
// silently drift from the business rule without a test noticing.
describe('AgentService INVARIANT — underwriting question matches catalog flag for every product', () => {
  it.each(PRODUCTS.map((p) => [p.id, !!p.requiresUnderwriting] as const))(
    'product "%s" (requiresUnderwriting=%s) asks for medical info iff the flag is set',
    async (productId, expectMedicalQuestion) => {
      const { service, telegram, conversations } = buildService({
        state: ConversationState.DATA_CAPTURE,
        context: { cedula: '12345678', nombre: 'Juan Pérez', quoteProductId: productId },
      });
      telegram.normalize.mockResolvedValue(makeMessage('juan@email.com'));
      await service.handleMessage({});
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
      if (expectMedicalQuestion) {
        expect(sentText).toMatch(/edad|enfermedad|historial/i);
        expect(savedContext.awaitingMedicalInfo).toBe(true);
      } else {
        expect(sentText).not.toMatch(/edad|enfermedad|historial/i);
        expect(savedContext.awaitingMedicalInfo).toBeFalsy();
      }
    },
  );
});

// 30s "come back to chat" reminder (2026-07-25 feature request)
// This app is otherwise fully stateless (driven only by incoming Telegram messages) — the
// reminder is the one place with an in-memory timer, scoped per conversation id. Every
// incoming message must cancel any reminder pending for THIS conversation (proof the user
// is still there) before scheduling a fresh one for the response about to go out —
// except when the conversation just reached a terminal state, where nudging is pointless.
describe('AgentService — 30s reminder scheduling', () => {
  it('cancels any pending reminder for this conversation on every incoming message', async () => {
    const { service, reminders } = buildService({ state: ConversationState.GREETING });
    await service.handleMessage({});
    expect(reminders.cancel).toHaveBeenCalledWith('conv-1');
  });

  it('schedules a reminder after a normal in-progress response (e.g. QUOTE_PRESENTED)', async () => {
    const { service, telegram, reminders } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: PRODUCTS[0].id },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿ese es el único plan?'));
    await service.handleMessage({});
    expect(reminders.schedule).toHaveBeenCalledWith('conv-1', 'u1', false);
  });

  // Real live-test bug (2026-07-26): a real Wompi payment link is valid for 30 minutes
  // ("El link vence en 30 minutos"), but the conversation auto-abandoned on the regular
  // 4-minute window regardless — closing the chat while the link was still payable.
  it('schedules with hasPendingPayment=true when the context has an active checkoutUrl', async () => {
    const { service, telegram, reminders } = buildService({
      state: ConversationState.PAYMENT,
      context: { checkoutUrl: 'https://checkout.wompi.co/l/test123' },
      intent: makeIntent({ isNegative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿ya casi?'));
    await service.handleMessage({});
    expect(reminders.schedule).toHaveBeenCalledWith('conv-1', 'u1', true);
  });

  it('schedules with hasPendingPayment=false when there is no active checkoutUrl', async () => {
    const { service, telegram, reminders } = buildService({
      state: ConversationState.PAYMENT,
      context: {},
      intent: makeIntent({ isNegative: false }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿cómo pago?'));
    await service.handleMessage({});
    expect(reminders.schedule).toHaveBeenCalledWith('conv-1', 'u1', false);
  });

  it('does NOT schedule a reminder when a plain decline ends in ABANDONED', async () => {
    const { service, reminders } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: PRODUCTS[0].id },
      intent: makeIntent({ isNegative: true, isAffirmative: false, wantsAlternative: false }),
    });
    await service.handleMessage({});
    expect(reminders.schedule).not.toHaveBeenCalled();
  });

  it('does NOT schedule a reminder when a plain decline ends in COMPLETED (already purchased)', async () => {
    const { service, reminders } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: PRODUCTS[0].id, hasCompletedPurchase: true },
      intent: makeIntent({ isNegative: true, isAffirmative: false, wantsAlternative: false }),
    });
    await service.handleMessage({});
    expect(reminders.schedule).not.toHaveBeenCalled();
  });

  it('does NOT schedule a reminder when authorization is declined (REJECTED)', async () => {
    const { service, reminders } = buildService({
      state: ConversationState.AUTHORIZATION,
      intent: makeIntent({ isNegative: true, isAffirmative: false }),
    });
    await service.handleMessage({});
    expect(reminders.schedule).not.toHaveBeenCalled();
  });
});

// Terminal-state restart (2026-07-26 live-test bug)
// ReminderService's auto-close message explicitly promises "cuando quieras continuar,
// aquí estoy — 24/7" — but only an EXACT hola/ayuda/inicio/start match ever restarted an
// ABANDONED/REJECTED conversation. A real follow-up question fell through to the static
// STATE_RESPONSES[currentState] text with no nextState, so the SAME terminal row got
// reused forever — every later message got the identical canned reply, no matter what it
// said. Live screenshot: two different follow-up questions in a row both got "Entendido.
// Cuando quieras retomar, aquí estoy — 24/7, sin esperas." verbatim.
describe('AgentService — terminal-state restart', () => {
  it('restarts (shows the GREETING text) on an ordinary follow-up message when state is ABANDONED, not just on a greeting keyword', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.ABANDONED,
      context: { productCategory: 'mascotas', abandonReason: 'no_response' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('De todos los que me sugieres, ¿cuál es mejor?'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('Entendido');
    expect(sentText).toContain('Asegura');
    // 2026-07-26 fix: nextState is AUTHORIZATION, not GREETING — the GREETING text already
    // folds in the authorization ask (same one-shot pattern as case GREETING itself), so
    // routing back through GREETING again would repeat that same text a second time on
    // the user's very next message (see the regression test below).
    expect(conversations.saveState).toHaveBeenCalledWith('conv-1', ConversationState.AUTHORIZATION, expect.objectContaining({ lastMessages: expect.any(Array) }));
  });

  it('restarts (shows the GREETING text) on an ordinary follow-up message when state is REJECTED', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.REJECTED,
      context: { autorizado: false },
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿cuál de todos es mejor para mi?'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('Entendido');
    expect(conversations.saveState).toHaveBeenCalledWith('conv-1', ConversationState.AUTHORIZATION, expect.objectContaining({ lastMessages: expect.any(Array) }));
  });

  it('still restarts via the 4 greeting keywords on ABANDONED (unchanged behavior)', async () => {
    const { service, telegram, conversations } = buildService({ state: ConversationState.ABANDONED });
    telegram.normalize.mockResolvedValue(makeMessage('hola'));
    await service.handleMessage({});
    expect(conversations.saveState).toHaveBeenCalledWith('conv-1', ConversationState.AUTHORIZATION, expect.anything());
  });

  // Real live-test bug (2026-07-26, screenshot): after "Hola." restarted an ABANDONED
  // conversation, the user's very next message — even an immediate "Sí." — got the
  // IDENTICAL "¡Hola!... Escríbeme 'sí' para empezar." text a second time before the
  // authorization question was ever actually evaluated, forcing a THIRD message just to
  // move past it. Root cause: the restart handler rendered GREETING's text (which already
  // asks for authorization) but set nextState back to GREETING, so the next turn re-ran
  // case GREETING and rendered the exact same text again.
  it('regression — does not repeat the GREETING/authorization text on the message right after a restart', async () => {
    const { service, telegram, conversations } = buildService({ state: ConversationState.ABANDONED });
    telegram.normalize.mockResolvedValue(makeMessage('Hola.'));
    await service.handleMessage({});
    const firstText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(firstText).toContain('Escríbeme');

    const restartedState = conversations.saveState.mock.calls[0]?.[1] as ConversationState;
    const restartedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    const { service: service2, telegram: telegram2 } = buildService({
      state: restartedState,
      context: restartedContext,
    });
    telegram2.normalize.mockResolvedValue(makeMessage('Sí.'));
    await service2.handleMessage({});
    const secondText = telegram2.sendText.mock.calls[0]?.[1] as string;
    expect(secondText).not.toContain('¡Hola!');
    expect(secondText).toContain('Ingresa tu ID');
  });

  it('does NOT restart COMPLETED on an ordinary message — still requires an exact greeting keyword (deliberately deferred scope)', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.COMPLETED,
      context: { hasCompletedPurchase: true, nombre: 'Ana', cedula: '123' },
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿cuál de todos es mejor para mi?'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain('¡Todo listo!');
    // No state transition — same terminal row, KYC data untouched.
    expect(conversations.saveState).not.toHaveBeenCalled();
  });

  // 2026-07-26 feature request: a COMPLETED customer asking about their OWN,
  // already-purchased policy used to get the same generic "¡Todo listo!" text no matter
  // what was asked — answer with the real purchased product instead.
  describe('AgentService — post-purchase policy inquiry (COMPLETED)', () => {
    it('answers a real question about the purchased policy using the actual product', async () => {
      const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
      const { service, telegram, conversations } = buildService({
        state: ConversationState.COMPLETED,
        context: { hasCompletedPurchase: true, nombre: 'Ana', cedula: '123', purchasedProductIds: [vidaProduct.id] },
      });
      telegram.normalize.mockResolvedValue(makeMessage('¿qué cubre mi póliza?'));
      await service.handleMessage({});
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      expect(sentText).toContain(vidaProduct.name);
      for (const coverage of vidaProduct.coverages) {
        expect(sentText).toContain(coverage);
      }
      // Never a sales pitch for something already bought.
      expect(sentText).not.toContain('¿Te interesa o prefieres que busquemos otra opción?');
      expect(conversations.saveState).not.toHaveBeenCalled();
    });

    it('answers for EACH product when the customer bought more than one', async () => {
      const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
      const petProduct = PRODUCTS.find(p => p.category === 'mascotas')!;
      const { service, telegram } = buildService({
        state: ConversationState.COMPLETED,
        context: { hasCompletedPurchase: true, purchasedProductIds: [vidaProduct.id, petProduct.id] },
      });
      telegram.normalize.mockResolvedValue(makeMessage('cuéntame de mi póliza'));
      await service.handleMessage({});
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      expect(sentText).toContain(vidaProduct.name);
      expect(sentText).toContain(petProduct.name);
    });

    it('does NOT intercept a normal message with no policy question, even in COMPLETED with purchasedProductIds set', async () => {
      const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
      const { service, telegram } = buildService({
        state: ConversationState.COMPLETED,
        context: { hasCompletedPurchase: true, purchasedProductIds: [vidaProduct.id] },
      });
      telegram.normalize.mockResolvedValue(makeMessage('gracias, todo bien'));
      await service.handleMessage({});
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      expect(sentText).toContain('¡Todo listo!');
    });

    it('falls back to the generic COMPLETED text when purchasedProductIds is empty/absent', async () => {
      const { service, telegram } = buildService({
        state: ConversationState.COMPLETED,
        context: { hasCompletedPurchase: true },
      });
      telegram.normalize.mockResolvedValue(makeMessage('¿qué cubre mi póliza?'));
      await service.handleMessage({});
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      expect(sentText).toContain('¡Todo listo!');
    });

    it('a policy question containing "ayuda" answers about the policy instead of restarting to GREETING', async () => {
      const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
      const { service, telegram, conversations } = buildService({
        state: ConversationState.COMPLETED,
        context: { hasCompletedPurchase: true, purchasedProductIds: [vidaProduct.id] },
      });
      telegram.normalize.mockResolvedValue(makeMessage('necesito ayuda, ¿qué cubre mi póliza?'));
      await service.handleMessage({});
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      expect(sentText).toContain(vidaProduct.name);
      expect(conversations.saveState).not.toHaveBeenCalled();
    });
  });

  // 2026-07-26 persistent memory — "la siguiente conversación nunca debe empezar desde
  // cero" (Diseño preguntas.docx). Durable profile facts survive an ABANDONED/REJECTED
  // restart; session-scoped state (the quote in progress, one-shot gates) still resets.
  describe('persistent memory across a restart', () => {
    it('carries forward petCount/dependents/budget/KYC/purchase-history facts, drops session-scoped state', async () => {
      const { service, telegram, conversations } = buildService({
        state: ConversationState.ABANDONED,
        context: {
          petCount: 2,
          dependents: 2,
          budget: 40000,
          cedula: '12345678',
          nombre: 'Ana Torres',
          email: 'ana@example.com',
          phoneVerified: true,
          hasCompletedPurchase: true,
          policyIds: ['pol-1'],
          // session-scoped — must NOT survive:
          petType: 'gato',
          petSpeciesCounts: { gato: 1, perro: 1 },
          productCategory: 'mascotas',
          quoteProductId: 'medicina-prepagada-gatos',
          shownProductIds: ['medicina-prepagada-gatos'],
          discoveryFilter: true,
          askedDependents: true,
          autorizado: true,
        },
      });
      telegram.normalize.mockResolvedValue(makeMessage('¿sigues ahí?'));
      await service.handleMessage({});
      const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
      expect(savedContext).toEqual(expect.objectContaining({
        petCount: 2,
        dependents: 2,
        budget: 40000,
        cedula: '12345678',
        nombre: 'Ana Torres',
        email: 'ana@example.com',
        phoneVerified: true,
        hasCompletedPurchase: true,
        policyIds: ['pol-1'],
        lastMessages: expect.any(Array),
      }));
      // Real live-test bug (2026-07-26): a stale petType/petSpeciesCounts silently
      // surviving a restart let a fresh "Mi mascota" tap skip straight to a one-species
      // quote with zero re-confirmation — these must now reset like productCategory does.
      expect(savedContext.petType).toBeUndefined();
      expect(savedContext.petSpeciesCounts).toBeUndefined();
    });

    // Real live-test bug (2026-07-26, screenshot): reproduces the exact reported symptom
    // end-to-end — a conversation restarted from ABANDONED with a stale mixed-species
    // profile left over from an earlier, unrelated mascotas inquiry. Tapping "Mi mascota"
    // fresh must ask the species question again, never jump straight to a one-species
    // quote using counts the user never restated this conversation.
    it('regression — a fresh "Mi mascota" tap after a restart asks the species question again, never reuses a stale species breakdown', async () => {
      const { service: s1, conversations: c1 } = buildService({
        state: ConversationState.ABANDONED,
        context: {
          petType: 'perro', // stale from an earlier, unrelated inquiry — must NOT survive
          petSpeciesCounts: { gato: 1, perro: 2 },
          quoteProductId: 'medicina-prepagada-perros',
        },
      });
      await s1.handleMessage({}); // any message restarts to GREETING
      const restartedContext = c1.saveState.mock.calls[0]?.[2] as ConversationContext;
      expect(restartedContext.petType).toBeUndefined();
      expect(restartedContext.petSpeciesCounts).toBeUndefined();

      // Fresh DISCOVERY turn: tapping the F01 "Mi mascota" button sets productCategory
      // fresh (never persisted, same as always) — with petType/petSpeciesCounts correctly
      // gone now, this must ask the species question, not skip straight to a quote.
      const { service: s2, telegram: t2, conversations: c2 } = buildService({
        state: ConversationState.DISCOVERY,
        context: { ...restartedContext, discoveryFilter: true },
        intent: makeIntent({ productCategory: 'mascotas' }),
      });
      t2.normalize.mockResolvedValue(makeMessage('🐾 Mi mascota'));
      await s2.handleMessage({});
      const sentText = t2.sendText.mock.calls[0]?.[1] as string;
      expect(sentText).toContain('¿Tus mascotas son gatos, perros');
      expect(sentText).not.toContain('Tu cotización personalizada');
      const savedContext2 = c2.saveState.mock.calls[0]?.[2] as ConversationContext;
      expect(savedContext2.quoteProductId).toBeUndefined();
    });

    it('the GREETING text acknowledges a remembered profile instead of a plain "¡Hola!"', async () => {
      const { service, telegram } = buildService({
        state: ConversationState.ABANDONED,
        context: { petType: 'perro', dependents: 1 },
      });
      telegram.normalize.mockResolvedValue(makeMessage('sigo aquí'));
      await service.handleMessage({});
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      expect(sentText).toContain('perfil de antes');
    });

    it('personalizes the greeting by first name when nombre survived the restart', async () => {
      const { service, telegram } = buildService({
        state: ConversationState.ABANDONED,
        context: { nombre: 'Carlos Ramírez', phoneVerified: true },
      });
      telegram.normalize.mockResolvedValue(makeMessage('hola de nuevo'));
      await service.handleMessage({});
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      expect(sentText).toContain('¡Hola de nuevo, Carlos!');
    });

    it('a genuinely fresh profile (no persistent facts at all) keeps the plain, unpersonalized greeting', async () => {
      const { service, telegram } = buildService({
        state: ConversationState.ABANDONED,
        context: { productCategory: 'vida' }, // session-scoped only, nothing persistent
      });
      telegram.normalize.mockResolvedValue(makeMessage('sigo aquí'));
      await service.handleMessage({});
      const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
      expect(sentText).not.toContain('perfil de una conversación anterior');
      expect(sentText).not.toContain('¡Hola de nuevo');
      expect(sentText).toContain('¡Hola!');
    });
  });
});

// Stuck-loop circuit breaker + human escalation (2026-07-26 live-test feedback)
// "If the agent doesn't have the info about the insurance asked, redirect the chat to a
// human." Only turns explicitly flagged unclearReply (DISCOVERY's genuinely-stuck
// fallback, QUOTE_PRESENTED's neutral re-show) count toward the streak — a real
// follow-up question that just needs another question asked is NOT confusion.
describe('AgentService — stuck-loop circuit breaker + human escalation', () => {
  it('a single unclear reply increments the counter but does not escalate', async () => {
    const product = PRODUCTS[0];
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: product.id },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿cuánto dura la cobertura?'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.consecutiveUnclearReplies).toBe(1);
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('serás redirigido');
    expect(sentText).toContain(product.name); // still the normal neutral re-show
  });

  it('a 2nd consecutive unclear reply still does not escalate (threshold is 3)', async () => {
    const product = PRODUCTS[0];
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: product.id, consecutiveUnclearReplies: 1 },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿cuánto dura la cobertura?'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.consecutiveUnclearReplies).toBe(2);
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('serás redirigido');
  });

  it('escalates to a human on the 3rd consecutive unclear reply, resetting the counter', async () => {
    const product = PRODUCTS[0];
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: product.id, consecutiveUnclearReplies: 2 },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿cuánto dura la cobertura?'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toBe('Parece que no te estoy ayudando bien, serás redirigido a mi líder de servicio 🙏');
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.consecutiveUnclearReplies).toBe(0);
    // Stays in the same state — this is a handoff, not a conversation-ending transition.
    expect(conversations.saveState).toHaveBeenCalledWith('conv-1', ConversationState.QUOTE_PRESENTED, expect.anything());
  });

  it('escalates from DISCOVERY too, via the genuinely-stuck (no progress) fallback', async () => {
    const { service, telegram } = buildService({
      state: ConversationState.DISCOVERY,
      context: { consecutiveUnclearReplies: 2 },
      intent: makeIntent({}), // no productCategory, no coverage, nothing — zero signal
    });
    telegram.normalize.mockResolvedValue(makeMessage('mmh no sé qué decir'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toBe('Parece que no te estoy ayudando bien, serás redirigido a mi líder de servicio 🙏');
  });

  it('a genuinely understood reply resets the streak instead of letting it carry over silently', async () => {
    const { service, telegram, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: { consecutiveUnclearReplies: 2 },
      intent: makeIntent({ productCategory: 'vida' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('quiero un seguro de vida'));
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.consecutiveUnclearReplies).toBe(0);
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).not.toContain('serás redirigido');
  });

  it('does not write a counter field at all when there was never a streak to begin with (ordinary conversation)', async () => {
    const { service, conversations } = buildService({
      state: ConversationState.DISCOVERY,
      context: {},
      intent: makeIntent({ productCategory: 'vida' }),
    });
    await service.handleMessage({});
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.consecutiveUnclearReplies).toBeUndefined();
  });

  it('notifies ADMIN_CHAT_ID with the username, user id, state and last message when configured', async () => {
    const product = PRODUCTS[0];
    const { service, telegram, config } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: product.id, consecutiveUnclearReplies: 2 },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    config.get.mockImplementation((key: string) => (key === 'ADMIN_CHAT_ID' ? '999999' : undefined));
    telegram.normalize.mockResolvedValue(makeMessage('¿cuánto dura la cobertura?', { username: 'alejoo_o' }));
    await service.handleMessage({});
    const adminCall = telegram.sendText.mock.calls.find((call) => call[0] === '999999');
    expect(adminCall).toBeDefined();
    const adminText = adminCall![1] as string;
    expect(adminText).toContain('@alejoo_o');
    expect(adminText).toContain('u1');
    expect(adminText).toContain(ConversationState.QUOTE_PRESENTED);
    expect(adminText).toContain('¿cuánto dura la cobertura?');
  });

  it('falls back to the bare user id (no "@") when Telegram never provided a username', async () => {
    const product = PRODUCTS[0];
    const { service, telegram, config } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: product.id, consecutiveUnclearReplies: 2 },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    config.get.mockImplementation((key: string) => (key === 'ADMIN_CHAT_ID' ? '999999' : undefined));
    telegram.normalize.mockResolvedValue(makeMessage('¿cuánto dura la cobertura?'));
    await service.handleMessage({});
    const adminCall = telegram.sendText.mock.calls.find((call) => call[0] === '999999');
    const adminText = adminCall![1] as string;
    expect(adminText).not.toContain('@');
    expect(adminText).toContain('u1');
  });

  it('does not attempt an admin notification when ADMIN_CHAT_ID is not configured — degrades silently', async () => {
    const product = PRODUCTS[0];
    const { service, telegram } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: product.id, consecutiveUnclearReplies: 2 },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('¿cuánto dura la cobertura?'));
    await service.handleMessage({});
    // Only one sendText call — to the user with the escalation message. No admin call.
    expect(telegram.sendText).toHaveBeenCalledTimes(1);
  });
});

// Comprehensive end-to-end live-test scenarios (2026-07-26)
// Each scenario below chains multiple real service.handleMessage() calls, manually
// threading each turn's saved context into the next buildService() call — the same
// convention already used by the mixed-species regression test above (this codebase has
// no infrastructure for re-using one service instance across turns; conversations.
// getOrCreate is a fixed, one-time snapshot per buildService() call). Answers, one
// scenario each, the exact questions raised in a real live-test review:
describe('AgentService — end-to-end live-test scenarios (comprehensive)', () => {
  // Q: "is it the user asked twice?" — no: DATA_CAPTURE only asks a field while it's
  // genuinely empty. A live "asked twice" report traces to ASR mis-transcribing an
  // email ("arroba" misheard), not this state machine re-asking a validly-answered field.
  it('SCENARIO 1 — DATA_CAPTURE never re-asks cédula/nombre/email once validly answered', async () => {
    const { service: s1, telegram: t1, conversations: c1 } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { quoteProductId: PRODUCTS[0].id },
      intent: makeIntent({}),
    });
    t1.normalize.mockResolvedValue(makeMessage('12345678'));
    await s1.handleMessage({});
    const ctx1 = c1.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(ctx1.cedula).toBe('12345678');
    expect(t1.sendText.mock.calls[0]?.[1]).toContain('nombre completo');

    const { service: s2, telegram: t2, conversations: c2 } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: ctx1,
      intent: makeIntent({}),
    });
    t2.normalize.mockResolvedValue(makeMessage('Ana Torres'));
    await s2.handleMessage({});
    const ctx2 = c2.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(ctx2.nombre).toBe('Ana Torres');
    expect(ctx2.cedula).toBe('12345678'); // untouched, never re-asked
    const sentText2 = t2.sendText.mock.calls[0]?.[1] as string;
    expect(sentText2).not.toContain('documento de identidad');
    expect(sentText2).toContain('correo');

    const { service: s3, telegram: t3, conversations: c3 } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: ctx2,
      intent: makeIntent({}),
    });
    t3.normalize.mockResolvedValue(makeMessage('ana@test.com'));
    await s3.handleMessage({});
    const ctx3 = c3.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(ctx3.email).toBe('ana@test.com');
    const sentText3 = t3.sendText.mock.calls[0]?.[1] as string;
    expect(sentText3).not.toContain('¿Cuál es tu nombre completo?');
    expect(sentText3).not.toContain('número de documento');
    expect(sentText3).toContain('Resumen de tu compra');
  });

  // Q: "if user wants to select a specific insurance offered before, what should be the
  // agent behavior?" — resolves the exact previously-shown product by name/position/
  // price, never confirms whichever product happens to be on screen instead.
  it('SCENARIO 2 — selecting a specific previously-shown option resolves to THAT product, not the current one', async () => {
    const p1 = PRODUCTS.find(p => p.id === 'asistencias-medicas')!; // $16.800
    const p2 = PRODUCTS.find(p => p.id === 'asistencias-multiples')!; // $20.000

    // Turn 1: p1 already shown, "otro" surfaces p2.
    const { service: s1, telegram: t1, conversations: c1, quoting: q1 } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: p1.id, shownProductIds: [p1.id], productCategory: 'asistencia' },
      intent: makeIntent({ wantsAlternative: true, productCategory: null }),
    });
    q1.score.mockReturnValue([
      { productId: p2.id, matchScore: 70, reasons: [], monthlyPremium: p2.basePremium, priority: 'high' },
    ]);
    t1.normalize.mockResolvedValue(makeMessage('otro'));
    await s1.handleMessage({});
    const ctx1 = c1.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(ctx1.quoteProductId).toBe(p2.id);
    expect(t1.sendText.mock.calls[0]?.[1]).toContain(p2.name);

    // Turn 2: user asks to go back to "la primera opción" — must resolve to p1, not p2.
    const { service: s2, telegram: t2, conversations: c2 } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: ctx1,
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    t2.normalize.mockResolvedValue(makeMessage('mejor la primera opción que me ofreciste'));
    await s2.handleMessage({});
    const ctx2 = c2.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(ctx2.quoteProductId).toBe(p1.id);
    const sentText2 = t2.sendText.mock.calls[0]?.[1] as string;
    expect(sentText2).toContain(p1.name);
    expect(sentText2).not.toContain(p2.name);
  });

  // Q: "what if asks for an insurance out of scope?" — an honest decline for a genuinely
  // unrelated category, but never a false denial of coverage the shown product ALREADY
  // includes (the asistencias-multiples "Asistencia vehículo" false-positive fix).
  it('SCENARIO 3 — out-of-scope request: honest decline when unrelated, no false denial when already covered', async () => {
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const { service: s1, telegram: t1 } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: vidaProduct.id, productCategory: 'vida' },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    t1.normalize.mockResolvedValue(makeMessage('¿y tienen seguro para mi carro?'));
    await s1.handleMessage({});
    expect((t1.sendText.mock.calls[0]?.[1] as string).toLowerCase()).toMatch(/no tengo|no ofrecemos|no cuento con/);

    const asistenciasMultiples = PRODUCTS.find(p => p.id === 'asistencias-multiples')!;
    const { service: s2, telegram: t2 } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: asistenciasMultiples.id, productCategory: 'asistencia' },
      intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
    });
    t2.normalize.mockResolvedValue(makeMessage('¿la asistencia también cubre si se vara mi vehículo?'));
    await s2.handleMessage({});
    expect((t2.sendText.mock.calls[0]?.[1] as string).toLowerCase()).not.toMatch(/no tengo seguros de vehículos/);
  });

  // Q: "what if the user wants to change an insurance [category] and the agent can
  // understand?" — defers to AFTER the current purchase closes, never abandons the
  // quote already on screen mid-flow.
  it('SCENARIO 4 — switching category mid-quote is deferred to after purchase, never an immediate switch', async () => {
    const petProduct = PRODUCTS.find(p => p.category === 'mascotas')!;
    const { service, telegram, conversations } = buildService({
      state: ConversationState.QUOTE_PRESENTED,
      context: { quoteProductId: petProduct.id, productCategory: 'mascotas', petType: 'gato' },
      intent: makeIntent({ productCategory: 'vida' }),
    });
    telegram.normalize.mockResolvedValue(makeMessage('también quiero un seguro de vida para mí'));
    await service.handleMessage({});
    const sentText = telegram.sendText.mock.calls[0]?.[1] as string;
    expect(sentText).toContain(petProduct.name); // current purchase named, not dropped
    expect(sentText.toLowerCase()).toMatch(/primero cerremos|en cuanto quede lista/);
    const savedContext = conversations.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(savedContext.quoteProductId).toBe(petProduct.id); // unchanged — never switched immediately
    expect(savedContext.pendingCrossSell).toBe('vida');
  });

  // Q: "when it's redirect to a human what it expect user and agent?" — the user sees
  // one specific, exact message; the agent notifies ADMIN_CHAT_ID with who/where/what,
  // and never actually ends or transitions the conversation (a handoff, not a hangup).
  it('SCENARIO 5 — 3 consecutive unclear replies escalate to a human, with the exact expected user+agent behavior', async () => {
    const product = PRODUCTS[0];
    let context: ConversationContext = { quoteProductId: product.id };
    let conversations;
    let telegram;
    for (let turn = 1; turn <= 3; turn++) {
      const built = buildService({
        state: ConversationState.QUOTE_PRESENTED,
        context,
        intent: makeIntent({ isAffirmative: false, isNegative: false, wantsAlternative: false, productCategory: null }),
      });
      telegram = built.telegram;
      conversations = built.conversations;
      telegram.normalize.mockResolvedValue(makeMessage('mmh no sé qué decir'));
      await built.service.handleMessage({});
      context = (conversations.saveState.mock.calls[0]?.[2] as ConversationContext) ?? context;
    }
    // User-facing expectation: the exact escalation text, nothing else.
    expect(telegram!.sendText.mock.calls[0]?.[1]).toBe(
      'Parece que no te estoy ayudando bien, serás redirigido a mi líder de servicio 🙏',
    );
    // Agent-facing expectation: counter resets (no repeat-escalation spam next turn),
    // and the conversation state itself is untouched — a handoff, not an ending.
    expect(context.consecutiveUnclearReplies).toBe(0);
    expect(conversations!.saveState).toHaveBeenCalledWith('conv-1', ConversationState.QUOTE_PRESENTED, expect.anything());
  });

  // Q: payment-active messaging + post-purchase inquiry + persistent memory — all three
  // tie together: the user is told the chat stays open, a real purchased policy answers
  // real questions in COMPLETED, and that fact survives an ABANDONED restart.
  it('SCENARIO 6 — payment-active reassurance, post-purchase inquiry, and persistent memory across a restart', async () => {
    // Step A: the payment link message reassures the chat stays available.
    const { service: s1, telegram: t1 } = buildService({
      state: ConversationState.DATA_CAPTURE,
      context: { cedula: '12345678', nombre: 'Ana Torres', email: 'ana@test.com', quoteProductId: PRODUCTS[0].id, awaitingPaymentMethodChoice: true },
      intent: makeIntent({}),
    });
    t1.normalize.mockResolvedValue(makeMessage('link de pago'));
    await s1.handleMessage({});
    expect((t1.sendText.mock.calls[0]?.[1] as string).toLowerCase()).toMatch(/se mantiene disponible|sigue disponible/);

    // Step B: purchase completed — a real policy question gets a real answer.
    const vidaProduct = PRODUCTS.find(p => p.category === 'vida')!;
    const { service: s2, telegram: t2 } = buildService({
      state: ConversationState.COMPLETED,
      context: {
        hasCompletedPurchase: true, nombre: 'Ana Torres', cedula: '12345678',
        purchasedProductIds: [vidaProduct.id],
        affiliateProfile: { rangoSalarial: 'Entre 1 y 1.5 SMLV', ciudadAfiliado: 'BOGOTA D.C.' },
      },
      intent: makeIntent({}),
    });
    t2.normalize.mockResolvedValue(makeMessage('¿qué cubre mi póliza?'));
    await s2.handleMessage({});
    const sentText2 = t2.sendText.mock.calls[0]?.[1] as string;
    expect(sentText2).toContain(vidaProduct.name);
    for (const coverage of vidaProduct.coverages) expect(sentText2).toContain(coverage);

    // Step C: this same durable profile survives an ABANDONED → GREETING restart.
    const { service: s3, telegram: t3, conversations: c3 } = buildService({
      state: ConversationState.ABANDONED,
      context: {
        hasCompletedPurchase: true, nombre: 'Ana Torres', cedula: '12345678', email: 'ana@test.com',
        purchasedProductIds: [vidaProduct.id],
        affiliateProfile: { rangoSalarial: 'Entre 1 y 1.5 SMLV', ciudadAfiliado: 'BOGOTA D.C.' },
        productCategory: 'vida', // session-scoped — must NOT survive
      },
    });
    t3.normalize.mockResolvedValue(makeMessage('sigo aquí'));
    await s3.handleMessage({});
    const ctx3 = c3.saveState.mock.calls[0]?.[2] as ConversationContext;
    expect(ctx3.purchasedProductIds).toEqual([vidaProduct.id]);
    expect(ctx3.affiliateProfile).toEqual({ rangoSalarial: 'Entre 1 y 1.5 SMLV', ciudadAfiliado: 'BOGOTA D.C.' });
    expect(ctx3.nombre).toBe('Ana Torres');
    expect(ctx3.productCategory).toBeUndefined(); // session-scoped, correctly dropped
  });
});
