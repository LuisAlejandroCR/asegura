// wompi-webhook.controller.ts: source of truth for payment confirmation.
// Wompi's Payment Links API has no "reference" create-parameter, so transactions
// are matched back to a policy via payment_link_id, not the transaction's own
// auto-generated reference. Chat-based "sí" no longer confirms payment — this
// webhook is the only path that registers on Celo and notifies the user.
import { Controller, Post, Body, UnauthorizedException, Logger } from '@nestjs/common';
import { WompiService } from './wompi.service';
import { PolicyService } from '../policy/policy.service';
import { CeloService } from '../blockchain/celo.service';
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
    private readonly celo: CeloService,
    private readonly conversations: ConversationService,
    private readonly telegram: TelegramAdapter,
  ) {}

  @Post()
  async handleWebhook(@Body() event: WompiWebhookEvent) {
    if (!this.wompi.validateWebhookSignature(event)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const txData = this.wompi.extractTransactionData(event);
    this.logger.log(`Wompi webhook: ${txData.transactionId} — ${txData.status}`);

    if (!txData.paymentLinkId) {
      this.logger.warn(`Webhook missing payment_link_id — cannot map to a policy (txn ${txData.transactionId})`);
      return { status: 'ignored', reason: 'no_payment_link_id' };
    }

    const policy = await this.policy.findByWompiLinkId(txData.paymentLinkId);
    if (!policy) {
      this.logger.warn(`No policy found for payment_link_id ${txData.paymentLinkId}`);
      return { status: 'ignored', reason: 'policy_not_found' };
    }

    // Idempotency — Wompi retries webhook delivery for reliability; a policy already
    // paid/active means this transaction (or a duplicate delivery of it) was handled.
    if (PROCESSED_STATUSES.includes(policy.status)) {
      return { status: 'already_processed' };
    }

    if (txData.status !== 'APPROVED') {
      await this.policy.updateStatus(policy.id, txData.status.toLowerCase());
      await this.notifyPaymentFailed(policy);
      return { status: 'ignored', reason: txData.status };
    }

    await this.policy.updateStatus(policy.id, 'paid', { wompi_link_id: txData.paymentLinkId });

    const referenceURI = `https://asegura.co/poliza/${policy.id}`;
    const { txHash, celoscanUrl } = await this.celo.registerPolicy(policy.id, referenceURI);
    await this.policy.updateStatus(policy.id, 'active', txHash ? { celo_tx_hash: txHash } : {});

    await this.notifyPolicyIssued(policy, celoscanUrl ?? undefined);

    return { status: 'processed', transactionId: txData.transactionId, celoTxHash: txHash };
  }

  private async notifyPolicyIssued(policy: Policy, celoscanUrl?: string): Promise<void> {
    if (!policy.conversation_id) return;
    const conversation = await this.conversations.findById(policy.conversation_id);
    if (!conversation) return;

    const newContext: ConversationContext = { ...conversation.context, celoscanUrl, policyId: policy.id };
    await this.conversations.saveState(conversation.id, ConversationState.POLICY_ISSUED, newContext);
    await this.telegram.sendText(conversation.user_id, STATE_RESPONSES[ConversationState.POLICY_ISSUED](newContext));

    // Only worth resending the PDF when there's a real on-chain tx to show — otherwise
    // it would carry the same referenceURI fallback QR as the draft PDF already sent.
    if (celoscanUrl) {
      const pdfBuffer = await this.policy.generateFinalPdf(policy, celoscanUrl);
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
