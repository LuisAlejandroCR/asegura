// persistent-context.spec.ts: tests pickPersistentFields and hasRememberedProfile —
// notably that a real 0 survives and that one-shot gates are not treated as durable.

import { pickPersistentFields, hasRememberedProfile, PERSISTENT_FIELDS } from './persistent-context';
import { ConversationContext } from './types';

describe('pickPersistentFields', () => {
  it('carries forward durable profile facts (petCount, dependents, budget, KYC, purchase history)', () => {
    const context: ConversationContext = {
      petCount: 2,
      dependents: 3,
      budget: 50000,
      cedula: '12345678',
      nombre: 'Ana Torres',
      email: 'ana@example.com',
      phoneVerified: true,
      verifiedPhone: '+573001234567',
      hasCompletedPurchase: true,
      policyIds: ['pol-1', 'pol-2'],
      purchasedProductIds: ['vida', 'medicina-prepagada-gatos'],
    };
    const result = pickPersistentFields(context);
    expect(result).toEqual(context);
  });

  it('does NOT carry forward session-scoped state (current quote, one-shot gates, discoveryFilter)', () => {
    const context: ConversationContext = {
      productCategory: 'vida',
      coverage: ['protección'],
      quoteProductId: 'vida',
      shownProductIds: ['vida', 'vida-ahorro'],
      discoveryFilter: true,
      askedDependents: true,
      awaitingPhoneVerification: true,
      awaitingSelfie: true,
      selfieProvided: true,
      awaitingMedicalInfo: true,
      medicalInfo: 'sin enfermedades',
      autorizado: true,
      abandonReason: 'no_response',
      checkoutUrl: 'https://checkout.wompi.co/l/test',
    };
    const result = pickPersistentFields(context);
    expect(result).toEqual({});
  });

  it('mixes both correctly — only the persistent subset survives, unrelated session state is dropped', () => {
    const context: ConversationContext = {
      petCount: 2,
      dependents: 0,
      productCategory: 'mascotas',
      quoteProductId: 'medicina-prepagada-perros',
      awaitingPhoneVerification: true,
    };
    const result = pickPersistentFields(context);
    expect(result).toEqual({ petCount: 2, dependents: 0 });
  });

  it('a real 0 value (e.g. dependents=0, "vivo solo") is preserved, not dropped as falsy', () => {
    const result = pickPersistentFields({ dependents: 0 });
    expect(result.dependents).toBe(0);
    expect('dependents' in result).toBe(true);
  });

  it('empty context in, empty context out', () => {
    expect(pickPersistentFields({})).toEqual({});
  });

  it('deliberately excludes autorizado — consent is re-confirmed each time, never assumed', () => {
    expect(PERSISTENT_FIELDS).not.toContain('autorizado');
  });

  it('deliberately excludes productCategory — a fresh inquiry may want something different', () => {
    expect(PERSISTENT_FIELDS).not.toContain('productCategory');
  });

  it('carries forward rangoSalarial and serieId from an affiliate CSV lookup — re-doing it on every restart would be pointless', () => {
    const result = pickPersistentFields({ rangoSalarial: 'Entre 4 y 6 SMLV', serieId: '42' });
    expect(result).toEqual({ rangoSalarial: 'Entre 4 y 6 SMLV', serieId: '42' });
  });

  it('deliberately excludes awaitingAffiliateId — a one-shot gate, not a durable fact', () => {
    expect(PERSISTENT_FIELDS).not.toContain('awaitingAffiliateId');
  });

  // Real live-test bug (2026-07-26, screenshot): tapping "Mi mascota" on a FRESH
  // restarted conversation jumped straight to a stale one-species quote with zero
  // re-confirmation — petType (narrowed to 'perro' by an earlier, unrelated inquiry) and
  // petSpeciesCounts silently satisfied every gate in handleDiscovery's mixto flow.
  // Unlike dependents/budget/cedula (facts about the PERSON), these describe THIS
  // SPECIFIC inquiry's resolution — same reasoning as productCategory above, a fresh
  // mascota inquiry may legitimately differ and must always re-ask.
  it('deliberately excludes petType, petSpeciesCounts, and pets — a fresh mascota inquiry must re-confirm species/counts, never silently reuse stale ones', () => {
    expect(PERSISTENT_FIELDS).not.toContain('petType');
    expect(PERSISTENT_FIELDS).not.toContain('petSpeciesCounts');
    expect(PERSISTENT_FIELDS).not.toContain('pets');
    // petCount (a plain total, often pre-filled from the affiliate CSV's own PET_COUNT
    // column) is a genuine standalone fact and still persists — it never gates or skips
    // the species question on its own.
    expect(PERSISTENT_FIELDS).toContain('petCount');
  });
});

describe('hasRememberedProfile', () => {
  it('false for a brand-new context with no persistent facts', () => {
    expect(hasRememberedProfile({})).toBe(false);
  });

  it('false when only session-scoped fields are set', () => {
    expect(hasRememberedProfile({ productCategory: 'vida', discoveryFilter: true })).toBe(false);
  });

  it('true when any single persistent field is set', () => {
    expect(hasRememberedProfile({ petCount: 2 })).toBe(true);
  });

  it('true even when the only persistent fact is dependents=0 (a real, deliberate answer)', () => {
    expect(hasRememberedProfile({ dependents: 0 })).toBe(true);
  });
});
