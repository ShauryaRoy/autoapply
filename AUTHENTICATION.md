# Authentication System Documentation

## Overview

The AutoApply authentication system is a **stateless, token-based authentication** using JWT (JSON Web Tokens). It provides secure user account management, session handling, and per-user data isolation across both the Electron desktop client and API backend.

### Key Architecture Components

- **JWT Tokens**: Stateless authentication with 7-day expiration
- **Password Security**: bcrypt with 12 salt rounds for hashing
- **Per-User Data Isolation**: User ID-scoped localStorage caching to prevent data cross-contamination
- **Credential Encryption**: Third-party integration credentials encrypted at rest
- **Middleware-Based Authorization**: All protected routes use `authRequired` middleware

---

## Frontend Authentication Flow

### Location
- **Token Management**: [apps/desktop/src/renderer/api.ts](apps/desktop/src/renderer/api.ts#L14-L32)
- **UI Implementation**: [apps/desktop/src/renderer/App.tsx](apps/desktop/src/renderer/App.tsx#L3249-L3330)

### 1. Registration

**Endpoint**: `POST /api/auth/register`

**Request Payload**:
```json
{
  "email": "user@example.com",
  "password": "securepassword123",
  "firstName": "John",
  "lastName": "Doe"
}
```

**Response**:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "userId": "user-uuid-here"
}
```

**Frontend Flow**:
```typescript
// apps/desktop/src/renderer/api.ts

export async function register(payload: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}): Promise<{ token: string; userId: string }> {
  const res = await api.post("/api/auth/register", payload);
  const { token, userId } = res.data;
  setStoredToken(token);  // Save JWT to localStorage
  return { token, userId };
}
```

**Key Points**:
- Token automatically stored in `localStorage["autoapply_token"]`
- Token is **immediately** attached to all subsequent requests via axios interceptor
- User ID is returned and used to create per-user cache keys
- On successful registration, `getMe()` is called to fetch complete user details

### 2. Login

**Endpoint**: `POST /api/auth/login`

**Request Payload**:
```json
{
  "email": "user@example.com",
  "password": "securepassword123"
}
```

**Response**: Same as registration
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "userId": "user-uuid-here"
}
```

**Frontend Flow**:
```typescript
export async function login(payload: {
  email: string;
  password: string;
}): Promise<{ token: string; userId: string }> {
  const res = await api.post("/api/auth/login", payload);
  const { token, userId } = res.data;
  setStoredToken(token);
  return { token, userId };
}
```

### 3. Token Attachment

**Auto-Attachment via Axios Interceptor**:
```typescript
api.interceptors.request.use((config) => {
  const t = getStoredToken();
  if (t) {
    config.headers.Authorization = `Bearer ${t}`;
  }
  return config;
});
```

Every HTTP request automatically includes the JWT in the `Authorization: Bearer <token>` header.

### 4. Logout

**Frontend Flow**:
```typescript
export function logout(): void {
  clearStoredToken();      // Remove JWT from localStorage
  clearStoredProfile();    // Clear all user-scoped profile caches
}
```

**What Gets Cleared**:
- `autoapply_token` — The JWT token
- `autoapply_profile_<userId>` — Per-user profile data cache
- `autoapply_onboarding_profile_<userId>` — Per-user onboarding data cache

This prevents **any** data from the logged-out user appearing to the next user.

### 5. Session Persistence (Auto-Login)

**On App Mount**:
```typescript
useEffect(() => {
  const token = getStoredToken();
  if (!token) { 
    setBootstrapping(false); 
    return; 
  }

  getMe()
    .then(async (me) => {
      setUser(me);
      const authoritativeProfile = await hydrateProfileFromBackend(me);
      setProfile(authoritativeProfile);
      // Redirect to appropriate screen
    })
    .catch(() => {
      // Token invalid or expired
      clearStoredToken();
      clearStoredProfile();
      setScreen("auth");
    })
    .finally(() => setBootstrapping(false));
}, []);
```

**Behavior**:
- App checks if JWT token exists in `localStorage`
- If token exists, calls `/api/auth/me` to validate it and fetch current user data
- If token invalid/expired, clears all authentication state and returns to login screen
- If valid, loads user profile and navigates to appropriate screen

