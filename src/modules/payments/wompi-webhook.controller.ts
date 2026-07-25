// wompi-webhook.controller.ts: source of truth for payment confirmation.
// Wompi's Payment Links API has no "reference" create-parameter, so transactions
// are matched back to a policy via payment_link_id, not the transaction's own
// auto-generated reference. Chat-based "sí" no longer confirms payment — this
// webhook is the only path that notifies the user and sends the final PDF.
import { Controller, Post, Body, UnauthorizedException, Logger } from '@nestjs/common';
import * as path from 'path';
import { WompiService } from './wompi.service';
import { PolicyService } from '../policy/policy.service';
import { ConversationService } from '../agent/conversation.service';
import { TelegramAdapter } from '../channel/telegram-adapter.service';
import { WompiWebhookEvent } from './types';
import { Policy } from '../policy/types';
import { ConversationState, ConversationContext } from '../agent/types';
import { STATE_RESPONSES, formatNameList } from '../agent/conversation-state.machine';

const PROCESSED_STATUSES = ['paid', 'active'];

// Static brand asset — referenced relative to the project root (not __dirname) because
// nest-cli.json doesn't copy non-.ts assets into dist/, and the server runs `node dist/main`
// from the project root, so `src/assets/` is reachable at runtime via process.cwd()
// (same convention as pdf.service.ts's IMAGES_DIR and agent.service.ts's copy of this path).
// "¡Pago recibido!" is baked into the video itself (2026-07-24 feedback) — same asset
// used for the Tarjeta Colsubsidio choice in agent.service.ts.
const PAYMENT_ANIMATION_PATH = path.join(process.cwd(), 'src', 'assets', 'payment-received.mp4');

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

    // 2026-07-24 gamification feedback: same celebratory, personalized style as the
    // single-policy STATE_RESPONSES[POLICY_ISSUED] message.
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
    // 2026-07-24 feedback: the real Wompi approval is the actual "successfully paid"
    // moment — gets the same branded success-checkmark video as the selfie and
    // Tarjeta Colsubsidio moments.
    await this.telegram.sendAnimation(conversation.user_id, PAYMENT_ANIMATION_PATH);
    await this.telegram.sendText(conversation.user_id, message);

    // This is the only PDF the user ever receives — the draft PDF before payment was
    // removed in an earlier fix, so each policy must send unconditionally on approval.
    for (const policy of policies) {
      const pdfBuffer = await this.policy.generateFinalPdf(policy);
      if (pdfBuffer) {
        await this.telegram.sendDocument(conversation.user_id, pdfBuffer, `poliza-${policy.id.slice(0, 8)}.pdf`);
      }
    }

    // 2026-07-24 "restore the flow": cross-selling now happens strictly AFTER a purchase
    // is fully paid, never mid-quote (see AgentService.deferCrossSell). If the user showed
    // interest in a specific category earlier, follow up with THAT one by name and seed it
    // into the fresh context so their very next message (even a bare "sí") produces a real
    // quote immediately. Otherwise offer a generic "want something else?" prompt. Either
    // way this starts a genuinely NEW, separate purchase — identity (cédula/nombre/correo)
    // is kept so DATA_CAPTURE doesn't re-ask it, but every product-specific field is reset.
    const pendingCategory = newContext.pendingCrossSell;
    const crossSellText = pendingCategory
      ? `¿Seguimos con el seguro de *${pendingCategory}* que mencionaste? Cuéntame y te cotizo.`
      : '¿Quieres proteger algo más? Tengo seguros de vida, accidentes, asistencia médica y mascotas.';
    await this.telegram.sendText(conversation.user_id, crossSellText);

    const followUpContext: ConversationContext = {
      cedula: newContext.cedula,
      documentType: newContext.documentType,
      nombre: newContext.nombre,
      email: newContext.email,
      // Phone verification (2026-07-24 KYC feedback) is a one-time identity check, not
      // per-purchase — carried over exactly like cédula/nombre/correo so a returning
      // customer isn't asked to re-verify on their next purchase in this conversation.
      phoneVerified: newContext.phoneVerified,
      verifiedPhone: newContext.verifiedPhone,
      // Cosmetic selfie step (2026-07-24) — same one-time-per-conversation reasoning.
      selfieProvided: newContext.selfieProvided,
      productCategory: pendingCategory ?? undefined,
      awaitingCrossSellResponse: true,
      // Real live-test bug: unlike policyId/policyIds (purchase-specific, reset here for
      // the next one) and awaitingCrossSellResponse (a one-shot flag), this must persist
      // permanently once set — it's the only durable signal that lets a LATER
      // abandonIntent (processMessage in agent.service.ts) tell "already bought
      // something" apart from "never bought anything", so a declined cross-sell doesn't
      // get recorded as the same conversation status as never having purchased at all.
      hasCompletedPurchase: true,
    };
    await this.conversations.saveState(conversation.id, ConversationState.DISCOVERY, followUpContext);
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
