
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('crm.db');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

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

const CURATED_IMAGES = [
  'https://images.unsplash.com/photo-1585704032915-c3400ca199e7?q=80&w=1200&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1584622650111-993a426fbf0a?q=80&w=1200&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1607472586893-edb57bdc0e39?q=80&w=1200&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1542013936693-884638332954?q=80&w=1200&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1581244277943-fe4a9c777189?q=80&w=1200&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1504148455328-c376907d081c?q=80&w=1200&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1590490360182-c33d57733427?q=80&w=1200&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?q=80&w=1200&auto=format&fit=crop'
];

async function gerarPostParaCliente(client) {
  return new Promise((resolve) => {
    db.get(
      'SELECT * FROM keywords WHERE client_id = ? ORDER BY usado_em ASC NULLS FIRST, RANDOM() LIMIT 1',
      [client.id],
      async (err, kw) => {
        const termo = kw ? (kw.variacao || kw.termo) : (client.nicho || 'serviços especializados');
        const termoBase = kw ? kw.termo : termo;
        const nicho = client.nicho || 'serviços';
        const local = client.localizacao || 'Brasil';
        const nome = client.name;

        console.log(`Gerando para ${nome} com termo: "${termoBase}"...`);

        const systemPrompt = `Você é um redator sênior especialista em SEO on-page, copywriting de alta conversão e autoridade no nicho de ${nicho} no Brasil.
Seu objetivo é criar um artigo técnico, atraente, envolvente e focado na intenção de busca do usuário que pesquisa por "${termoBase}".
Regras fundamentais:
1. O TÍTULO deve ser direto, magnético, persuasivo, com alta taxa de cliques (CTR) contendo "${termoBase}" e a região "${local}".
2. Conteúdo 100% focado no problema e soluções de "${termoBase}".
3. Escreva em português brasileiro impecável, natural, sem clichês de IA.
4. Destaque em <strong>negrito</strong> a palavra-chave "${termoBase}" naturalmente ao longo do texto.
5. Formate exclusivamente em HTML semântico limpo: <h2>, <h3>, <p>, <ul>, <li>, <strong>.`;

        const userPrompt = `Crie um artigo completo e aprofundado (800 a 1100 palavras) sobre: "${termoBase}".

Dados da Empresa:
- Nome: "${nome}"
- Nicho: "${nicho}"
- Região: "${local}"

Estrutura OBRIGATÓRIA da resposta:
Linha 1: TITULO: [Crie um título irresistível, profissional e com alta taxa de cliques contendo "${termoBase}" e região]
Linha 2: VARIACOES: [3 variações curtas de busca separadas por "|"]

(Em seguida, escreva diretamente o conteúdo em HTML limpo iniciando pela introdução, sem repetir o título em H1):
- Introdução sobre a importância de resolver "${termoBase}" em ${local}.
- <h2>O que causa o problema de ${termoBase} e sinais de alerta?</h2>
- <h2>Como é realizado o procedimento profissional passo a passo?</h2>
- <h2>Cuidados essenciais e por que evitar métodos amadores</h2>
- <h2>Como solicitar orçamento para ${termoBase}</h2>
- <h2>Perguntas Frequentes sobre ${termoBase} (FAQ)</h2> com 3 perguntas e respostas.
- <h2>Atendimento Especializado com a ${nome} em ${local}</h2> com chamada para ação no WhatsApp.`;

        try {
          const resposta = await chamarIA([
            { role: 'user', content: systemPrompt + '\n\n' + userPrompt }
          ]);

          let titulo = '';
          let matchTitulo = resposta.match(/(?:t[íi]tulo|title|headline)[:\s*#]+([^\r\n<]+)/i);
          if (matchTitulo && matchTitulo[1]) {
            titulo = matchTitulo[1].replace(/^[*\-•#\s]+/, '').replace(/^["'«»“`]+|["'«»”`]+$/g, '').trim();
          }

          if (!titulo) {
            const firstLine = resposta.split('\n').map(l => l.trim()).filter(Boolean)[0] || '';
            const cleanLine = firstLine.replace(/<\/?[^>]+(>|$)/g, '').replace(/^[*\-•#\s]+/, '').trim();
            if (cleanLine && cleanLine.length >= 15 && cleanLine.length <= 150 && !cleanLine.includes('|')) {
              titulo = cleanLine;
            }
          }

          if (!titulo || titulo.toLowerCase() === termoBase.toLowerCase()) {
            const cap = termoBase.charAt(0).toUpperCase() + termoBase.slice(1);
            titulo = `${cap}: Atendimento Especializado e Soluções Rápidas em ${local}`;
          }

          titulo = titulo.replace(/[*_~`#]+/g, '').trim();

          let conteudo = resposta
            .replace(/<!DOCTYPE[^>]*>/gi, '')
            .replace(/<html[^>]*>/gi, '')
            .replace(/<\/html>/gi, '')
            .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
            .replace(/<body[^>]*>/gi, '')
            .replace(/<\/body>/gi, '')
            .replace(/^[*\-•#\s]*t[íi]tulo:[^\r\n]+\r?\n?/i, '')
            .replace(/<h1[^>]*>[\s\S]*?<\/h1>/gi, '')
            .replace(/^[*\-•#\s]*varia[çc][õo]es:[^\r\n]+\r?\n?/i, '')
            // Remove code fences de markdown que a IA embrulha ```html ... ```
            .replace(/^```[a-zA-Z0-9]*\s*\r?\n?/i, '')
            .replace(/\r?\n?```\s*$/i, '')
            .trim();

          const randomImg = CURATED_IMAGES[Math.floor(Math.random() * CURATED_IMAGES.length)];
          const slug = (titulo + '-' + Date.now().toString().slice(-4))
            .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
            .substring(0, 80);

          db.run(
            `INSERT INTO blogs (client_id, title, slug, content, imagem_url, status, published_at)
             VALUES (?, ?, ?, ?, ?, 'publicado', CURRENT_TIMESTAMP)`,
            [client.id, titulo, slug, conteudo, randomImg],
            function(errInsert) {
              if (errInsert) {
                console.error(`Erro ao salvar post para ${nome}:`, errInsert.message);
              } else {
                if (kw) {
                  db.run('UPDATE keywords SET usado_em = CURRENT_TIMESTAMP WHERE id = ?', [kw.id]);
                }
                console.log(`✅ [PUBLICADO] "${titulo}" -> /blog/${client.slug}`);
              }
              resolve();
            }
          );
        } catch(e) {
          console.error(`Erro ao gerar IA para ${nome}:`, e.message);
          resolve();
        }
      }
    );
  });
}

async function main() {
  db.all('SELECT id, name, slug, nicho, localizacao FROM clients', async (err, clients) => {
    if (err || !clients || !clients.length) {
      console.log('Nenhum cliente encontrado');
      process.exit(0);
    }
    console.log(`\n🚀 INICIANDO GERAÇÃO EM LOTE PARA ${clients.length} CLIENTES...\n`);
    for (const c of clients) {
      await gerarPostParaCliente(c);
      await new Promise(r => setTimeout(r, 2000));
    }
    console.log('\n🎉 TODOS OS POSTS PUBLICADOS COM SUCESSO!');
    process.exit(0);
  });
}

main();
