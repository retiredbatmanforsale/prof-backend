import { OAuth2Client } from "google-auth-library";
import type { GoogleUserPayload } from "../types/index.js";

let client: OAuth2Client | null = null;

function getClient(): OAuth2Client {
  if (!client) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      throw new Error("GOOGLE_CLIENT_ID must be set in environment variables");
    }
    client = new OAuth2Client(clientId);
  }
  return client;
}

export async function verifyGoogleIdToken(
  idToken: string
): Promise<GoogleUserPayload> {
  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const ticket = await getClient().verifyIdToken({
    idToken,
    audience: clientId,
  });

  const payload = ticket.getPayload();
  if (!payload || !payload.email) {
    throw new Error("Invalid Google ID token: missing email");
  }

  return {
    sub: payload.sub,
    name: payload.name || payload.email.split("@")[0],
    email: payload.email,
    email_verified: payload.email_verified ?? false,
    picture: payload.picture,
  };
}
