# Lex AI Auth Service - Knowledge Transfer Document

This document is a complete knowledge transfer for the Lex AI authentication backend. It covers everything a developer needs to understand, maintain, and extend this codebase.

---

## 1. Codebase Overview

### What does this backend do?

This is the authentication, authorization, and payment microservice for the Lex AI learning platform. It handles:

- User registration and login (email/password + Google OAuth)
- Email verification and password reset flows
- JWT-based session management with refresh token rotation
- Razorpay payment integration (one-time purchases + recurring subscriptions)
- B2B institutional access management (organizations, student invitations, CSV bulk upload)
- Admin panel API for managing organizations and students

### How does it fit into the ecosystem?

This backend serves as the API for two frontends:

- **prof-lexai.vercel.app** - The newer frontend (Next.js/Nexus)
- **docusaurus-lexailabs.vercel.app** - The original Docusaurus-based frontend (legacy, on `old-staging` branch)

The backend is deployed on **Google Cloud Run** and connects to a **Neon PostgreSQL** database.

### The core problem it solves

Lex AI offers paid courses. Users get access in three ways:

1. **One-time payment (legacy)** - User pays once via Razorpay, gets lifetime access
2. **Subscription** - User subscribes monthly/quarterly/yearly via Razorpay
3. **Institutional (B2B)** - A college/university signs up, admin adds students, students get access without paying

The JWT issued at login contains `hasAccess`, `accessType`, and `organizationName` so the frontend can gate course content without additional API calls.

---

## 2. Tech Stack

| Layer | Technology | Details |
|-------|-----------|---------|
| Runtime | Node.js 22 | ESM modules (`"type": "module"`) |
| Framework | Fastify 5.2.1 | High-performance web framework |
| Language | TypeScript 5.7 | Strict mode, ES2022 target |
| Database | PostgreSQL | Hosted on Neon (serverless) |
| ORM | Prisma 6.x | Schema-first, type-safe queries |
| Auth | JWT (@fastify/jwt) | 15-min access tokens, 7-day refresh tokens |
| OAuth | Google Identity Services | Server-side ID token verification |
| Payments | Razorpay | One-time orders + recurring subscriptions |
| Email | Gmail API (googleapis) | OAuth2 service account, branded HTML emails |
| Validation | Zod | Schema validation on all request bodies |
| Password Hashing | bcryptjs | 12 salt rounds |
| Rate Limiting | @fastify/rate-limit | Per-IP limits on all endpoints |
| File Upload | @fastify/multipart | CSV bulk upload (5MB limit) |
| CSV Parsing | csv-parse | Sync parsing of student CSV files |
| Security | @fastify/helmet | Security headers (CSP disabled for API) |
| Containerization | Docker | Multi-stage build, node:22-alpine |
| Hosting | Google Cloud Run | Container-based deployment |

---

## 3. Project Structure

