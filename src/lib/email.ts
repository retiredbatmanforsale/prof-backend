import { google } from "googleapis";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const EMAIL_FROM = process.env.EMAIL_FROM || "noreply@lexailabs.com";
const isDev = process.env.NODE_ENV === "development";

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "https://developers.google.com/oauthplayground"
);

oauth2Client.setCredentials({
  refresh_token: process.env.GMAIL_REFRESH_TOKEN,
});

const gmail = google.gmail({ version: "v1", auth: oauth2Client });

function buildRawEmail(to: string, subject: string, html: string): string {
  const message = [
    `From: Lex AI <${EMAIL_FROM}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=UTF-8`,
    "",
    html,
  ].join("\r\n");

  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sendEmail(to: string, subject: string, html: string) {
  if (isDev) {
    console.log(`[EMAIL] Would send to ${to}: ${subject}`);
    console.log(`[EMAIL] Body: ${html.substring(0, 200)}...`);
    return;
  }

  const raw = buildRawEmail(to, subject, html);
  try {
    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });
    console.log(`[EMAIL] Sent to ${to}: ${subject}`);
  } catch (err: any) {
    console.error(`[EMAIL] Failed to send to ${to}: ${subject}`, {
      status: err?.code || err?.response?.status,
      message: err?.message,
      errors: err?.errors,
    });
    throw err;
  }
}

export async function sendVerificationEmail(email: string, token: string) {
  const verifyUrl = `${process.env.BACKEND_URL || "http://localhost:4000"}/auth/verify-email?token=${token}`;

  await sendEmail(
    email,
    "Verify your email - Lex AI",
    `
      <h2>Welcome to Lex AI</h2>
      <p>Click the link below to verify your email address:</p>
      <a href="${verifyUrl}">Verify Email</a>
      <p>This link expires in 24 hours.</p>
      <p>If you didn't create an account, you can ignore this email.</p>
    `
  );
}

export async function sendPasswordResetEmail(email: string, token: string) {
  const resetUrl = `${FRONTEND_URL}/reset-password?token=${token}`;

  await sendEmail(
    email,
    "Reset your password - Lex AI",
    `
      <h2>Password Reset</h2>
      <p>Click the link below to reset your password:</p>
      <a href="${resetUrl}">Reset Password</a>
      <p>This link expires in 1 hour.</p>
      <p>If you didn't request a password reset, you can ignore this email.</p>
    `
  );
}
