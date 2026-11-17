# Atendimento automático AlphaTech no WhatsApp

Robô que conversa com os clientes no WhatsApp da AlphaTech, tira dúvidas sobre os serviços e **agenda a reunião de orçamento** na sua Google Agenda, com link do Google Meet.

- **WhatsApp:** API oficial da Meta (Cloud API)
- **Inteligência:** Claude (Anthropic)
- **Agenda:** Google Agenda + Google Meet
- **Código:** Node.js 22, **sem nenhuma dependência** (não precisa de `npm install`)

## Como funciona

```
Cliente no WhatsApp ──► Meta (webhook) ──► este servidor ──► Claude
                                                  │             │ usa ferramentas:
                                                  │             ├─ consultar horários livres  ─► Google Agenda
                                                  │             ├─ agendar reunião + Meet      ─► Google Agenda
                                                  │             ├─ ver / cancelar reunião      ─► Google Agenda
                                                  │             └─ chamar atendente humano     ─► alerta no seu WhatsApp
                                                  ◄─────────────┘
Cliente recebe a resposta ◄── Meta ◄──────────────┘
```

O que o robô faz:

- Responde dúvidas usando só as informações da AlphaTech (serviços, como funciona, perguntas frequentes). Não inventa preços: explica que o orçamento sai na reunião gratuita.
- Entende a necessidade do cliente, oferece 3 ou 4 horários livres reais, confirma e agenda. O evento já sai com link do Meet, os dados do cliente e um resumo da necessidade.
- Se o cliente informar e-mail, ele recebe o convite da agenda.
- Remarca e cancela reuniões, mas só as do próprio número do cliente.
- Passa para um humano quando o cliente pede, reclama ou o assunto foge do escopo. Nesse caso o robô fica em silêncio com aquele cliente por 12 horas (configurável) e avisa você.
- Avisa no seu WhatsApp a cada reunião nova ou cancelada.

## Arquivos

| Arquivo | O que é |
|---|---|
| `src/prompt.js` | **O que o robô sabe e como ele fala.** Edite aqui para mudar serviços, tom e regras. |
| `src/agent.js` | Conversa com o Claude e executa as ferramentas |
| `src/calendar.js` | Google Agenda: horários livres, criar, listar e cancelar |
| `src/whatsapp.js` | Envio de mensagens e leitura do webhook da Meta |
| `src/index.js` | Servidor (`/webhook` e `/health`) |
| `src/time.js` | Cálculo dos horários livres com fuso horário |
| `scripts/simular.js` | Conversar com o robô pelo terminal, sem WhatsApp |
| `scripts/google-auth.js` | Gera a autorização da sua Google Agenda |
| `test/` | Testes automáticos (`npm test`) |

---

## Passo a passo

Faça na ordem. Cada etapa pode ser testada antes da próxima.

### 1. Claude (5 minutos)

1. Em https://console.anthropic.com, crie uma conta, adicione créditos e gere uma chave em **API Keys**.
2. Copie `.env.example` para `.env` e preencha `ANTHROPIC_API_KEY`.
3. Rode `npm run simular` e converse como se fosse um cliente. A agenda é simulada nesta etapa.
4. Ajuste o `src/prompt.js` até gostar das respostas.

### 2. Google Agenda (15 minutos)

1. Em https://console.cloud.google.com, crie um projeto (ex.: "AlphaTech Bot").
2. Em **APIs e serviços › Biblioteca**, ative a **Google Calendar API**.
3. Em **Tela de consentimento OAuth**, escolha **Externo** e preencha nome e e-mail. Em **Usuários de teste**, adicione o Gmail da agenda.
4. Depois clique em **Publicar aplicativo** (status "Em produção").
   - **Importante:** enquanto o app estiver em "Teste", a autorização expira em 7 dias e o robô para de agendar.
   - Publicado sem verificação, o Google mostra um aviso de "app não verificado" só para você, na hora de autorizar. Pode continuar normalmente.