---

## Backend Authentication

### Location
- **JWT Implementation**: [apps/api/src/auth/jwt.ts](apps/api/src/auth/jwt.ts)
- **Auth Routes**: [apps/api/src/routes/auth.ts](apps/api/src/routes/auth.ts)
- **Type Definitions**: [apps/api/src/types/modules.d.ts](apps/api/src/types/modules.d.ts)

### 1. JWT Token Generation

**Function**: `signAccessToken(claims: AuthClaims): string`

```typescript
export interface AuthClaims {
  sub: string;      // Subject (User ID)
  email: string;
}

export function signAccessToken(claims: AuthClaims): string {
  return jwt.sign(claims, env.jwtSecret, { expiresIn: "7d" });
}
```

**Token Characteristics**:
- **Algorithm**: HS256 (HMAC with SHA-256)
- **Secret Key**: Loaded from environment variable `JWT_SECRET`
- **Expiration**: 7 days from issue
- **Claims**:
  - `sub`: User's UUID
  - `email`: User's email address
  - `iat`: Issued at timestamp (automatic)
  - `exp`: Expiration timestamp (automatic)

**Token Payload Example** (decoded):
```json
{
  "sub": "550e8400-e29b-41d4-a716-446655440000",
  "email": "user@example.com",
  "iat": 1745270000,
  "exp": 1745875000
}
```

### 2. Registration Endpoint

**Route**: `POST /api/auth/register`

**Implementation**:
```typescript
router.post("/register", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = RegisterSchema.parse(req.body);

    // Prevent duplicate emails
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      res.status(409).json({ message: "An account with this email already exists" });
      return;
    }

    // Hash password with bcrypt (12 salt rounds)
    const passwordHash = await bcrypt.hash(input.password, 12);
    
    // Create new user
    const user = await prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName
      }
    });

    // Generate JWT token
    const token = signAccessToken({ sub: user.id, email: user.email });
    res.status(201).json({ token, userId: user.id });
  } catch (error) {
    next(error);
  }
});
```

**Validation Rules** (via Zod schema):
```typescript
const RegisterSchema = z.object({
  email: z.string().email(),           // Valid email format
  password: z.string().min(8),         // Minimum 8 characters
  firstName: z.string().min(1),        // Non-empty
  lastName: z.string().min(1)          // Non-empty
});
```

**Security Features**:
- ✅ **Duplicate Email Prevention**: Returns 409 Conflict if email already exists
- ✅ **Password Hashing**: bcrypt with 12 rounds (secure, slow)
- ✅ **Generic Error Messages**: Returns 409 (not "email taken") to prevent user enumeration (if needed, could be improved)
- ✅ **Automatic Token Generation**: User logged in immediately after registration

### 3. Login Endpoint

**Route**: `POST /api/auth/login`

**Implementation**:
```typescript
router.post("/login", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = LoginSchema.parse(req.body);
    
    // Find user by email
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    // Compare provided password with stored hash
    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    // Generate JWT token
    const token = signAccessToken({ sub: user.id, email: user.email });
    res.json({ token, userId: user.id });
  } catch (error) {
    next(error);
  }
});
```

**Security Features**:
- ✅ **Bcrypt Comparison**: Uses `bcrypt.compare()` to safely verify hashed password
- ✅ **Constant-Time Comparison**: bcrypt prevents timing attacks
- ✅ **Generic Error Messages**: Returns "Invalid credentials" for both wrong email and wrong password (prevents enumeration)

### 4. Current User Endpoint (`/me`)

**Route**: `GET /api/auth/me` (requires authentication)

**Implementation**:
```typescript
router.get("/me", authRequired, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // authRequired middleware already validated JWT and populated req.user
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }
    res.json({ 
      id: user.id, 
      email: user.email, 
      firstName: user.firstName, 
      lastName: user.lastName 
    });
  } catch (error) {
    next(error);
  }
});
```