```
auth-service/
├── prisma/
│   ├── schema.prisma          # Database schema (all models, enums, relations)
│   ├── seed.ts                # Test data seeder (users, orgs, students)
│   └── seed-plans.ts          # Creates Razorpay subscription plans
├── src/
│   ├── index.ts               # Entry point — starts Fastify server on PORT
│   ├── app.ts                 # App builder — registers plugins, health checks, route prefixes
│   ├── types/
│   │   └── index.ts           # JWTPayload, GoogleUserPayload, Fastify module augmentations
│   ├── lib/
│   │   ├── email.ts           # Gmail API — sends verification, reset, invitation, no-password emails
│   │   ├── google.ts          # Verifies Google OAuth ID tokens
│   │   ├── passwords.ts       # bcrypt hash + verify (12 rounds)
│   │   ├── session.ts         # Token issuance, access checks, revocation
│   │   ├── tokens.ts          # Secure random token generation + SHA-256 hashing
│   │   ├── razorpay.ts        # Razorpay SDK — orders, subscriptions, signature verification
│   │   └── plans.ts           # Subscription plan configs (prices, Razorpay plan IDs)
│   ├── hooks/
│   │   ├── auth.ts            # authenticate (JWT verify) + optionalAuthenticate
│   │   └── admin.ts           # requireAdmin (role === ADMIN check)
│   ├── plugins/
│   │   ├── cors.ts            # CORS — ALLOWED_ORIGINS whitelist, dev localhost:* fallback
│   │   ├── jwt.ts             # JWT plugin — JWT_SECRET, 15m default expiry
│   │   ├── prisma.ts          # Prisma client lifecycle (connect/disconnect)
│   │   ├── rate-limit.ts      # Default 1000 req/min per IP
│   │   └── multipart.ts       # File upload — 5MB limit
│   ├── schemas/
│   │   ├── auth.ts            # Zod schemas: register, login, google, refresh, logout, forgot/reset password
│   │   └── admin.ts           # Zod schemas: createOrg, updateOrg, addStudent, acceptInvite
│   └── routes/
│       ├── auth/
│       │   ├── index.ts       # Aggregates all auth routes
│       │   ├── register.ts    # POST /auth/register
│       │   ├── login.ts       # POST /auth/login
│       │   ├── google.ts      # POST /auth/google (+ B2B_PENDING_INVITE guard)
│       │   ├── refresh.ts     # POST /auth/refresh (token rotation + theft detection)
│       │   ├── logout.ts      # POST /auth/logout + POST /auth/logout-all
│       │   ├── me.ts          # GET /auth/me (user profile + access info)
│       │   ├── verify-email.ts    # GET /auth/verify-email (redirect-based)
│       │   ├── forgot-password.ts # POST /auth/forgot-password
│       │   ├── reset-password.ts  # POST /auth/reset-password
│       │   └── accept-invite.ts   # GET /auth/invite-info + POST /auth/accept-invite
│       ├── admin/
│       │   ├── index.ts           # Applies authenticate + requireAdmin to all child routes
│       │   ├── organizations.ts   # CRUD: POST/GET/GET:id/PATCH organizations
│       │   └── students.ts       # POST add, POST bulk CSV, GET list, DELETE remove
│       ├── payments/
│       │   └── index.ts          # POST create-order, POST verify, GET status
│       ├── subscriptions/
│       │   └── index.ts          # GET plans, POST create, POST verify, GET status, POST cancel, POST cancel-created
│       └── webhooks/
│           └── razorpay.ts       # POST /webhooks/razorpay — payment + subscription event handler
├── Dockerfile                 # Multi-stage: build with tsc, run with node:22-alpine
├── .dockerignore
├── .gitignore
├── .env.example               # All required env vars with descriptions
├── package.json
├── tsconfig.json
├── README.md
├── ADMIN-FLOW.md              # Detailed admin/B2B flow documentation for frontend developers
└── KT-Backend.md              # This file
```

---

## 4. API Endpoints

### Health Checks (no auth)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Returns `{ status: "ok" }` |
| GET | `/health/ready` | Tests DB connection |
| GET | `/health/email` | Tests Gmail API connection, shows diagnostic info |

### Auth (`/auth`)

| Method | Path | Auth | Rate Limit | Purpose |
|--------|------|------|------------|---------|
| POST | `/auth/register` | No | 5/min | Create account (email/password). Sends verification email. Auto-grants B2B access if email matches PreloadedStudent. |
| POST | `/auth/login` | No | 10/min | Email/password login. Returns JWT + refresh token. Checks B2B preapproval. |
| POST | `/auth/google` | No | 20/min | Google OAuth login. Creates/links account. Blocks new signups with pending B2B invite (code: `B2B_PENDING_INVITE`). |
| POST | `/auth/refresh` | No | 30/min | Refresh access token. Token rotation. Theft detection (revoked token = revoke all). |
| POST | `/auth/logout` | Yes | 10/min | Revoke single refresh token. |
| POST | `/auth/logout-all` | Yes | 5/min | Revoke all user sessions. |
| GET | `/auth/me` | Yes | 30/min | Current user profile + access info. |
| GET | `/auth/verify-email` | No | 10/min | Email verification (redirect to frontend). |
| POST | `/auth/forgot-password` | No | 3/min | Request password reset email. |
| POST | `/auth/reset-password` | No | 5/min | Reset password with token. Revokes all sessions. |
| GET | `/auth/invite-info` | No | 20/min | Validate B2B invitation token, return email/name/orgName. |
| POST | `/auth/accept-invite` | No | 10/min | Accept B2B invitation, create account + org membership. |

#### Detailed Request/Response for Key Endpoints

**POST /auth/register**
```
Request:  { name: string, email: string, password: string }
Response: { success: true, message: "Account created. Please check your email..." }
Notes:    Always returns 201 even if user exists (prevents enumeration).
          Password: 8-128 chars. Email verification token: 24h expiry.
```

**POST /auth/login**
```
Request:  { email: string, password: string }
Response: { success: true, accessToken: string, refreshToken: string }
Errors:   401 — Invalid credentials
          401 + code "B2B_PREAPPROVED" — Email is in PreloadedStudent, prompt to register
          403 + code "EMAIL_NOT_VERIFIED" — Email not verified yet
          403 — Account deactivated
```

