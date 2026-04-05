# Lex AI — Auth Service

Backend authentication and authorization service for the Lex AI learning platform. Handles user accounts, OAuth, payments, subscriptions, and B2B institutional access.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js (ESM) |
| Framework | Fastify 5 |
| Language | TypeScript |
| Database | PostgreSQL (Neon) |
| ORM | Prisma |
| Auth | JWT (access + refresh tokens) |
| OAuth | Google Identity Services |
| Payments | Razorpay |
| Validation | Zod |
| Email | Gmail API (OAuth2) |

---

## Project Structure

```
auth-service/
├── prisma/
│   ├── schema.prisma         # Database models
│   ├── seed.ts               # Test data seeder
│   └── seed-plans.ts         # Subscription plan seeder
├── src/
│   ├── index.ts              # Entry point
│   ├── app.ts                # Fastify app setup & plugin registration
│   ├── hooks/
│   │   ├── auth.ts           # JWT authentication middleware
│   │   └── admin.ts          # Admin role guard
│   ├── plugins/
│   │   ├── cors.ts           # CORS configuration
│   │   ├── jwt.ts            # JWT plugin
│   │   ├── prisma.ts         # Prisma client plugin
│   │   ├── rate-limit.ts     # Rate limiting
│   │   └── multipart.ts      # File upload (CSV)
│   ├── lib/
│   │   ├── email.ts          # Email sending (verification, reset, invitations)
│   │   ├── google.ts         # Google OAuth token verification
│   │   ├── passwords.ts      # bcrypt hashing
│   │   ├── session.ts        # Token issuance & access control
│   │   ├── tokens.ts         # Secure token generation
│   │   ├── razorpay.ts       # Razorpay API client
│   │   └── plans.ts          # Subscription plan config
│   ├── schemas/
│   │   ├── auth.ts           # Auth endpoint validation schemas
│   │   └── admin.ts          # Admin endpoint validation schemas
│   ├── routes/
│   │   ├── auth/
│   │   │   ├── index.ts      # Auth route aggregator
│   │   │   ├── register.ts   # POST /auth/register
│   │   │   ├── login.ts      # POST /auth/login
│   │   │   ├── google.ts     # POST /auth/google
│   │   │   ├── refresh.ts    # POST /auth/refresh
│   │   │   ├── logout.ts     # POST /auth/logout
│   │   │   ├── me.ts         # GET  /auth/me
│   │   │   ├── verify-email.ts
│   │   │   ├── forgot-password.ts
│   │   │   ├── reset-password.ts
│   │   │   └── accept-invite.ts  # B2B invitation acceptance
│   │   ├── admin/
│   │   │   ├── index.ts          # Admin route barrel (auth + admin guard)
│   │   │   ├── organizations.ts  # Org CRUD
│   │   │   └── students.ts      # Student management + CSV upload
│   │   ├── payments/
│   │   ├── subscriptions/
│   │   └── webhooks/
│   └── types/
│       └── index.ts          # TypeScript type declarations
├── package.json
└── tsconfig.json
```

---

## API Endpoints

### Auth (`/auth`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/auth/register` | No | Create account (email/password) |
| POST | `/auth/login` | No | Email/password login |
| POST | `/auth/google` | No | Google OAuth login |
| POST | `/auth/refresh` | No | Refresh access token |
| POST | `/auth/logout` | Yes | Revoke refresh token |
| POST | `/auth/logout-all` | Yes | Revoke all sessions |
| GET | `/auth/me` | Yes | Current user + access info |
| GET | `/auth/verify-email` | No | Email verification (redirect) |
| POST | `/auth/forgot-password` | No | Request password reset |
| POST | `/auth/reset-password` | No | Reset password with token |
| GET | `/auth/invite-info` | No | Validate B2B invitation token |
| POST | `/auth/accept-invite` | No | Accept B2B invitation |

### Admin (`/admin`) — requires `ADMIN` role

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/admin/organizations` | Create organization |
| GET | `/admin/organizations` | List all organizations |
| GET | `/admin/organizations/:id` | Organization detail |
| PATCH | `/admin/organizations/:id` | Update organization |
| POST | `/admin/organizations/:orgId/students` | Add student + send invite |
| POST | `/admin/organizations/:orgId/students/bulk` | CSV bulk upload |
| GET | `/admin/organizations/:orgId/students` | List students |
| DELETE | `/admin/organizations/:orgId/students/:id` | Remove unclaimed student |

### Payments & Subscriptions

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/payments/create-order` | Yes | Create Razorpay order |
| POST | `/payments/verify` | Yes | Verify payment |
| POST | `/subscriptions/create` | Yes | Create subscription |
| POST | `/subscriptions/cancel` | Yes | Cancel subscription |
| GET | `/subscriptions/status` | Yes | Subscription status |
| POST | `/webhooks/razorpay` | No | Razorpay webhook handler |

---

## Access Control

Users gain platform access through one of three paths:

| Access Type | How |
|-------------|-----|
| `premium` | Legacy one-time payment |
| `subscription` | Active Razorpay subscription (monthly/quarterly/yearly) |
| `institution` | B2B — organization membership with active access window |

The JWT payload includes `hasAccess`, `accessType`, and `organizationName` so the frontend can gate content without extra API calls.

### B2B Flow

```
Admin creates org → adds students (single or CSV)
  → students receive invitation email
  → student clicks link → sets name + password
  → redirected to login → logs in → institutional access granted
```

Organizations support configurable access windows (`accessStartDate` / `accessEndDate`). Access is automatically revoked when the window expires — no manual action needed.

---

## Environment Variables

```env
# Database
DATABASE_URL=postgresql://...

# Auth
JWT_SECRET=your-secret-key

# Google OAuth
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# Gmail API (for sending emails)
GMAIL_REFRESH_TOKEN=...

# Razorpay
RAZORPAY_KEY_ID=...
RAZORPAY_KEY_SECRET=...
RAZORPAY_PLAN_MONTHLY=...
RAZORPAY_PLAN_QUARTERLY=...
RAZORPAY_PLAN_YEARLY=...
PRICE_MONTHLY=...
PRICE_QUARTERLY=...
PRICE_YEARLY=...

# URLs
FRONTEND_URL=https://your-frontend.com
BACKEND_URL=https://your-backend.com
ALLOWED_ORIGINS=https://your-frontend.com

# Server
PORT=4000
```

---

## Getting Started

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env   # fill in your values

# Sync database schema
npx prisma db push

# Generate Prisma client
npx prisma generate

# Seed test data
npm run db:seed

# Development (hot reload)
npm run dev

# Production build
npm run build
npm start
```

---

## Security

- **Passwords** — bcrypt with 12 salt rounds
- **Access tokens** — JWT, 15-minute expiry
- **Refresh tokens** — SHA-256 hashed before storage, 7-day expiry, rotation on use
- **Token theft detection** — reuse of revoked refresh token revokes all user sessions
- **Rate limiting** — per-IP limits on all endpoints
- **CORS** — origin whitelist validation
- **Helmet** — security headers (CSP disabled for API)
- **Input validation** — Zod schemas on all request bodies
- **No info leakage** — register/forgot-password return identical responses regardless of user existence

---

## Database

View and manage data with Prisma Studio:

```bash
npm run db:studio
```

---

## License

Private — Lex AI Labs
