import http from 'node:http';
import crypto from 'node:crypto';
import { shell } from 'electron';
import type { GmailTokens } from './types';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SCOPE = 'https://mail.google.com/';

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64url');
}

function genPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Durée max du flow OAuth avant abandon (l'utilisateur n'a pas terminé). */
const OAUTH_TIMEOUT_MS = 5 * 60_000;

/** Démarre le flux OAuth Authorization Code + PKCE pour une app desktop. */
export function startOAuthFlow(
  clientId: string,
  clientSecret: string,
  redirectPort: number
): Promise<GmailTokens> {
  return new Promise((resolve, reject) => {
    const { verifier, challenge } = genPkce();
    const redirectUri = `http://localhost:${redirectPort}/`;
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      reject(new Error('Flow OAuth expiré (5 min) — relancez la connexion Gmail.'));
    }, OAUTH_TIMEOUT_MS);

    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close();
      reject(e);
    };
    const succeed = (t: GmailTokens) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(t);
    };

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GMAIL_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;

    const server = http.createServer((req, res) => {
      const url = req.url ?? '/';
      console.log('[OAuth] requête reçue:', req.method, url);
      const parsed = new URL(url, `http://localhost:${redirectPort}`);
      const code = parsed.searchParams.get('code');
      const error = parsed.searchParams.get('error');

      // Ignore les requêtes sans code ni error (favicon, preflight, etc.)
      // pour ne pas fermer le serveur prématurément.
      if (!code && !error) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><p>En attente de la redirection Google…</p></body></html>');
        return;
      }

      if (error) {
        const errorDesc = parsed.searchParams.get('error_description') ?? error;
        console.error('[OAuth] erreur Google:', error, errorDesc);
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body style="font-family:sans-serif;padding:40px"><h2>Connexion échouée</h2><p><strong>${error}</strong></p><p>${errorDesc}</p></body></html>`);
        fail(new Error(`Google a refusé: ${error} — ${errorDesc}`));
        return;
      }

      // On a le code : échange contre des tokens.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>Connexion réussie</h2><p>Vous pouvez fermer cet onglet et revenir à Mail Sorter AI.</p></body></html>`);
      server.close();

      exchangeCode(clientId, clientSecret, code!, redirectUri, verifier)
        .then(succeed)
        .catch(fail);
    });

    server.on('error', (e: NodeJS.ErrnoException) => {
      const hint = e.code === 'EADDRINUSE'
        ? `le port ${redirectPort} est déjà utilisé — changez le port de redirection dans Paramètres ou fermez l'app qui l'occupe`
        : e.message;
      fail(new Error(`serveur OAuth: ${hint}`));
    });
    server.listen(redirectPort, '127.0.0.1', () => {
      shell.openExternal(authUrl).catch((e) => {
        fail(new Error(`ouverture navigateur: ${e.message}`));
      });
    });
  });
}

async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  verifier: string
): Promise<GmailTokens> {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`token endpoint ${resp.status}: ${text}`);
  const v = JSON.parse(text);
  if (!v.access_token) throw new Error('access_token absent');
  const expiresIn: number = v.expires_in ?? 3600;
  return {
    accessToken: v.access_token,
    refreshToken: v.refresh_token ?? null,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    scope: v.scope ?? '',
  };
}

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<GmailTokens> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await resp.text();
  if (!resp.ok) {
    // invalid_grant = refresh token révoqué/expiré → reconnexion obligatoire.
    if (resp.status === 400 && text.includes('invalid_grant')) {
      throw new Error('Session Gmail expirée ou révoquée — reconnectez votre compte.');
    }
    throw new Error(`refresh endpoint ${resp.status}: ${text}`);
  }
  const v = JSON.parse(text);
  if (!v.access_token) throw new Error('access_token absent après refresh');
  const expiresIn: number = v.expires_in ?? 3600;
  return {
    accessToken: v.access_token,
    refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    scope: v.scope ?? '',
  };
}