**POST /auth/google**
```
Request:  { credential: string }  // Google ID token
Response: { success: true, accessToken: string, refreshToken: string }
Errors:   403 + code "B2B_PENDING_INVITE" — New user has pending B2B invite
          403 — Account deactivated
```

**POST /auth/refresh**
```
Request:  { refreshToken: string }
Response: { success: true, accessToken: string, refreshToken: string }
Notes:    Old refresh token is revoked (rotation). If revoked token is reused,
          ALL user tokens are revoked (theft detection).
```

**GET /auth/me**
```
Response: {
  user: { id, name, email, image, role, isPremium, emailVerified, createdAt },
  hasAccess: boolean,
  accessType: "premium" | "subscription" | "institution" | null,
  organizationName: string | null
}
```

**GET /auth/invite-info?token=xxx**
```
Response: { email: string, name: string | null, organizationName: string }
Errors:   404 — Invalid token
          410 — Token used or expired
```

**POST /auth/accept-invite**
```
Request:  { token: string, name: string, password: string }
Response: { success: true }
Notes:    Creates user (or updates existing) + OrganizationMember.
          Email is auto-verified. Student should be redirected to /login?verified=true.
```

### Admin (`/admin`) — All require JWT with role=ADMIN

| Method | Path | Rate Limit | Purpose |
|--------|------|------------|---------|
| POST | `/admin/organizations` | 10/min | Create organization |
| GET | `/admin/organizations` | - | List all orgs with student/member counts |
| GET | `/admin/organizations/:id` | - | Org detail with members + preloaded students |
| PATCH | `/admin/organizations/:id` | 10/min | Update org (name, domains, active, timeline) |
| POST | `/admin/organizations/:orgId/students` | 10/min | Add single student + send invite email |
| POST | `/admin/organizations/:orgId/students/bulk` | 5/min | CSV upload (multipart/form-data) |
| GET | `/admin/organizations/:orgId/students` | - | List students with claim status |
| DELETE | `/admin/organizations/:orgId/students/:id` | 10/min | Remove unclaimed student |

**POST /admin/organizations**
```
Request: {
  name: string,                    // 1-200 chars
  slug: string,                    // lowercase alphanumeric + hyphens, unique
  emailDomains: string[],          // at least one
  accessStartDate?: ISO 8601,      // null = immediate
  accessEndDate?: ISO 8601         // null = never expires, must be > startDate, must be future
}
Response: { success: true, organization: { id, name, slug, emailDomains, isActive, accessStartDate, accessEndDate, ... } }
```

**GET /admin/organizations**
```
Response: {
  organizations: [{
    id, name, slug, emailDomains, isActive, accessStartDate, accessEndDate,
    _count: { members: number, preloadedStudents: number }
  }]
}
```

**POST /admin/organizations/:orgId/students**
```
Request:  { email: string, name?: string }
Response: { success: true, student: { id, email, name, claimed } }
Notes:    Upserts student. Invalidates old tokens. Generates 7-day invitation token.
          Sends branded invitation email automatically.
          Re-adding same email = resend invitation.
```

**POST /admin/organizations/:orgId/students/bulk**
```
Content-Type: multipart/form-data (field name: "file")
CSV format: email,name (header required, name optional)
Max: 5MB file, 10,000 rows
Response: { success: true, added: number, skipped: number, errors: string[] }
```

### Payments (`/payments`) — All require JWT

| Method | Path | Rate Limit | Purpose |
|--------|------|------------|---------|
| POST | `/payments/create-order` | 5/min | Create Razorpay one-time order |
| POST | `/payments/verify` | 5/min | Verify payment signature + grant access |
| GET | `/payments/status` | 30/min | Current payment/access status |

**POST /payments/create-order**
```
Response: { orderId: string, amount: number, currency: "INR", keyId: string }
Notes:    Blocked if user already has premium or institutional access.
          Amount from PLATFORM_PRICE env var (default: 49900 paise = Rs 499).
```

**POST /payments/verify**
```
Request:  { razorpay_order_id, razorpay_payment_id, razorpay_signature }
Response: { success: true, message: "Payment verified and access granted" }
Notes:    Verifies signature, sets payment.status="paid", user.isPremium=true.
```

### Subscriptions (`/subscriptions`)