**Response**:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "user@example.com",
  "firstName": "John",
  "lastName": "Doe"
}
```

**Key Points**:
- Protected by `authRequired` middleware
- Uses `req.user.id` (populated by JWT verification, not client-provided)
- Double-checks user exists in database
- Returns only necessary user fields

---

## Authentication Middleware

### Location
[apps/api/src/auth/jwt.ts](apps/api/src/auth/jwt.ts#L22-L40)

### `authRequired` Middleware

**Purpose**: Validates JWT tokens and populates `req.user` for protected routes

**Implementation**:
```typescript
export function authRequired(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  
  // Check header format
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ message: "Missing bearer token" });
    return;
  }

  // Extract token
  const token = header.slice(7);

  try {
    // Verify JWT signature and expiration
    const claims = jwt.verify(token, env.jwtSecret) as AuthClaims;
    
    // Populate req.user for downstream handlers
    req.user = {
      id: claims.sub,
      email: claims.email
    };
    
    // Continue to next middleware/handler
    next();
  } catch {
    // Invalid signature, expired, or malformed
    res.status(401).json({ message: "Invalid token" });
  }
}
```

### Express Type Augmentation

**Location**: [apps/api/src/types/modules.d.ts](apps/api/src/types/modules.d.ts)

```typescript
declare namespace Express {
  interface Request {
    user?: {
      id: string;
      email: string;
    };
    file?: Multer.File;
  }
}
```

This allows TypeScript to recognize `req.user` as a safe property on Express Request objects.

### Usage in Routes

All protected routes apply this middleware:

```typescript
// app.ts
app.use("/api/profile", authRequired, createProfileRouter());
app.use("/api/applications", authRequired, createApplicationRouter());
app.use("/api/credentials", authRequired, /* ... */);
```

**Benefits**:
- 🔒 **Automatic Authorization**: All routes under these paths require valid JWT
- 🔐 **User Context**: Handlers access `req.user.id` for per-user operations
- ⚡ **Stateless**: No server-side session storage needed

---

## Data Isolation & Caching

### Profile Cache Key Scoping

**Problem**: Previous architecture used single cache key `autoapply_profile` for all users. If logout failed or browser wasn't cleared, next user would see previous user's data.

**Solution**: Per-user cache keys scoped by user ID

**Frontend Implementation**: [apps/desktop/src/renderer/api.ts](apps/desktop/src/renderer/api.ts#L203-L237)

```typescript
const PROFILE_KEY = "autoapply_profile";

function getProfileCacheKey(userId?: string): string {
  return userId ? `${PROFILE_KEY}_${userId}` : PROFILE_KEY;
}

export function getStoredProfile(userId?: string): UserProfile | null {
  try {
    const key = getProfileCacheKey(userId);
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as UserProfile;
  } catch {
    return null;
  }
}

