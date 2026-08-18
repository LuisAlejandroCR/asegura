// conversation.service.ts: loads, creates and persists conversation rows in Supabase,
// with a short-lived in-memory cache keyed by user + channel.

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../database/supabase.service';
import { Conversation, ConversationContext, ConversationState } from './types';

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  // Keyed by `${userId}:${channel}`. Absorbs transient Supabase failures and stops two rapid
  // messages from each creating their own conversation row.
  private readonly cache = new Map<string, Conversation>();

  constructor(private readonly supabase: SupabaseService) {}

  private cacheKey(userId: string, channel: string): string {
    return `${userId}:${channel}`;
  }

  async findByUser(userId: string, channel: string): Promise<Conversation | null> {
    // maybeSingle() returns { data: null, error: null } for 0 rows; order+limit keep the result
    // deterministic even if the unique index is missing.
    const { data, error } = await this.supabase.db
      .from('conversations')
      .select('*')
      .eq('user_id', userId)
      .eq('channel', channel)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      this.logger.warn(`findByUser error: ${error.message}`);
    }
    return data as Conversation | null;
  }

  // Used by the Wompi webhook to resolve who owns a policy's conversation.
  async findById(conversationId: string): Promise<Conversation | null> {
    const { data, error } = await this.supabase.db
      .from('conversations')
      .select('*')
      .eq('id', conversationId)
      .maybeSingle();

    if (error) {
      this.logger.warn(`findById error: ${error.message}`);
      return null;
    }
    return data as Conversation | null;
  }

  async create(userId: string, channel: string): Promise<Conversation> {
    const { data, error } = await this.supabase.db
      .from('conversations')
      .insert({
        user_id: userId,
        channel,
        state: ConversationState.GREETING,
        context: {},
      })
      .select()
      .single();

    if (error) {
      this.logger.error(`create error: ${error.message}`);
      throw error;
    }
    return data as Conversation;
  }

  async saveState(
    id: string,
    state: ConversationState,
    context?: Partial<ConversationContext>,
  ): Promise<void> {
    const update: Record<string, unknown> = { state, updated_at: new Date().toISOString() };
    if (context) update.context = context;

    for (const [key, conv] of this.cache.entries()) {
      if (conv.id === id) {
        this.cache.set(key, { ...conv, state, context: (context ?? conv.context) as ConversationContext });
        break;
      }
    }

    const { error } = await this.supabase.db
      .from('conversations')
      .update(update)
      .eq('id', id);

    if (error) {
      this.logger.error(`saveState error: ${error.message}`);
    }
  }

  async getOrCreate(userId: string, channel: string): Promise<Conversation> {
    const key = this.cacheKey(userId, channel);

    const cached = this.cache.get(key);
    if (cached) return cached;

    const existing = await this.findByUser(userId, channel);
    if (existing) {
      this.cache.set(key, existing);
      return existing;
    }

    const created = await this.create(userId, channel);
    this.cache.set(key, created);
    return created;
  }
}
