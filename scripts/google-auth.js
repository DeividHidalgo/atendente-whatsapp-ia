// Gera o GOOGLE_REFRESH_TOKEN uma única vez, no seu computador.
// Uso: preencha GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no .env e rode `npm run google-auth`.

import http from 'node:http';

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 53682;
const redirectUri = `http://localhost:${PORT}/callback`;

if (!clientId || !clientSecret) {
  console.error('Preencha GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no arquivo .env antes de rodar.');
  process.exit(1);
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
    ].join(' '),
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== '/callback') return res.writeHead(404).end();
  const code = url.searchParams.get('code');
  if (!code) {
    res.end('Autorização cancelada.');
    return;
  }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await r.json();
  if (!data.refresh_token) {
    res.end('Não veio refresh token. Veja o terminal.');
    console.error('Resposta do Google:', data);
  } else {
    res.end('Pronto! Pode fechar esta aba e voltar ao terminal.');
    console.log('\nCopie esta linha para o seu .env (e para as variáveis do servidor):\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${data.refresh_token}\n`);
  }
  server.close();
});

server.listen(PORT, () => {
  console.log('Abra este link no navegador, entre com a conta Google da agenda da AlphaTech e autorize:\n');
  console.log(authUrl + '\n');
});