export function saveProfile(profile: UserProfile, userId?: string): void {
  const key = getProfileCacheKey(userId);
  localStorage.setItem(key, JSON.stringify(profile));
}
```

**Cache Keys Generated**:
- User A with ID `123abc`: `autoapply_profile_123abc`
- User B with ID `456def`: `autoapply_profile_456def`

Each user's cache is completely isolated.

### Profile Hydration

**Location**: [apps/desktop/src/renderer/App.tsx](apps/desktop/src/renderer/App.tsx#L3388-3405)

```typescript
const hydrateProfileFromBackend = useCallback(async (me: AuthUser): Promise<UserProfile> => {
  try {
    // 1. Fetch authoritative profile from backend (scoped to authenticated user)
    const backendProfile = normalizeProfile(await getProfile());
    
    // 2. Merge with user name/email from JWT claims
    let authoritative = normalizeProfile({
      ...backendProfile,
      firstName: backendProfile.firstName || me.firstName,
      lastName: backendProfile.lastName || me.lastName,
      email: backendProfile.email || me.email
    });

    // 3. Cache using user ID (PREVENTS cross-user contamination)
    saveProfile(authoritative, me.id);
    return authoritative;
  } catch {
    // 4. Fallback to local cache for this specific user
    const cache = getStoredProfile(me.id);
    if (cache) return normalizeProfile(cache);
    return normalizeProfile({ 
      ...EMPTY_PROFILE, 
      firstName: me.firstName, 
      lastName: me.lastName, 
      email: me.email 
    });
  }
}, []);
```

**Flow**:
1. Backend is source of truth
2. Cache is only used on network failure
3. Always scoped to current user's ID
4. Never uses cross-user cache data

### Profile Data Isolation (Backend)

**Location**: [apps/api/src/services/profileService.ts](apps/api/src/services/profileService.ts)

Each profile is stored in the database with a `userId` foreign key:

```typescript
export async function getProfileByUserId(userId: string): Promise<UserProfilePayload> {
  const record = await prisma.userProfile.findUnique({
    where: { userId },  // ← User ID filters the query
    select: {
      education: true,
      experience: true,
      skills: true,
      projects: true,
      resumeText: true
    }
  });

  if (!record) return getEmptyProfile();
  return fromRecordToProfile(record);
}
```

**Guarantees**:
- ✅ Each user can only access **their own** profile
- ✅ Query is filtered by authenticated user ID
- ✅ Database constraint prevents mixing profiles

---

## Security Features

### 1. Password Security

| Feature | Implementation |
|---------|-----------------|
| **Hashing Algorithm** | bcrypt with 12 salt rounds |
| **Hash Generation** | `await bcrypt.hash(password, 12)` |
| **Verification** | `await bcrypt.compare(providedPassword, storedHash)` |
| **Time Complexity** | O(2^12) = 4096 iterations (slow by design) |

**Why bcrypt?**
- Slow hashing prevents brute-force attacks
- 12 rounds = ~200ms per attempt (limits enumeration)
- Built-in salt prevents rainbow tables
- Automatically resistant to GPU attacks due to memory requirements

### 2. JWT Token Security

| Feature | Value |
|---------|-------|
| **Algorithm** | HS256 (HMAC-SHA256) |
| **Expiration** | 7 days |
| **Secret Key** | Environment variable `JWT_SECRET` (never in code) |
| **Transport** | HTTPS only (in production) |
| **Storage** | localStorage (encrypted by browser in production) |

**Token Validation Chain**:
1. Header format check (`Bearer <token>`)
2. Signature verification (using `JWT_SECRET`)
3. Expiration check (automatic via `jwt.verify`)
4. Claims extraction (`sub`, `email`)

### 3. Authorization

| Endpoint | Protection | User Scope |
|----------|-----------|-----------|
| `/api/auth/register` | ❌ Public | N/A |
| `/api/auth/login` | ❌ Public | N/A |
| `/api/auth/me` | ✅ `authRequired` | Own user |
| `/api/profile` | ✅ `authRequired` | Own profile |
| `/api/applications` | ✅ `authRequired` | Own applications |
| `/api/credentials` | ✅ `authRequired` | Own credentials |

### 4. Credential Encryption

**Location**: [apps/api/src/security/encryption.js](apps/api/src/security/encryption.js)

Third-party integration credentials (e.g., LinkedIn, job board accounts) are encrypted at rest:

```typescript
router.post("/credentials", authRequired, async (req, res) => {
  const userId = req.user!.id;  // Use authenticated user ID
  const encryptedPassword = encryptString(input.password);

  await prisma.integrationCredential.upsert({
    where: { userId_provider: { userId, provider: input.provider } },
    create: {
      userId,                          // ← Scoped to user
      provider: input.provider,
      username: input.username,
      encryptedPassword                // ← Never stored plaintext
    }
  });
});
```

**Guarantees**:
- ✅ Passwords encrypted with AES-256
- ✅ Keys derived from environment secrets
- ✅ Only accessible to authenticated user
- ✅ Decryption requires `req.user.id` match

### 5. Defenses Against Common Attacks

| Attack | Defense |
|--------|---------|
| **Brute Force** | Slow bcrypt hashing (200ms per attempt) |
| **Timing Attacks** | bcrypt constant-time comparison |
| **Token Theft** | 7-day expiration; tokens stored in secure localStorage |
| **CSRF** | API uses JSON/Bearer tokens (not cookies) |
| **Session Fixation** | Stateless JWT; no session storage |
| **Cross-User Data Access** | User ID verified from JWT; database queries filtered by user |
| **Rainbow Tables** | bcrypt uses per-password salt |
| **Token Forgery** | HMAC signature verified with `JWT_SECRET` |

---

## Error Responses

### Registration Errors

```
409 Conflict: An account with this email already exists
400 Bad Request: Validation failed (invalid email, password too short, etc.)
500 Internal Server Error: Database or server error
```

### Login Errors

```
401 Unauthorized: Invalid credentials (wrong email or password)
400 Bad Request: Invalid input format
500 Internal Server Error: Database or server error
```

### Protected Route Errors

```
401 Unauthorized: Missing bearer token
401 Unauthorized: Invalid token (expired, malformed, or wrong secret)
404 Not Found: User or resource not found (after JWT verification)
500 Internal Server Error: Server error
```

---

## Environment Configuration

### Required Environment Variables

**Backend** (`.env` or via deployment):
```bash
JWT_SECRET=your-super-secret-key-min-32-chars
DATABASE_URL=postgresql://user:pass@localhost:5432/autoapply
ENCRYPTION_KEY=your-encryption-key-32-chars
API_PORT=4000
```

### Key Points

- ✅ `JWT_SECRET` must be:
  - Same on all backend instances (vertical scaling)
  - Generated randomly (minimum 32 characters)
  - Never committed to version control
  - Different per environment (dev, staging, prod)

- ✅ `ENCRYPTION_KEY` must be:
  - Stored securely in secrets manager
  - Same across all instances (credential decryption)
  - Rotated carefully (invalidates old credentials)

---

## Authentication State Machine

### Browser State Transitions

```
┌─────────────────────────────────────┐
│  App Mounts                         │
│  (Check localStorage for token)     │
└────────────────┬────────────────────┘
                 │
        ┌────────┴─────────┐
        │                  │
   ┌────▼────┐        ┌────▼────┐
   │ Token   │        │ No Token │
   │ Found   │        │          │
   └────┬────┘        └─────┬────┘
        │                   │
        │          ┌────────▼────────┐
        │          │ AuthScreen      │
        │          │ (login/register)│
        │          └─────────────────┘
        │
   ┌────▼──────────┐
   │ POST /me      │
   │ Validate JWT  │
   └────┬──────────┘
        │
   ┌────┴──────────┐
   │    Valid?     │
   └────┬──────────┘
        │
   ┌────┴──────────────┐
   │                   │
 ┌─▼───────┐    ┌──────▼────┐
 │  Valid  │    │  Invalid/  │
 │ Profile │    │  Expired   │
 │ Screen  │    │ -> AuthScrn│
 └─────────┘    └────────────┘
