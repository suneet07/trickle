# Google Cloud setup

Trickle sends and reads email through the Gmail API, so it needs an OAuth client from Google Cloud. The same client is used for "Sign in with Google" if you enable it. It's free and takes about five minutes.

## 1. Create a project and enable the Gmail API

1. Go to <https://console.cloud.google.com/> and create a project (for example `trickle`).
2. **APIs & Services → Library**, search for **Gmail API**, and click **Enable**.

## 2. Configure the OAuth consent screen

**APIs & Services → OAuth consent screen** (called "Google Auth Platform" in newer consoles):

- **User type:**
  - **Internal** if every sending inbox is in your own Google Workspace organization. No review, no test-user list, tokens don't expire. Best option when available.
  - **External** otherwise (for example personal `@gmail.com` inboxes).
- App name, support email and developer email: anything sensible.
- **Scopes:** you can leave this empty; Trickle requests what it needs at connect time.
- **Test users** (External only): add every Gmail address you will connect, and every address that will sign in with Google.

> **External apps in "Testing" status:** Google expires refresh tokens after 7 days, so inboxes have to be reconnected weekly. To avoid that, publish the app ("In production"). Because Trickle uses restricted Gmail scopes, a publicly published app needs Google's verification; for a handful of your own inboxes you can publish without verification and click through the "unverified app" warning when connecting. Workspace users should choose **Internal** and skip all of this.

## 3. Create the OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID**

- **Application type:** Web application
- **Authorized redirect URIs:** add both, replacing the base with your `APP_BASE_URL`:

  ```
  http://localhost:8080/api/accounts/oauth/callback
  http://localhost:8080/api/auth/google/callback
  ```

  For a public deployment use your real URL, e.g. `https://trickle.example.com/api/accounts/oauth/callback`. You can list local and production URIs on the same client.

Copy the **Client ID** and **Client secret** into `.env`:

```env
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```

## 4. (Optional) Sign in with Google

Set the addresses allowed to sign in. Whole domains work too:

```env
ALLOWED_LOGIN_EMAILS=you@example.com,@yourcompany.com
```

Sign-in only asks Google for your identity (`openid email profile`); it does not grant Gmail access.

## Scopes Trickle requests when you connect an inbox

| Scope | Why |
|-------|-----|
| `gmail.send` | Send campaign emails, follow-ups and replies |
| `gmail.readonly` | Detect replies and bounces, and check placement-test folders |
| `gmail.modify` | Warmup: rescue warmup mail from spam and mark it important |
| `userinfo.email` | Identify which inbox was connected |

Refresh tokens are encrypted with `TOKEN_ENCRYPTION_KEY` (AES-256-GCM) before they are stored. **Disconnect** in the Inboxes page revokes the grant at Google as well as deleting it locally.

## Sending from an alias

To send as an address other than the inbox's own (for example `alex@brand.com` from `alex@company.com`), first add it in Gmail under **Settings → Accounts → Send mail as** and verify it, then set it as the inbox's *Send-as alias* in Trickle.

## Domain authentication

Make sure the sending domain has SPF, DKIM and DMARC set up (Google Workspace admin → Apps → Gmail → Authenticate email for DKIM). The **Settings** page in Trickle shows whether SPF and DMARC records are found; missing records lower an inbox's health score.
