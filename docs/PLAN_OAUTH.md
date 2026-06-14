# Subscription login (`plan-oauth`)

Some providers let you sign in with an existing **subscription** instead of paying per-token for API credits — two different shapes:

- **OpenAI** — ChatGPT **Plus/Pro**: a **browser sign-in** ("Sign in with ChatGPT").
- **xAI** — **SuperGrok / X Premium+**: SuperGrok hands you a **token** after sign-in; you **paste** it.

```sh
nomos connect    # openai → "ChatGPT Plus/Pro login"  → browser opens → done
nomos connect    # xai    → "SuperGrok / X Premium+ token" → paste the token SuperGrok gave you
nomos run -m openai/gpt-5.1-codex "fix the failing test"   # uses your plan, not API credits
```

## How it works

**OpenAI** runs the standard OAuth 2.0 **PKCE loopback** flow: Nomos opens your browser to the consent page, catches the redirect on `localhost:1455`, and exchanges the code for an access + refresh token. The access token is **refreshed automatically** before it expires — you log in once.

**xAI** is simpler: SuperGrok gives you a token directly, so you paste it (no browser dance, no refresh — re-paste if it ever expires).

Either way the token is stored locally (`auth.json`, mode `0600`) and these endpoints speak the **OpenAI Responses API** (`input`/`instructions`, not `messages`) on a different base than their public API key, so Nomos routes them through a Responses adapter. For OpenAI it also sends the `chatgpt-account-id` (decoded from the token) and the `originator` header its CLI uses.

## Provenance

The client ids and endpoints are the **public app registrations of each vendor's own first-party CLI** — not guessed. Sourced from `openai/codex` (the canonical Codex CLI), the OpenCode OpenAI-Codex auth plugin, `stnly/pi-grok`, and xAI's live OIDC discovery document.

## Caveats

- **Unit-tested, confirm live.** The OAuth + token flows, refresh, and the Responses request shape are unit-tested; the live browser sign-in and the exact streaming event names are confirmed on your first real run against your own subscription (a few constants are single-source — see the provenance notes).
- **Personal use, at your own risk.** A subscription token is account-bound and used outside each vendor's documented API path; their CLIs use it for personal development, and Nomos does the same. For production / multi-user, use a normal API key (`nomos connect` → API key).
- The token, refresh token, and account id live only in your local `auth.json` — never in the repo, logs, or anywhere Nomos sends except the provider's own auth header.