| Method | Path | Auth | Rate Limit | Purpose |
|--------|------|------|------------|---------|
| GET | `/subscriptions/plans` | No | 30/min | List available plans with prices |
| POST | `/subscriptions/create` | Yes | 5/min | Create Razorpay subscription |
| POST | `/subscriptions/verify` | Yes | 5/min | Verify subscription payment |
| GET | `/subscriptions/status` | Yes | 30/min | Current subscription details |
| POST | `/subscriptions/cancel-created` | Yes | 5/min | Cancel CREATED subscription (popup dismissed) |
| POST | `/subscriptions/cancel` | Yes | 3/min | Cancel active subscription at cycle end |

**GET /subscriptions/plans**
```
Response: {
  plans: [{
    planType: "MONTHLY" | "QUARTERLY" | "YEARLY",
    label: string,
    price: number,          // in paise
    priceDisplay: string,   // e.g. "₹499"
    interval: string        // "month" | "quarter" | "year"
  }]
}
```

**POST /subscriptions/create**
```
Request:  { planType: "MONTHLY" | "QUARTERLY" | "YEARLY" }
Response: { subscriptionId: string, keyId: string }
Notes:    Auto-cancels stale CREATED subscriptions before creating new one.
          Blocked if user already has access.
```

**POST /subscriptions/cancel**
```
Response: { success: true, message: "Subscription will be cancelled at end of billing period", currentPeriodEnd }
Notes:    Cancels at cycle end (not immediately). Webhook updates final status.
```

### Webhooks (`/webhooks`) — No auth (signature-verified)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/webhooks/razorpay` | Handle Razorpay payment + subscription events |

**Events handled:**

| Event | Action |
|-------|--------|
| `payment.captured` | Mark payment "paid", set `isPremium=true` |
| `payment.failed` | Mark payment "failed" |
| `subscription.activated` | Status="ACTIVE", `isPremium=true` |
| `subscription.charged` | Status="ACTIVE", update period dates, `isPremium=true` |
| `subscription.pending` | Status="PENDING" (keep access during retry window) |
| `subscription.halted` | Status="HALTED", revoke access (unless legacy one-time payment exists) |
| `subscription.cancelled` | Status="CANCELLED", revoke access (unless legacy payment) |
| `subscription.completed` | Status="COMPLETED", revoke access (unless legacy payment) |
| `subscription.paused` | Status="PAUSED", revoke access (unless legacy payment) |
| `subscription.resumed` | Status="ACTIVE", restore access |

**Legacy payment protection:** When revoking access on subscription end, the webhook checks if the user has a legacy one-time `Payment` with `status="paid"`. If so, `isPremium` stays `true`.

---

## 5. Database Schema

### Enums

```
Role:               ADMIN, USER
PlanType:           MONTHLY, QUARTERLY, YEARLY
SubscriptionStatus: CREATED, AUTHENTICATED, ACTIVE, PENDING, HALTED, CANCELLED, COMPLETED, EXPIRED, PAUSED
```

### Tables

**users**
| Column | Type | Notes |
|--------|------|-------|
| id | cuid | Primary key |
| name | String | Required |
| email | String | Unique |
| emailVerified | DateTime? | Null = not verified |
| image | String? | Profile picture URL |
| hashedPassword | String? | Null for Google-only accounts |
| role | Role | Default: USER |
| isActive | Boolean | Default: true. False = account deactivated |
| isPremium | Boolean | Default: false. True = has paid access |
| createdAt | DateTime | Auto |
| updatedAt | DateTime | Auto |

**oauth_accounts**
| Column | Type | Notes |
|--------|------|-------|
| id | cuid | Primary key |
| userId | String | FK to users |
| provider | String | "google" |
| providerAccountId | String | Google `sub` ID |
| | | Unique: [provider, providerAccountId] |

**refresh_tokens**
| Column | Type | Notes |
|--------|------|-------|
| id | cuid | Primary key |
| userId | String | FK to users. Indexed. |
| token | String | SHA-256 hash. Unique. |
| expiresAt | DateTime | 7 days from creation |
| isRevoked | Boolean | Default: false |
| createdAt | DateTime | Auto |

**email_verification_tokens**
| Column | Type | Notes |
|--------|------|-------|
| id | cuid | Primary key |
| email | String | The email to verify |
| token | String | SHA-256 hash. Unique. |
| expiresAt | DateTime | 24 hours from creation |
| createdAt | DateTime | Auto |

**password_reset_tokens**
| Column | Type | Notes |
|--------|------|-------|
| id | cuid | Primary key |
| userId | String | FK to users |
| token | String | SHA-256 hash. Unique. |
| expiresAt | DateTime | 1 hour from creation |
| used | Boolean | Default: false |
| createdAt | DateTime | Auto |

