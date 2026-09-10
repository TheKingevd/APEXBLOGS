const fs = require('fs');
const path = require('path');
const Module = require('module');

const filename = path.join(__dirname, 'server-core.js');
let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');

// 1) Branding: the visible CTA color wins over generic CSS variables.
source = source.replace(
  "    let corFoco = corFocoAceitavel(varFoco) ? varFoco : null;\n" +
  "    if (!corFoco && corFocoAceitavel(ctaBtnHex)) corFoco = ctaBtnHex;\n" +
  "    if (!corFoco && corFocoAceitavel(primaryBtnHex)) corFoco = primaryBtnHex;\n" +
  "    if (!corFoco && varFoco) corFoco = varFoco; // queda: usa a var mesmo assim\n",
  "    let corFoco = null;\n" +
  "    if (corFocoAceitavel(ctaBtnHex)) corFoco = ctaBtnHex;\n" +
  "    if (!corFoco && corFocoAceitavel(primaryBtnHex)) corFoco = primaryBtnHex;\n" +
  "    if (!corFoco && corFocoAceitavel(varFoco)) corFoco = varFoco;\n" +
  "    if (!corFoco && varFoco) corFoco = varFoco;\n"
);

// 2) AI: normalize keywords and clean malformed model output.
const aiMarker = "/**\n * Gera e publica um post automaticamente para um cliente.\n */\nasync function gerarPostAutomatico(clientId) {\n";
const aiHelper = [
  "function normalizarKeywordPrincipal(termo, localizacao) {",
  "  let texto = String(termo || '').replace(/\\s+/g, ' ').trim();",
  "  const local = String(localizacao || '').replace(/\\s+/g, ' ').trim();",
  "  texto = texto",
  "    .replace(/\\bEMERGENCIAL(?=\\d)/gi, 'EMERGENCIAL ')",
  "    .replace(/\\bURGENTE(?=\\d)/gi, 'URGENTE ')",
  "    .replace(/\\b24HORAS\\b/gi, '24 HORAS')",
  "    .replace(/\\b24H\\b/gi, '24 HORAS')",
  "    .replace(/\\s+/g, ' ')",
  "    .trim();",
  "  if (local && texto.toLowerCase().endsWith(' em ' + local.toLowerCase())) {",
  "    texto = texto.slice(0, -(local.length + 4)).trim();",
  "  }",
  "  return texto || 'serviço especializado';",
  "}",
  "",
  "function limparConteudoIA(conteudo, titulo) {",
  "  let texto = String(conteudo || '')",
  "    .replace(/\\r\\n/g, '\\n')",
  "    .replace(/<!DOCTYPE[^>]*>/gi, '')",
  "    .replace(/<html[^>]*>/gi, '')",
  "    .replace(/<\\/html>/gi, '')",
  "    .replace(/<head[^>]*>[\\s\\S]*?<\\/head>/gi, '')",
  "    .replace(/<body[^>]*>/gi, '')",
  "    .replace(/<\\/body>/gi, '')",
  "    .replace(/<\\/r>/gi, '</strong>')",
  "    .replace(/^```(?:html)?\\s*/i, '')",
  "    .replace(/\\s*```$/i, '')",
  "    .trim();",
  "  const linhas = texto.split('\\n');",
  "  const primeira = (linhas[0] || '').replace(/<[^>]+>/g, '').replace(/^[*#\\-•\\s]+/, '').trim();",
  "  if (titulo && primeira && primeira.toLowerCase() === String(titulo).trim().toLowerCase()) {",
  "    linhas.shift();",
  "    texto = linhas.join('\\n').trim();",
  "  }",
  "  if (!/(?:<h2|<h3|<p|<ul|<ol|<li)\\b/i.test(texto)) texto = humanizarTexto(texto);",
  "  texto = texto.replace(/^\\s*<h1[^>]*>[\\s\\S]*?<\\/h1>\\s*/i, '');",
  "  return texto.trim();",
  "}",
  ""
].join('\n');
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

// 3) Scheduler: persist the exact date/time slot so it can never fire twice.
const schemaOld =
  "    ultimo_post DATETIME,\n" +
  "    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n";
if (source.includes(schemaOld) && !source.includes('ultimo_slot TEXT')) {
  source = source.replace(
    schemaOld,
    "    ultimo_post DATETIME,\n" +
    "    ultimo_slot TEXT,\n" +
    "    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n"
  );
}
const migrationAnchor = "  db.run(`CREATE TABLE IF NOT EXISTS client_ads (";
if (source.includes(migrationAnchor) && !source.includes('ALTER TABLE post_schedules ADD COLUMN ultimo_slot')) {
  source = source.replace(
    migrationAnchor,
    "  db.run(\"ALTER TABLE post_schedules ADD COLUMN ultimo_slot TEXT\", () => {});\n\n" +
    migrationAnchor
  );
}

const schedulerGuardMarker = "        if (!matchesNow && !matchesRecent) continue;\n";
const schedulerGuard = [
  "        const slotKey = isoDate + ' ' + hhmm;",
  "        if (sched.ultimo_slot === slotKey) continue;",
  "        db.run(",
  "          'UPDATE post_schedules SET ultimo_slot = ? WHERE id = ? AND (ultimo_slot IS NULL OR ultimo_slot != ?)',",
  "          [slotKey, sched.id, slotKey]",
  "        );",
  ""
].join('\n');
if (!source.includes("const slotKey = isoDate + ' ' + hhmm;") && source.includes(schedulerGuardMarker)) {
  source = source.replace(schedulerGuardMarker, schedulerGuardMarker + schedulerGuard);
}

const runtimeModule = new Module(filename, module);
runtimeModule.filename = filename;
runtimeModule.paths = Module._nodeModulePaths(__dirname);
runtimeModule._compile(source, filename);
