
const https = require('https');

function chamarIA(mensagens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      assistant_id: 0,
      model: 'gpt-4omini',
      msg: mensagens,
      type: 0
    });

    const options = {
      hostname: 'tresoradraichatbot.aritek.app',
      path: '/api/v1/chat',
      method: 'POST',
      headers: {
        'Accept': 'text/event-stream',
        'Content-Type': 'application/json',
        'ctry_target': 'others',
        'device_id': '086dd1f6906474a8',
        'sign': 'f9783a47dd9254c6f81a58c474bdd45c18fe72a3',
        'token': 'eyJzdWIiwsdeOiIyMzQyZmczNHJ0MJuYW1lIjorwiSm9objMdf0NTM0NT',
        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 7.1.2; ASUS_Z01QD Build/N2G48H)',
        'version_code': '111',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let fullText = '';
      let buffer = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          const m = trimmed.match(/^data:\s?(.*)$/);
          if (m && m[1] && m[1] !== '[DONE]') {
            fullText += m[1];
          }
        }
      });

      res.on('end', () => {
        const m = buffer.trim().match(/^data:\s?(.*)$/);
        if (m && m[1] && m[1] !== '[DONE]') fullText += m[1];
        fullText = fullText.replace(/\[e-n-t-e-r\]/gi, '\n');
        resolve(fullText.trim());
      });

      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('IA timeout')); });
    req.write(body);
    req.end();
  });
}

async function testPrompt(termo, nicho, nome, local) {
  console.log('==================================================');
  console.log(`TESTING PROMPT FOR: [${termo}] | Empresa: ${nome} | Local: ${local}`);
  console.log('==================================================');

  const systemPrompt = `Você é um redator sênior especialista em SEO on-page, copywriting de alta conversão e autoridade no nicho de ${nicho} no Brasil.
Seu objetivo é criar um artigo técnico, envolvente e extremamente focado na intenção de busca do usuário que pesquisa por "${termo}".
Regras fundamentais:
1. O TÍTULO deve ser direto, magnético, persuasivo e conter a palavra-chave principal "${termo}" e a região "${local}".
2. O conteúdo NÃO deve ser genérico. Foque 100% no problema e na solução do termo "${termo}".
3. Escreva em português brasileiro impecável, natural, claro, sem clichês de IA (proibido usar "certamente", "em suma", "resumo", "no mundo de hoje").
4. Destaque em <strong>negrito</strong> a palavra-chave principal "${termo}" e variações naturais 4 a 6 vezes ao longo do texto.
5. Formate exclusivamente em HTML semântico limpo: <h2>, <h3>, <p>, <ul>, <li>, <strong> (nunca use <h1> e nunca use Markdown).`;

  const userPrompt = `Crie um artigo completo e aprofundado (800 a 1100 palavras) sobre: "${termo}".

Informações da Empresa:
- Nome da Empresa: "${nome}"
- Nicho / Especialidade: "${nicho}"
- Região de Atendimento: "${local}"

Estrutura OBRIGATÓRIA da resposta:
Linha 1: TITULO: [Crie um título irresistível, profissional e com alta taxa de cliques, incluindo "${termo}" e o benefício/região]
Linha 2: VARIACOES: [3 variações curtas de busca separadas por "|"]

(Em seguida, escreva diretamente o conteúdo em HTML limpo iniciando pela introdução, sem repetir o título em H1):
- Introdução envolvente descrevendo a urgência do problema de "${termo}", os riscos de adiar a solução e a importância de atendimento rápido em ${local}.
- <h2>O que causa o problema de ${termo} e quais são os primeiros sinais?</h2>
- <h2>Como é realizado o procedimento profissional passo a passo?</h2> (detalhes técnicos, equipamentos modernos, segurança e agilidade).
- <h2>Por que evitar soluções caseiras ou amadoras?</h2>
- <h2>Quanto custa e como solicitar orçamento para ${termo}?</h2> (fatores que influenciam no preço, transparência e sem cobrança de taxa de visita).
- <h2>Perguntas Frequentes sobre ${termo} (FAQ)</h2> com 3 perguntas e respostas diretas.
- <h2>Atendimento Especializado com a ${nome} em ${local}</h2> com chamada persuasiva para contato 24 horas via WhatsApp.`;

  const res = await chamarIA([
    { role: 'user', content: systemPrompt + '\n\n' + userPrompt }
  ]);

  const matchTitulo = res.match(/t[íi]tulo:\s*([^\r\n<]+)/i);
  console.log('TITLE GENERATED:', matchTitulo ? matchTitulo[1].trim() : 'NO TITLE FOUND');
  console.log('SNIPPET (first 500 chars):\n', res.slice(0, 500));
}

async function run() {
  await testPrompt('caça vazamento com geofone', 'caça-vazamento e encanador', 'Tony Tech', 'Diadema e ABC Paulista');
  await testPrompt('desentupimento de esgoto 24 horas', 'desentupidora 24h', 'Turbo Hidro Desentupidora', 'Campinas e Região');
}

run().catch(console.error);
