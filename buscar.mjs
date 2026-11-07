// Radar China: busca passagens todo dia e grava docs/dados.json.
// Fontes: Google Voos (via SerpApi, 250 buscas grátis por mês) e Aviasales (via Travelpayouts, grátis).
import fs from "node:fs/promises";

const cfg = JSON.parse(await fs.readFile("config.json", "utf8"));
const bloq = JSON.parse(await fs.readFile("bloqueados.json", "utf8"));
const ARQ = "docs/dados.json";
const SERP = process.env.SERPAPI_KEY || "";
const TP = process.env.TRAVELPAYOUTS_TOKEN || "";
const NTFY = process.env.NTFY_TOPIC || "";
const MODO = process.env.MODO || "diario"; // diario | prioridade
const MOCK = process.env.MOCK_DIR || "";

let dados = {};
try { dados = JSON.parse(await fs.readFile(ARQ, "utf8")); } catch { dados = {}; }
dados.buscas ||= {}; dados.historico ||= {}; dados.datasBaratas ||= {};
const log = [];
const avisos = [];

const agora = process.env.HOJE ? new Date(process.env.HOJE) : new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const hoje = iso(agora);
const addDias = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const limiteGoogle = addDias(hoje, cfg.diasAbertosGoogle);
const diaN = Math.floor(agora.getTime() / 864e5);
const fmt = (v) => "R$ " + Math.round(v).toLocaleString("pt-BR");
const J = cfg.janelas;

/* ---------- Conexões que exigem visto ---------- */
function checarConexoes(codigos) {
  const proib = codigos.filter((c) => bloq.bloquear[c]);
  const conf = codigos.filter((c) => bloq.conferir[c]);
  return {
    ok: proib.length === 0,
    motivo: proib.length ? `Conexão em ${[...new Set(proib.map((c) => bloq.bloquear[c]))].join(", ")} (${proib.join(", ")}), que exige visto para brasileiro` : "",
    aviso: conf.length ? `Conexão em ${[...new Set(conf.map((c) => bloq.conferir[c]))].join(", ")} (${conf.join(", ")}): confira se não precisa sair da área de trânsito` : "",
  };
}

/* ---------- Google Voos (SerpApi) ---------- */
async function serpJson(params) {
  if (MOCK) return JSON.parse(await fs.readFile(`${MOCK}/serp.json`, "utf8"));
  const r = await fetch("https://serpapi.com/search.json?" + new URLSearchParams({ ...params, api_key: SERP }));
  return r.json();
}
async function cotaSerp() {
  if (MOCK) return 250;
  if (!SERP) return 0;
  try {
    const r = await fetch("https://serpapi.com/account.json?api_key=" + SERP);
    const j = await r.json();
    return Number(j.total_searches_left ?? j.plan_searches_left ?? 0);
  } catch { return 0; }
}
async function buscarGoogle(t) {
  const p = { engine: "google_flights", currency: "BRL", hl: "pt-BR", gl: "br", exclude_conns: cfg.excluirConexoes.join(",") };
  if (t.trip === 3) { p.type = "3"; p.multi_city_json = JSON.stringify(t.legs.map(([d, a, b]) => ({ departure_id: a, arrival_id: b, date: d }))); }
  else { p.type = "1"; p.departure_id = t.legs[0][1]; p.arrival_id = t.legs[0][2]; p.outbound_date = t.legs[0][0]; p.return_date = t.legs[1][0]; }
  const j = await serpJson(p);
  if (j.error) throw new Error(j.error);
  const opcoes = [...(j.best_flights || []), ...(j.other_flights || [])].filter((o) => typeof o.price === "number");
  let descartados = 0, melhor = null;
  for (const o of opcoes.sort((a, b) => a.price - b.price)) {
    const cods = [...(o.layovers || []).map((l) => l.id), ...(o.flights || []).slice(0, -1).map((f) => f.arrival_airport?.id)].filter(Boolean);
    const c = checarConexoes([...new Set(cods)]);
    if (!c.ok) { descartados++; continue; }
    melhor = {
      preco: o.price,
      cia: [...new Set((o.flights || []).map((f) => f.airline).filter(Boolean))].join(", "),
      escalas: (o.layovers || []).length,
      conexoes: (o.layovers || []).map((l) => `${l.name} (${l.id})`),
      duracaoMin: o.total_duration || null,
      aviso: [c.aviso, t.trip === 3 || t.trip === 1 ? "Volta já filtrada pelo Google, mas confira as conexões da volta antes de comprar." : ""].filter(Boolean).join(" "),
    };
    break;
  }
  const pi = j.price_insights || {};
  return { melhor, descartados, total: opcoes.length, insights: { menorGoogle: pi.lowest_price ?? null, nivel: pi.price_level ?? null, faixaTipica: pi.typical_price_range ?? null } };
}

