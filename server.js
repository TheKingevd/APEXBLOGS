const fs = require('fs');
const path = require('path');
const Module = require('module');

// Compatibility loader: keeps the original application in server-core.js while
// applying the three hotfixes before the real server is compiled.
const filename = path.join(__dirname, 'server-core.js');
let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');

// 1) Client branding: prefer the visible CTA color over generic CSS variables.
source = source.replace(
`    let corFoco = corFocoAceitavel(varFoco) ? varFoco : null;
    if (!corFoco && corFocoAceitavel(ctaBtnHex)) corFoco = ctaBtnHex;
    if (!corFoco && corFocoAceitavel(primaryBtnHex)) corFoco = primaryBtnHex;
    if (!corFoco && varFoco) corFoco = varFoco; // queda: usa a var mesmo assim
`,
`    let corFoco = null;
    // CTA visível tem prioridade sobre variáveis genéricas de destaque.
    if (corFocoAceitavel(ctaBtnHex)) corFoco = ctaBtnHex;
    if (!corFoco && corFocoAceitavel(primaryBtnHex)) corFoco = primaryBtnHex;
    if (!corFoco && corFocoAceitavel(varFoco)) corFoco = varFoco;
    if (!corFoco && varFoco) corFoco = varFoco;
`);

// 2) AI content: normalize noisy keywords and sanitize the model response.
const aiMarker = `/**
 * Gera e publica um post automaticamente para um cliente.
 */
async function gerarPostAutomatico(clientId) {
`;
const aiHelper = `function normalizarKeywordPrincipal(termo, localizacao) {
  let texto = String(termo || '').replace(/\s+/g, ' ').trim();
  const local = String(localizacao || '').replace(/\s+/g, ' ').trim();
  texto = texto
    .replace(/\bEMERGENCIAL(?=\d)/gi, 'EMERGENCIAL ')
    .replace(/\bURGENTE(?=\d)/gi, 'URGENTE ')
    .replace(/\b24HORAS\b/gi, '24 HORAS')
    .replace(/\b24H\b/gi, '24 HORAS')
    .replace(/\s+/g, ' ')
    .trim();
  if (local && texto.toLowerCase().endsWith(\` em \${local}\`.toLowerCase())) {
    texto = texto.slice(0, -(local.length + 4)).trim();
  }
  return texto || 'serviço especializado';
}

function limparConteudoIA(conteudo, titulo) {
  let texto = String(conteudo || '')
    .replace(/\r\n/g, '\n')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<html[^>]*>/gi, '')
    .replace(/<\/html>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<body[^>]*>/gi, '')
    .replace(/<\/body>/gi, '')
    .replace(/<\/r>/gi, '</strong>')
    .replace(/^\x60{3}(?:html)?\s*/i, '')
    .replace(/\s*\x60{3}$/i, '')
    .trim();
  const linhas = texto.split('\n');
  const primeira = (linhas[0] || '').replace(/<[^>]+>/g, '').replace(/^[*#\-•\s]+/, '').trim();
  if (titulo && primeira && primeira.toLowerCase() === String(titulo).trim().toLowerCase()) {
    linhas.shift();
    texto = linhas.join('\n').trim();
  }
  if (!/<(?:h2|h3|p|ul|ol|li)\b/i.test(texto)) texto = humanizarTexto(texto);
  texto = texto.replace(/^\s*<h1[^>]*>[\s\S]*?<\/h1>\s*/i, '');
  return texto.trim();
}

`;
if (!source.includes('function normalizarKeywordPrincipal(')) {
  source = source.replace(aiMarker, aiHelper + aiMarker);
}
source = source.replace(
  'const termoBase = kw ? kw.termo : termo;',
  'const termoBase = normalizarKeywordPrincipal(kw ? kw.termo : termo, client.localizacao);'
);
source = source.replace('"urgence", "24 horas"', '"urgente", "24 horas"');
source = source.replace('em <strong>negrito</r', 'em <strong>negrito</strong>.');

const cleanupRe = /            conteudo = conteudo\n              \.replace\(\/<!DOCTYPE\[\^>\]\*\/gi, ''\)[\s\S]*?\.trim\(\);/;
if (cleanupRe.test(source)) {
  source = source.replace(cleanupRe, '            conteudo = limparConteudoIA(conteudo, titulo);');
}

