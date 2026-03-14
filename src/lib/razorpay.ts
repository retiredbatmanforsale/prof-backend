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

export function verifyWebhookSignatureFn(
  body: string,
  signature: string,
  secret: string
): boolean {
  return validateWebhookSignature(body, signature, secret);
}