5. Em **Credenciais › Criar credenciais › ID do cliente OAuth**, escolha o tipo **App para computador**. Copie o ID e a chave secreta para `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`.
6. No seu computador, rode `npm run google-auth`, abra o link, entre com a conta da agenda e autorize. Copie o `GOOGLE_REFRESH_TOKEN` que aparecer no terminal para o `.env`.
7. Rode `npm run simular` de novo. Agora ele usa a **agenda real**. Marque uma reunião de teste e veja o evento aparecer com o link do Meet.

Para usar uma agenda separada só para as reuniões, troque `GOOGLE_CALENDAR_ID` pelo ID dela. Ele fica em **Configurações da agenda › Integrar agenda**.

### 3. Colocar o servidor no ar (15 minutos)

A Meta precisa de um endereço público com HTTPS. Sugestão: **Railway** (https://railway.app).

1. Suba esta pasta para um repositório **privado** no GitHub. O `.env` não vai junto, porque já está no `.gitignore`.
2. No Railway, use **New Project › Deploy from GitHub** e escolha o repositório.
3. Em **Variables**, cadastre todas as variáveis do seu `.env`.
4. O comando de início é `npm start`. Confira se a versão do Node é 22.9 ou superior. Se precisar, adicione a variável `NIXPACKS_NODE_VERSION=22`.
5. Em **Settings › Networking › Generate Domain**, gere o endereço (ex.: `https://alphatech-bot.up.railway.app`).
6. Abra `https://SEU-ENDERECO/health`. Deve aparecer `ok`.

Mantenha **1 instância sempre ligada**. Evite planos que "dormem", porque a Meta desiste do webhook se o servidor demorar a acordar.

### 4. WhatsApp: API oficial da Meta (30 minutos)

1. Em https://developers.facebook.com, crie um app do tipo **Empresa** e adicione o produto **WhatsApp**.
2. A Meta fornece um **número de teste** grátis. Em **WhatsApp › Configuração da API**:
   - Copie a **Identificação do número de telefone** para `WHATSAPP_PHONE_NUMBER_ID`.
   - Cadastre o seu celular como destinatário de teste.
3. **Token permanente:** em https://business.facebook.com/settings, vá em **Usuários do sistema** e crie um usuário administrador.
   - Atribua a ele o app e a conta do WhatsApp.
   - Clique em **Gerar token** com as permissões `whatsapp_business_messaging` e `whatsapp_business_management`.
   - Coloque o token em `WHATSAPP_TOKEN`. Não use o token temporário: ele expira em 24 horas.
4. **Chave secreta do app:** pegue em **Configurações do app › Básico** e coloque em `WHATSAPP_APP_SECRET`.
5. **Webhook:** em **WhatsApp › Configuração**, preencha:
   - **URL de callback:** `https://SEU-ENDERECO/webhook`
   - **Token de verificação:** o mesmo valor de `WHATSAPP_VERIFY_TOKEN`
   - Clique em **Verificar e salvar**. Depois, em **Campos do webhook**, assine **messages**.
6. Atualize as variáveis no Railway e mande "oi" do seu celular para o número de teste.

### 5. Usar o número da AlphaTech (15) 99844-0100

Hoje esse número está no app WhatsApp Business, com o catálogo. Há três caminhos:

| Opção | Como | Prós e contras |
|---|---|---|
| **Coexistência** (recomendado) | Conectar o número à API por um provedor parceiro da Meta (BSP) que ofereça "coexistence" | Mantém o app, o catálogo e o histórico, e você pode responder pelo celular quando o robô passar a conversa. O número precisa continuar ativo no celular. |
| **Chip novo só para o robô** | Registrar um número novo direto na Meta | Mais simples, mas o cliente passa a ter dois números da AlphaTech. |
| **Migrar o número atual só para a API** | Excluir a conta do app e registrar o número na Meta | Você perde o uso do app nesse número (catálogo e conversas pelo celular). |

No modo coexistência, assine também o campo **smb_message_echoes** no webhook. Assim, quando você responder um cliente pelo app, o robô sai de cena com aquele cliente sozinho.

A Meta também pode pedir a **verificação da empresa** e a aprovação do nome de exibição antes de liberar volumes maiores.

---

### 6. Modo coexistência com Dualhook (número no app e no robô)

Com o Dualhook, o número continua no **app WhatsApp Business** e também responde pelo robô. Só mudam as variáveis no Railway:

| Variável | Valor no modo Dualhook |
|---|---|
| `WHATSAPP_API_BASE` | `https://api.dualhook.com` |
| `GRAPH_API_VERSION` | `v25.0` (versão exigida pelo Dualhook) |
| `WHATSAPP_TOKEN` | a chave `dh_live_...` da conexão no Dualhook |
| `WHATSAPP_PHONE_NUMBER_ID` | o Phone Number ID do número conectado |
| `WHATSAPP_WABA_ID` | o ID da conta do WhatsApp (WABA) |
| `WHATSAPP_APP_SECRET` | **vazio** (as mensagens são assinadas pelo app do Dualhook) |
| `WEBHOOK_PATH` | um caminho secreto, ex.: `/webhook/a8f3k29xq7` |

No painel do Dualhook, configure o webhook como `https://SEU-ENDERECO.up.railway.app` + o `WEBHOOK_PATH`, com o mesmo `WHATSAPP_VERIFY_TOKEN`.

Quando alguém da equipe responde pelo app, o robô fica em silêncio com aquele cliente por `HANDOFF_HOURS` horas.

**Prospecção e robôs de outras empresas:** quando você manda a primeira mensagem para um contato pelo app, ou quando o contato responde com um robô (menu, boas-vindas automáticas, "um representante falará com você"), o robô da AlphaTech fica em silêncio com ele por `OWNER_FIRST_PAUSE_HOURS` horas (padrão 72) e avisa você no `OWNER_WHATSAPP`. Há também uma trava: mais de 5 respostas para o mesmo contato em 3 minutos pausa o robô com ele. Para religar: `#retomar 5515...`.

## Uso no dia a dia

- **Alertas:** reuniões novas, cancelamentos e pedidos de atendente chegam no `OWNER_WHATSAPP`. As reuniões também aparecem na sua Google Agenda, com as notificações dela.
- **Assumir uma conversa:** quando o robô chama um atendente, ele pausa sozinho. Para comandar manualmente, mande do seu WhatsApp pessoal para o número do robô:
  - `#pausar 5515999999999`: o robô para de responder esse cliente.
  - `#retomar 5515999999999`: o robô volta a responder.
- **Mudar o que o robô sabe:** edite `src/prompt.js` e faça um novo deploy.
- **Mudar expediente e duração:** use as variáveis `WORK_DAYS`, `WORK_START`, `WORK_END`, `MEETING_DURATION_MIN`, `MIN_NOTICE_HOURS` e `BOOKING_WINDOW_DAYS`. Não precisa mexer no código.

## Limitações conhecidas

- **Janela de 24 horas da Meta:** mensagens livres só podem ser enviadas até 24h depois da última mensagem da pessoa. As respostas do robô estão sempre dentro dessa janela. Já o **alerta para você** só chega se você tiver mandado alguma mensagem para o número do robô nas últimas 24h. Para alertas garantidos, o próximo passo é criar um modelo (template) de mensagem aprovado na Meta.
- **Memória das conversas:** fica na memória do servidor por 24h e se perde se o servidor reiniciar. As reuniões não se perdem, porque ficam na Google Agenda.
- **Tipos de mensagem:** o robô lê texto e legendas. Para áudio e figurinhas, ele pede para o cliente escrever.

## Custos (referência; confira os valores atuais)

- **Meta:** responder conversas iniciadas pelo cliente, dentro da janela de 24h, não é cobrado no modelo atual. Mensagens de modelo (template), como lembretes ativos, são cobradas.
- **Claude:** cobrado por uso, na casa de centavos por conversa. Para reduzir, use `ANTHROPIC_MODEL=claude-haiku-5-5`.
- **Railway:** plano pago básico.

## Testes

```
npm test
```

São 11 testes que simulam a Meta, o Claude e o Google. Eles cobrem o fluxo completo de agendamento, a passagem para humano, os comandos `#pausar` e `#retomar`, mensagens duplicadas, assinatura do webhook, horários ocupados e fora do expediente, e o cálculo de horários com fuso.
