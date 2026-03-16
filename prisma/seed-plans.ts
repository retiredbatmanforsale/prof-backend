import Razorpay from "razorpay";

const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;

if (!keyId || !keySecret) {
  console.error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set.");
  process.exit(1);
}

const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

interface PlanDef {
  name: string;
  period: "monthly" | "quarterly" | "yearly";
  interval: number;
  amount: number;
  envVar: string;
}

const plans: PlanDef[] = [
  {
    name: "Lex AI Monthly",
    period: "monthly",
    interval: 1,
    amount: parseInt(process.env.PRICE_MONTHLY || "49900", 10),
    envVar: "RAZORPAY_PLAN_MONTHLY",
  },
  {
    name: "Lex AI Quarterly",
    period: "quarterly",
    interval: 3,
    amount: parseInt(process.env.PRICE_QUARTERLY || "119900", 10),
    envVar: "RAZORPAY_PLAN_QUARTERLY",
  },
  {
    name: "Lex AI Yearly",
    period: "yearly",
    interval: 12,
    amount: parseInt(process.env.PRICE_YEARLY || "399900", 10),
    envVar: "RAZORPAY_PLAN_YEARLY",
  },
];

async function seedPlans() {
  console.log("Creating Razorpay subscription plans...\n");

  for (const plan of plans) {
    try {
      const result = await razorpay.plans.create({
        period: "monthly",
        interval: plan.interval,
        item: {
          name: plan.name,
          amount: plan.amount,
          currency: "INR",
          description: `${plan.name} subscription`,
        },
      });

      console.log(`${plan.name}: ${result.id}`);
      console.log(`  ${plan.envVar}=${result.id}`);
      console.log();
    } catch (err: any) {
      console.error(`Failed to create ${plan.name}:`, err.message || err);
    }
  }

  console.log("Done! Copy the plan IDs above to your .env file.");
}

seedPlans();