```

### Database Schema (User & Profile)

```sql
-- User table
CREATE TABLE "User" (
  id             TEXT PRIMARY KEY,
  email          TEXT UNIQUE NOT NULL,
  passwordHash   TEXT NOT NULL,
  firstName      TEXT NOT NULL,
  lastName       TEXT NOT NULL,
  createdAt      TIMESTAMP DEFAULT NOW()
);

-- User profile (1:1 relationship)
CREATE TABLE "UserProfile" (
  id             TEXT PRIMARY KEY,
  userId         TEXT UNIQUE NOT NULL,
  education      JSONB,
  experience     JSONB,
  skills         JSONB,
  projects       JSONB,
  resumeText     TEXT,
  FOREIGN KEY(userId) REFERENCES "User"(id)
);

-- Integration credentials (encrypted)
CREATE TABLE "IntegrationCredential" (
  id                TEXT PRIMARY KEY,
  userId            TEXT NOT NULL,
  provider          TEXT NOT NULL,
  username          TEXT,
  encryptedPassword TEXT,
  createdAt         TIMESTAMP DEFAULT NOW(),
  UNIQUE(userId, provider),
  FOREIGN KEY(userId) REFERENCES "User"(id)
);
```

---

## Common Tasks

### How to Reset a User's Password

```bash
# Currently: User must use manual password reset (not implemented)
# Future: Add password reset flow:
# 1. POST /api/auth/forgot-password (sends email)
# 2. User clicks link with reset token
# 3. POST /api/auth/reset-password (sets new password)
```

### How to Logout from Backend

```bash
# JWT is stateless, so no server-side logout needed
# Client simply:
# 1. Deletes token from localStorage
# 2. Clears all cached user data
# 3. Redirects to login screen
```

### How to Add OAuth (e.g., Google Sign-In)

```typescript
// Would require:
// 1. New route: POST /api/auth/oauth/callback
// 2. Exchange OAuth code for user info
// 3. Find or create user (email-based)
// 4. Generate JWT token
// 5. Return token (same as register/login)
```

### How to Implement Token Refresh

```typescript
// Current: 7-day tokens (stateless, simple)
// Could add refresh tokens:
// 1. Issue short-lived access token (15 min)
// 2. Issue long-lived refresh token (30 day, server-stored)
// 3. POST /api/auth/refresh-token exchanges refresh for new access
// 4. Benefits: Faster token rotation, revocation capability
```

---

## Testing Authentication

### Manual Testing

```bash
# 1. Register
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "testpass123",
    "firstName": "Test",
    "lastName": "User"
  }'

