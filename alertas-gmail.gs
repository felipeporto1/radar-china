/**
 * Radar China: lê os e-mails de alerta de preço (Kayak, Momondo, Skyscanner, Google Voos,
 * Aviasales, Trip.com) do seu Gmail e entrega um resumo para o site do Radar.
 * Só lê. Não apaga, não responde, não muda nada no Gmail.
 */
const BUSCA = 'newer_than:60d (from:kayak OR from:momondo OR from:skyscanner OR from:google.com OR from:aviasales OR from:trip.com)';
const CHINA = /(pequim|beijing|peking|hong ?kong|china|teresina|s[aã]o paulo)/i;
const IATA = /\b(PEK|PKX|BJS|HKG|THE|GRU|SAO)\b/;
const FORA = /(seguran[cç]a|security|senha|password|verifica[cç][aã]o|login)/i;
const VOO = /(voo|voos|flight|passage|tarifa|fare|pre[cç]o|price|alerta|alert)/i;

function fonteDe(de) {
  if (/kayak/i.test(de)) return 'Kayak';
  if (/momondo/i.test(de)) return 'Momondo';
  if (/skyscanner/i.test(de)) return 'Skyscanner';
  if (/aviasales/i.test(de)) return 'Aviasales';
  if (/trip\.com/i.test(de)) return 'Trip.com';
  if (/google/i.test(de)) return 'Google Voos';
  return '';
}

function lerAlertas() {
  const itens = [];
  for (const t of GmailApp.search(BUSCA, 0, 80)) {
    const msgs = t.getMessages();
    const m = msgs[msgs.length - 1];
    const fonte = fonteDe(m.getFrom());
    if (!fonte) continue;
    const assunto = m.getSubject() || '';
    const corpo = (m.getPlainBody() || '').slice(0, 30000);
    if (FORA.test(assunto)) continue;
    if (!/R\$/.test(assunto) && !/(pre[cç]o|price|alerta|alert|tarifa)/i.test(assunto)) continue;
    if (!VOO.test(assunto) && !(fonte !== 'Google Voos' && VOO.test(corpo.slice(0, 2000)))) continue;
    if (!CHINA.test(assunto + ' ' + corpo) && !IATA.test(assunto + ' ' + corpo)) continue;
    const precos = [];
    const re = /R\$\s?(\d{1,3}(?:\.\d{3})+|\d{3,6})(?:,\d{2})?/g;
    const noAssunto = re.exec(assunto);
    re.lastIndex = 0;
    let x;
    while ((x = re.exec(noAssunto ? assunto : assunto + ' ' + corpo)) !== null) {
      const v = Number(x[1].replace(/\./g, ''));
      if (v >= 300 && v <= 60000) precos.push(v);
    }
    itens.push({
      fonte: fonte,
      assunto: assunto.slice(0, 160),
      quando: m.getDate().toISOString(),
      menorPreco: precos.length ? (noAssunto ? precos[0] : Math.min.apply(null, precos)) : null,
      link: 'https://mail.google.com/mail/u/0/#all/' + t.getId()
    });
  }
  itens.sort(function (a, b) { return b.quando.localeCompare(a.quando); });
  return itens.slice(0, 40);
}

function doGet() {
  const corpo = JSON.stringify({ atualizado: new Date().toISOString(), itens: lerAlertas() });
  return ContentService.createTextOutput(corpo).setMimeType(ContentService.MimeType.JSON);
}

/** Rode esta função uma vez no editor para autorizar e testar. */
function testar() {
  Logger.log(JSON.stringify(lerAlertas(), null, 1));
}