**organizations**
| Column | Type | Notes |
|--------|------|-------|
| id | cuid | Primary key |
| name | String | Display name |
| slug | String | URL-safe identifier. Unique. |
| emailDomains | String[] | Array of allowed email domains |
| isActive | Boolean | Default: true. Master kill switch. |
| accessStartDate | DateTime? | Null = immediate access |
| accessEndDate | DateTime? | Null = no expiry |
| createdAt | DateTime | Auto |
| updatedAt | DateTime | Auto |

**organization_members**
| Column | Type | Notes |
|--------|------|-------|
| id | cuid | Primary key |
| userId | String | FK to users |
| organizationId | String | FK to organizations |
| isVerified | Boolean | Default: false |
| isActive | Boolean | Default: true |
| | | Unique: [userId, organizationId] |

**preloaded_students**
| Column | Type | Notes |
|--------|------|-------|
| id | cuid | Primary key |
| email | String | Student email |
| name | String? | Optional name from admin/CSV |
| organizationId | String | FK to organizations |
| claimed | Boolean | Default: false. True after invite accepted. |
| claimedByUserId | String? | FK to users (who accepted) |
| | | Unique: [organizationId, email] |

**invitation_tokens**
| Column | Type | Notes |
|--------|------|-------|
| id | cuid | Primary key |
| token | String | Raw token (not hashed). Unique. |
| preloadedStudentId | String | FK to preloaded_students. Cascade delete. |
| expiresAt | DateTime | 7 days from creation |
| used | Boolean | Default: false |
| createdAt | DateTime | Auto |

**payments**
| Column | Type | Notes |
|--------|------|-------|
| id | cuid | Primary key |
| userId | String | FK to users. Indexed. |
| razorpayOrderId | String | Unique |
| razorpayPaymentId | String? | Unique. Set after payment captured. |
| amount | Int | In paise (49900 = Rs 499) |
| currency | String | Default: "INR" |
| status | String | "created", "paid", "failed" |
| receipt | String? | Internal receipt ID |

**subscriptions**
| Column | Type | Notes |
|--------|------|-------|
| id | cuid | Primary key |
| userId | String | FK to users. Indexed. |
| razorpaySubscriptionId | String | Unique |
| razorpayPlanId | String | Razorpay plan ID |
| planType | PlanType | MONTHLY/QUARTERLY/YEARLY |
| status | SubscriptionStatus | Indexed. See state machine below. |
| currentPeriodStart | DateTime? | Current billing period start |
| currentPeriodEnd | DateTime? | Current billing period end |
| cancelledAt | DateTime? | When cancellation was requested |
| endedAt | DateTime? | When subscription actually ended |
| shortUrl | String? | Razorpay payment link |

---

## 6. Authentication & Authorization

### Token Lifecycle

```
User logs in (email/password or Google OAuth)
  → Backend calls issueTokens()
  → JWT access token created (15-minute expiry)
     Payload: { userId, email, role, hasAccess, accessType, organizationName }
  → Refresh token: 32 random bytes (hex), SHA-256 hashed, stored in DB (7-day expiry)
  → Both returned to frontend

Frontend stores:
  - Access token: in memory (not localStorage)
  - Refresh token: in localStorage

Every 14 minutes (before 15-min expiry):
  → Frontend calls POST /auth/refresh with refresh token
  → Backend: hash token, lookup in DB, verify not revoked/expired
  → Old refresh token is revoked (rotation)
  → New access + refresh tokens issued

If revoked token is reused (theft detection):
  → ALL user refresh tokens are revoked (force logout everywhere)
  → Returns 401
```

### Access Control Decision Tree

```
getAccessInfo(userId):
  1. Is user.isPremium?
     → Has active subscription (ACTIVE/AUTHENTICATED/PENDING)?
       → Within currentPeriodEnd?  → accessType = "subscription"
       → Period expired?           → Has legacy one-time payment? → "premium"
                                   → No legacy payment? → revoke isPremium, fall through
     → No active subscription?     → accessType = "premium" (legacy one-time user)

  2. Has OrganizationMember?
     → isActive=true, isVerified=true
     → org.isActive=true
     → accessStartDate is null OR <= now
     → accessEndDate is null OR >= now
     → If all true: accessType = "institution"

  3. Otherwise: hasAccess = false
```

### Role-Based Access

