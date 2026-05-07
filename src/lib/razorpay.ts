import Razorpay from "razorpay";
import {
  validatePaymentVerification,
  validateWebhookSignature,
} from "razorpay/dist/utils/razorpay-utils.js";

let razorpayInstance: Razorpay | null = null;

function getRazorpay(): Razorpay {
  if (!razorpayInstance) {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      throw new Error(
        "RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in environment variables"
      );
    }
    razorpayInstance = new Razorpay({
      key_id: keyId,
      key_secret: keySecret,
    });
  }
  return razorpayInstance;
}

function getKeySecret(): string {
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) {
    throw new Error("RAZORPAY_KEY_SECRET must be set in environment variables");
  }
  return keySecret;
}

export async function createOrder(
  amount: number,
  currency: string,
  receipt: string,
  notes?: Record<string, string>
) {
  return getRazorpay().orders.create({
    amount,
    currency,
    receipt,
    notes,
  });
}

export function verifyPaymentSignature(
  orderId: string,
  paymentId: string,
  signature: string
): boolean {
  return validatePaymentVerification(
    { order_id: orderId, payment_id: paymentId },
    signature,
    getKeySecret()
  );
}

interface CreateSubscriptionOptions {
  customerId?: string;
  customerNotify?: 0 | 1;
  notifyEmail?: string;
  notifyPhone?: string;
  notes?: Record<string, string>;
}

export async function createSubscription(
  planId: string,
  totalCount: number,
  opts: CreateSubscriptionOptions = {}
) {
  const { customerId, customerNotify, notifyEmail, notifyPhone, notes } = opts;

  const notifyInfo =
    notifyEmail || notifyPhone
      ? {
          ...(notifyEmail ? { notify_email: notifyEmail } : {}),
          ...(notifyPhone ? { notify_phone: notifyPhone } : {}),
        }
      : undefined;

  return getRazorpay().subscriptions.create({
    plan_id: planId,
    total_count: totalCount,
    quantity: 1,
    ...(customerId ? { customer_id: customerId } : {}),
    ...(customerNotify !== undefined ? { customer_notify: customerNotify } : {}),
    ...(notifyInfo ? { notify_info: notifyInfo } : {}),
    ...(notes ? { notes } : {}),
  });
}

export async function createCustomer(
  name: string,
  email: string,
  contact?: string,
  notes?: Record<string, string>
) {
  return getRazorpay().customers.create({
    name,
    email,
    ...(contact ? { contact } : {}),
    fail_existing: 0,
    ...(notes ? { notes } : {}),
  });
}

export async function fetchSubscription(subscriptionId: string) {
  return getRazorpay().subscriptions.fetch(subscriptionId);
}

export async function cancelSubscription(
  subscriptionId: string,
  cancelAtCycleEnd: boolean = true
) {
  return getRazorpay().subscriptions.cancel(subscriptionId, cancelAtCycleEnd);
}

// Schedule a plan change on an existing subscription. We always schedule
// the switch at cycle_end so the user keeps continuous access through
// the period they've already paid for, and the new plan kicks in on the
// next billing date. Razorpay will fire `subscription.charged` against
// the new plan_id at that boundary.
export async function updateSubscriptionPlan(
  subscriptionId: string,
  newPlanId: string,
  customerNotify: 0 | 1 = 1
): Promise<unknown> {
  // The Razorpay Node SDK's subscriptions.update signature isn't typed
  // for `schedule_change_at`, so we call it through `any` to pass the
  // documented payload through. Behaviour is verified end-to-end via
  // the subscription.charged webhook reflecting the new plan.
  const subs = getRazorpay().subscriptions as unknown as {
    update: (
      id: string,
      body: {
        plan_id: string;
        schedule_change_at: "now" | "cycle_end";
        customer_notify: 0 | 1;
      }
    ) => Promise<unknown>;
  };
  return subs.update(subscriptionId, {
    plan_id: newPlanId,
    schedule_change_at: "cycle_end",
    customer_notify: customerNotify,
  });
}

export async function refundPayment(
  paymentId: string,
  amount?: number,
  notes?: Record<string, string>
) {
  // Omitting amount issues a full refund. speed=normal goes via Razorpay's
  // standard rails (5–7 business days). Use 'optimum' if you want them to
  // pick the fastest method available per instrument.
  return getRazorpay().payments.refund(paymentId, {
    ...(amount !== undefined ? { amount } : {}),
    speed: "normal",
    ...(notes ? { notes } : {}),
  });
}

export async function fetchPayment(paymentId: string) {
  return getRazorpay().payments.fetch(paymentId);
}

export function verifySubscriptionSignature(
  subscriptionId: string,
  paymentId: string,
  signature: string
): boolean {
  return validatePaymentVerification(
    { subscription_id: subscriptionId, payment_id: paymentId },
    signature,
    getKeySecret()
  );
}

export function verifyWebhookSignatureFn(
  body: string,
  signature: string,
  secret: string
): boolean {
  return validateWebhookSignature(body, signature, secret);
}