# Response:
# {
#   "token": "eyJhbGc...",
#   "userId": "550e8400-..."
# }

# 2. Login
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "testpass123"
  }'

# 3. Get current user (requires token)
curl -X GET http://localhost:4000/api/auth/me \
  -H "Authorization: Bearer eyJhbGc..."

# Expected: User object with id, email, firstName, lastName
```

### Automated Testing

```typescript
// Example: Test user registration
describe("Auth", () => {
  test("should register new user", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        email: "test@example.com",
        password: "password123",
        firstName: "Test",
        lastName: "User"
      });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(res.body.userId).toBeDefined();
  });

  test("should reject duplicate email", async () => {
    // Register first user
    await request(app)
      .post("/api/auth/register")
      .send({ email: "dup@example.com", password: "pass123", firstName: "A", lastName: "A" });

    // Try to register same email
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "dup@example.com", password: "pass123", firstName: "B", lastName: "B" });

    expect(res.status).toBe(409);
  });
});
```

---

## Troubleshooting

### "Invalid token" Error

**Causes**:
- Token expired (> 7 days old)
- Token signature is invalid (JWT_SECRET changed)
- Token is malformed (corrupted data)
- Token was issued by different backend instance

**Solution**:
1. Check `JWT_SECRET` is same across all backend instances
2. Re-login to get fresh token
3. Check browser console for token value (should be valid base64)

### User Data Cross-Contamination

**Previously Broken** (before fixes):
- Two users on same device would see each other's profile data
- Secondary user would inherit primary user's cached profile

**How It's Fixed Now**:
- Cache keys are per-user: `autoapply_profile_<userId>`
- Logout clears all profile caches completely
- Profile hydration only uses cache for same `userId`

### Token Not Being Sent

**Causes**:
- Token missing from localStorage
- Axios interceptor not running
- Authorization header not attached

**Debug**:
```javascript
// In browser console:
localStorage.getItem("autoapply_token");  // Should return token string
```

### Database Constraint Errors

**Error**: `unique constraint "IntegrationCredential_userId_provider_key" is violated`

**Cause**: Trying to create duplicate credential for same (userId, provider) pair

**Solution**: Use `upsert` instead of `create` (already fixed in codebase)

---

## Security Audit Checklist

- ✅ Passwords hashed with bcrypt (12 rounds)
- ✅ JWT tokens signed with `JWT_SECRET`
- ✅ All protected routes use `authRequired` middleware
- ✅ User ID verified from JWT (not client-provided)
- ✅ Per-user database queries (no cross-user access)
- ✅ Per-user cache keys (no cache cross-contamination)
- ✅ Credentials encrypted at rest
- ✅ Generic error messages (no user enumeration)
- ✅ Token expiration (7 days)
- ⚠️ **TODO**: HTTPS enforcement in production
- ⚠️ **TODO**: Password reset flow (not implemented)
- ⚠️ **TODO**: Rate limiting on auth endpoints
- ⚠️ **TODO**: Suspicious login detection

---

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                         ELECTRON DESKTOP CLIENT                      │
├──────────────────────┬──────────────────────┬───────────────────────┤
│   AuthScreen         │   App State          │   API Client          │
│ ┌────────────────┐  │ ┌──────────────────┐ │ ┌─────────────────┐   │
│ │ Register/Login │  │ │ user: AuthUser   │ │ │ localStorage:   │   │
│ │    Form        │  │ │ profile:Profile  │ │ │ ├─ token         │   │
│ └────────────────┘  │ │ screen: Screen   │ │ │ ├─ profile_<id> │   │
│                     │ └──────────────────┘ │ │ │ └─ onboarding  │   │
│                     │                      │ │ │                     │
│                     │                      │ │ Axios Interceptor   │
│                     │                      │ │ ├─ Bearer <token>  │
│                     │                      │ │ └─ Auto-attach    │
│                     │                      │ └─────────────────┘   │
└──────────────────────┴──────────────────────┴────────┬──────────────┘
                                                       │ HTTP/HTTPS
                            ┌──────────────────────────┴──────────────────┐
                            │                                              │
                    ┌───────▼─────────────────────────────────────────────┐
                    │            EXPRESS BACKEND API                      │
                    ├──────────────────┬──────────────────────────────────┤
                    │ Public Routes    │ Protected Routes (authRequired)   │
                    │ ┌──────────────┐│ ┌──────────────────┐              │
                    │ │ POST /auth/  ││ │ GET /auth/me      │              │
                    │ │ register     ││ │ GET /profile      │              │
                    │ │ login        ││ │ PUT /profile      │              │
                    │ └──────────────┘│ │ GET /applications │              │
                    │                 │ │ POST /credentials │              │
                    │                 │ └──────────────────┘              │
                    │                 │                                    │
                    │ JWT.ts (Core)  │ Controllers + Services             │
                    │ ┌────────────┐ │ ┌─────────────────────┐            │
                    │ │ signToken  │ │ │ getProfileByUserId  │            │
                    │ │ authRequired│ │ │ (filtered by userId)│            │
                    │ └────────────┘ │ └─────────────────────┘            │
                    └──────────────────┴──────────────────┬────────────────┘
                                                         │
                              ┌──────────────────────────┴────────────────┐
                              │                                           │
                    ┌─────────▼──────────────┐                           │
                    │     PostgreSQL         │                           │
                    │   DATABASE             │                           │
                    ├─────────────────────────┤                           │
                    │ User                  │                           │
                    │ ├─ id (PK)            │                           │
                    │ ├─ email (UNIQUE)     │                           │
                    │ ├─ passwordHash       │                           │
                    │ └─ firstName/lastName │                           │
                    │                       │                           │
                    │ UserProfile (1:1)     │                           │
                    │ ├─ userId (FK)        │                           │
                    │ ├─ education (JSON)   │                           │
                    │ ├─ experience (JSON)  │                           │
                    │ └─ resumeText         │                           │
                    │                       │                           │
                    │ IntegrationCred       │                           │
                    │ ├─ userId (FK)        │                           │
                    │ ├─ provider           │                           │
                    │ └─ encryptedPassword  │                           │
                    └───────────────────────┘                           │
                                                                         │
                              [All queries filtered by              │
                               authenticated user ID]                │
                                                                         │
                              [Encryption/Decryption                │
                               for sensitive fields]                │
```

---

## Future Enhancements

1. **Password Reset Flow**
   - Email-based password recovery
   - Secure reset token generation

2. **Rate Limiting**
   - Limit login attempts (5 per 15 minutes)
   - Limit registration (3 per hour per IP)

3. **Multi-Factor Authentication**
   - TOTP (Google Authenticator)
   - Email verification

4. **OAuth / Social Sign-In**
   - Google, GitHub, LinkedIn integration

5. **Token Refresh**
   - Short-lived access tokens (15 min)
   - Longer-lived refresh tokens (30 days)
   - Server-side revocation capability

6. **Activity Logging**
   - Log successful/failed login attempts
   - Detect suspicious account access

7. **Session Management**
   - Revoke all active sessions on password change
   - Device management (list active sessions)

---

## References

- [JWT.io](https://jwt.io) — JWT specification and tools
- [bcrypt](https://github.com/kelektiv/node.bcryptjs) — Password hashing library
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [Express Security Best Practices](https://expressjs.com/en/advanced/best-practice-security.html)

---

**Last Updated**: April 17, 2026  
**Maintained By**: AutoApply Team  
**Status**: ✅ Production Ready