// 3) Scheduler: consume an exact date/time slot once, instead of using a rolling 3-minute lock.
const schemaOld = `    ultimo_post DATETIME,\n    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n`;
if (source.includes(schemaOld) && !source.includes('ultimo_slot TEXT')) {
  source = source.replace(schemaOld, `    ultimo_post DATETIME,\n    ultimo_slot TEXT,\n    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n`);
}
const migrationAnchor = '  db.run(`CREATE TABLE IF NOT EXISTS client_ads (';
if (source.includes(migrationAnchor) && !source.includes('ALTER TABLE post_schedules ADD COLUMN ultimo_slot')) {
  source = source.replace(migrationAnchor, '  db.run("ALTER TABLE post_schedules ADD COLUMN ultimo_slot TEXT", () => {});\n\n' + migrationAnchor);
}

const schedulerOld = `        // Verifica se o horário atual bate com o agendamento OU se estava previsto nos últimos 3 minutos
        const matchesNow = horarios.includes(hhmm);
        let matchesRecent = false;
        if (!matchesNow) {
          for (const h of horarios) {
            const [hHour, hMin] = h.split(':').map(Number);
            const diffMin = (hour * 60 + minute) - (hHour * 60 + hMin);
            if (diffMin > 0 && diffMin <= 3) {
              matchesRecent = true;
              break;
            }
          }
        }

        if (!matchesNow && !matchesRecent) continue;

        // Evita disparar duas vezes para o mesmo agendamento nos últimos 3 minutos
        if (sched.ultimo_post) {
          const ultimo = new Date(sched.ultimo_post.endsWith('Z') ? sched.ultimo_post : sched.ultimo_post + 'Z');
          const diffMin = (now.getTime() - ultimo.getTime()) / 60000;
          if (diffMin < 3) continue;
        }

        console.log(`[CRON] 🚀 Disparando agendamento (Schedule ID: ${sched.id}, Client ID: ${sched.client_id}) às ${hhmm}`);
        db.run('UPDATE post_schedules SET ultimo_post = CURRENT_TIMESTAMP WHERE id = ?', [sched.id]);

        if (sched.client_id === 0 || sched.client_id === 'ALL' || sched.client_id === 'TODOS') {
`;
const schedulerNew = `        // Aceita no máximo 1 minuto de atraso. O slot persistido impede repetição após F5/restart.
        const matchesNow = horarios.includes(hhmm);
        let slotHora = matchesNow ? hhmm : null;
        if (!slotHora) {
          for (const h of horarios) {
            const [hHour, hMin] = h.split(':').map(Number);
            const diffMin = (hour * 60 + minute) - (hHour * 60 + hMin);
            if (diffMin > 0 && diffMin <= 1) { slotHora = h; break; }
          }
        }
        if (!slotHora) continue;
        const slotKey = \`${isoDate} \${slotHora}\`;
        if (sched.ultimo_slot === slotKey) continue;
        console.log(\`[CRON] 🚀 Disparando agendamento (Schedule ID: \${sched.id}, Client ID: \${sched.client_id}) às \${hhmm} | Slot: \${slotKey}\`);
        db.run(
          'UPDATE post_schedules SET ultimo_post = CURRENT_TIMESTAMP, ultimo_slot = ? WHERE id = ? AND (ultimo_slot IS NULL OR ultimo_slot != ?)',
          [slotKey, sched.id, slotKey],
          function(updateErr) {
            if (updateErr || this.changes !== 1) return;
            if (sched.client_id === 0 || sched.client_id === 'ALL' || sched.client_id === 'TODOS') {
`;
if (source.includes(schedulerOld)) source = source.replace(schedulerOld, schedulerNew);

const closeOld = `          gerarPostAutomatico(sched.client_id)
            .then(r => console.log(\`[CRON] ✅ Post publicado: "\${r.titulo}" para \${r.client_name}\`))
            .catch(e => console.error(\`[CRON] ❌ Falha:\`, e.message));
        }

      } catch(e) {
`;
const closeNew = `              gerarPostAutomatico(sched.client_id)
                .then(r => console.log(\`[CRON] ✅ Post publicado: "\${r.titulo}" para \${r.client_name}\`))
                .catch(e => console.error(\`[CRON] ❌ Falha:\`, e.message));
            }
          }
        );

      } catch(e) {
`;
if (source.includes(closeOld)) source = source.replace(closeOld, closeNew);

const runtimeModule = new Module(filename, module);
runtimeModule.filename = filename;
runtimeModule.paths = Module._nodeModulePaths(__dirname);
runtimeModule._compile(source, filename);
