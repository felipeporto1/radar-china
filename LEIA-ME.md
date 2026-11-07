# Radar China

Busca passagens todo dia às 7h15 (horário de Teresina) e mostra tudo em um site seu, de graça.

- Fontes: Google Voos (pelo SerpApi, 250 buscas grátis por mês) e Aviasales (pelo Travelpayouts, grátis).
- Descarta voos com conexão nos EUA, Canadá, México, Austrália ou Nova Zelândia.
- Avisa no celular (app ntfy) quando um preço fica abaixo do teto e é o menor já visto.

Arquivos:
- `config.json`: janelas, tetos e quantas buscas por dia. Mude aqui se as datas mudarem.
- `buscar.mjs`: a busca diária.
- `bloqueados.json`: aeroportos onde a conexão exige visto para brasileiro.
- `docs/index.html`: o site. `docs/dados.json`: os preços, atualizados pela busca.
- `.github/workflows/buscar.yml`: o agendamento diário.
