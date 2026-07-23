import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../database/supabase.service';
import { Conversation, ConversationContext, ConversationState } from './types';

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async findByUser(userId: string, channel: string): Promise<Conversation | null> {
    const { data, error } = await this.supabase.db
      .from('conversations')
      .select('*')
      .eq('user_id', userId)
      .eq('channel', channel)
      .single();

    if (error && error.code !== 'PGRST116') {
      this.logger.warn(`findByUser error: ${error.message}`);
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

    const { error } = await this.supabase.db
      .from('conversations')
      .update(update)
      .eq('id', id);

    if (error) {
      this.logger.error(`saveState error: ${error.message}`);
    }
  }

  async getOrCreate(userId: string, channel: string): Promise<Conversation> {
    const existing = await this.findByUser(userId, channel);
    if (existing) return existing;
    return this.create(userId, channel);
  }
}