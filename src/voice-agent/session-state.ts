// session-state.ts: what the worker knows about the person during one call. The text channel
// keeps this in the conversations row; voice had nowhere to put it, which is why it could
// quote but never authorize, capture or close (audit 3.4).

import { ConversationContext } from '../modules/agent/types';

export class VoiceSessionState {
  // The LiveKit identity is the conversationId the chat link was minted for, or undefined
  // for a standalone voz.html visit. Every merge is announced so the row can follow the call.
  constructor(
    readonly conversationId?: string,
    private readonly alCambiar?: (context: ConversationContext) => void,
  ) {}

  private ctx: ConversationContext = {};

  get context(): ConversationContext {
    return this.ctx;
  }

  merge(patch: ConversationContext): void {
    this.ctx = { ...this.ctx, ...patch };
    this.alCambiar?.(this.ctx);
  }

  // What the chat already knew, on the way in. Announcing it would write the row back over
  // itself before the person has said a word.
  hidratar(patch: ConversationContext): void {
    this.ctx = { ...this.ctx, ...patch };
  }
}
