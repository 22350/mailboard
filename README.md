# Mailboard

Gmail as Kanban columns, in the browser. Static files only — no server.
Columns other than Inbox are Gmail labels under `Board/`, so plain Gmail
shows the same sorting.

## One-time Google setup

1. Go to https://console.cloud.google.com → create a project called "Mailboard".
2. **APIs & Services → Library** → search "Gmail API" → **Enable**.
3. **Google Auth Platform** (OAuth consent screen) → Get started:
   - App name: Mailboard; support email: your Gmail. Audience: **External**.
   - **Audience → Test users** → add your Gmail address.
   - **Data access → Add scopes** → `https://www.googleapis.com/auth/gmail.modify`.
4. **Clients → Create client** → type **Web application**.
   Authorized JavaScript origins:
   - `http://localhost:8090`
   - `https://22350.github.io`
   Leave redirect URIs empty. Copy the **Client ID**.
5. Open Mailboard, paste the Client ID, sign in. Google warns the app is
   unverified — that's expected for your own app (Continue).

## Run locally

    python -m http.server 8090 --bind 127.0.0.1 --directory ~/Work/mailboard

Then open http://localhost:8090.

## Using it

- Drag cards between columns, or click a card and use the **Move to** buttons.
- Keyboard: Tab to a card, arrows to move around, **1–9** moves the card to
  that column, Enter opens it, Esc closes. Every move has an **Undo**.
- The last column (Done) archives mail. A new reply to a Done thread brings
  it back to Inbox.
- Sign-in lasts about an hour; after that a **Reconnect** bar appears.