| Role | Capabilities |
|------|-------------|
| USER | Access courses (if `hasAccess`), manage own profile, payments |
| ADMIN | Everything USER can do + all `/admin/*` endpoints |

### B2B Auto-Access

On register/login/Google auth, the backend checks if the user's email matches an unclaimed `PreloadedStudent` record with an active organization. If so, it automatically creates an `OrganizationMember` and marks the student as claimed. This means students who register normally (without an invite link) can still get B2B access if they were pre-loaded.

---

## 7. Payment Integration (Razorpay)

### One-Time Payments

```
Frontend                              Backend                              Razorpay
   |                                     |                                     |
   |-- POST /payments/create-order ----->|                                     |
   |                                     |-- createOrder(amount) ------------->|
   |                                     |<-- order { id } -------------------|
   |                                     |-- Store Payment(status=created) --->|
   |<-- { orderId, amount, keyId } ------|                                     |
   |                                     |                                     |
   |-- Open Razorpay checkout popup ---->|                                     |
   |   (user pays)                       |                                     |
   |                                     |                                     |
   |-- POST /payments/verify ----------->|                                     |
   |   { order_id, payment_id, sig }     |-- verifySignature() ------------->  |
   |                                     |-- Update Payment(status=paid) ---->  |
   |                                     |-- Set user.isPremium=true -------->  |
   |<-- { success: true } ---------------|                                     |
```

### Subscriptions

```
Frontend                              Backend                              Razorpay
   |                                     |                                     |
   |-- GET /subscriptions/plans -------->|                                     |
   |<-- plans[] (with prices) ----------|                                     |
   |                                     |                                     |
   |-- POST /subscriptions/create ------>|                                     |
   |   { planType: "MONTHLY" }           |-- createSubscription(planId) ----->|
   |                                     |<-- subscription { id } ------------|
   |                                     |-- Store Subscription(CREATED) ---->  |
   |<-- { subscriptionId, keyId } ------|                                     |
   |                                     |                                     |
   |-- Open Razorpay checkout popup ---->|                                     |
   |   (user pays first installment)     |                                     |
   |                                     |                                     |
   |-- POST /subscriptions/verify ------>|                                     |
   |   { sub_id, payment_id, sig }       |-- verifySignature() ------------->  |
   |                                     |-- Update Sub(AUTHENTICATED) ------>  |
   |                                     |-- Set user.isPremium=true -------->  |
   |<-- { success: true } ---------------|                                     |
   |                                     |                                     |
   |  (recurring charges happen via webhooks)                                  |
   |                                     |<-- webhook: subscription.charged --|
   |                                     |-- Update Sub(ACTIVE, periodEnd) -->  |
```

### Subscription State Machine

```
CREATED ──────────> AUTHENTICATED ──────────> ACTIVE
   │                                            │
   │ (user dismisses popup)                     │ (payment fails)
   v                                            v
CANCELLED                                    PENDING
                                               │
                                    (retry succeeds) → ACTIVE
                                    (retry fails)    → HALTED
                                                        │
                                                        v
                                               CANCELLED / COMPLETED

Additional states: PAUSED ←→ ACTIVE (via resume)
```

### Plan Pricing (configurable via env vars)

| Plan | Default Price | Billing Cycles |
|------|--------------|----------------|
| MONTHLY | Rs 499/month | 120 cycles (10 years) |
| QUARTERLY | Rs 1,199/quarter | 40 cycles (10 years) |
| YEARLY | Rs 3,999/year | 10 cycles (10 years) |

---

## 8. Email System

Uses Gmail API with OAuth2. In development mode (`NODE_ENV=development`), emails are logged to console instead of sent.

| Email Type | Trigger | Link Target | Expiry |
|-----------|---------|-------------|--------|
| Verification | POST /auth/register | `{BACKEND_URL}/auth/verify-email?token=xxx` | 24 hours |
| Password Reset | POST /auth/forgot-password | `{FRONTEND_URL}/reset-password?token=xxx` | 1 hour |
| Invitation | Admin adds student | `{FRONTEND_URL}/accept-invite?token=xxx` | 7 days |
| No Password | POST /auth/forgot-password (Google-only user) | `{FRONTEND_URL}/login` | N/A |

