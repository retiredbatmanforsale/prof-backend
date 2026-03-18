import { z } from "zod";

export const createOrganizationSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(200),
    slug: z
      .string()
      .min(1, "Slug is required")
      .max(100)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Slug must be lowercase alphanumeric with hyphens"
      ),
    emailDomains: z
      .array(z.string().min(1))
      .min(1, "At least one email domain is required"),
    accessStartDate: z.string().datetime().nullish(),
    accessEndDate: z.string().datetime().nullish(),
  })
  .refine(
    (data) => {
      if (data.accessStartDate && data.accessEndDate) {
        return new Date(data.accessEndDate) > new Date(data.accessStartDate);
      }
      return true;
    },
    { message: "End date must be after start date", path: ["accessEndDate"] }
  )
  .refine(
    (data) => {
      if (data.accessEndDate) {
        return new Date(data.accessEndDate) > new Date();
      }
      return true;
    },
    { message: "End date must be in the future", path: ["accessEndDate"] }
  );

export const updateOrganizationSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    emailDomains: z.array(z.string().min(1)).min(1).optional(),
    isActive: z.boolean().optional(),
    accessStartDate: z.string().datetime().nullish(),
    accessEndDate: z.string().datetime().nullish(),
  })
  .refine(
    (data) => {
      if (data.accessStartDate && data.accessEndDate) {
        return new Date(data.accessEndDate) > new Date(data.accessStartDate);
      }
      return true;
    },
    { message: "End date must be after start date", path: ["accessEndDate"] }
  )
  .refine(
    (data) => {
      if (data.accessEndDate) {
        return new Date(data.accessEndDate) > new Date();
      }
      return true;
    },
    { message: "End date must be in the future", path: ["accessEndDate"] }
  );

export const addStudentSchema = z.object({
  email: z.string().email("Invalid email"),
  name: z.string().max(100).optional(),
});

export const acceptInviteSchema = z.object({
  token: z.string().min(1, "Token is required"),
  name: z.string().min(1, "Name is required").max(100),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
export type AddStudentInput = z.infer<typeof addStudentSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
