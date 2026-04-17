# Account Switching Bug — Complete Debugging Guide

> This guide is written specifically for this codebase after reading the actual source files.  
> Every storage key, state variable, and flow mentioned here is real — not generic advice.

---

## Table of Contents

1. [What Data Exists and Where It Lives](#1-what-data-exists-and-where-it-lives)
2. [All Possible Reasons This Can Happen](#2-all-possible-reasons-this-can-happen)
3. [Layer-by-Layer Breakdown](#3-layer-by-layer-breakdown)
4. [How to Identify Which Layer Is the Problem](#4-how-to-identify-which-layer-is-the-problem)
5. [Step-by-Step Debugging Plan](#5-step-by-step-debugging-plan)
6. [Summary Table](#6-summary-table)

---

## 1. What Data Exists and Where It Lives

This is the most important section. You cannot debug data leakage until you know **every place data is stored**.

---

### 1A — localStorage (browser persistent storage)

`localStorage` survives page reloads and app restarts. It is **shared across all accounts** unless the key includes the userId.

#### SCOPED keys (safe — tied to a specific userId)

These keys include the userId in their name, so each account gets its own slot.

| Key Pattern | What It Stores | File Where It's Written |
|---|---|---|
| `autoapply_profile_<userId>` | Full user profile (name, email, phone, resume text, education, experience, skills, work auth, EEO, links, salary, availability, preferences) | `api.ts → saveProfile()` |
| `autoapply_onboarding_profile_<userId>` | Onboarding chat profile (structured data from resume extraction) | `api.ts → saveOnboardingProfile()` |

These are written in `api.ts` and are correctly isolated per user.

---

#### UNSCOPED keys (danger zone — shared across ALL accounts)

These keys have a **fixed name** and are overwritten every time any user interacts with the app. When user 2 logs in, they read whatever user 1 left behind.

| Key | What It Stores | File Where It's Written | File Where It's Read |
|---|---|---|---|
| `autoapply_token` | JWT authentication token | `api.ts → setStoredToken()` | `api.ts → getStoredToken()` |
| `autoapply_resume_pdf_data_url` | The full base64-encoded PDF of the resume | `App.tsx` (around line 361) | `App.tsx` (line 350), `main-dashboard-screen.tsx` (line 233) |
| `autoapply_resume_pdf_name` | The file name of the uploaded resume PDF | `App.tsx` (around line 362) | `App.tsx` (line 351), `main-dashboard-screen.tsx` (line 234) |
| `autoapply_resume_optimization_snapshot` | A diff/snapshot of the last resume optimization session | `App.tsx` (around line 383) | `App.tsx` (line 370) |
| `autoapply_dashboard_job_history` | The list of jobs the user searched or applied to | `main-dashboard-screen.tsx` (line 228) | `main-dashboard-screen.tsx` (line 203) |
| `autoapply_onboarding_success_message` | A message shown after onboarding finishes | Unknown write location | `pages/Dashboard.tsx` (line 50) |

**These are the most likely culprits for your bug.**

---

### 1B — React In-Memory State (exists only while the app is running)

This state lives in RAM and disappears when the component unmounts. The `App` component (root) holds:

| State Variable | What It Holds | Where It's Declared |
|---|---|---|
| `user` | The current logged-in user (`id`, `email`, `firstName`, `lastName`) | `App.tsx` line 3370 |
| `profile` | The full `UserProfile` object (all the form fields) | `App.tsx` line 3371 |
| `screen` | Which screen is currently visible (`"auth"`, `"apply"`, `"profile"`, `"profileView"`) | `App.tsx` line 3372 |
| `bootstrapping` | Whether the app is still checking for a saved token on startup | `App.tsx` line 3373 |

The `MainDashboardScreen` component holds its own local state including:

| State Variable | What It Holds |
|---|---|
| `jobHistory` | List of previously applied/searched jobs (from unscoped localStorage) |
| `applicationId` | Currently active application ID |
| `runData` | Data from the most recent automation run |
| `livePreviewUrl` | Live preview URL for the current run |
| `activeItem` | Which nav tab is selected (Apply, Applications, Tracker, etc.) |
| `selectedJob` | The job currently selected in the job panel |
| `analysisPreview` | Job analysis result |

---

### 1C — Backend Database (PostgreSQL via Prisma)

All persistent data lives here, filtered by `userId`:

| Data Type | How It's Queried |
|---|---|
| Profile | `WHERE userId = req.user.id` (via JWT) |
| Applications / runs | `WHERE userId = req.user.id` |
| Resume text | Part of the profile row |

The backend appears correctly scoped by `userId` extracted from the JWT.

---

### 1D — Socket.IO Connection

The socket is a **module-level singleton** declared in `api.ts`:

```
export const socket = io(apiBaseUrl, { autoConnect: false });
```

This socket instance is **never destroyed or re-created** between logins. It persists for the entire lifetime of the Electron app process. If it was subscribed to an application belonging to user 1, and user 1 never explicitly unsubscribed, user 2 could receive WebSocket events for user 1's data.

---

## 2. All Possible Reasons This Can Happen

Here are all the reasons, explained simply:

---

### Reason 1 — Unscoped localStorage keys (Most Likely)

**What it means in simple terms:**  
Imagine a physical locker with your things in it. Scoped keys give each person their own locker. Unscoped keys mean everyone shares ONE locker. When you leave and someone else arrives, they open the locker and see your stuff.

**What this looks like in your app:**  
- User 1 uploads a resume PDF → stored in `autoapply_resume_pdf_data_url`  
- User 1 searches for jobs → stored in `autoapply_dashboard_job_history`  
- User 2 logs in → the app reads those same keys and shows user 1's resume and job history  
- The backend returned the correct data for user 2, but the UI is showing LOCAL data instead

**This is a confirmed issue in your codebase.** The keys above are genuinely unscoped.

---

### Reason 2 — React State Was Not Reset Before Loading New User's Data

**What it means in simple terms:**  
React keeps data in memory while a component is "alive." If you log out and log in again but the page never truly reloads, old data might still be sitting in memory when the new user's data arrives — creating a brief flash, or if something goes wrong, a permanent display of old data.

**What happens in your code:**  
In `handleAuth()`, the sequence is:
1. `setUser(null)` — clears user
2. `setProfile(EMPTY_PROFILE)` — clears profile
3. `setUser(u)` — sets new user
4. `hydrateProfileFromBackend(u)` — fetches and sets new profile (async)

The risk: steps 1–3 all call `setState`, and React batches these. If anything between step 3 and the resolution of step 4 causes a re-render, a component might briefly or permanently receive `user = new user` but `profile = old profile` because the async fetch hasn't finished yet.

This is less likely to be your primary issue but is a real race condition.

---

### Reason 3 — Stale API Token Causes Backend to Return Wrong User's Data

**What it means in simple terms:**  
The JWT token is like a keycard. When you switch accounts, the app must swap keycards. If for any reason the old keycard is still being sent, the backend will unlock the old user's room.

**What happens in your code:**  
The `login()` function in `api.ts` calls `setStoredToken(token)` which overwrites `autoapply_token`. The Axios interceptor then reads this token for every request. This part looks correct — the token IS replaced on login.

However, risk areas:
- Any **in-flight API request** that started before the token swap might complete using the old token
- The socket connection is authenticated separately and is never re-authenticated on login

---

### Reason 4 — Backend Is Not Filtering By User (Low Probability)

**What it means in simple terms:**  
Even if the token is correct, if the backend ignores the userId from the token and just returns all records, every user sees everything.

**What happens in your code:**  
The backend looks correct. `profileController.ts` reads `req.user?.id` from the JWT. `applications.ts` queries `WHERE userId = user.id`. This is unlikely to be the problem.

---

### Reason 5 — The App Reads Local Cache Before the Fresh Fetch Returns (Timing Bug)

**What it means in simple terms:**  
The app first tries to show data from a fast local cache (localStorage), while simultaneously fetching fresh data from the server. If the cache belongs to user 1 and user 2 logged in, the user briefly (or permanently if the fetch fails) sees user 1's cached data.

**What happens in your code:**  
`hydrateProfileFromBackend()` tries the backend first and falls back to `getStoredProfile(me.id)`. Since `getStoredProfile` is scoped by userId, this fallback is safe for profile. But for the PDF resume and job history, the read happens from unscoped keys with no fallback logic — it just shows whatever is there.

---

## 3. Layer-by-Layer Breakdown

---

### Layer 1 — Frontend React State

**What can go wrong:**  
- State from `MainDashboardScreen` is not reset if the component stays mounted
- `profile` state doesn't reset atomically before new data arrives

**In your code specifically:**  
When you log out → screen becomes `"auth"` → `MainDashboardScreen` is unmounted → all its local state IS cleared. When you log back in → screen becomes `"apply"` → `MainDashboardScreen` is freshly mounted with empty state → it then reads from unscoped localStorage.

So the React state itself resets correctly. **The leak comes from what it reads on mount (localStorage).**

---

### Layer 2 — localStorage / Caching

**What can go wrong:**  
Unscoped keys let one user's data bleed into another's session.

**In your code specifically:**  
The following are definitely unscoped and will show user 1's data to user 2:
- Resume PDF and filename (`autoapply_resume_pdf_data_url`, `autoapply_resume_pdf_name`)
- Job history (`autoapply_dashboard_job_history`)
- Resume optimization snapshot (`autoapply_resume_optimization_snapshot`)
- Onboarding success message (`autoapply_onboarding_success_message`)

The following are correctly scoped (safe):
- Profile data (`autoapply_profile_<userId>`)
- Onboarding profile data (`autoapply_onboarding_profile_<userId>`)

---

### Layer 3 — API Calls (Token Issues)

**What can go wrong:**  
Wrong token sent → backend returns wrong user's data.

**In your code specifically:**  
The token swap on login looks correct. The Axios interceptor reads from `autoapply_token` which is overwritten on every `login()` or `register()` call. This layer is likely NOT the problem.

The socket is a risk but only for real-time updates, not for initial data loads.

---

### Layer 4 — Backend

**What can go wrong:**  
Backend ignores userId and returns all records.

**In your code specifically:**  
Profile and application queries are filtered by `req.user.id`. This layer is almost certainly NOT the problem, but you should verify it.

---

## 4. How to Identify Which Layer Is the Problem

---

### Check 1 — Inspect localStorage in DevTools

**Steps:**
1. Open DevTools (F12 in Electron, or right-click → Inspect)
2. Go to **Application** tab (or **Storage** tab in some browsers)
3. Click **Local Storage** in the left panel
4. Look at ALL keys and their values

**What to look for:**

| Key | What to check |
|---|---|
| `autoapply_token` | After logging in as user 2, this should contain the token for user 2. Decode it at [jwt.io](https://jwt.io) — the `sub` or `userId` field inside must match user 2's ID |
| `autoapply_resume_pdf_data_url` | If this contains data that belongs to user 1, you have confirmed the unscoped key bug |
| `autoapply_dashboard_job_history` | If jobs from user 1's session appear here, confirmed |
| `autoapply_profile_<userId>` | There should be separate entries for each userId |

**Result interpretation:**
- If `autoapply_token` contains the WRONG userId → token swap failed (Layer 3 bug)
- If `autoapply_resume_pdf_data_url` has old data → unscoped key bug confirmed (Layer 2)
- If `autoapply_dashboard_job_history` has old jobs → unscoped key bug confirmed (Layer 2)

---

### Check 2 — Decode the Active JWT Token

**Steps:**
1. In DevTools → Application → Local Storage, copy the value of `autoapply_token`
2. Go to [https://jwt.io](https://jwt.io) in your browser
3. Paste the token in the "Encoded" box on the left
4. Look at the "Payload" section on the right

**What to look for:**  
The payload will contain something like:
```
{
  "sub": "user-id-here",
  "email": "someone@example.com",
  "iat": 1234567890
}
```

The `sub` (or `userId`, or `id` — depends on how your JWT is signed) must match user 2's ID.

**Result interpretation:**
- Correct userId in token → token swap worked → the bug is in localStorage (Layer 2) or state (Layer 1)
- Wrong userId in token → token was never replaced → bug is in the login flow (Layer 3)

---

### Check 3 — Watch Network Requests

**Steps:**
1. DevTools → **Network** tab
2. Check the **XHR/Fetch** filter (to only see API calls)
3. Log in as user 2
4. Watch the requests go out

**For each request, click on it and check:**

**Request Headers tab:**  
Look for `Authorization: Bearer <token>`. This must be the NEW token (user 2's token).

**Response tab:**  
Look at the actual data returned. Is the profile data user 2's or user 1's?

**What to look for in specific endpoints:**
- `GET /api/auth/me` → the `id` in the response must be user 2's ID
- `GET /api/profile` → name, email, resume must belong to user 2
- `GET /api/applications` → must only show applications created by user 2

**Result interpretation:**
- If the response data is wrong (user 1's data) → backend bug (Layer 4, unlikely but check)
- If the response data is correct (user 2's data) but the UI shows wrong data → state/cache bug (Layers 1 or 2)
- If the `Authorization` header still has user 1's token → token swap bug (Layer 3)

---

### Check 4 — Check React State Directly (if you have React DevTools)

**Steps:**
1. Install React DevTools extension (or use the Electron version if available)
2. Open the Components tab
3. Find the `App` component
4. Inspect its state: `user.id`, `profile.firstName`, `profile.email`

**What to look for:**  
After logging in as user 2, `user.id` must be user 2's ID and `profile.firstName` must match user 2's profile.

---

### Check 5 — Check What the Dashboard Reads From localStorage On Mount

**Steps:**
1. In DevTools → Sources or Debugger tab
2. Search for the file `main-dashboard-screen.tsx` (or `main-dashboard-screen.js` in the compiled output)
3. Set a breakpoint on the line that reads `localStorage.getItem(JOB_HISTORY_STORAGE_KEY)` (around line 203)
4. Log in as user 2 and watch what value is returned

---

## 5. Step-by-Step Debugging Plan

Follow these steps in order. Stop when you find the problem.

---

### Step 1 — Establish Your Test Baseline

Before doing anything else:

1. Close the app completely
2. Open DevTools → Application → Local Storage
3. **Screenshot or write down every key and value** you see
4. Delete all keys manually (there's a "Clear All" button, or select and delete one by one)
5. Now open the app fresh

This gives you a clean environment so you're not debugging stale data.

---

### Step 2 — Create Two Test Accounts and Log In Sequentially

1. Register as **User A** with a distinct email (e.g., `usera@test.com`)
2. Fill in profile data that is obviously User A's (e.g., name "ALPHA USER", phone "111-111-1111")
3. Upload a PDF with User A's name visible
4. Perform one job search / application to populate job history
5. Check localStorage — take a screenshot of all keys and values
6. Log out
7. Register as **User B** with a different email (e.g., `userb@test.com`)
8. **Without filling in any profile** — just log in

---

### Step 3 — Immediately After User B Logs In, Check localStorage

Go to DevTools → Application → Local Storage and inspect:

| Key | Expected | Actual | Status |
|---|---|---|---|
| `autoapply_token` | User B's token | ? | ? |
| `autoapply_resume_pdf_data_url` | Should be empty or User B's | ? | ? |
| `autoapply_resume_pdf_name` | Should be empty or User B's | ? | ? |
| `autoapply_dashboard_job_history` | Should be empty | ? | ? |
| `autoapply_profile_<UserA_id>` | Still there (harmless, scoped) | ? | ? |
| `autoapply_profile_<UserB_id>` | Should be User B's data | ? | ? |

**If you see User A's data in any of the unscoped keys → you have confirmed the bug is Layer 2 (localStorage).**

---

### Step 4 — Decode the Token and Verify Identity

1. Copy `autoapply_token` from localStorage
2. Paste at [jwt.io](https://jwt.io)
3. Confirm the user ID in the payload is User B's ID
4. Also open Network tab → find the request to `GET /api/auth/me` or `GET /api/profile` → check the Authorization header matches this token

**If token is correct but UI shows wrong data → localStorage or state bug.**  
**If token has wrong user ID → login flow bug.**

---

### Step 5 — Compare Network Response vs UI Display

1. In Network tab, find `GET /api/profile` response after User B logs in
2. Note what the response contains (should be empty or User B's data if they have no profile yet)
3. Compare what the **UI actually shows**

If the Network response says "no data / User B's empty profile" but the UI shows User A's profile → the UI is reading from localStorage, not from the API response.

---

### Step 6 — Identify Which Specific Data Is Leaking

Based on what the UI shows for User B that belongs to User A:

| What you see | Which key is leaking | Where it's written |
|---|---|---|
| User A's resume PDF visible | `autoapply_resume_pdf_data_url` | `App.tsx` line 361 |
| "User A's resume.pdf" as filename | `autoapply_resume_pdf_name` | `App.tsx` line 362 |
| User A's job search history | `autoapply_dashboard_job_history` | `main-dashboard-screen.tsx` line 228 |
| User A's profile fields (name, phone, etc.) | This would be the API returning wrong data OR scoped cache bug | `api.ts` |
| User A's resume optimization diff | `autoapply_resume_optimization_snapshot` | `App.tsx` line 383 |

---

### Step 7 — Confirm the Root Cause

You should now be able to answer:

- **Is the wrong data coming from the API?**  
  → Check Step 5. If the network response is wrong, it's backend or token.

- **Is the wrong data coming from localStorage?**  
  → Check Step 3. If the unscoped keys have User A's data, it's Layer 2.

- **Is the wrong data coming from React state not clearing?**  
  → This is harder to see without React DevTools. But if the above two checks pass AND the UI is still wrong, add `console.log` at the point where state is set and verify the values being set.

---

## 6. Summary Table

| What Is Leaking | Storage Type | Key Name | Scoped? | Likely Cause |
|---|---|---|---|---|
| Resume PDF content | localStorage | `autoapply_resume_pdf_data_url` | ❌ NO | CONFIRMED BUG |
| Resume PDF filename | localStorage | `autoapply_resume_pdf_name` | ❌ NO | CONFIRMED BUG |
| Job history (dashboard) | localStorage | `autoapply_dashboard_job_history` | ❌ NO | CONFIRMED BUG |
| Resume optimization diff | localStorage | `autoapply_resume_optimization_snapshot` | ❌ NO | CONFIRMED BUG |
| Onboarding success msg | localStorage | `autoapply_onboarding_success_message` | ❌ NO | LIKELY BUG |
| User profile (structured) | localStorage | `autoapply_profile_<userId>` | ✅ YES | Safe |
| Onboarding profile | localStorage | `autoapply_onboarding_profile_<userId>` | ✅ YES | Safe |
| Auth token | localStorage | `autoapply_token` | ✅ Overwritten on login | Safe (token is replaced) |
| Profile fields (React) | React state | `profile` in `App` | ✅ YES | Cleared on login |
| User identity (React) | React state | `user` in `App` | ✅ YES | Cleared on login |
| Applications list (API) | Backend DB | Queried by userId | ✅ YES | Safe |
| Socket subscriptions | In-memory (module singleton) | N/A | ❌ NO | Possible event leakage |

---

## What To Tell Us After You Do This

After following the steps above, come back with:

1. The screenshot of localStorage keys immediately after User B logs in
2. The decoded payload of the token (`autoapply_token`) at that moment
3. What the Network tab shows for `GET /api/profile` response
4. What the UI actually displays vs what the network returned

That will tell us exactly which fix is needed and where.
