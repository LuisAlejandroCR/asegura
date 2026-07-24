// wompi-webhook.controller.ts: source of truth for payment confirmation.
// Wompi's Payment Links API has no "reference" create-parameter, so transactions
// are matched back to a policy via payment_link_id, not the transaction's own
// auto-generated reference. Chat-based "sí" no longer confirms payment — this
// webhook is the only path that notifies the user and sends the final PDF.
import { Controller, Post, Body, UnauthorizedException, Logger } from '@nestjs/common';
import { WompiService } from './wompi.service';
import { PolicyService } from '../policy/policy.service';
import { ConversationService } from '../agent/conversation.service';
import { TelegramAdapter } from '../channel/telegram-adapter.service';
import { WompiWebhookEvent } from './types';
import { Policy } from '../policy/types';
import { ConversationState, ConversationContext } from '../agent/types';
import { STATE_RESPONSES } from '../agent/conversation-state.machine';

const PROCESSED_STATUSES = ['paid', 'active'];

@Controller('webhooks/wompi')
export class WompiWebhookController {
  private readonly logger = new Logger(WompiWebhookController.name);

  constructor(
    private readonly wompi: WompiService,
    private readonly policy: PolicyService,
    private readonly conversations: ConversationService,
    private readonly telegram: TelegramAdapter,
  ) {}

  @Post()
  async handleWebhook(@Body() event: WompiWebhookEvent) {
    if (!this.wompi.validateWebhookSignature(event)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // A genuinely-signed event can still carry an unexpected shape (e.g. a ping/test
    // event, or a future Wompi event type without a transaction) — extractTransactionData
    // destructures event.data.transaction.* unconditionally, so this must be checked first
    // to avoid an uncaught TypeError turning into a 500 instead of a clean ignored response.
    if (!event.data?.transaction || typeof event.data.transaction.status !== 'string') {
      this.logger.warn(`Malformed Wompi webhook payload — missing transaction or status`);
      return { status: 'ignored', reason: 'malformed_payload' };
    }

    const txData = this.wompi.extractTransactionData(event);
    this.logger.log(`Wompi webhook: ${txData.transactionId} — ${txData.status}`);

    if (!txData.paymentLinkId) {
      this.logger.warn(`Webhook missing payment_link_id — cannot map to a policy (txn ${txData.transactionId})`);
      return { status: 'ignored', reason: 'no_payment_link_id' };
    }

    // A multi-product purchase ("quiero los dos") issues one policy per product, all
    // sharing this one combined payment link — never just the first/single match.
    const policies = await this.policy.findAllByWompiLinkId(txData.paymentLinkId);
    if (policies.length === 0) {
      this.logger.warn(`No policy found for payment_link_id ${txData.paymentLinkId}`);
      return { status: 'ignored', reason: 'policy_not_found' };
    }

    // Idempotency — Wompi retries webhook delivery for reliability; if every policy
    // sharing this link is already paid/active, this transaction (or a duplicate
    // delivery of it) was already handled in full.
    const pending = policies.filter((p) => !PROCESSED_STATUSES.includes(p.status));
    if (pending.length === 0) {
      return { status: 'already_processed' };
    }

    if (txData.status !== 'APPROVED') {
      for (const p of pending) {
        await this.policy.updateStatus(p.id, txData.status.toLowerCase());
      }
      await this.notifyPaymentFailed(pending[0]);
      return { status: 'ignored', reason: txData.status };
    }

    for (const p of pending) {
      await this.policy.updateStatus(p.id, 'paid', { wompi_link_id: txData.paymentLinkId });
      await this.policy.updateStatus(p.id, 'active');
    }

    await this.notifyPoliciesIssued(pending);

    return { status: 'processed', transactionId: txData.transactionId };
  }

  private async notifyPoliciesIssued(policies: Policy[]): Promise<void> {
    const first = policies[0];
    if (!first.conversation_id) return;
    const conversation = await this.conversations.findById(first.conversation_id);
    if (!conversation) return;

    const newContext: ConversationContext = {
      ...conversation.context,
      policyId: first.id,
      policyIds: policies.map((p) => p.id),
    };
    await this.conversations.saveState(conversation.id, ConversationState.POLICY_ISSUED, newContext);

    const message = policies.length > 1
      ? `✅ *¡Quedaste asegurado con ${policies.length} pólizas!*\n\n` +
        `Tus seguros están activos desde hoy. Recibirás un PDF por cada uno adjunto a este chat.\n\n` +
        `Si tienes dudas sobre coberturas o quieres proteger algo más, aquí estoy 24/7.`
      : STATE_RESPONSES[ConversationState.POLICY_ISSUED](newContext);
    await this.telegram.sendText(conversation.user_id, message);

    // This is the only PDF the user ever receives — the draft PDF before payment was
    // removed in an earlier fix, so each policy must send unconditionally on approval.
    for (const policy of policies) {
      const pdfBuffer = await this.policy.generateFinalPdf(policy);
      if (pdfBuffer) {
        await this.telegram.sendDocument(conversation.user_id, pdfBuffer, `poliza-${policy.id.slice(0, 8)}.pdf`);
      }
    }
  }

  private async notifyPaymentFailed(policy: Policy): Promise<void> {
    if (!policy.conversation_id) return;
    const conversation = await this.conversations.findById(policy.conversation_id);
    if (!conversation) return;

    // Clear the dead checkoutUrl so the user's next "sí" creates a fresh payment link
    // instead of handlePayment telling them their (declined) old link "sigue activo".
    const newContext: ConversationContext = { ...conversation.context, checkoutUrl: undefined };
    await this.conversations.saveState(conversation.id, ConversationState.PAYMENT, newContext);

    await this.telegram.sendText(
      conversation.user_id,
      'Tu pago no se pudo completar. Si quieres intentar de nuevo, escríbeme *"sí"* y te genero un nuevo link de pago.',
    );
  }
}