All emails use branded HTML with Lex AI styling (blue #2563eb CTA button, sign-off from "The Lex AI Team").

---

## 9. Environment Variables

```env
# ─── Database ───
DATABASE_URL=postgresql://user:password@host.neon.tech/lexai?sslmode=require&connection_limit=20

# ─── Auth ───
JWT_SECRET=your-random-64-char-secret-here        # REQUIRED. Used to sign JWTs.

# ─── Google OAuth ───
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com    # For verifying Google ID tokens
GOOGLE_CLIENT_SECRET=xxx                           # For Gmail API OAuth2
GMAIL_REFRESH_TOKEN=xxx                            # Long-lived refresh token for Gmail API

# ─── Razorpay ───
RAZORPAY_KEY_ID=rzp_test_xxx                       # Test or live key (shown to frontend)
RAZORPAY_KEY_SECRET=xxx                            # Server-side only
RAZORPAY_WEBHOOK_SECRET=xxx                        # For verifying webhook signatures
PLATFORM_PRICE=49900                               # One-time payment amount in paise

# ─── Razorpay Plans (from seed-plans.ts output) ───
RAZORPAY_PLAN_MONTHLY=plan_xxxxxxxxxxxxx
RAZORPAY_PLAN_QUARTERLY=plan_xxxxxxxxxxxxx
RAZORPAY_PLAN_YEARLY=plan_xxxxxxxxxxxxx
PRICE_MONTHLY=49900                                # Subscription price in paise
PRICE_QUARTERLY=119900
PRICE_YEARLY=399900

# ─── Email ───
EMAIL_FROM=your-email@yourdomain.com               # Gmail sender address

# ─── URLs ───
FRONTEND_URL=http://localhost:3000                  # For email links (reset password, invitations)
BACKEND_URL=http://localhost:4000                   # For email links (verify email redirect)
ALLOWED_ORIGINS=http://localhost:3000               # Comma-separated CORS origins

# ─── Server ───
PORT=4000                                          # Server port (Cloud Run uses 8080)
NODE_ENV=development                               # "development" = log emails instead of sending
```

---

## 10. Deployment

### Google Cloud Run

The service is containerized with Docker and deployed to Google Cloud Run.

**Dockerfile details:**
- Builder stage: `node:22-alpine`, runs `npm ci` + `prisma generate` + `tsc`
- Runtime stage: `node:22-alpine`, non-root `app` user, copies `dist/` + `node_modules/` + `prisma/`
- Exposes port 8080 (Cloud Run default), but app listens on `PORT` env var

**To deploy manually:**
```bash
# Build and push image
docker build -t gcr.io/YOUR_PROJECT/auth-service .
docker push gcr.io/YOUR_PROJECT/auth-service

# Deploy to Cloud Run
gcloud run deploy auth-service \
  --image gcr.io/YOUR_PROJECT/auth-service \
  --region YOUR_REGION \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "DATABASE_URL=...,JWT_SECRET=...,..."
```

**Important:** Set the `PORT` env var to `8080` on Cloud Run, or update the Dockerfile `EXPOSE` to match.

---

## 11. Local Setup Guide

```bash
# 1. Clone
git clone https://github.com/retiredbatmanforsale/prof-backend.git
cd prof-backend

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Fill in all values — at minimum: DATABASE_URL, JWT_SECRET, GOOGLE_CLIENT_ID/SECRET

# 4. Push schema to database
npx prisma db push

# 5. Generate Prisma client
npx prisma generate

# 6. Seed test data
npm run db:seed

# 7. (Optional) Create Razorpay subscription plans
npm run db:seed-plans
# Copy the output plan IDs into .env

# 8. Start development server (hot reload)
npm run dev
# Server starts at http://localhost:4000

# 9. View database
npm run db:studio
# Opens Prisma Studio at http://localhost:5555
```

### Test Accounts (after seeding)

All passwords: `testpass123`

| Email | Role | Access |
|-------|------|--------|
| admin@lexailabs.com | ADMIN | Premium + admin panel |
| premium@example.com | USER | Premium (one-time) |
| test@example.com | USER | No access (needs payment) |
| unverified@example.com | USER | Email not verified (login blocked) |
| existing-student@acme.edu | USER | Institutional (Acme University) |

B2B test emails (register with these to get auto-access): `alice@acme.edu`, `bob@acme.edu`, `charlie@acme.edu`

---

## 12. Key Business Logic

### Access Timeline Management

Organizations have optional `accessStartDate` and `accessEndDate`. The backend enforces these at token issuance time (every 15-minute refresh):

- `accessStartDate = null` → access starts immediately
- `accessEndDate = null` → access never expires
- Both set → access only within `[start, end]` window
- When window expires, `getAccessInfo()` returns `hasAccess: false` — students lose access automatically

### Student Pre-loading and Claiming

1. Admin adds student email to organization (creates `PreloadedStudent` record)
2. Invitation email sent with unique token
3. Student clicks link → `/accept-invite?token=xxx`
4. Student sets name + password → user account created, `OrganizationMember` granted, `PreloadedStudent.claimed = true`
5. Alternatively: if student registers/logs in normally with the same email, B2B auto-access kicks in and claims the record

### Invitation Token Lifecycle

- Generated as raw 32-byte hex (NOT hashed — stored as plaintext for URL use)
- 7-day expiry
- When admin re-adds an existing student, old unused tokens are invalidated, new one is generated
- Marked `used = true` after acceptance
- Cascade-deleted if PreloadedStudent is deleted

### Google OAuth B2B Guard

If a new user tries to sign up via Google OAuth and their email matches an unclaimed `PreloadedStudent` with an active org, the backend returns `403` with code `B2B_PENDING_INVITE`. This forces them to use the invitation link instead, ensuring they go through the proper accept-invite flow. Existing users (already accepted invite) are not affected.

### User Enumeration Prevention

- `POST /auth/register` always returns success (even if user exists)
- `POST /auth/forgot-password` always returns success (even if no user found)
- Login returns generic "Invalid email or password" for both wrong email and wrong password

### Subscription Cancellation Behavior

- `POST /subscriptions/cancel` tells Razorpay to cancel at cycle end (not immediately)
- User keeps access until `currentPeriodEnd`
- The actual status change (ACTIVE → CANCELLED) happens via webhook
- Legacy one-time payment users keep `isPremium = true` even after subscription ends

---

## 13. Claude Code Session History

The project has been worked on across multiple Claude Code sessions in `/Users/zebra/.claude/projects/-Users-zebra-lexaiLMS/`. Key work completed:

### Session: B2B Admin Flow Implementation (current)

Major feature addition covering the complete B2B institutional enrollment flow:

**Schema changes:** Added `name` to `PreloadedStudent`, `accessStartDate`/`accessEndDate` to `Organization`, new `InvitationToken` model.

**New backend files (7):** Multipart plugin, admin hook, admin schemas, admin route barrel, organizations CRUD routes, students management routes (single + CSV bulk), accept-invite route (token validation + account creation).

**Modified backend files (5):** Added `sendInvitationEmail()` to email.ts, timeline enforcement to session.ts `getAccessInfo()`, Google OAuth guard for pending B2B invites, registered multipart plugin + admin routes in app.ts, registered accept-invite in auth routes.

**Frontend pages (2):** Accept-invite page (token validation, name+password form, redirect on success), admin panel page (org CRUD, timeline management, student management, CSV upload with template preview + download).

**Frontend update:** Handle `B2B_PENDING_INVITE` error code in Google sign-in flow on login page.

**Seed data:** Added names to preloaded students, 3-month access window to test organization.

**Bug fix:** Replaced em dash with plain dash in invitation email subject to fix UTF-8 encoding issue.

**Documentation:** Created `ADMIN-FLOW.md` (frontend developer guide for recreating admin flow) and `README.md`.

**Repository migration:** Code pushed to new repo at `github.com/retiredbatmanforsale/prof-backend`. Old frontend code preserved on `old-staging` branch at `github.com/retiredbatmanforsale/lexailabs-learning-os`.

### Earlier Sessions

Multiple sessions covering initial auth service buildout: user registration, login, Google OAuth, JWT management, email verification, password reset, Razorpay one-time payments, Razorpay subscriptions with webhook handling, B2B pre-loaded student auto-access, rate limiting, CORS configuration, Docker containerization, and Cloud Run deployment setup.

---

## 14. Security Summary

| Measure | Implementation |
|---------|---------------|
| Password hashing | bcryptjs, 12 salt rounds |
| Access tokens | JWT, 15-minute expiry |
| Refresh tokens | SHA-256 hashed in DB, 7-day expiry, rotated on use |
| Token theft detection | Revoked token reuse → revoke all user sessions |
| Rate limiting | Per-IP limits on all endpoints (3-30/min depending on sensitivity) |
| CORS | Explicit origin whitelist from `ALLOWED_ORIGINS` |
| Security headers | Helmet (CSP disabled since API-only) |
| Input validation | Zod schemas on every request body |
| Webhook verification | HMAC signature verification on Razorpay webhooks |
| User enumeration | Register/forgot-password return identical responses regardless |
| Account deactivation | `isActive` check on every login/refresh |
| Session invalidation | Password reset revokes all refresh tokens |
| Non-root container | Docker runs as `app` user |