/* ---------- Aviasales (Travelpayouts) ---------- */
async function tp(path, params) {
  if (MOCK) return JSON.parse(await fs.readFile(`${MOCK}/tp.json`, "utf8"));
  const r = await fetch(`https://api.travelpayouts.com${path}?` + new URLSearchParams({ ...params, currency: "brl", market: "br", token: TP }), { headers: { "Accept-Encoding": "gzip, deflate" } });
  const j = await r.json().catch(() => ({ success: false, error: "resposta inválida (" + r.status + ")" }));
  if (j.success === false || j.error) throw new Error(String(j.error || j.message || r.status));
  return j;
}
function itemAviasales(x) {
  return {
    preco: x.price, cia: x.airline || "", escalas: (x.transfers ?? 0) + (x.return_transfers ?? 0),
    ida: String(x.departure_at || "").slice(0, 10), volta: String(x.return_at || "").slice(0, 10),
    link: x.link ? "https://www.aviasales.com" + x.link : "",
    aviso: "A Aviasales não informa onde são as conexões: confira se nenhuma passa por EUA, Canadá, México, Austrália ou Nova Zelândia.",
  };
}

/* ---------- Registro ---------- */
function registrar(id, fonte, r, extra = {}) {
  const chave = `${id}|${fonte}`;
  const antes = dados.buscas[chave];
  const hist = (dados.historico[chave] ||= []);
  const minAnterior = hist.length ? Math.min(...hist.map((h) => h.p)) : Infinity;
  dados.buscas[chave] = { id, fonte, quando: agora.toISOString(), ...extra, ...r, melhorJa: r.melhor ? Math.min(minAnterior, r.melhor.preco) : (isFinite(minAnterior) ? minAnterior : null) };
  if (r.melhor) {
    if (hist.length && hist[hist.length - 1].d === hoje) hist.pop();
    hist.push({ d: hoje, p: r.melhor.preco });
    if (hist.length > 500) hist.shift();
  }
  return { minAnterior, antes };
}
function talvezAvisar(t, fonte, r, minAnterior) {
  if (!r.melhor) return;
  const teto = t.tipo === "the" ? cfg.tetoThe : cfg.tetoPrincipal;
  if (t.tipo === "ref") return;
  const p = r.melhor.preco;
  if (p <= teto && p < minAnterior) {
    avisos.push(`${t.rotulo}: ${fmt(p)} (${fonte}${r.melhor.cia ? ", " + r.melhor.cia : ""}). Abaixo do teto de ${fmt(teto)} e o menor já visto.${fonte === "Aviasales" ? " Confira as conexões." : ""}`);
  }
}

