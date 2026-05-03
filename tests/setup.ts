// Vitest setup. Keep tests fully offline: never read .env, never hit Prisma,
// never call Razorpay. Each test mocks what it needs.
process.env.NODE_ENV = "test";
process.env.RAZORPAY_KEY_ID = "rzp_test_DUMMY";
process.env.RAZORPAY_KEY_SECRET = "dummy_secret";
process.env.RAZORPAY_WEBHOOK_SECRET = "dummy_webhook_secret";
process.env.RAZORPAY_PLAN_MONTHLY = "plan_test_monthly";
process.env.RAZORPAY_PLAN_QUARTERLY = "plan_test_quarterly";
process.env.RAZORPAY_PLAN_YEARLY = "plan_test_yearly";
