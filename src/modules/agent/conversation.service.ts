// conversation.service.ts: loads, creates and persists conversation rows in Supabase,
// with a short-lived in-memory cache keyed by user + channel.

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../database/supabase.service';
import { Conversation, ConversationContext, ConversationState } from './types';

interface CachedConversation {
  conv: Conversation;
  expiresAt: number;
}

// Unbounded and without a TTL, this held every user ever seen — each with cedula, nombre and
// correo in context — for the life of the process. A conversation lasts minutes; past that a
// returning user costs one query.
const CACHE_TTL_MS = 30 * 60_000;
const CACHE_MAX_ENTRIES = 500;

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  // Keyed by `${userId}:${channel}`. Absorbs transient Supabase failures and stops two rapid
  // messages from each creating their own conversation row.
  private readonly cache = new Map<string, CachedConversation>();

  constructor(private readonly supabase: SupabaseService) {}

  private cacheKey(userId: string, channel: string): string {
    return `${userId}:${channel}`;
  }

  private cacheGet(key: string): Conversation | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.conv;
  }

  private cacheSet(key: string, conv: Conversation): void {
    const now = Date.now();
    for (const [k, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(k);
    }
    // Map iterates in insertion order, so the first key is the oldest write.
    while (!this.cache.has(key) && this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { conv, expiresAt: now + CACHE_TTL_MS });
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

    for (const [key, entry] of this.cache.entries()) {
      if (entry.conv.id === id) {
        this.cacheSet(key, { ...entry.conv, state, context: (context ?? entry.conv.context) as ConversationContext });
        break;
      }
    }

    const { error } = await this.supabase.db
      .from('conversations')
      .update(update)
      .eq('id', id);

    if (error) {
      // The cache deliberately keeps the new state — dropping it would lose the user's
      // progress mid-conversation — so name the divergence instead of hiding it.
      this.logger.error(`saveState failed for ${id}; the cache is now ahead of the database: ${error.message}`);
    }
  }

  async getOrCreate(userId: string, channel: string): Promise<Conversation> {
    const key = this.cacheKey(userId, channel);

    const cached = this.cacheGet(key);
    if (cached) return cached;

    const existing = await this.findByUser(userId, channel);
    if (existing) {
      this.cacheSet(key, existing);
      return existing;
    }

    const created = await this.create(userId, channel);
    this.cacheSet(key, created);
    return created;
  }
}