/* ---------- Lista de buscas ---------- */
const dm = (s) => s.slice(8, 10) + "/" + s.slice(5, 7);
function tarefas() {
  const t = [];
  for (const w of J) t.push({ id: `${w.k}-multi`, tipo: "multi", prio: 1, trip: 3, w, legs: [[w.ida, "GRU", "PEK"], [w.volta, "HKG", "GRU"]], rotulo: `${w.nome}, GRU→PEK ${dm(w.ida)} + HKG→GRU ${dm(w.volta)}` });
  const flex = J.flatMap((w) => cfg.flex.map(([a, b]) => {
    const ida = addDias(w.ida, a), volta = addDias(w.volta, b);
    return { id: `${w.k}-flex_${ida}_${volta}`, tipo: "flex", prio: 2, trip: 3, w, legs: [[ida, "GRU", "PEK"], [volta, "HKG", "GRU"]], rotulo: `${w.nome} com datas próximas, GRU→PEK ${dm(ida)} + HKG→GRU ${dm(volta)}` };
  }));
  for (let i = 0; i < cfg.flexPorDia; i++) t.push(flex[(diaN * cfg.flexPorDia + i) % flex.length]);
  const wt = J[diaN % J.length];
  t.push({ id: `${wt.k}-the`, tipo: "the", prio: 3, trip: 1, w: wt, legs: [[wt.theIda, "THE", "GRU"], [wt.theVolta, "GRU", "THE"]], rotulo: `${wt.nome}, THE⇄GRU ${dm(wt.theIda)} e ${dm(wt.theVolta)}` });
  const refs = J.flatMap((w) => [["pek", "PEK"], ["hkg", "HKG"]].map(([s, c]) => ({ id: `${w.k}-${s}`, tipo: "ref", prio: 4, trip: 1, w, legs: [[w.ida, "GRU", c], [w.voltaRef, c, "GRU"]], rotulo: `${w.nome}, GRU⇄${c} (referência)` })));
  t.push(refs[diaN % refs.length]);
  return t;
}

/* ---------- Execução ---------- */
let cota = await cotaSerp();
const reserva = cfg.reservaNoMes;
let usadas = 0;
const lista = tarefas().filter((t) => MODO !== "prioridade" || t.prio === 1).sort((a, b) => a.prio - b.prio);
for (const t of lista) {
  if (!SERP) { log.push("Google Voos: falta a chave SERPAPI_KEY."); break; }
  const ultimaPerna = t.legs[t.legs.length - 1][0];
  if (ultimaPerna > limiteGoogle) { dados.buscas[`${t.id}|Google Voos`] = { id: t.id, fonte: "Google Voos", tipo: t.tipo, janela: t.w.k, rotulo: t.rotulo, legs: t.legs, fechada: true, abre: addDias(ultimaPerna, -cfg.diasAbertosGoogle), quando: agora.toISOString(), melhorJa: dados.buscas[`${t.id}|Google Voos`]?.melhorJa ?? null }; continue; }
  if (usadas >= cfg.maxBuscasPorDia || cota - usadas <= (t.prio === 1 ? 0 : reserva)) { log.push(`Pulei ${t.rotulo}: guardando buscas do mês.`); continue; }
  try {
    usadas++;
    const r = await buscarGoogle(t);
    const { minAnterior } = registrar(t.id, "Google Voos", r, { tipo: t.tipo, janela: t.w.k, rotulo: t.rotulo, legs: t.legs, fechada: false });
    talvezAvisar(t, "Google Voos", r, minAnterior);
    log.push(`${t.rotulo}: ${r.melhor ? fmt(r.melhor.preco) : "nenhum voo que sirva"}${r.descartados ? ` (${r.descartados} descartados por visto)` : ""}.`);
  } catch (e) {
    log.push(`${t.rotulo}: erro no Google Voos (${String(e.message).slice(0, 140)}).`);
    dados.buscas[`${t.id}|Google Voos`] = { ...(dados.buscas[`${t.id}|Google Voos`] || {}), id: t.id, fonte: "Google Voos", tipo: t.tipo, janela: t.w.k, rotulo: t.rotulo, legs: t.legs, erro: String(e.message).slice(0, 200), quando: agora.toISOString() };
  }
}

