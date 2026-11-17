// Detecta respostas automáticas de robôs de outras empresas (menus, boas-vindas, "um atendente falará com você").
// Quando a AlphaTech prospecta uma clínica, quem responde primeiro costuma ser o robô dela. O nosso robô não deve
// conversar com outro robô: ele fica em silêncio com aquele contato e o dono decide o que fazer.

const STRONG = [
  /digite\s+(uma\s+das\s+op[çc][õo]es|a\s+op[çc][ãa]o|o\s+n[úu]mero)/i,
  /escolha\s+uma\s+das\s+op[çc][õo]es/i,
  /(selecione|responda\s+com)\s+(o\s+n[úu]mero|uma\s+op[çc][ãa]o)/i,
  /agradecemos\s+(o\s+seu|o|seu)\s+contato/i,
  /(representante|atendente|consultor[a]?)\s+(falar[áa]|entrar[áa]|ir[áa]\s+(falar|te\s+atender|responder)|retornar[áa])/i,
  /(retornaremos|responderemos)\s+(em\s+breve|o\s+mais\s+r[áa]pido)/i,
  /mensagem\s+autom[áa]tica/i,
  /(estamos|nos\s+encontramos)\s+fora\s+do\s+(hor[áa]rio|expediente)/i,
  /nosso\s+hor[áa]rio\s+de\s+atendimento\s+[ée]/i,
  /voc[êe]\s+j[áa]\s+[ée]\s+(nosso\s+)?(paciente|cliente)\s*\?/i,
];

const WELCOME = /seja\s+bem[\s-]?vind[oa]|bem[\s-]?vind[oa]\s+(a|à|ao)\s/i;
const OFFER_HELP = /como\s+(posso|podemos)\s+(te\s+|lhe\s+)?ajudar/i;
const MENU_LINES = /(^|\n)\s*(1\s*[-–.)]|1️⃣)[^\n]*\n[\s\S]*?(^|\n)\s*(2\s*[-–.)]|2️⃣)/;

export function isAutomatedMessage(text) {
  const t = String(text ?? '');
  if (!t.trim()) return false;
  if (STRONG.some((re) => re.test(t))) return true;
  if (MENU_LINES.test(t) && (WELCOME.test(t) || /op[çc][õo]es|digite|escolha/i.test(t))) return true;
  if (WELCOME.test(t) && OFFER_HELP.test(t)) return true;
  return false;
}

/** Texto que o Claude devolve quando percebe sozinho que a mensagem é de um robô. */
export const NO_REPLY = '[SEM_RESPOSTA]';
