import { z } from "zod";

// Indian mobile: +91 followed by 10 digits starting with 6/7/8/9.
// Empty string and undefined both accepted (phone optional at signup).
export const indianPhoneSchema = z
  .string()
  .regex(
    /^\+91[6-9]\d{9}$/,
    "Phone must be in format +91XXXXXXXXXX (10-digit Indian mobile)"
  );

export const registerSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  email: z.string().email("Invalid email").max(255),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128),
  phone: indianPhoneSchema.optional(),
});

export const updatePhoneSchema = z.object({
  phone: indianPhoneSchema,
});

export const updateProfileSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    phone: indianPhoneSchema.optional(),
  })
  .refine(
    (d) => d.name !== undefined || d.phone !== undefined,
    { message: "At least one field must be provided" }
  );

export const loginSchema = z.object({
  email: z.string().email("Invalid email"),
  password: z.string().min(1, "Password is required"),
});

export const googleAuthSchema = z.object({
  credential: z.string().min(1, "Google credential is required"),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token is required"),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email("Invalid email"),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, "Token is required"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128),
});

// Waitlist capture — email is required, everything else optional.
// Source must be one of the known surfaces so we can segment in the
// admin panel without juggling free-form strings.
export const waitlistSchema = z.object({
  email: z.string().email("Invalid email").max(255),
  source: z
    .string()
    .min(1, "source is required")
    .max(64, "source too long")
    .regex(/^[a-z0-9-]+$/, "source must be lowercase / digits / hyphens"),
  // Self-reported, all optional. The /experiences and /subscribe forms
  // only send email + source today; the dedicated waitlist landing
  // collects the richer set.
  name: z.string().max(120).optional(),
  phone: z.string().max(32).optional(),
  organization: z.string().max(160).optional(),
  role: z.string().max(64).optional(),
  // Auto-captured by the frontend.
  referrer: z.string().max(512).optional(),
  utmSource: z.string().max(120).optional(),
  utmMedium: z.string().max(120).optional(),
  utmCampaign: z.string().max(120).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type UpdatePhoneInput = z.infer<typeof updatePhoneSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type GoogleAuthInput = z.infer<typeof googleAuthSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type LogoutInput = z.infer<typeof logoutSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type WaitlistInput = z.infer<typeof waitlistSchema>;