if (TP || MOCK) {
  try {
    const prox = addDias(hoje, 40).slice(0, 7);
    const j = await tp("/aviasales/v3/prices_for_dates", { origin: "SAO", destination: "BJS", departure_at: prox, one_way: "false", sorting: "price", limit: "3" });
    const it = (j.data || [])[0];
    dados.aviasalesTeste = { quando: agora.toISOString(), ok: true, exemplo: it ? `São Paulo⇄Pequim saindo em ${prox}: a partir de ${fmt(it.price)}` : `sem preços para ${prox}` };
    log.push("Aviasales conectada. " + dados.aviasalesTeste.exemplo + ".");
  } catch (e) { dados.aviasalesTeste = { quando: agora.toISOString(), ok: false, erro: String(e.message).slice(0, 160) }; log.push("Aviasales com erro: " + dados.aviasalesTeste.erro); }
  for (const w of J) {
    const pares = [
      { id: `${w.k}-pek`, tipo: "ref", o: "SAO", d: "BJS", ida: w.ida, volta: w.voltaRef, rotulo: `${w.nome}, São Paulo⇄Pequim` },
      { id: `${w.k}-hkg`, tipo: "ref", o: "SAO", d: "HKG", ida: w.ida, volta: w.voltaRef, rotulo: `${w.nome}, São Paulo⇄Hong Kong` },
      { id: `${w.k}-the`, tipo: "the", o: "THE", d: "SAO", ida: w.theIda, volta: w.theVolta, rotulo: `${w.nome}, THE⇄São Paulo` },
    ];
    for (const p of pares) {
      try {
        const j = await tp("/aviasales/v3/prices_for_dates", { origin: p.o, destination: p.d, departure_at: p.ida, return_at: p.volta, one_way: "false", sorting: "price", limit: "5" });
        const it = (j.data || []).filter((x) => x.price).sort((a, b) => a.price - b.price)[0];
        const r = { melhor: it ? itemAviasales(it) : null };
        const { minAnterior } = registrar(p.id, "Aviasales", r, { tipo: p.tipo, janela: w.k, rotulo: p.rotulo, legs: [[p.ida, p.o, p.d], [p.volta, p.d, p.o]] });
        talvezAvisar({ ...p, w }, "Aviasales", r, minAnterior);
      } catch (e) { log.push(`${p.rotulo}: erro na Aviasales (${String(e.message).slice(0, 100)}).`); }
    }
  }
  for (const [o, d, nome] of [["SAO", "BJS", "São Paulo⇄Pequim"], ["SAO", "HKG", "São Paulo⇄Hong Kong"]]) {
    for (const mes of ["2027-10", "2027-11"]) {
      try {
        const j = await tp("/aviasales/v3/prices_for_dates", { origin: o, destination: d, departure_at: mes, return_at: mes, one_way: "false", sorting: "price", limit: "10" });
        dados.datasBaratas[`${o}-${d}-${mes}`] = { rota: nome, mes, quando: agora.toISOString(), itens: (j.data || []).filter((x) => x.price).slice(0, 8).map(itemAviasales) };
      } catch (e) { log.push(`${nome} ${mes}: erro na Aviasales.`); }
    }
  }
} else log.push("Aviasales: falta o TRAVELPAYOUTS_TOKEN.");

dados.atualizado = agora.toISOString();
dados.cotaGoogle = Math.max(0, cota - usadas);
dados.config = { tetoPrincipal: cfg.tetoPrincipal, tetoThe: cfg.tetoThe, prazoPrincipal: cfg.prazoPrincipal, janelas: J, diasAbertosGoogle: cfg.diasAbertosGoogle, alertasUrl: cfg.alertasUrl || "" };
dados.log = log;
await fs.writeFile(ARQ, JSON.stringify(dados, null, 1));

if (NTFY && avisos.length) {
  await fetch("https://ntfy.sh/" + NTFY, { method: "POST", headers: { Title: "Radar China: preco bom", Priority: "high", Tags: "airplane" }, body: avisos.join("\n") }).catch(() => {});
}
console.log(log.join("\n"));
console.log(avisos.length ? "AVISOS:\n" + avisos.join("\n") : "Sem avisos.");
