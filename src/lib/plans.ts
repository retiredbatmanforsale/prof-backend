import type { PlanType } from "@prisma/client";

export interface PlanConfig {
  planType: PlanType;
  razorpayPlanId: string;
  price: number;
  totalCount: number;
  label: string;
  interval: string;
}

const PLAN_CONFIGS: Record<PlanType, () => PlanConfig> = {
  MONTHLY: () => ({
    planType: "MONTHLY",
    razorpayPlanId: process.env.RAZORPAY_PLAN_MONTHLY || "",
    price: parseInt(process.env.PRICE_MONTHLY || "49900", 10),
    totalCount: 120,
    label: "Monthly",
    interval: "month",
  }),
  QUARTERLY: () => ({
    planType: "QUARTERLY",
    razorpayPlanId: process.env.RAZORPAY_PLAN_QUARTERLY || "",
    price: parseInt(process.env.PRICE_QUARTERLY || "119900", 10),
    totalCount: 40,
    label: "Quarterly",
    interval: "3 months",
  }),
  YEARLY: () => ({
    planType: "YEARLY",
    razorpayPlanId: process.env.RAZORPAY_PLAN_YEARLY || "",
    price: parseInt(process.env.PRICE_YEARLY || "399900", 10),
    totalCount: 10,
    label: "Yearly",
    interval: "year",
  }),
};

export function getPlanConfig(planType: PlanType): PlanConfig {
  const configFn = PLAN_CONFIGS[planType];
  if (!configFn) {
    throw new Error(`Unknown plan type: ${planType}`);
  }
  const config = configFn();
  if (!config.razorpayPlanId) {
    throw new Error(
      `Razorpay plan ID not configured for ${planType}. Set RAZORPAY_PLAN_${planType} in env.`
    );
  }
  return config;
}

export function getAllPlanConfigs(): PlanConfig[] {
  return (["MONTHLY", "QUARTERLY", "YEARLY"] as PlanType[]).map((pt) => {
    const configFn = PLAN_CONFIGS[pt];
    return configFn();
  });
}
