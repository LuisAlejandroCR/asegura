// wompi-webhook.controller.ts: the source of truth for payment confirmation. Transactions
// map back to a policy via payment_link_id, since Wompi's Payment Links API has no
// "reference" create-parameter. Only this path notifies the user and sends the final PDF.
import { Controller, Post, Body, UnauthorizedException, Logger } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import * as path from 'path';
import { WompiService } from './wompi.service';
import { PolicyService } from '../policy/policy.service';
import { ConversationService } from '../agent/conversation.service';
import { ChannelRegistry } from '../channel/channel-registry.service';
import { ReminderService } from '../channel/reminder.service';
import { WompiWebhookEvent } from './types';
import { Policy } from '../policy/types';
import { ConversationState, ConversationContext } from '../agent/types';
import { STATE_RESPONSES, formatNameList } from '../agent/conversation-state.machine';

const PROCESSED_STATUSES = ['paid', 'active'];

// Resolved from the project root, not __dirname: nest-cli.json doesn't copy non-.ts assets
// into dist/. "¡Pago recibido!" is baked into the video itself.
const PAYMENT_ANIMATION_PATH = path.join(process.cwd(), 'src', 'assets', 'payment-received.mp4');

// The signature is the gate, and a 429 here is a paid policy that never gets issued.
@SkipThrottle()
@Controller('webhooks/wompi')
export class WompiWebhookController {
  private readonly logger = new Logger(WompiWebhookController.name);

  constructor(
    private readonly wompi: WompiService,
    private readonly policy: PolicyService,
    private readonly conversations: ConversationService,
    private readonly channels: ChannelRegistry,
    private readonly reminders: ReminderService,
  ) {}

  @Post()
  async handleWebhook(@Body() event: WompiWebhookEvent) {
    if (!this.wompi.validateWebhookSignature(event)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // A genuinely-signed event can still carry an unexpected shape (a ping, a future event
    // type), and extractTransactionData destructures transaction.* unconditionally.
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

    // A multi-product purchase shares this one combined link across several policies.
    const policies = await this.policy.findAllByWompiLinkId(txData.paymentLinkId);
    if (policies.length === 0) {
      this.logger.warn(`No policy found for payment_link_id ${txData.paymentLinkId}`);
      return { status: 'ignored', reason: 'policy_not_found' };
    }

    // Idempotency: Wompi retries delivery, so if every policy on this link is already
    // paid/active, this transaction was handled in full.
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

    // One write, not 'paid' followed by 'active': the second overwrote the first in the
    // same request, so the intermediate state was never readable by anything.
    for (const p of pending) {
      await this.policy.updateStatus(p.id, 'active', { wompi_link_id: txData.paymentLinkId });
    }

    await this.notifyPoliciesIssued(pending);

    return { status: 'processed', transactionId: txData.transactionId };
  }

  private async notifyPoliciesIssued(policies: Policy[]): Promise<void> {
    const first = policies[0];
    if (!first.conversation_id) return;
    const conversation = await this.conversations.findById(first.conversation_id);
    if (!conversation) return;
    const adapter = this.channels.get(conversation.channel as 'telegram' | 'whatsapp');

    const newContext: ConversationContext = {
      ...conversation.context,
      policyId: first.id,
      policyIds: policies.map((p) => p.id),
    };
    await this.conversations.saveState(conversation.id, ConversationState.POLICY_ISSUED, newContext);

    let message: string;
    if (policies.length > 1) {
      const firstName = newContext.nombre?.split(' ')[0];
      const petNames = (newContext.pets ?? []).map((p) => p.name);
      const headline = firstName ? `¡Listo, ${firstName}!` : '¡Listo!';
      const petsLine = petNames.length > 0
        ? ` ${formatNameList(petNames)} ya ${petNames.length > 1 ? 'cuentan' : 'cuenta'} con su seguro.`
        : '';
      message =
        `🎉 *${headline}* Quedaste asegurado con ${policies.length} pólizas.${petsLine}\n\n` +
        `Tus seguros están activos desde hoy. Recibirás un PDF por cada uno adjunto a este chat.\n\n` +
        `Si tienes dudas sobre coberturas o quieres proteger algo más, aquí estoy 24/7.`;
    } else {
      message = STATE_RESPONSES[ConversationState.POLICY_ISSUED](newContext);
    }
    await adapter.sendAnimation(conversation.user_id, PAYMENT_ANIMATION_PATH);
    await adapter.sendText(conversation.user_id, message);

    // The only PDF the user ever receives, so each policy sends unconditionally on approval.
    for (const policy of policies) {
      const pdfBuffer = await this.policy.generateFinalPdf(policy);
      if (pdfBuffer) {
        await adapter.sendDocument(conversation.user_id, pdfBuffer, `poliza-${policy.id.slice(0, 8)}.pdf`);
      }
    }

    // Cross-sell happens strictly AFTER payment, never mid-quote. It starts a NEW purchase:
    // identity is kept so DATA_CAPTURE doesn't re-ask, every product field is reset.
    const pendingCategory = newContext.pendingCrossSell;
    const crossSellText = pendingCategory
      ? `¿Seguimos con el seguro de *${pendingCategory}* que mencionaste? Cuéntame y te cotizo.`
      : '¿Quieres proteger algo más? Tengo seguros de vida, accidentes, asistencia médica y mascotas.';
    await adapter.sendText(conversation.user_id, crossSellText);

    const followUpContext: ConversationContext = {
      cedula: newContext.cedula,
      documentType: newContext.documentType,
      nombre: newContext.nombre,
      email: newContext.email,
      // A one-time identity check, not per-purchase — carried over like cédula/nombre/correo.
      phoneVerified: newContext.phoneVerified,
      verifiedPhone: newContext.verifiedPhone,
      // Same one-time-per-conversation reasoning as the phone check.
      selfieProvided: newContext.selfieProvided,
      productCategory: pendingCategory ?? undefined,
      awaitingCrossSellResponse: true,
      // Must persist permanently, unlike policyIds (reset per purchase) and
      // awaitingCrossSellResponse (one-shot): it is the only signal that lets abandonIntent
      // tell "already bought" from "never bought".
      hasCompletedPurchase: true,
      // Unlike policyId/policyIds this carries forward: it is what a later "¿qué cubre mi
      // póliza?" reads from once those are reset for the next purchase.
      purchasedProductIds: newContext.purchasedProductIds,
    };
    await this.conversations.saveState(conversation.id, ConversationState.DISCOVERY, followUpContext);

    // Sent from here, not from a chat message, so handleMessage's own reminder scheduling
    // never runs for it.
    this.reminders.schedule(conversation.id, conversation.user_id, conversation.channel as 'telegram' | 'whatsapp');
  }

  private async notifyPaymentFailed(policy: Policy): Promise<void> {
    if (!policy.conversation_id) return;
    const conversation = await this.conversations.findById(policy.conversation_id);
    if (!conversation) return;

    // Clear the dead checkoutUrl so the next "sí" mints a fresh link instead of re-offering it.
    const newContext: ConversationContext = { ...conversation.context, checkoutUrl: undefined };
    await this.conversations.saveState(conversation.id, ConversationState.PAYMENT, newContext);

    const adapter = this.channels.get(conversation.channel as 'telegram' | 'whatsapp');
    await adapter.sendText(
      conversation.user_id,
      'Tu pago no se pudo completar. Si quieres intentar de nuevo, escríbeme *"sí"* y te genero un nuevo link de pago.',
    );
  }
}
