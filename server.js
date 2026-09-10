require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const sharp = require('sharp');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const https = require('https');
const cron = require('node-cron');
const compression = require('compression');
const Tesseract = require('tesseract.js');

const ConnectSqlite3 = require('connect-sqlite3')(session);

// ── GOOGLE & BING INDEXING PING HELPER ────────────────────────────────────────

// ── HELPER DE DOMÍNIO PÚBLICO E REVERSE PROXY ────────────────────────────────
function getPublicBlogUrl(req, client) {
  const forwardedHost = req ? req.get('x-forwarded-host') : null;
  const forwardedProto = req ? (req.get('x-forwarded-proto') || 'https') : 'https';
  if (forwardedHost) {
    return `${forwardedProto}://${forwardedHost}/blog`;
  }
  if (client && client.website && /^https?:\/\//i.test(client.website)) {
    const cleanSite = client.website.replace(/\/+$/, '');
    return `${cleanSite}/blog`;
  }
  const host = req ? req.get('host') : 'localhost:1337';
  const proto = req ? req.protocol : 'http';
  return `${proto}://${host}/blog/${client ? client.slug : ''}`;
}

async function pingSearchEngines(sitemapUrl) {
  if (!sitemapUrl) return;
  const pings = [
    `https://www.google.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`,
    `https://www.bing.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`
  ];
  for (const url of pings) {
    try {
      fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }).catch(() => {});
    } catch(e) {}
  }
}


// ── Uploads setup ──────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ── DB setup ──────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'crm.db');
const db = new sqlite3.Database(DB_PATH);

// Habilita chaves estrangeiras para que remover um cliente/site também apague
// seus posts (blogs), keywords, agendamentos e logs associados (ON DELETE CASCADE).
db.run('PRAGMA foreign_keys = ON');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT,
    email TEXT,
    phone TEXT,
    website TEXT,
    nicho TEXT,
    status TEXT DEFAULT 'ativo',
    whatsapp TEXT,
    localizacao TEXT,
    logo TEXT,
    fonte TEXT,
    cor_primaria TEXT,
    cor_fundo TEXT,
    cor_titulo TEXT,
    cor_foco TEXT,
    redes_sociais TEXT,
    seo_titulo TEXT,
    seo_descricao TEXT,
    footer_html TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Auto-migration for existing databases
  db.run("ALTER TABLE clients ADD COLUMN cor_foco TEXT", () => {});
  db.run("ALTER TABLE clients ADD COLUMN slug TEXT", () => {});
  db.run("ALTER TABLE clients ADD COLUMN cor_header_bg TEXT", () => {});
  db.run("ALTER TABLE clients ADD COLUMN redes_sociais TEXT", () => {});

  db.run(`CREATE TABLE IF NOT EXISTS blogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    slug TEXT,
    status TEXT DEFAULT 'rascunho',
    content TEXT,
    imagem_url TEXT,
    published_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`);
  db.run("ALTER TABLE blogs ADD COLUMN imagem_url TEXT", () => {});
  db.run("ALTER TABLE blogs ADD COLUMN imagem_origem TEXT", () => {});

  db.run(`CREATE TABLE IF NOT EXISTS keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    termo TEXT NOT NULL,
    variacao TEXT,
    usado_em DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER,
    post_slug TEXT,
    action TEXT,
    origin_type TEXT,
    referrer TEXT,
    ip TEXT,
    ip_version TEXT,
    city TEXT,
    region TEXT,
    device TEXT,
    browser TEXT,
    os TEXT,
    duration_seconds INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS post_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    horarios TEXT DEFAULT '["09:00"]',
    dias_semana TEXT DEFAULT '[1,2,3,4,5,6,7]',
    ativo INTEGER DEFAULT 1,
    posts_por_dia INTEGER DEFAULT 1,
    ultimo_post DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS client_ads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    posicao TEXT NOT NULL,
    ativo INTEGER DEFAULT 0,
    imagem_url TEXT,
    link_url TEXT,
    views INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(client_id, posicao)
  )`);

  // seed admin user
  const email = 'wolfofdown@gmail.com';
  const rawPassword = '40028933Ab_';
  db.get('SELECT id FROM users WHERE email = ?', [email], (err, row) => {
    if (!row) {
      const hash = bcrypt.hashSync(rawPassword, 12);
      db.run('INSERT INTO users (email, password) VALUES (?, ?)', [email, hash]);
      console.log('Admin criado:', email);
    }
  });
});

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── CORS & SECURITY HEADERS (CORS + CSP Allow Eval/Inline) ─────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' data:; style-src * 'unsafe-inline' https: http:; img-src * data: blob: https: http:; font-src * data: https: http:; connect-src * https: http:;");
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Serve static uploads with caching
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '30d', etag: true }));
app.use(express.static(__dirname, {
  maxAge: '1d',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
  }
}));

// Favicon fallback
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Migration & Optimization helper: downloads, resizes and caches all images locally in WebP
async function optimizeAllBlogImages() {
  db.all("SELECT id, content, imagem_url FROM blogs", [], async (err, rows) => {
    if (err || !rows || !rows.length) return;
    for (const row of rows) {
      let content = row.content || '';
      let imagemUrl = row.imagem_url || '';
      let changed = false;

      // Convert Base64 or external uncompressed HTTP URLs to optimized WebP in /uploads/
      if (imagemUrl && !imagemUrl.startsWith('/uploads/')) {
        try {
          let buf;
          if (imagemUrl.startsWith('data:image')) {
            const match = imagemUrl.match(/^data:image\/(\w+);base64,(.+)$/);
            if (match) buf = Buffer.from(match[2], 'base64');
          } else if (imagemUrl.startsWith('http')) {
            const res = await fetch(imagemUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (res.ok) buf = Buffer.from(await res.arrayBuffer());
          }

          if (buf) {
            const resized = await sharp(buf)
              .resize({ width: 800, height: 450, fit: 'cover' })
              .webp({ quality: 80 })
              .toBuffer();
            const fn = `img_opt_${row.id}_${Date.now()}.webp`;
            fs.writeFileSync(path.join(UPLOADS_DIR, fn), resized);
            imagemUrl = `/uploads/${fn}`;
            changed = true;
          }
        } catch (e) {
          console.warn(`[OPTIMIZER] Falha ao otimizar imagem do post ${row.id}:`, e.message);
        }
      }

      // Convert Base64 inside content
      if (content.includes('data:image')) {
        content = content.replace(/data:image\/(\w+);base64,([A-Za-z0-9+/=]+)/g, (fullMatch, type, base64Str) => {
          try {
            const buf = Buffer.from(base64Str, 'base64');
            const fn = `img_content_${row.id}_${Math.random().toString(36).substring(2,7)}.webp`;
            fs.writeFileSync(path.join(UPLOADS_DIR, fn), buf);
            changed = true;
            return `/uploads/${fn}`;
          } catch(e) { return fullMatch; }
        });
      }

      if (changed) {
        db.run("UPDATE blogs SET content = ?, imagem_url = ? WHERE id = ?", [content, imagemUrl, row.id]);
      }
    }
  });
}
setTimeout(optimizeAllBlogImages, 2000);

app.use(session({
  store: new ConnectSqlite3({ db: 'sessions.db', dir: __dirname }),
  secret: process.env.SESSION_SECRET || 'crm-blog-secret-xK92!',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8h
}));

// ── Clean Page Routes ────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'login.html'));
});
app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Não autenticado' });
  res.redirect('/login');
}

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatórios' });

  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (err || !user) return res.status(401).json({ error: 'Credenciais inválidas' });
    if (!bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Credenciais inválidas' });

    req.session.userId = user.id;
    req.session.userEmail = user.email;
    res.json({ success: true, email: user.email });
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ email: req.session.userEmail });
});

// ── Client CRUD ───────────────────────────────────────────────────────────────
app.get('/api/clients', requireAuth, (req, res) => {
  const search = req.query.search ? `%${req.query.search}%` : '%';
  const status = req.query.status || '%';
  db.all(
    `SELECT c.*, (SELECT COUNT(*) FROM blogs WHERE client_id = c.id) as blog_count
     FROM clients c
     WHERE (c.name LIKE ? OR c.email LIKE ? OR c.nicho LIKE ?)
       AND c.status LIKE ?
     ORDER BY c.created_at DESC`,
    [search, search, search, status],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

app.get('/api/clients/:id', requireAuth, (req, res) => {
  db.get('SELECT * FROM clients WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Cliente não encontrado' });
    res.json(row);
  });
});

app.post('/api/clients', requireAuth, async (req, res) => {
  let {
    name, email, phone, website, nicho, status, notes,
    whatsapp, localizacao, logo, fonte, cor_primaria, cor_fundo, cor_titulo, cor_foco, cor_header_bg, redes_sociais,
    seo_titulo, seo_descricao, footer_html
  } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  const slug = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

  // Auto-analysis on creation if website is provided and visual details are missing
  if (website && (!cor_primaria || cor_primaria === '#000000' || !logo)) {
    try {
      const data = await analisarSite(website);
      nicho = nicho || data.nicho;
      email = email || (data.contato.email !== 'Não encontrado' ? data.contato.email : null);
      whatsapp = whatsapp || data.contato.whatsapp;
      phone = phone || data.contato.whatsapp;
      localizacao = localizacao || data.contato.localizacao;
      logo = logo || data.design.logo;
      fonte = fonte || data.design.fonte;
      cor_primaria = cor_primaria || data.design.cores.corPrimaria;
      cor_header_bg = cor_header_bg || data.design.cores.corHeaderBg;
      cor_fundo = cor_fundo || data.design.cores.corFundo;
      cor_titulo = cor_titulo || data.design.cores.corTitulo;
      cor_foco = cor_foco || data.design.cores.corFoco;
      redes_sociais = redes_sociais || JSON.stringify(data.contato.redesSociais || {});
      seo_titulo = seo_titulo || data.seo.titulo;
      seo_descricao = seo_descricao || data.seo.descricao;
      footer_html = footer_html || data.estrutura.footerHtml;
    } catch (err) {
      console.error('Auto-analysis failed during client creation:', err.message);
    }
  }

  const socialVal = typeof redes_sociais === 'object' ? JSON.stringify(redes_sociais) : (redes_sociais || null);

  db.run(
    `INSERT INTO clients (
      name, email, phone, website, nicho, status, notes, slug,
      whatsapp, localizacao, logo, fonte, cor_primaria, cor_fundo, cor_titulo, cor_foco, cor_header_bg, redes_sociais,
      seo_titulo, seo_descricao, footer_html
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name, email || null, phone || null, website || null, nicho || null, status || 'ativo', notes || null, slug,
      whatsapp || null, localizacao || null, logo || null, fonte || null,
      cor_primaria || null, cor_fundo || null, cor_titulo || null, cor_foco || null, cor_header_bg || null, socialVal,
      seo_titulo || null, seo_descricao || null, footer_html || null
    ],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT * FROM clients WHERE id = ?', [this.lastID], (e, row) => res.status(201).json(row));
    }
  );
});

app.put('/api/clients/:id', requireAuth, (req, res) => {
  const fields = ['name','email','phone','website','nicho','status','notes',
    'whatsapp','localizacao','logo','fonte','cor_primaria','cor_fundo','cor_titulo','cor_foco','cor_header_bg','redes_sociais',
    'seo_titulo','seo_descricao','footer_html'];
  const updates = [];
  const vals = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) {
      const val = (f === 'redes_sociais' && typeof req.body[f] === 'object') ? JSON.stringify(req.body[f]) : req.body[f];
      updates.push(`${f} = ?`); vals.push(val);
    }
  });
  if (req.body.name) {
    const slug = req.body.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    updates.push('slug = ?');
    vals.push(slug);
  }
  if (!updates.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  updates.push('updated_at = CURRENT_TIMESTAMP');
  vals.push(req.params.id);

  db.run(`UPDATE clients SET ${updates.join(', ')} WHERE id = ?`, vals, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    db.get('SELECT * FROM clients WHERE id = ?', [req.params.id], (e, row) => res.json(row));
  });
});

app.delete('/api/clients/:id', requireAuth, (req, res) => {
  db.run('DELETE FROM clients WHERE id = ?', [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ── Blog CRUD ─────────────────────────────────────────────────────────────────
app.get('/api/clients/:id/blogs', requireAuth, (req, res) => {
  db.all(
    'SELECT * FROM blogs WHERE client_id = ? ORDER BY created_at DESC',
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

app.post('/api/clients/:id/blogs', requireAuth, (req, res) => {
  const { title, content, status, slug } = req.body;
  if (!title) return res.status(400).json({ error: 'Título obrigatório' });
  const generatedSlug = slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  db.run(
    `INSERT INTO blogs (client_id, title, slug, content, status, published_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [req.params.id, title, generatedSlug, content || null, status || 'rascunho',
     status === 'publicado' ? new Date().toISOString() : null],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT * FROM blogs WHERE id = ?', [this.lastID], (e, row) => res.status(201).json(row));
    }
  );
});

app.put('/api/blogs/:id', requireAuth, (req, res) => {
  const { title, content, status, slug, imagem_url } = req.body;
  db.run(
    `UPDATE blogs SET 
      title = COALESCE(?, title),
      content = COALESCE(?, content),
      status = COALESCE(?, status),
      slug = COALESCE(?, slug),
      imagem_url = COALESCE(?, imagem_url),
      published_at = CASE WHEN ? = 'publicado' THEN COALESCE(published_at, CURRENT_TIMESTAMP) ELSE published_at END
     WHERE id = ?`,
    [title || null, content || null, status || null, slug || null, imagem_url || null, status, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT * FROM blogs WHERE id = ?', [req.params.id], (e, row) => res.json(row));
    }
  );
});

// Upload ou troca direta de imagem de post do blog
app.post('/api/blogs/:id/imagem', requireAuth, (req, res) => {
  const { id } = req.params;
  const { imagem_url, data } = req.body;

  if (data && data.startsWith('data:image')) {
    const m = data.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: 'Formato de imagem inválido' });
    try {
      const ext = (m[1] || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
      const buf = Buffer.from(m[2], 'base64');
      const fn = `post_manual_${id}_${Date.now()}.${ext === 'png' ? 'png' : 'jpg'}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, fn), buf);
      const url = `/uploads/${fn}`;
      db.run('UPDATE blogs SET imagem_url = ? WHERE id = ?', [url, id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, imagem_url: url });
      });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  } else if (imagem_url) {
    db.run('UPDATE blogs SET imagem_url = ? WHERE id = ?', [imagem_url.trim(), id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, imagem_url: imagem_url.trim() });
    });
  } else {
    res.status(400).json({ error: 'Envie imagem_url ou data em base64' });
  }
});

app.delete('/api/blogs/:id', requireAuth, (req, res) => {
  db.run('DELETE FROM blogs WHERE id = ?', [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, (req, res) => {
  db.get(`SELECT
    (SELECT COUNT(*) FROM clients) as total_clients,
    (SELECT COUNT(*) FROM clients WHERE status = 'ativo') as active_clients,
    (SELECT COUNT(*) FROM blogs) as total_blogs,
    (SELECT COUNT(*) FROM blogs WHERE status = 'publicado') as published_blogs
  `, (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row);
  });
});

// ── Analyzer (existing, now auth-protected) ───────────────────────────────────
function rgbToHex(rgbStr) {
  if (!rgbStr) return null;
  if (rgbStr.startsWith('#')) return rgbStr;
  const m = rgbStr.match(/\d+/g);
  if (!m || m.length < 3) return rgbStr;
  const r = parseInt(m[0]);
  const g = parseInt(m[1]);
  const b = parseInt(m[2]);
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

function formatarTelefone(tel) {
  if (!tel) return '';
  const digitos = tel.replace(/\D/g, '');
  if (digitos.length === 11) {
    return `(${digitos.slice(0,2)}) ${digitos.slice(2,7)}-${digitos.slice(7)}`;
  }
  if (digitos.length === 10) {
    return `(${digitos.slice(0,2)}) ${digitos.slice(2,6)}-${digitos.slice(6)}`;
  }
  if (digitos.length === 13 && digitos.startsWith('55')) {
    return `(${digitos.slice(2,4)}) ${digitos.slice(4,9)}-${digitos.slice(9)}`;
  }
  if (digitos.length === 12 && digitos.startsWith('55')) {
    return `(${digitos.slice(2,4)}) ${digitos.slice(4,8)}-${digitos.slice(8)}`;
  }
  return tel;
}

function identificarNicho(titulo, descricao) {
  const texto = (titulo + ' ' + descricao).toLowerCase();
  if (texto.includes('vazamento') || texto.includes('geofone') || texto.includes('encanador') || texto.includes('hidráulic') || texto.includes('infiltra'))
    return 'Caça Vazamento / Desentupidora';
  if (texto.includes('desentupidora') || texto.includes('desentupimento') || texto.includes('fossa') || texto.includes('esgoto'))
    return 'Caça Vazamento / Desentupidora';
  if (texto.includes('advogado') || texto.includes('advocacia'))
    return 'Direito / Advocacia';
  if (texto.includes('clínica') || texto.includes('odonto'))
    return 'Saúde / Clínica';
  if (texto.includes('imóveis') || texto.includes('corretor'))
    return 'Imobiliária';
  if (texto.includes('contab') || texto.includes('contador'))
    return 'Contabilidade';
  if (texto.includes('restaurante') || texto.includes('pizzaria') || texto.includes('lanchonete'))
    return 'Alimentação / Gastronomia';
  if (texto.includes('academia') || texto.includes('personal'))
    return 'Fitness / Saúde';
  if (texto.includes('eletricista') || texto.includes('elétric'))
    return 'Serviços Elétricos';
  if (texto.includes('pintor') || texto.includes('pintura') || texto.includes('reforma'))
    return 'Reformas / Construção';
  return 'Serviços Gerais';
}

async function analisarSite(url) {
  let browser = null;
  let html = '';
  let designSystem = { fonte: 'Inter', cssVars: {}, headerBg: null, heroBg: null, heroHeadingColor: null, primaryBtnBg: null, ctaBtnBg: null, headingColor: null, logoSrc: null, waNumber: null };

  try {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    html = await page.content();
    designSystem = await page.evaluate(() => {
      const bodyFont = window.getComputedStyle(document.body).fontFamily;
      const cssVars = {};
      // 1) vars explícitas em regras :root
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.selectorText === ':root') {
              for (let i = 0; i < rule.style.length; i++) {
                const prop = rule.style[i];
                cssVars[prop] = rule.style.getPropertyValue(prop).trim();
              }
            }
          }
        } catch(e) {}
      }
      // 2) vars computadas herdadas (caso o :root esteja em CSS dinâmico/JS ou o site use
      //    custom props em outro seletor) — captura --secondary-blue, --accent-orange etc.
      try {
        const cs = window.getComputedStyle(document.documentElement);
        for (let i = 0; i < cs.length; i++) {
          const p = cs[i];
          if (p.startsWith('--') && !cssVars[p]) cssVars[p] = cs.getPropertyValue(p).trim();
        }
      } catch(e) {}

      // 1. Header
      const header = document.querySelector('header, .main-header, [class*="header"], nav, .navbar');
      const headerBg = header ? window.getComputedStyle(header).backgroundColor : null;

      // 2. Hero
      const hero = document.querySelector('.hero-section, .hero, section:first-of-type, [class*="banner"], [class*="hero"]');
      const heroBg = hero ? window.getComputedStyle(hero).backgroundColor : null;
      const heroHeading = hero ? hero.querySelector('h1, h2') : null;
      const heroHeadingColor = heroHeading ? window.getComputedStyle(heroHeading).color : null;

      // 3. CTA Buttons
      const primaryBtn = document.querySelector('.btn-primary-cta, .btn-header-cta, button[class*="primary"], a[class*="btn-primary"], a[class*="button"], .btn-primary, [role="button"]');
      const primaryBtnBg = primaryBtn ? window.getComputedStyle(primaryBtn).backgroundColor : null;

      const ctaBtn = document.querySelector('a[href*="wa.me"], a[href*="whatsapp"], .btn-secondary, [class*="cta"], [class*="destaque"], button');
      const ctaBtnBg = ctaBtn ? window.getComputedStyle(ctaBtn).backgroundColor : null;

      // 4. Heading
      const h1 = document.querySelector('h1, h2');
      const headingColor = h1 ? window.getComputedStyle(h1).color : null;

      // 5. Logo — Filtro estrito: busca no header/nav, ignorando o footer
      const logoImg = document.querySelector('header nav a img, header .logo img, header a[href="/"] img, nav .logo img, nav a[href="/"] img, header img:not(footer img), nav img:not(footer img), a[class*="brand"] img, [class*="logo"] img');
      const logoSrc = logoImg ? logoImg.src : null;

      let waNumber = null;
      const scripts = document.querySelectorAll('script:not([src])');
      for (const s of scripts) {
        const m = s.textContent.match(/(?:NUMERO_WHATSAPP|numero[_]?whatsapp|whatsapp|telefone)['"]*\s*[:=]\s*['"](\d{10,15})['"]/i);
        if (m) { waNumber = m[1]; break; }
      }
      if (!waNumber) {
        for (const s of scripts) {
          const m = s.textContent.match(/['"](5\d{2}9?\d{8})['"]/);
          if (m) { waNumber = m[1]; break; }
        }
      }
      return { fonte: bodyFont, cssVars, headerBg, heroBg, heroHeadingColor, primaryBtnBg, ctaBtnBg, headingColor, logoSrc, waNumber };
    });
  } catch (errPup) {
    console.warn('[ANALYZER] Puppeteer indisponível ou falhou, usando analisador direto HTTP+Cheerio:', errPup.message);
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      html = await resp.text();
    } catch(errFetch) {
      throw new Error(`Não foi possível acessar o site: ${errFetch.message}`);
    }
  } finally {
    if (browser) {
      try { await browser.close(); } catch(e) {}
    }
  }

  const $ = cheerio.load(html);
  const origin = new URL(url).origin;

  // Coleta todo o CSS (inline <style> e folhas externas <link rel="stylesheet">)
  let allCss = '';
  $('style').each((_, el) => { allCss += '\n' + $(el).text(); });

  const cssUrls = [];
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !href.includes('font-awesome') && !href.includes('fonts.googleapis.com')) {
      cssUrls.push(href.startsWith('http') ? href : new URL(href, url).href);
    }
  });

  for (const cUrl of cssUrls) {
    try {
      const cRes = await fetch(cUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
      allCss += '\n' + (await cRes.text());
    } catch(e) {}
  }

  // Extrai variáveis CSS globais
  const extractedCssVars = { ...(designSystem.cssVars || {}) };
  const varMatches = allCss.matchAll(/--([a-zA-Z0-9_-]+)\s*:\s*([^;}\n]+)/g);
  for (const m of varMatches) {
    extractedCssVars[`--${m[1]}`] = m[2].trim();
  }
  designSystem.cssVars = extractedCssVars;

  // Extrai regras de Header, Hero e Botões do CSS consolidado
  if (!designSystem.headerBg) {
    const headerRule = allCss.match(/(?:\.main-header|\.header|header|\.navbar|\.nav-bar)[^{]*\{([^}]+)\}/i);
    if (headerRule) {
      const bgMatch = headerRule[1].match(/background(?:-color)?\s*:\s*([^;!}\n]+)/i);
      if (bgMatch) designSystem.headerBg = bgMatch[1].trim();
    }
  }

  if (!designSystem.heroBg) {
    const heroRule = allCss.match(/(?:\.hero-section|\.hero|\.banner)[^{]*\{([^}]+)\}/i);
    if (heroRule) {
      const bgMatch = heroRule[1].match(/background(?:-color)?\s*:\s*([^;!}\n]+)/i);
      if (bgMatch) designSystem.heroBg = bgMatch[1].trim();
    }
  }

  if (!designSystem.ctaBtnBg) {
    const ctaRule = allCss.match(/(?:\.btn-primary|\.header-cta|\.btn-primary-cta|\.btn-secondary|\.cta|\.btn)[^{]*\{([^}]+)\}/i);
    if (ctaRule) {
      const bgMatch = ctaRule[1].match(/background(?:-color)?\s*:\s*([^;!}\n]+)/i);
      if (bgMatch) designSystem.ctaBtnBg = bgMatch[1].trim();
    }
  }

  function resolveCssColor(val) {
    if (!val) return null;
    if (typeof val === 'string' && val.startsWith('var(')) {
      const varName = val.match(/var\(\s*(--[a-zA-Z0-9_-]+)/)?.[1];
      if (varName && designSystem.cssVars[varName]) return resolveCssColor(designSystem.cssVars[varName]);
    }
    return rgbToHex(val) || val;
  }

  designSystem.headerBg = resolveCssColor(designSystem.headerBg);
  designSystem.heroBg = resolveCssColor(designSystem.heroBg);
  designSystem.primaryBtnBg = resolveCssColor(designSystem.primaryBtnBg);
  designSystem.ctaBtnBg = resolveCssColor(designSystem.ctaBtnBg);

        let logo = designSystem.logoSrc;
    if (!logo) {
      $('header img, nav img, .navbar img, .header img').each((_, el) => {
        if (!$(el).closest('footer, #footer, .footer').length && !logo) {
          const src = $(el).attr('src');
          if (src) logo = src;
        }
      });
    }
    if (!logo) {
      logo = $('meta[property="og:image"]').attr('content') || $('link[rel="icon"]').attr('href');
    }
    if (logo && !logo.startsWith('http') && !logo.startsWith('data:')) {
      logo = new URL(logo, origin).href;
    }

    let whatsapp = null;
    const waLink = $('a[href*="wa.me"], a[href*="api.whatsapp.com"], a[href*="web.whatsapp.com"], a[href^="whatsapp://"]').attr('href');
    if (waLink) {
      const m = waLink.match(/(\d{10,15})/);
      if (m) whatsapp = m[1];
    }

    if (!whatsapp) {
      $('a[href^="tel:"]').each((i, el) => {
        const href = $(el).attr('href');
        const digits = href.replace(/\D/g, '');
        if (digits.length >= 8 && digits.length <= 15) {
          whatsapp = digits;
          return false;
        }
      });
    }

    if (!whatsapp && designSystem.waNumber) {
      whatsapp = designSystem.waNumber;
    }

    if (!whatsapp) {
      const bodyClone = $('body').clone();
      bodyClone.find('script, style, noscript, svg, iframe').remove();
      const cleanText = bodyClone.text();
      const match = cleanText.match(/(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?9\d{4}[-\s]?\d{4}/g);
      if (match) {
        whatsapp = match[0].replace(/\D/g, '');
      }
    }

    const whatsappFormatado = whatsapp ? formatarTelefone(whatsapp) : 'Não encontrado';

    // Scrape Email — prioriza footer e mailto:
    let email = null;
    $('footer a[href^="mailto:"], [class*="footer"] a[href^="mailto:"], [id*="footer"] a[href^="mailto:"]').each((_, el) => {
      if (!email) {
        const h = $(el).attr('href');
        if (h) email = h.replace(/^mailto:/i, '').split('?')[0].trim();
      }
    });
    if (!email) {
      $('a[href^="mailto:"]').each((_, el) => {
        if (!email) {
          const h = $(el).attr('href');
          if (h) email = h.replace(/^mailto:/i, '').split('?')[0].trim();
        }
      });
    }
    if (!email) {
      const footerTextForEmail = ($('footer').text() || $('[class*="footer"]').text() || '');
      const mEmail = footerTextForEmail.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (mEmail && !/\.(png|jpg|jpeg|webp|svg|gif|css|js)$/i.test(mEmail[0])) {
        email = mEmail[0];
      }
    }
    if (!email) {
      const bodyText = $('body').text();
      const mEmail = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (mEmail && !/\.(png|jpg|jpeg|webp|svg|gif|css|js)$/i.test(mEmail[0])) {
        email = mEmail[0];
      }
    }

    // Scrape Social Links — busca em toda a página priorizando footer
    const social = {};
    const detectSocial = (href) => {
      if (!href || href === '#' || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
      const absHref = href.startsWith('http') ? href : (href.startsWith('/') ? new URL(href, origin).href : null);
      if (!absHref) return;
      if (/instagram\.com/i.test(absHref) && !social.instagram) social.instagram = absHref;
      else if (/(?:facebook\.com|fb\.com)/i.test(absHref) && !social.facebook) social.facebook = absHref;
      else if (/(?:wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|whatsapp:\/\/)/i.test(absHref) && !social.whatsapp) social.whatsapp = absHref;
      else if (/(?:twitter\.com|x\.com)/i.test(absHref) && !social.twitter) social.twitter = absHref;
      else if (/(?:youtube\.com|youtu\.be)/i.test(absHref) && !social.youtube) social.youtube = absHref;
      else if (/linkedin\.com/i.test(absHref) && !social.linkedin) social.linkedin = absHref;
      else if (/tiktok\.com/i.test(absHref) && !social.tiktok) social.tiktok = absHref;
      else if (/pinterest\.com/i.test(absHref) && !social.pinterest) social.pinterest = absHref;
      else if (/(?:g\.page|maps\.google|google\.com\/maps|business\.google)/i.test(absHref) && !social.google) social.google = absHref;
      else if (/(?:t\.me|telegram\.me)/i.test(absHref) && !social.telegram) social.telegram = absHref;
    };

    $('footer a[href], [class*="footer"] a[href], [id*="footer"] a[href]').each((_, el) => {
      detectSocial($(el).attr('href'));
    });
    $('a[href]').each((_, el) => {
      detectSocial($(el).attr('href'));
    });

    if (!social.whatsapp && whatsapp) {
      social.whatsapp = `https://wa.me/55${whatsapp}`;
    }

    let footerHtml = null; // Desativa injeção de scripts/html poluído de sites externos
    const footerText = $('footer').text() || $('[class*="footer"]').text() || null;

    const titulo = $('title').text();
    const descricao = $('meta[name="description"]').attr('content') || '';
    const nicho = identificarNicho(titulo, descricao);

    let localizacao = null;
    const addrMeta = $('meta[name="geo.placename"], meta[property="business:contact_data:locality"]').attr('content');
    if (addrMeta) localizacao = addrMeta.trim();

    // Busca detalhada por cidades e áreas de cobertura na página inteira
    const bodyAllText = $('body').text() || '';
    const coberturaMatch = bodyAllText.match(/(?:Área de Cobertura|Atendemos|Regiões de Atendimento|Cidades Atendidas|Locais Atendidos|Atendimento em)[:\s]*([^\n.]{10,200})/i);
    if (coberturaMatch) {
      const parsedLoc = coberturaMatch[1].replace(/\s+/g, ' ').replace(/[•|✓\-]/g, ',').trim();
      if (parsedLoc.length > 5) localizacao = parsedLoc;
    }

    if (!localizacao) {
      const footerCob = (footerText || '') + ' ' + ($('.bairros-section, [class*="bairro"], [class*="cobertura"], [class*="cidade"]').text() || '');
      const mCob = footerCob.match(/(?:Área de Cobertura|Atendemos|Cobertura|Área)[:\s]*([^\n.<]{5,100})/i);
      if (mCob) localizacao = mCob[1].replace(/\s+/g, ' ').trim();
    }

    if (!localizacao) {
      const mDesc = descricao.match(/\bem\s+([A-ZÁÉÍÓÚ][^.]{2,80})/);
      if (mDesc) localizacao = mDesc[1].replace(/\s+/g, ' ').trim();
    }

    if (!localizacao && footerText) {
      const m = footerText.match(/(Rua|Av\.|Avenida|CEP|Estado|Município|São Paulo|Diadema|ABC)[\s\S]{10,120}/i);
      if (m) localizacao = m[0].replace(/\n/g, ' ').trim();
    }

    function sanitizeColor(col, fallback) {
      if (!col || col === 'transparent' || col === 'rgba(0, 0, 0, 0)') return fallback;
      const hex = rgbToHex(col);
      return (hex && hex.startsWith('#')) ? hex : fallback;
    }

    function isColorLight(hexStr) {
      if (!hexStr || !hexStr.startsWith('#')) return false;
      let hex = hexStr.slice(1);
      if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
      const r = parseInt(hex.slice(0, 2), 16) || 0;
      const g = parseInt(hex.slice(2, 4), 16) || 0;
      const b = parseInt(hex.slice(4, 6), 16) || 0;
      return (r * 299 + g * 587 + b * 114) / 1000 > 155;
    }

    let headerBgHex   = sanitizeColor(designSystem.headerBg, '#0b2238');
    let heroBgHex     = sanitizeColor(designSystem.heroBg, null);
    let primaryBtnHex = sanitizeColor(designSystem.primaryBtnBg, null);
    let ctaBtnHex     = sanitizeColor(designSystem.ctaBtnBg, null);

    // Safeguard: Se a cor primária for amarela/clara, ela NUNCA deve ser fundo do header
    const isHexYellow = c => /^#(f{2}c{2}00|ffc700|ffd700|ffff00|ffe53b|ffc745|f59e0b|eab308)/i.test(c || '');
    let finalFoco = '#ffc700';
    if (primaryBtnHex && isHexYellow(primaryBtnHex)) finalFoco = primaryBtnHex;
    else if (ctaBtnHex && isHexYellow(ctaBtnHex)) finalFoco = ctaBtnHex;

    if (headerBgHex && (isHexYellow(headerBgHex) || isColorLight(headerBgHex))) {
      finalFoco = headerBgHex;
      headerBgHex = '#0b2238'; // Dark Navy elegante
    }

    const vars = designSystem.cssVars || {};

    // ── LÓGICA DE CORES UNIVERSAL E INTELIGENTE ─────────────────────────
    // 1. corFundo: Sempre Branco (#ffffff) para leitura de blog
    let corFundo = '#ffffff';

    // ── LÓGICA DE CORES VINDA DO SITE MÃE ──────────────────────────────
    // Busca a cor de destaque do site original nas variáveis CSS (:root), priorizando
    // as mais comuns do template. Nunca fixa cor: tudo vem do site mãe.
    const lookupVars = (prefixes) => {
      for (const p of prefixes) {
        for (const k of Object.keys(vars)) {
          if (k.toLowerCase() === p.toLowerCase()) {
            const v = vars[k];
            const resolvida = typeof v === 'string' ? resolveCssColor(v) : v;
            if (resolvida && resolvida !== 'transparent' && /^#/.test(resolvida)) return resolvida;
          }
        }
      }
      return null;
    };

    const isHexEscura = (c) => { try { return !isColorLight(c); } catch(e){ return false; } };
    const isHexCinza = (c) => {
      if (!c || !c.startsWith('#')) return false;
      let h = c.slice(1); if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
      const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
      return Math.abs(r-g) < 25 && Math.abs(g-b) < 25 && Math.abs(r-b) < 25;
    };

    // 2. corPrimaria: Tom corporativo vindo do site mãe (header ou hero ou var primária)
    const varPrimarias = lookupVars(['--primary-color','--primary','--brand-color','--brand-primary','--secondary-blue','--secondary-color','--main-color','--color-primary','--azul-primario']);
    let corPrimaria = varPrimarias || headerBgHex || heroBgHex || '#1e3a58';
    if (isColorLight(corPrimaria) || corPrimaria === '#ffffff' || corPrimaria === 'transparent') {
      corPrimaria = primaryBtnHex || ctaBtnHex || '#1e3a58';
    }

    // 3. corFoco: Destaque do site mãe (accent/laranja/secundária/CTA), rejeitando preto/cinza
    const varFoco = lookupVars(['--accent-orange','--accent-color','--accent','--secondary-color','--secondary','--action-color','--cta-color','--highlight','--highlight-color','--destaque','--cor-secundaria','--cor-destaque','--orange-color','--laranja']);
    const corFocoAceitavel = (c) => c && /^#/.test(c) && !isHexCinza(c) && isHexEscura(c) && c !== '#ffffff' && c !== '#000000';
    let corFoco = corFocoAceitavel(varFoco) ? varFoco : null;
    if (!corFoco && corFocoAceitavel(ctaBtnHex)) corFoco = ctaBtnHex;
    if (!corFoco && corFocoAceitavel(primaryBtnHex)) corFoco = primaryBtnHex;
    if (!corFoco && varFoco) corFoco = varFoco; // queda: usa a var mesmo assim
    if (!corFoco && ctaBtnHex) corFoco = ctaBtnHex;
    if (!corFoco) corFoco = '#FF7B00'; // laranja neutro, NUNCA preto
    if (corFoco === corPrimaria) {
      if (varFoco && varFoco !== corPrimaria) corFoco = varFoco;
      else corFoco = isHexCinza(ctaBtnHex) || ctaBtnHex === corPrimaria ? '#FF7B00' : (ctaBtnHex || '#FF7B00');
    }

    // 4. corTitulo: Texto de Título em Fundo Claro (Azul Marinho / Slate legível #0b2238)
    let corTitulo = !isColorLight(corPrimaria) ? corPrimaria : '#0b2238';

    return {
      url, nicho,
      contato: {
        email: email || 'Não encontrado',
        whatsapp: whatsappFormatado,
        whatsappRaw: whatsapp || 'Não encontrado',
        localizacao: localizacao || 'Não encontrada',
        redesSociais: social
      },
      design: {
        logo: logo || 'Não encontrado',
        fonte: designSystem.fonte ? designSystem.fonte.split(',')[0].replace(/['"]/g, '').trim() : 'Inter',
        cssVars: designSystem.cssVars || {},
        cores: {
          headerBg: headerBgHex,
          heroBg: heroBgHex,
          primaryColor: primaryBtnHex || corPrimaria,
          headingColor: corTitulo,
          corPrimaria: corPrimaria,
          corFundo: corFundo,
          corTitulo: corTitulo,
          corFoco: corFoco
        }
      },
      seo: { titulo, descricao },
      estrutura: { footerHtml: footerHtml ? footerHtml.trim() : 'Não encontrado' }
    };
}

app.get('/api/analyze', requireAuth, async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

  try {
    const data = await analisarSite(url);

    // auto-save to client if client_id provided
    const clientId = req.query.client_id;
    if (clientId) {
      const socialStr = JSON.stringify(data.contato.redesSociais || {});
      db.run(
        `UPDATE clients SET
          nicho=?, whatsapp=?, localizacao=?, logo=?, fonte=?,
          cor_primaria=?, cor_fundo=?, cor_titulo=?, cor_foco=?,
          redes_sociais=?,
          seo_titulo=?, seo_descricao=?, footer_html=?,
          email = COALESCE(email, ?),
          updated_at=CURRENT_TIMESTAMP
         WHERE id=?`,
        [data.nicho, data.contato.whatsapp, data.contato.localizacao,
         data.design.logo, data.design.fonte,
         data.design.cores.corPrimaria, data.design.cores.corFundo, data.design.cores.corTitulo, data.design.cores.corFoco,
         socialStr,
         data.seo.titulo, data.seo.descricao, data.estrutura.footerHtml,
         data.contato.email !== 'Não encontrado' ? data.contato.email : null,
         clientId]
      );
    }

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: 'Falha ao analisar o site', details: error.message });
  }
});

// ── Serve pages ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  // Landing page pública; usuário logado vai direto ao painel
  if (req.session.userId) return res.redirect('/dashboard.html');
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/dashboard.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});


// ══════════════════════════════════════════════════════════════════════════════
// ── SEO INDEXING ENGINE: ROBOTS.TXT, SITEMAP.XML & RSS FEED ───────────────────
// ══════════════════════════════════════════════════════════════════════════════

// 1. Dynamic Robots.txt (Clean, Standard & High Authority)
app.get(['/blog/:slug/robots.txt', '/robots.txt'], (req, res) => {
  const slug = req.params.slug;
  const clientQuery = slug ? 'SELECT * FROM clients WHERE slug = ?' : 'SELECT * FROM clients ORDER BY id DESC LIMIT 1';
  const clientParam = slug ? [slug] : [];

  db.get(clientQuery, clientParam, (err, client) => {
    const blogUrl = getPublicBlogUrl(req, client);
    const sitemapUrl = `${blogUrl}/sitemap.xml`;

    const robotsTxt = [
      'User-agent: *',
      'Allow: /',
      'Allow: /blog/',
      'Allow: /uploads/',
      'Disallow: /api/',
      'Disallow: /login',
      'Disallow: /dashboard',
      '',
      `Sitemap: ${sitemapUrl}`
    ].join('\n');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(robotsTxt);
  });
});

// 2. Dynamic Sitemap.xml com URLs Limpas (Sem #) e Domínio Oficial
app.get(['/blog/:slug/sitemap.xml', '/sitemap.xml'], (req, res) => {
  const slug = req.params.slug;
  const clientQuery = slug ? 'SELECT * FROM clients WHERE slug = ?' : 'SELECT * FROM clients ORDER BY id DESC LIMIT 1';
  const clientParam = slug ? [slug] : [];

  db.get(clientQuery, clientParam, (err, client) => {
    if (err || !client) {
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      return res.status(404).send('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
    }

    db.all(
      `SELECT * FROM blogs WHERE client_id = ? AND status = 'publicado' ORDER BY published_at DESC, created_at DESC`,
      [client.id],
      (errPosts, posts) => {
        const blogUrl = getPublicBlogUrl(req, client);
        const originHost = `${req.protocol}://${req.get('host')}`;
        const lastModDate = (posts && posts.length > 0 && posts[0].published_at)
          ? new Date(posts[0].published_at).toISOString().split('T')[0]
          : new Date().toISOString().split('T')[0];

        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n';
        xml += '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n';

        // Home do Blog do Cliente
        xml += '  <url>\n';
        xml += `    <loc>${blogUrl}</loc>\n`;
        xml += `    <lastmod>${lastModDate}</lastmod>\n`;
        xml += '    <changefreq>daily</changefreq>\n';
        xml += '    <priority>1.0</priority>\n';
        if (client.logo && !client.logo.includes('placehold')) {
          const logoUrl = client.logo.startsWith('http') ? client.logo : originHost + client.logo;
          xml += '    <image:image>\n';
          xml += `      <image:loc>${logoUrl}</image:loc>\n`;
          xml += `      <image:title>${(client.name || 'Blog').replace(/[<>&"]/g, '')}</image:title>\n`;
          xml += '    </image:image>\n';
        }
        xml += '  </url>\n';

        // Cada post publicado com URL limpa sem hash (#)
        (posts || []).forEach(p => {
          const postDate = p.published_at ? new Date(p.published_at).toISOString().split('T')[0] : lastModDate;
          const postLoc = `${blogUrl}/${p.slug}`;
          const cleanTitle = (p.title || '').replace(/[<>&"]/g, '');
          const imgUrl = (p.imagem_url && p.imagem_url.startsWith('/uploads/'))
            ? `${originHost}${p.imagem_url}`
            : (p.imagem_url || '');

          xml += '  <url>\n';
          xml += `    <loc>${postLoc}</loc>\n`;
          xml += `    <lastmod>${postDate}</lastmod>\n`;
          xml += '    <changefreq>weekly</changefreq>\n';
          xml += '    <priority>0.8</priority>\n';
          if (imgUrl) {
            xml += '    <image:image>\n';
            xml += `      <image:loc>${imgUrl}</image:loc>\n`;
            xml += `      <image:title>${cleanTitle}</image:title>\n`;
            xml += `      <image:caption>${cleanTitle}</image:caption>\n`;
            xml += '    </image:image>\n';
          }
          xml += '  </url>\n';
        });

        xml += '</urlset>';
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=1800');
        res.send(xml);
      }
    );
  });
});

// 3. Dynamic RSS Feed (Consumido por bots do Google Notícias e agregadores para indexação instantânea)
app.get(['/blog/:slug/rss.xml', '/blog/:slug/feed.xml', '/rss.xml', '/feed.xml'], (req, res) => {
  const originHost = `${req.protocol}://${req.get('host')}`;
  const slug = req.params.slug;

  const clientQuery = slug ? 'SELECT * FROM clients WHERE slug = ?' : 'SELECT * FROM clients ORDER BY id DESC LIMIT 1';
  const clientParam = slug ? [slug] : [];

  db.get(clientQuery, clientParam, (err, client) => {
    if (err || !client) {
      res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
      return res.status(404).send('<rss version="2.0"></rss>');
    }

    db.all(
      `SELECT * FROM blogs WHERE client_id = ? AND status = 'publicado' ORDER BY published_at DESC, created_at DESC`,
      [client.id],
      (errPosts, posts) => {
        const blogUrl = `${originHost}/blog/${client.slug}`;
        let rss = '<?xml version="1.0" encoding="UTF-8" ?>\n';
        rss += '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n';
        rss += '  <channel>\n';
        rss += `    <title>${(client.name || 'Blog').replace(/[<>&"]/g, '')} | Blog Oficial</title>\n`;
        rss += `    <link>${blogUrl}</link>\n`;
        rss += `    <description>${(client.seo_descricao || 'Notícias e artigos técnicos especializados').replace(/[<>&"]/g, '')}</description>\n`;
        rss += '    <language>pt-BR</language>\n';
        rss += `    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>\n`;
        rss += `    <atom:link href="${blogUrl}/rss.xml" rel="self" type="application/rss+xml" />\n`;

        (posts || []).forEach(p => {
          const postDate = p.published_at ? new Date(p.published_at).toUTCString() : new Date().toUTCString();
          const postLink = `${blogUrl}#post-${p.slug}`;
          const cleanTitle = (p.title || '').replace(/[<>&"]/g, '');
          const excerpt = (p.content || '').replace(/<[^>]*>/g, '').substring(0, 200).replace(/[<>&"]/g, '') + '...';
          const imgUrl = (p.imagem_url && p.imagem_url.startsWith('/uploads/'))
            ? `${originHost}${p.imagem_url}`
            : (p.imagem_url || '');

          rss += '    <item>\n';
          rss += `      <title>${cleanTitle}</title>\n`;
          rss += `      <link>${postLink}</link>\n`;
          rss += `      <guid isPermaLink="true">${postLink}</guid>\n`;
          rss += `      <pubDate>${postDate}</pubDate>\n`;
          rss += `      <description>${excerpt}</description>\n`;
          if (imgUrl) {
            rss += `      <enclosure url="${imgUrl}" type="image/jpeg" />\n`;
          }
          rss += '    </item>\n';
        });

        rss += '  </channel>\n';
        rss += '</rss>';
        res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=1800');
        res.send(rss);
      }
    );
  });
});

app.get(['/blog/:slug/:postSlug', '/blog/:slug'], (req, res) => {
  const { slug, postSlug } = req.params;

  db.get('SELECT * FROM clients WHERE slug = ?', [slug], (err, client) => {
    if (err || !client) {
      return res.status(404).send('<h1>Blog não encontrado</h1>');
    }
    db.all(
      `SELECT * FROM blogs
       WHERE client_id = ? AND status = 'publicado'
       ORDER BY published_at DESC, created_at DESC`,
      [client.id],
      (err, posts) => {
        if (err) return res.status(500).send('Erro interno');
        db.all('SELECT * FROM client_ads WHERE client_id = ?', [client.id], (errAds, adRows) => {
        if (errAds) return res.status(500).send('Erro interno');
        const ads = {};
        (adRows || []).forEach(a => { ads[a.posicao] = a; });

        db.all('SELECT termo, variacao FROM keywords WHERE client_id = ?', [client.id], (errKw, kwRows) => {
        const keywordsList = Array.from(new Set([
          ...(kwRows || []).map(k => k.termo),
          ...(kwRows || []).map(k => k.variacao).filter(Boolean),
          client.nicho,
          client.localizacao,
          'atendimento 24 horas',
          'orçamento sem compromisso',
          'plantão emergencial'
        ].filter(Boolean))).join(', ');
        
        console.log(`[DEBUG /blog/:slug] Client: "${client.name}" (ID: ${client.id}) | Posts: ${posts ? posts.length : 0} | Keywords indexadas: ${(kwRows || []).length}`);

        const templatePath = path.join(__dirname, 'blog-base.html');
        fs.readFile(templatePath, 'utf8', (err, html) => {
          if (err) return res.status(500).send('Template base não encontrado');

          let rendered = html;

          // Helper to check if a color is light (high brightness)
          function isLightColor(colorStr) {
            if (!colorStr) return false;
            let r = 0, g = 0, b = 0;
            if (colorStr.startsWith('#')) {
              let hex = colorStr.slice(1);
              if (hex.length === 3) {
                hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
              }
              r = parseInt(hex.slice(0, 2), 16);
              g = parseInt(hex.slice(2, 4), 16);
              b = parseInt(hex.slice(4, 6), 16);
            } else {
              const m = colorStr.match(/\d+/g);
              if (m && m.length >= 3) {
                r = parseInt(m[0]);
                g = parseInt(m[1]);
                b = parseInt(m[2]);
              } else {
                return false;
              }
            }
            const brightness = (r * 299 + g * 587 + b * 114) / 1000;
            return brightness > 155;
          }

          const isYellow = c => /^#(f{2}c{2}00|ffc700|ffd700|ffff00)/i.test(c || '') || /255,\s*204,\s*0/.test(c || '');
          const isRed = c => /^#(e63946|ef4444|e11d48|dc2626)/i.test(c || '');

          const corFundo = client.cor_fundo || '#ffffff';
          const corPrimaria = client.cor_primaria || '#0b2238';
          const corFoco = client.cor_foco || '#ffcc00';
          const norm = c => (c || '').toLowerCase().trim();

          const isFundoLight = isLightColor(corFundo);
          const isPrimariaLight = isLightColor(corPrimaria);

          // Headings on light background MUST be dark and legible — never yellow (#ffcc00) or white (#ffffff)
          let corTitulo = client.cor_titulo;
          if (!corTitulo || isLightColor(corTitulo) || isYellow(corTitulo) || norm(corTitulo) === norm(corFundo)) {
            if (corPrimaria && !isLightColor(corPrimaria) && norm(corPrimaria) !== norm(corFundo)) {
              corTitulo = corPrimaria;
            } else {
              corTitulo = '#0b2238';
            }
          }
          let corLinks = (corPrimaria && !isLightColor(corPrimaria)) ? corPrimaria : '#0b457f';

          // ── PLACEHOLDERS E TEMPLATE BASE ───────────────────────────────
          // Quando o cliente não define cor de header, usa a cor primária (ex: azul marinho
          // do site oficial) em vez de branco. Isso mantém a navbar escura e faz o texto
          // claro da logo aparecer.
          const corHeaderBg = client.cor_header_bg || corPrimaria || '#ffffff';
          const isHeaderLight = isLightColor(corHeaderBg);
          const corHeaderTexto = isHeaderLight ? '#1e293b' : '#ffffff';
          // Hover e borda usam a cor de foco real vinda do site mãe. Como o analisador
          // agora rejeita preto/cinza no foco, a cor legível fica garantida sem hardcode.
          const corHeaderHover = isHeaderLight ? (isLightColor(corPrimaria) ? '#08499a' : corPrimaria) : (corFoco || '#FF7B00');
          const corHeaderBorda = isHeaderLight ? (corFoco || '#e2e8f0') : (corFoco || '#FF7B00');

          rendered = rendered.replace(/--cor-primaria:\s*[^;]+;/g, `--cor-primaria: ${corPrimaria};`);
          rendered = rendered.replace(/--cor-header-bg:\s*[^;]+;/g, `--cor-header-bg: ${corHeaderBg};`);
          rendered = rendered.replace(/--cor-header-texto:\s*[^;]+;/g, `--cor-header-texto: ${corHeaderTexto};`);
          rendered = rendered.replace(/--cor-header-hover:\s*[^;]+;/g, `--cor-header-hover: ${corHeaderHover};`);
          rendered = rendered.replace(/--cor-header-borda:\s*[^;]+;/g, `--cor-header-borda: ${corHeaderBorda};`);
          rendered = rendered.replace(/--cor-fundo-destaque:\s*[^;]+;/g, `--cor-fundo-destaque: ${corFundo};`);
          rendered = rendered.replace(/--cor-texto-destaque:\s*[^;]+;/g, `--cor-texto-destaque: ${corTitulo};`);
          rendered = rendered.replace(/--cor-foco:\s*[^;]+;/g, `--cor-foco: ${corFoco};`);
          rendered = rendered.replace(/--cor-links:\s*[^;]+;/g, `--cor-links: ${corLinks};`);
          
          const fonteNome = client.fonte ? client.fonte.split(',')[0].replace(/['"]/g, '').trim() : 'Inter';
          const googleFontsTag = `
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(fonteNome)}:wght@400;500;600;700;800&display=swap" rel="stylesheet">
          `.trim();
          rendered = rendered.replace(/\{\{GOOGLE_FONTS_TAG\}\}/g, googleFontsTag);

          rendered = rendered.replace(/--fonte-padrao:\s*[^;]+;/g, `--fonte-padrao: '${fonteNome}', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;`);
          rendered = rendered.replace(/--fonte-titulos:\s*[^;]+;/g, `--fonte-titulos: '${fonteNome}', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;`);

          // 2. Placeholders — SEMPRE substituídos (fallback genérico se campo vazio)
          const nome = client.name || 'Blog Corporativo';
          const telefone = client.whatsapp || client.phone || '(00) 00000-0000';
          const local = client.localizacao || 'Localização não informada';
          const logo = (client.logo && client.logo !== 'Não encontrado') ? client.logo : 'https://images.unsplash.com/photo-1585704032915-c3400ca199e7?q=80&w=1200&auto=format&fit=crop' + encodeURIComponent(nome);
          const desc = client.seo_descricao || `Notícias e atualizações da empresa ${nome}.`;
          const titulo = client.seo_titulo || `${nome} | Blog Oficial`;
          const email = client.email || '';
          const ano = new Date().getFullYear();

          // Footer colunas — por nicho
          const footerCol2Titulo = 'Serviços Especializados';
          const isHidraulica = /vazamento|desentupid|hidr[aá]ul/i.test(client.nicho || '') || /desentupid|vazamento|esgot/i.test(client.name || '');
          const footerCol2Items = isHidraulica
            ? [
                '<li><a href="#home"><i class="fa-solid fa-droplet" style="color:var(--cor-foco)"></i> Caça Vazamento Não Destrutivo</a></li>',
                '<li><a href="#home"><i class="fa-solid fa-faucet-drip" style="color:var(--cor-foco)"></i> Desentupimento de Esgoto e Pias</a></li>',
                '<li><a href="#home"><i class="fa-solid fa-toilet" style="color:var(--cor-foco)"></i> Desobstrução de Ralos e Vasos</a></li>',
                '<li><a href="#home"><i class="fa-solid fa-water" style="color:var(--cor-foco)"></i> Hidrojateamento de Alta Pressão</a></li>',
                '<li><a href="#home"><i class="fa-solid fa-file-shield" style="color:var(--cor-foco)"></i> Laudo Técnico / Relatório Sabesp</a></li>'
              ].join('')
            : [
                '<li><a href="#home"><i class="fa-solid fa-circle-check" style="color:var(--cor-foco)"></i> Atendimento Técnico Especializado</a></li>',
                '<li><a href="#home"><i class="fa-solid fa-circle-check" style="color:var(--cor-foco)"></i> Diagnóstico e Orçamento</a></li>',
                '<li><a href="#home"><i class="fa-solid fa-circle-check" style="color:var(--cor-foco)"></i> Suporte e Garantia</a></li>'
              ].join('');

          const footerCol3Titulo = 'Atendimento & Contato';
          const footerCol3Items = [
            `<li><i class="fa-solid fa-location-dot" style="color:var(--cor-foco);margin-top:3px"></i><span><strong>Área de Cobertura:</strong> ${local}</span></li>`,
            `<li><i class="fa-solid fa-phone" style="color:var(--cor-foco)"></i><span><strong>Telefone / Plantão:</strong> <a href="tel:${telefone.replace(/\D/g,'')}">${telefone}</a></span></li>`,
            `<li><i class="fa-solid fa-clock" style="color:var(--cor-foco)"></i><span><strong>Disponibilidade:</strong> Plantão 24 Horas / 7 Dias</span></li>`,
            email ? `<li><i class="fa-solid fa-envelope" style="color:var(--cor-foco)"></i><span><strong>E-mail:</strong> <a href="mailto:${email}">${email}</a></span></li>` : ''
          ].filter(Boolean).join('\n');

          rendered = rendered.replace(/\{\{SEO_TITULO\}\}/g, titulo);
          rendered = rendered.replace(/\{\{NOME_EMPRESA\}\}/g, nome);
          rendered = rendered.replace(/\{\{TELEFONE\}\}/g, telefone);
          rendered = rendered.replace(/\{\{LOCALIZACAO\}\}/g, local);
          rendered = rendered.replace(/\{\{NICHO\}\}/g, client.nicho || 'Serviços Especializados');
          rendered = rendered.replace(/\{\{LOGO_URL\}\}/g, logo);
          rendered = rendered.replace(/\{\{DESCRICAO_EMPRESA\}\}/g, desc);
          rendered = rendered.replace(/\{\{FOOTER_COL2_TITULO\}\}/g, footerCol2Titulo);
          rendered = rendered.replace(/\{\{FOOTER_COL2_ITEMS\}\}/g, footerCol2Items);
          rendered = rendered.replace(/\{\{FOOTER_COL3_TITULO\}\}/g, footerCol3Titulo);
          rendered = rendered.replace(/\{\{FOOTER_COL3_ITEMS\}\}/g, footerCol3Items);
          rendered = rendered.replace(/\{\{ANO\}\}/g, String(ano));

          // Build dynamic topbar social links
          let socialObj = {};
          try {
            if (client.redes_sociais) {
              socialObj = JSON.parse(client.redes_sociais);
            }
          } catch(e) {}

          let topbarSocialHtml = '';
          if (socialObj.instagram) {
            topbarSocialHtml += `<a href="${socialObj.instagram}" target="_blank" rel="noopener" title="Instagram"><i class="fa-brands fa-instagram"></i></a>`;
          }
          if (socialObj.facebook) {
            topbarSocialHtml += `<a href="${socialObj.facebook}" target="_blank" rel="noopener" title="Facebook"><i class="fa-brands fa-facebook"></i></a>`;
          }
          if (socialObj.whatsapp) {
            topbarSocialHtml += `<a href="${socialObj.whatsapp}" target="_blank" rel="noopener" title="WhatsApp"><i class="fa-brands fa-whatsapp"></i></a>`;
          }
          if (socialObj.google) {
            topbarSocialHtml += `<a href="${socialObj.google}" target="_blank" rel="noopener" title="Google Meu Negócio"><i class="fa-brands fa-google"></i></a>`;
          }
          if (socialObj.twitter) {
            topbarSocialHtml += `<a href="${socialObj.twitter}" target="_blank" rel="noopener" title="X / Twitter"><i class="fa-brands fa-x-twitter"></i></a>`;
          }
          if (socialObj.youtube) {
            topbarSocialHtml += `<a href="${socialObj.youtube}" target="_blank" rel="noopener" title="YouTube"><i class="fa-brands fa-youtube"></i></a>`;
          }
          if (socialObj.linkedin) {
            topbarSocialHtml += `<a href="${socialObj.linkedin}" target="_blank" rel="noopener" title="LinkedIn"><i class="fa-brands fa-linkedin"></i></a>`;
          }
          if (socialObj.tiktok) {
            topbarSocialHtml += `<a href="${socialObj.tiktok}" target="_blank" rel="noopener" title="TikTok"><i class="fa-brands fa-tiktok"></i></a>`;
          }
          if (socialObj.pinterest) {
            topbarSocialHtml += `<a href="${socialObj.pinterest}" target="_blank" rel="noopener" title="Pinterest"><i class="fa-brands fa-pinterest"></i></a>`;
          }
          if (socialObj.telegram) {
            topbarSocialHtml += `<a href="${socialObj.telegram}" target="_blank" rel="noopener" title="Telegram"><i class="fa-brands fa-telegram"></i></a>`;
          }

          rendered = rendered.replace(/\{\{TOPBAR_SOCIAL_HTML\}\}/g, topbarSocialHtml);

          let footerSocialHtml = '';
          if (socialObj.instagram) footerSocialHtml += `<a href="${socialObj.instagram}" target="_blank" rel="noopener" class="social-pill" title="Instagram"><i class="fa-brands fa-instagram"></i> Instagram</a>`;
          if (socialObj.facebook) footerSocialHtml += `<a href="${socialObj.facebook}" target="_blank" rel="noopener" class="social-pill" title="Facebook"><i class="fa-brands fa-facebook"></i> Facebook</a>`;
          if (socialObj.whatsapp) footerSocialHtml += `<a href="${socialObj.whatsapp}" target="_blank" rel="noopener" class="social-pill" title="WhatsApp"><i class="fa-brands fa-whatsapp"></i> WhatsApp</a>`;
          if (socialObj.google) footerSocialHtml += `<a href="${socialObj.google}" target="_blank" rel="noopener" class="social-pill" title="Google Meu Negócio"><i class="fa-brands fa-google"></i> Google Meu Negócio</a>`;
          if (socialObj.twitter) footerSocialHtml += `<a href="${socialObj.twitter}" target="_blank" rel="noopener" class="social-pill" title="X / Twitter"><i class="fa-brands fa-x-twitter"></i> Twitter / X</a>`;
          if (socialObj.youtube) footerSocialHtml += `<a href="${socialObj.youtube}" target="_blank" rel="noopener" class="social-pill" title="YouTube"><i class="fa-brands fa-youtube"></i> YouTube</a>`;
          if (socialObj.linkedin) footerSocialHtml += `<a href="${socialObj.linkedin}" target="_blank" rel="noopener" class="social-pill" title="LinkedIn"><i class="fa-brands fa-linkedin"></i> LinkedIn</a>`;
          if (socialObj.tiktok) footerSocialHtml += `<a href="${socialObj.tiktok}" target="_blank" rel="noopener" class="social-pill" title="TikTok"><i class="fa-brands fa-tiktok"></i> TikTok</a>`;
          if (socialObj.pinterest) footerSocialHtml += `<a href="${socialObj.pinterest}" target="_blank" rel="noopener" class="social-pill" title="Pinterest"><i class="fa-brands fa-pinterest"></i> Pinterest</a>`;
          if (socialObj.telegram) footerSocialHtml += `<a href="${socialObj.telegram}" target="_blank" rel="noopener" class="social-pill" title="Telegram"><i class="fa-brands fa-telegram"></i> Telegram</a>`;

          rendered = rendered.replace(/\{\{FOOTER_SOCIAL_HTML\}\}/g, footerSocialHtml);

          // ── CRM FOOTER HTML ───────────────────────────────────────────
          if (client.footer_html && client.footer_html !== 'Não encontrado') {
            let cleanFooter = client.footer_html;
            cleanFooter = cleanFooter.replace(/<div class="footer-bottom[^>]*>[\s\S]*?<\/div>\s*<\/div>|<div class="footer-bottom[^>]*>[\s\S]*?<\/div>/gi, '');
            if (logo && !logo.includes('placehold')) {
              cleanFooter = cleanFooter.replace(/src="[^"]*logo-rodape[^"]*"/gi, `src="${logo}"`);
            }
            cleanFooter = cleanFooter
              .replace(/✓\s*Caça Vazamento/gi, '<i class="fa-solid fa-droplet"></i> Caça Vazamento')
              .replace(/✓\s*Relatório[^<]*/gi, '<i class="fa-solid fa-file-shield"></i> Laudo Técnico / Conta Alta')
              .replace(/✓\s*Desentupimento[^<]*/gi, '<i class="fa-solid fa-faucet-drip"></i> Desentupimento Geral')
              .replace(/✓\s*Infiltração[^<]*/gi, '<i class="fa-solid fa-wrench"></i> Infiltração e Hidráulica')
              .replace(/✓\s*/gi, '<i class="fa-solid fa-check"></i> ');
            
            if (!cleanFooter.includes('fa-location-dot')) {
              cleanFooter = cleanFooter.replace(/<strong>Área de Cobertura:<\/strong>/gi, '<i class="fa-solid fa-location-dot"></i> <strong>Área de Cobertura:</strong>');
            }
            if (!cleanFooter.includes('fa-clock')) {
              cleanFooter = cleanFooter.replace(/<strong>Horário:<\/strong>/gi, '<i class="fa-solid fa-clock"></i> <strong>Plantão 24 Horas:</strong>');
            }
            if (!cleanFooter.includes('fa-whatsapp') && cleanFooter.includes('btn-footer-phone-large')) {
              cleanFooter = cleanFooter.replace(/class="btn-footer-phone-large">([^<]*)<\/a>/gi, 'class="btn-footer-phone-large"><i class="fa-brands fa-whatsapp"></i> $1</a>');
            }

            rendered = rendered.replace(/<!-- CRM_FOOTER_START -->[\s\S]*?<!-- CRM_FOOTER_END -->/i, cleanFooter);
          }

          // Auto-inject title attribute on any iframe missing title for accessibility compliance
          rendered = rendered.replace(/<iframe(?![^>]*\btitle=)([^>]*)>/gi, '<iframe title="Mapa de Localização e Conteúdo Mídia"$1>');

          // Substitui os slots estáticos de anúncio do template pela config do painel
          const originHost = `${req.protocol}://${req.get('host')}`;
          const adH = ads.horizontal || null;
          const adS = ads.sidebar || null;
          const adIn = ads.in_article || null;

          rendered = rendered.replace(/<a href="#" class="custom-ad ad-horizontal">[\s\S]*?<\/a>/i,
            () => buildAdHtml(adH, client.id, 'horizontal', '[Espaço Publicitário 728x90] Anuncie Seu Produto Aqui'));
          rendered = rendered.replace(/<a href="#" class="custom-ad ad-horizontal" style="margin: 40px 0;">[\s\S]*?<\/a>/i,
            () => buildAdHtml(adIn || adH, client.id, 'in_article', '[Espaço Publicitário] Solicite Orçamento'));
          rendered = rendered.replace(/<a href="#" class="custom-ad ad-sidebar">[\s\S]*?<\/a>/i,
            () => buildAdHtml(adS, client.id, 'sidebar', 'Banner Publicitário 300x250'));

          // Strip HTML comments for ultra clean production source code (exceto CRM footer se houver)
          rendered = rendered.replace(/<!--(?!CRM_FOOTER)(?!\[if)[\s\S]*?-->/g, '');

          // ── FOOTER INTELIGENTE STYLES ─────────────────────────────────
          let footerBgColor = corPrimaria;
          if (isLightColor(footerBgColor)) {
            footerBgColor = '#0b2238';
          }
          const footerAccentColor = isLightColor(corFoco) ? corFoco : (isLightColor(corPrimaria) ? '#ffffff' : corFoco);

          const footerVarBlock = `<style>:root {
            --footer-bg: ${footerBgColor};
            --footer-accent: ${footerAccentColor};
            --footer-heading: #ffffff;
            --footer-text: rgba(255,255,255,0.82);
            --footer-link: rgba(255,255,255,0.88);
          }</style>`;

          // ── SEO META TAGS + SCHEMA JSON-LD ────────────────────────────
          const waClean = (client.whatsapp || '').replace(/\D/g, '');
          const waUrl = waClean ? `https://wa.me/55${waClean}` : '';
          const blogUrl = getPublicBlogUrl(req, client);

          const seoMeta = `
  <meta name="description" content="${(client.seo_descricao || desc).replace(/"/g, '&quot;').substring(0, 160)}">
  <meta name="keywords" content="${keywordsList.replace(/"/g, '&quot;')}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
  <meta name="author" content="${nome}">
  <link rel="canonical" href="${blogUrl}">
  <link rel="sitemap" type="application/xml" title="Sitemap" href="${blogUrl}/sitemap.xml">
  <link rel="alternate" type="application/rss+xml" title="${nome} — Feed de Notícias" href="${blogUrl}/rss.xml">
  <!-- Open Graph -->
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${nome}">
  <meta property="og:title" content="${titulo}">
  <meta property="og:description" content="${(client.seo_descricao || desc).replace(/"/g, '&quot;').substring(0, 160)}">
  <meta property="og:url" content="${blogUrl}">
  ${logo && !logo.includes('placehold') ? `<meta property="og:image" content="${logo}">` : ''}
  <meta property="og:locale" content="pt_BR">
  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${titulo}">
  <meta name="twitter:description" content="${(client.seo_descricao || desc).replace(/"/g, '&quot;').substring(0, 160)}">`;

          const socialLinks = [];
          if (socialObj.instagram) socialLinks.push(socialObj.instagram);
          if (socialObj.facebook) socialLinks.push(socialObj.facebook);
          if (socialObj.twitter) socialLinks.push(socialObj.twitter);
          if (socialObj.youtube) socialLinks.push(socialObj.youtube);
          if (socialObj.google) socialLinks.push(socialObj.google);

          // ── SCHEMA.ORG GRAPH COMPLETO PARA O GOOGLE ───────────────────
          const schemaGraph = [
            {
              "@type": "LocalBusiness",
              "@id": `${blogUrl}#business`,
              "name": nome,
              "description": client.seo_descricao || desc,
              "url": blogUrl,
              "telephone": client.phone || client.whatsapp || '',
              "email": client.email || '',
              "address": {
                "@type": "PostalAddress",
                "addressLocality": local !== 'Localização não informada' ? local : '',
                "addressCountry": "BR"
              },
              "image": logo && !logo.includes('placehold') ? logo : undefined,
              "sameAs": socialLinks,
              ...(socialObj.google ? { "hasMap": socialObj.google } : {}),
              ...(waUrl ? {
                "contactPoint": {
                  "@type": "ContactPoint",
                  "telephone": waClean,
                  "contactType": "customer service",
                  "contactOption": "TollFree",
                  "availableLanguage": "Portuguese"
                }
              } : {})
            },
            {
              "@type": "Blog",
              "@id": `${blogUrl}#blog`,
              "name": `${nome} | Blog Oficial`,
              "description": client.seo_descricao || desc,
              "url": blogUrl,
              "publisher": { "@id": `${blogUrl}#business` },
              "blogPost": (posts || []).slice(0, 10).map(p => {
                const pImg = (p.imagem_url && p.imagem_url.startsWith('/uploads/')) ? `${originHost}${p.imagem_url}` : p.imagem_url;
                return {
                  "@type": "BlogPosting",
                  "@id": `${blogUrl}#post-${p.slug}`,
                  "headline": (p.title || '').replace(/^[*\-•#\s]+/, '').replace(/[<>&"]/g, ''),
                  "datePublished": p.published_at || p.created_at,
                  "dateModified": p.published_at || p.created_at,
                  "image": pImg,
                  "url": `${blogUrl}#post-${p.slug}`,
                  "author": { "@type": "Organization", "name": `Equipe Técnica ${nome}` },
                  "publisher": { "@id": `${blogUrl}#business` },
                  "description": (p.content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').substring(0, 160).replace(/[<>&"]/g, '')
                };
              })
            }
          ];

          // FAQPage Schema extraído dos posts para Rich Snippets com estrelas/perguntas no Google
          const faqEntities = [];
          (posts || []).slice(0, 5).forEach(p => {
            const h2Matches = (p.content || '').match(/<h2[^>]*>(.*?)<\/h2>\s*<p>(.*?)<\/p>/gi);
            if (h2Matches) {
              h2Matches.slice(0, 2).forEach(m => {
                const q = m.replace(/<[^>]*>/g, ' ').trim();
                const parts = q.split('?');
                if (parts.length >= 2) {
                  faqEntities.push({
                    "@type": "Question",
                    "name": parts[0].trim() + '?',
                    "acceptedAnswer": {
                      "@type": "Answer",
                      "text": parts.slice(1).join('?').trim() || 'Consulte nossos especialistas técnicos para diagnóstico detalhado.'
                    }
                  });
                }
              });
            }
          });
          if (faqEntities.length > 0) {
            schemaGraph.push({
              "@type": "FAQPage",
              "@id": `${blogUrl}#faq`,
              "mainEntity": faqEntities
            });
          }

          const schemaScript = `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": schemaGraph }, null, 0)}</script>`;

          // ── MEGA CLUSTER SEMÂNTICO INVISÍVEL PARA O GOOGLE ───────────
          const PALAVRAS_NIVEL_BRASIL = [
            "desentupidora 24h", "desentupidora 24 horas", "desentupidora urgente", "desentupidora perto de mim",
            "telefone desentupidora", "orçamento desentupidora", "preço desentupidora", "empresa de desentupimento",
            "serviço de desentupimento", "desentupidora de esgoto", "desentupimento de esgoto", "desentupir esgoto",
            "desentupir esgotos", "desentupidora de esgoto 24 horas", "empresa de desentupimento de esgoto",
            "serviço de desentupimento de esgoto", "desentupidora de rede de esgoto", "desentupimento de rede de esgoto",
            "desentupir cano de esgoto", "desentupimento de tubulação de esgoto", "desentupidora caixa de esgoto",
            "desentupimento de caixa de esgoto", "limpeza de caixa de esgoto", "limpar caixa de esgoto",
            "desentupidora de pia", "desentupimento de pia", "desentupidora de pias", "desentupidora de ralo",
            "desentupimento de ralo", "ralo entupido", "desentupidora de vaso sanitário", "desentupimento de vaso sanitário",
            "desentupidor de vaso 24 horas", "empresa que desentope vaso sanitário", "desentupidora de caixa de gordura",
            "desentupimento caixa de gordura", "empresa de limpeza de caixa de gordura", "empresa para desentupir caixa de gordura",
            "limpeza caixa de gordura preço", "hidrojateamento", "hidrojateamento de esgoto", "serviço de hidrojateamento"
          ];
          
          const combinedKeywordsSet = new Set([
            ...PALAVRAS_NIVEL_BRASIL,
            ...PALAVRAS_NIVEL_BRASIL.map(k => `${k} em ${local}`),
            ...PALAVRAS_NIVEL_BRASIL.map(k => `${k} ${nome}`)
          ]);
          const fullKeywordsList = Array.from(combinedKeywordsSet).join(', ');

          const semanticHiddenCorpus = `
          <section class="sr-only" aria-hidden="true" style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0">
            <h2>Índice Oficial de Serviços e Palavras-Chave de Busca Google: ${nome}</h2>
            <p>Empresa de Desentupimento e Caça Vazamento com Plantão 24 Horas em ${local}.</p>
            <p>Termos de Pesquisa e Soluções: ${fullKeywordsList}</p>
            <nav aria-label="Índice Semântico para Rastreamento">
              <ul>
                ${PALAVRAS_NIVEL_BRASIL.map(k => `<li><a href="${blogUrl}#servico-${k.replace(/\s+/g, '-')}">${k} em ${local} com garantia e preço justo</a></li>`).join('')}
                ${(posts || []).map(p => `<li><a href="${blogUrl}#post-${p.slug}">${(p.title || '').replace(/^[*\-•#\s]+/, '')} - ${nome}</a> - ${(p.content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').substring(0, 150)}</li>`).join('')}
              </ul>
            </nav>
          </section>`;

          // Insere o corpus semântico antes do fechamento do body no HTML base
          rendered = rendered.replace(/<\/body>/i, () => semanticHiddenCorpus + '\n</body>');

          // ── INJEÇÃO 100% SEGURA DE CONFIG, POSTS E ANÚNCIOS NO HEAD ──
          const normalizedPosts = (posts || []).map(p => {
            let cleanContent = (p.content || '')
              .replace(/<!DOCTYPE[^>]*>/gi, '')
              .replace(/<html[^>]*>/gi, '')
              .replace(/<\/html>/gi, '')
              .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
              .replace(/<body[^>]*>/gi, '')
              .replace(/<\/body>/gi, '')
              .trim();
            return {
              ...p,
              title: (p.title || '').replace(/^[-•#*~\s]+/, '').trim(),
              content: cleanContent,
              imagem_url: (p.imagem_url && p.imagem_url.startsWith('/uploads/')) ? `${originHost}${p.imagem_url}` : p.imagem_url
            };
          });

          function safeJsonForScript(obj) {
            return JSON.stringify(obj)
              .replace(/</g, '\\u003c')
              .replace(/>/g, '\\u003e')
              .replace(/&/g, '\\u0026')
              .replace(/\u2028/g, '\\u2028')
              .replace(/\u2029/g, '\\u2029');
          }

          const clientConfigScript = '<script>window.BLOG_CONFIG = ' + safeJsonForScript({
            clientId: client.id,
            nome: nome,
            telefone: telefone,
            localizacao: local,
            nicho: client.nicho || 'Serviços Especializados'
          }) + '; window.CLIENT_ID = ' + client.id + ';</script>\n';

          const postsInjectionScript = '<script>window.BLOG_POSTS = ' + safeJsonForScript(normalizedPosts) + ';</script>\n';

          const normAdImg = url => (url && url.startsWith('/uploads/')) ? `${originHost}${url}` : url;
          const adsBlock = '<script>window.BLOG_ADS = ' + safeJsonForScript({
            horizontal: { ativo: !!(ads.horizontal && ads.horizontal.ativo), client_id: client.id, imagem_url: normAdImg(ads.horizontal && ads.horizontal.imagem_url), link_url: (ads.horizontal && ads.horizontal.link_url) || '' },
            in_article: { ativo: !!(ads.in_article && ads.in_article.ativo), client_id: client.id, imagem_url: normAdImg(ads.in_article && ads.in_article.imagem_url), link_url: (ads.in_article && ads.in_article.link_url) || '' },
            sidebar: { ativo: !!(ads.sidebar && ads.sidebar.ativo), client_id: client.id, imagem_url: normAdImg(ads.sidebar && ads.sidebar.imagem_url), link_url: (ads.sidebar && ads.sidebar.link_url) || '' },
            floating: { ativo: !!(ads.floating && ads.floating.ativo), client_id: client.id, imagem_url: normAdImg(ads.floating && ads.floating.imagem_url), link_url: (ads.floating && ads.floating.link_url) || '' }
          }) + ';</script>\n' +
          '<script>(function(){var a=window.BLOG_ADS;if(!a)return;var c=[];["horizontal","in_article","sidebar","floating"].forEach(function(p){if(a[p]&&a[p].ativo)c.push(p);});if(!c.length)return;c.forEach(function(p){fetch("' + originHost + '/api/ads/view",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({client_id:a[p].client_id,posicao:p})}).catch(function(){})});})();</script>\n';

          const headAdditions = '\n' + footerVarBlock + '\n' + seoMeta + '\n' + schemaScript + '\n' + clientConfigScript + postsInjectionScript + adsBlock;
          rendered = rendered.replace(/<\/head>/i, () => headAdditions + '</head>');

          // Se veio com postSlug específico na URL, injeta script para abrir direto o post
          if (postSlug) {
            const cleanPostSlug = postSlug.replace(/[^a-zA-Z0-9\-_]/g, '');
            rendered = rendered.replace('</body>', `<script>document.addEventListener('DOMContentLoaded', function(){ if(typeof renderSinglePostBySlug === 'function') renderSinglePostBySlug('${cleanPostSlug}'); });</script></body>`);
          }

          res.send(rendered);
        });
        });
        });
      }
    );
  });
});

// ── SEO: llms.txt (AI Crawler Friendly) ──────────────────────────────────────
app.get('/blog/:slug/llms.txt', (req, res) => {
  const { slug } = req.params;
  db.get('SELECT * FROM clients WHERE slug = ?', [slug], (err, client) => {
    if (err || !client) return res.status(404).send('Not found');
    db.all(`SELECT title, content, published_at FROM blogs WHERE client_id = ? AND status = 'publicado' ORDER BY published_at DESC LIMIT 20`, [client.id], (err2, posts) => {
      const base = `${req.protocol}://${req.get('host')}/blog/${slug}`;
      let txt = `# ${client.name || slug}\n`;
      txt += `> Blog oficial de ${client.name || slug}. ${client.seo_descricao || ''}\n\n`;
      txt += `- URL: ${base}\n`;
      if (client.localizacao) txt += `- Localização: ${client.localizacao}\n`;
      if (client.email) txt += `- E-mail: ${client.email}\n`;
      if (client.whatsapp) txt += `- WhatsApp: ${client.whatsapp}\n`;
      txt += `\n## Artigos\n\n`;
      (posts || []).forEach(p => {
        const plain = (p.content || '').replace(/<[^>]*>/g, '').substring(0, 200);
        txt += `### ${p.title}\n${plain}...\n\n`;
      });
      res.header('Content-Type', 'text/plain; charset=utf-8').send(txt);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── MOTOR DE IA — GERAÇÃO E AGENDAMENTO DE POSTS ─────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Chama a API de IA gratuita (SSE streaming) e retorna o texto completo.
 */
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
        buffer = lines.pop(); // guarda linha incompleta

        for (const line of lines) {
          const trimmed = line.trim();
          const m = trimmed.match(/^data:\s?(.*)$/);
          if (m) {
            const token = m[1]; // descarta o separador "data:" + espaço opcional
            if (token && token !== '[DONE]') {
              fullText += token;
            }
          }
        }
      });

      res.on('end', () => {
        // processa último buffer se sobrou
        const m = buffer.trim().match(/^data:\s?(.*)$/);
        if (m && m[1] && m[1] !== '[DONE]') fullText += m[1];

        // IA emite [e-n-t-e-r] no lugar de quebras de linha — normaliza
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

/**
 * Busca imagem relevante para o post, limpa termos genéricos para evitar flyers/anúncios,
 * e aplica marca d'água nítida com o nome do cliente no canto inferior direito.
 */
const REAL_CURATED_PLUMBING_IMAGES = [
  'https://images.unsplash.com/photo-1585704032915-c3400ca199e7?q=80&w=1200&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1584622650111-993a426fbf0a?q=80&w=1200&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1607472586893-edb57bdc0e39?q=80&w=1200&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1542013936693-884638332954?q=80&w=1200&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1581244277943-fe4a9c777189?q=80&w=1200&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1504148455328-c376907d081c?q=80&w=1200&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1590490360182-c33d57733427?q=80&w=1200&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?q=80&w=1200&auto=format&fit=crop'
];

function extrairTermoBuscaSemantico(titulo, nicho) {
  const t = (titulo || '').toLowerCase();
  const n = (nicho || '').toLowerCase();

  if (t.includes('ralo') || t.includes('chuveiro')) return 'unclogging bathroom floor drain plumbing';
  if (t.includes('pia') || t.includes('sifão') || t.includes('sifao') || t.includes('torneira')) return 'kitchen sink pipe unclogging plumber';
  if (t.includes('vaso') || t.includes('sanitário') || t.includes('sanitario') || t.includes('privada')) return 'toilet plumbing repair bathroom';
  if (t.includes('caixa de gordura')) return 'grease trap cleaning plumbing maintenance';
  if (t.includes('caixa de esgoto') || t.includes('rede de esgoto') || t.includes('esgoto')) return 'sewer pipe cleaning plumbing service';
  if (t.includes('hidrojateamento') || t.includes('hidrojato')) return 'hydro jetting pipe cleaning';
  if (t.includes('vazamento') || t.includes('infiltração') || t.includes('infiltracao') || t.includes('geofone') || t.includes('caça') || t.includes('caca')) return 'water leak detection pipe repair plumber';
  if (t.includes('calha') || t.includes('telhado')) return 'roof gutter cleaning repair';
  if (t.includes('eletric') || t.includes('disjuntor') || t.includes('fiação') || t.includes('fiacao')) return 'electrician working on breaker panel';
  if (t.includes('ar condicionado') || t.includes('climatiza')) return 'air conditioner maintenance technician';
  if (t.includes('dedetiza') || t.includes('pragas') || t.includes('cupim')) return 'pest control technician spraying';
  if (t.includes('desentupid') || t.includes('desentupir') || t.includes('desobstru')) return 'professional plumber unblocking drain pipe';

  let clean = t
    .replace(/[:-–—|]/g, ' ')
    .replace(/\b(guia pr[aá]tico|guia completo|solu[cç][oõ]es eficazes|dicas essenciais|passo a passo|como fazer|tudo sobre|tudo o que voc[eê] precisa saber|para seu im[oó]vel|no seu im[oó]vel|em seu im[oó]vel|seu im[oó]vel|im[oó]vel|receita caseira|receitas caseiras|caseiro|caseira)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? `${clean} plumbing service` : `${n || 'encanador'} servico`;
}

// ── DEDUP: imagem já usada no blog deste cliente ───────────────────────────────
const _imagensUsadasGlobal = new Map(); // clientId -> Set(origem)
function getImagensUsadasCliente(clientId) {
  if (!clientId) return new Set();
  return new Promise((resolve) => {
    db.all('SELECT DISTINCT imagem_origem FROM blogs WHERE client_id = ? AND imagem_origem IS NOT NULL AND imagem_origem != \'\'', [clientId], (err, rows) => {
      const set = new Set((rows || []).map(r => r.imagem_origem));
      // junta com as usadas em memória nesta sessão
      if (_imagensUsadasGlobal.has(clientId)) {
        _imagensUsadasGlobal.get(clientId).forEach(o => set.add(o));
      }
      resolve(set);
    });
  });
}
function registrarImagemUsada(clientId, origem) {
  if (!clientId || !origem) return;
  if (!_imagensUsadasGlobal.has(clientId)) _imagensUsadasGlobal.set(clientId, new Set());
  _imagensUsadasGlobal.get(clientId).add(origem);
}

// ── OCR: rejeita imagens com MUITO texto/logo de outra empresa ────────────────
let _ocrWorker = null;
let _ocrLock = Promise.resolve();
async function ocrImage(buf) {
  const run = async () => {
    if (!_ocrWorker) {
      _ocrWorker = await Tesseract.createWorker('por');
      console.log('[IMG OCR] Worker do Tesseract iniciado');
    }
    const { data } = await _ocrWorker.recognize(buf);
    return (data && data.text) || '';
  };
  const p = _ocrLock.then(run, run);
  _ocrLock = p.catch(() => {});
  return p;
}

// Detectar se a imagem parece conter logo/adesivo/marca com muito texto visível
function textoSugereLogo(texto) {
  const t = (texto || '').toLowerCase();
  // Sinais fortes de marca de outro negócio (site/email/telefone/razão social)
  if (/\bwww\.|\.com|@|\(\d{2}\)|\b\d{4}-?\d{4}\b|\bltda\b|\bme\b|whatsapp|telefone|orçamento|orcamento|ligue agora|contato/i.test(t)) return true;
  const stopwords = new Set(['que','com','para','uma','por','como','esta','estao','sao','das','dos','sem','mas','mais','tem','muito','bem','pela','pelo','seu','sua','isso','essa','este','dentro','entre','dele','nela','nele','quando','ainda','depois','antes','tambem','sobre']);
  const palavras = t.match(/[a-zà-ú]{3,}/g) || [];
  const significativas = palavras.filter(w => !stopwords.has(w.replace(/[^a-zà-ú]/g, ''))).length;
  // Imagem com apenas alguns rótulos pequenos é ok; muito texto = logo/selo/adesivo
  return significativas >= 6;
}

// Compila o título em termos de busca de imagem via IA (com fallback heurístico)
async function compilarTermoBuscaIA(titulo, nicho) {
  try {
    const resp = await Promise.race([
      chamarIA([
        { role: 'user', content: `Você é especialista em bancos de imagens profissionais. Considerando o título de um artigo \"${titulo}\" de uma empresa de ${nicho || 'serviços'}, liste em UMA linha, separados por vírgula, 4 termos curtos em inglês (3 a 6 palavras cada) para buscar fotos stock limpas, sem texto e sem logo, que combinem com o tema. Retorne SOMENTE os termos, sem explicação.` }
      ]),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout IA imagem')), 12000))
    ]);
    const termos = (resp || '').split(/[,\n]/).map(s => s.replace(/[^a-zA-Z0-9\s-]/g, '').trim()).filter(Boolean);
    if (termos.length >= 1) {
      termos.push(extrairTermoBuscaSemantico(titulo, nicho));
      console.log(`[IMG AI] Título "${titulo}" → termos: ${termos.join(' | ')}`);
      return termos;
    }
  } catch (e) {
    console.warn('[IMG AI] falhou, usando heurística:', e.message);
  }
  return [extrairTermoBuscaSemantico(titulo, nicho)];
}

async function buscarImagem(termoBusca, logoUrl, clientName, nicho, opts) {
  opts = opts || {};
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  const getFallbackRealImg = () => REAL_CURATED_PLUMBING_IMAGES[Math.floor(Math.random() * REAL_CURATED_PLUMBING_IMAGES.length)];

  // Compila termos de busca a partir do título (IA + fallback heurístico)
  const termos = await compilarTermoBuscaIA(termoBusca, nicho);
  let origensUsadas;
  try { origensUsadas = await getImagensUsadasCliente(opts.clientId); } catch(e) { origensUsadas = new Set(); }

  const sitesRuins = ['pinterest', 'youtube', 'tiktok', 'facebook', 'dailymotion', 'regularize', 'imobiliaria', 'corretor', 'cartilha', 'escritura', 'folheto', 'vector', 'clipart', 'freepik', 'vectorstock', 'shutterstock', '123rf', 'aliexpress', 'ebay', 'amazon', 'kit', 'tool-set'];

  let escolhida = null;
  let termoUsado = termoBusca;

  // Percorre por baixa resolução menos promissora do termo promissor: testa cada termo
  buscaPorTermos: for (const termo of termos) {
    termoUsado = termo;
    console.log(`[IMAGE SEARCH] Buscando "${termo}"...`);
    let dados = [];
    try {
      // 1. Token VQD do DuckDuckGo
      const rHtml = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(termo)}`, { headers: { 'User-Agent': UA } });
      const html = await rHtml.text();
      const vqdMatch = html.match(/vqd=["']?([^"'\s&]+)/);
      if (!vqdMatch) continue;
      const vqd = vqdMatch[1];

      // 2. JSON de imagens
      const rImg = await fetch(`https://duckduckgo.com/i.js?q=${encodeURIComponent(termo)}&o=json&vqd=${vqd}`, { headers: { 'User-Agent': UA } });
      const json = await rImg.json();
      dados = json.results;
    } catch (e) {
      console.warn('[IMAGE SEARCH] DDG falhou para este termo:', e.message);
      continue;
    }
    if (!dados || !dados.length) continue;

    // 3. Filtro de qualidade e relevância visual estrita + dedup
    let filtradas = dados.filter(img => {
      const url = (img.image || '').toLowerCase();
      const title = (img.title || '').toLowerCase();
      if (origensUsadas.has(img.image)) return false; // já usada neste blog
      const isBad = sitesRuins.some(r => url.includes(r) || title.includes(r));
      if (isBad) return false;
      // rejeita thumbnails muito pequenas
      return img.width && img.height && img.width >= img.height && img.width >= 700;
    });
    if (!filtradas.length) continue;

    // 4. Baixa as candidatas e valida via OCR (rejeita logo/marca com muito texto)
    filtradas.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    const candidatas = filtradas.slice(0, 8);
    let encontrada = null;
    for (const cand of candidatas) {
      try {
        const res = await fetch(cand.image, { headers: { 'User-Agent': UA } });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        const ocrTxt = await ocrImage(buf);
        if (textoSugereLogo(ocrTxt)) {
          console.log(`  [OCR] rejeitada (cheia de texto): ${cand.image}`);
          continue;
        }
        encontrada = { image: cand.image, title: cand.title, imgWidth: cand.width, imgHeight: cand.height, buf };
        break;
      } catch (e) {
        console.warn('  [OCR] erro ao validar candidata:', e.message);
      }
    }
    if (encontrada) { escolhida = encontrada; break buscaPorTermos; }
  }

  if (!escolhida) throw new Error('Nenhuma imagem limpa e inédita encontrada para o post');

  try {
    // 5. Aplica marca d'água e padroniza em 800x450 (16:9)
    // usa o buffer já baixado durante a validação OCR
    const buf = escolhida.buf;
    if (!buf) throw new Error('Buffer da imagem indisponível');
    const OUT_W = 800, OUT_H = 450;
    let img = sharp(buf).resize({ width: OUT_W, height: OUT_H, fit: 'cover' });

    const composites = [];

    // Marca d'água com nome do blog do cliente
    const finalClientName = (clientName || '').trim();
    if (finalClientName) {
      const cleanName = finalClientName.toUpperCase().replace(/[<>&"]/g, '');
      const wmSvg = Buffer.from(`
        <svg width="${OUT_W}" height="${OUT_H}">
          <defs>
            <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="#000000" flood-opacity="0.9"/>
            </filter>
          </defs>
          <style>
            .wm-text {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
              font-size: 13px;
              font-weight: 800;
              letter-spacing: 1.5px;
              fill: #ffffff;
              text-anchor: end;
              filter: url(#shadow);
            }
          </style>
          <g>
            <text x="${OUT_W - 24}" y="${OUT_H - 24}" class="wm-text">${cleanName}</text>
          </g>
        </svg>
      `);
      composites.push({ input: wmSvg, top: 0, left: 0 });
    }

    if (composites.length > 0) {
      try {
        img = img.composite(composites);
      } catch (e) { console.warn('Watermark texto falhou:', e.message); }
    }

    const finalBuf = await img.jpeg({ quality: 84 }).toBuffer();
    const fn = `post_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.jpg`;
    fs.writeFileSync(path.join(UPLOADS_DIR, fn), finalBuf);
    registrarImagemUsada(opts.clientId, escolhida.image);
    return { url: `/uploads/${fn}`, origem: escolhida.image, credito: `Foto: ${escolhida.title || termoBusca}`, alt: termoUsado };
  } catch (e) {
    console.warn('buscarImagem DDG falhou, usando imagem real HD do catálogo:', e.message);
    try {
      // catálogo também não repete imagem já usada neste blog
      const pool = REAL_CURATED_PLUMBING_IMAGES.filter(u => !origensUsadas.has(u));
      const fbUrl = (pool.length ? pool : REAL_CURATED_PLUMBING_IMAGES)[Math.floor(Math.random() * (pool.length ? pool.length : REAL_CURATED_PLUMBING_IMAGES.length))];
      const imgRes = await fetch(fbUrl, { headers: { 'User-Agent': UA } });
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const OUT_W = 800, OUT_H = 450;
      let img = sharp(buf).resize({ width: OUT_W, height: OUT_H, fit: 'cover' });
      const finalClientName = (clientName || '').trim().toUpperCase().replace(/[<>&"]/g, '');
      if (finalClientName) {
        const wmSvg = Buffer.from(`
          <svg width="${OUT_W}" height="${OUT_H}">
            <defs><filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="#000000" flood-opacity="0.9"/></filter></defs>
            <text x="${OUT_W - 24}" y="${OUT_H - 24}" font-family="sans-serif" font-size="13px" font-weight="800" letter-spacing="1.5px" fill="#ffffff" text-anchor="end" filter="url(#sh)">${finalClientName}</text>
          </svg>
        `);
        img = img.composite([{ input: wmSvg, top: 0, left: 0 }]);
      }
      const finalBuf = await img.jpeg({ quality: 85 }).toBuffer();
      const fn = `post_hd_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.jpg`;
      fs.writeFileSync(path.join(UPLOADS_DIR, fn), finalBuf);
      registrarImagemUsada(opts.clientId, fbUrl);
      return { url: `/uploads/${fn}`, origem: fbUrl, credito: 'Foto HD', alt: termoBusca };
    } catch(err2) {
      const fbUrl = (REAL_CURATED_PLUMBING_IMAGES.filter(u => !origensUsadas.has(u))[0]) || REAL_CURATED_PLUMBING_IMAGES[0];
      registrarImagemUsada(opts.clientId, fbUrl);
      return { url: fbUrl, origem: fbUrl, credito: 'Imagem ilustrativa', alt: termoBusca };
    }
  }
}

function humanizarTexto(texto) {
  const substituicoes = [
    [/\bCertamente\b/gi, 'Sim'],
    [/\bClaro que\b/gi, 'É verdade que'],
    [/\bCom certeza\b/gi, 'Sem dúvida'],
    [/\bé importante (ressaltar|destacar|mencionar|notar)\b/gi, 'vale notar'],
    [/\bé fundamental (que|para)\b/gi, 'é essencial que'],
    [/\bNo entanto,? é (importante|fundamental|crucial|essencial)\b/gi, 'Mas vale lembrar:'],
    [/\bEm conclusão,?\b/gi, 'No fim das contas,'],
    [/\bEm resumo,?\b/gi, 'Para fechar,'],
    [/\bEm síntese,?\b/gi, 'Na prática,'],
    [/\bPrimeiramente,?\b/gi, 'Antes de tudo,'],
    [/\bPor fim,?\b/gi, 'Pra concluir,'],
    [/\bAlém disso,? é (importante|necessário|fundamental)\b/gi, 'Também vale destacar que'],
    [/\bem termos de\b/gi, 'quando se fala em'],
    [/\b(vale|é importante) ressaltar\b/gi, 'vale mencionar'],
    [/\bde acordo com especialistas\b/gi, 'segundo quem entende do assunto'],
    [/\b\*\*([^*]+)\*\*/g, '<strong>$1</strong>'], // converte **bold** para HTML
    [/\n\n#{1,3} /g, '\n\n'], // remove markdown headers repetitivos
  ];

  let resultado = texto;
  for (const [de, para] of substituicoes) {
    resultado = resultado.replace(de, para);
  }

  // Converte markdown básico para HTML
  resultado = resultado
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/^\* (.+)$/gm, '<li>$1</li>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/gs, (m) => `<ul>${m}</ul>`)
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[hup])/, '<p>')
    .replace(/(?<![>])$/, '</p>');

  return resultado;
}

/**
 * Gera e publica um post automaticamente para um cliente.
 */
async function gerarPostAutomatico(clientId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM clients WHERE id = ?', [clientId], async (err, client) => {
      if (err || !client) return reject(new Error('Cliente não encontrado'));

      // Pega keyword menos usada ou cria uma baseada no nicho
      db.get(
        `SELECT * FROM keywords WHERE client_id = ? ORDER BY usado_em ASC NULLS FIRST, RANDOM() LIMIT 1`,
        [clientId],
        async (err2, kw) => {
          const termo = kw ? (kw.variacao || kw.termo) : (client.nicho || 'serviços especializados');
          const termoBase = kw ? kw.termo : termo;

          const nicho = client.nicho || 'serviços';
          const local = client.localizacao || 'Brasil';
          const nome = client.name;

          // Prompt dinâmico: gera título realista e conteúdo focado na keyword
          const systemPrompt = `Você é um redator sênior de blogs técnicos para empresas de ${nicho} no Brasil.
Escreva para o leitor que está com um problema urgente e precisa de solução agora — não para um robô de SEO.

REGRAS DE SEO OBRIGATÓRIAS:
1. TÍTULO: Deve conter EXATAMENTE a keyword "${termoBase}" + a localização "${local}" + termo de intenção (como/quanto/custo/preço/urgente). Exemplo real: "${termoBase} em ${local}: Quanto Custa e Como Resolver Rápido". NUNCA use "Guia Completo", "Tudo Que Precisa Saber", "Saiba Mais".
2. PRIMEIRA FRASE: Deve conter a keyword "${termoBase}" e "${local}" naturalmente. O Google indexa as primeiras palavras com mais peso.
3. H2s: Devem conter termos de intenção de busca reais que o usuário pesquisaria: "quanto custa", "como funciona", "perto de mim", "urgence", "24 horas", "orçamento".
4. KEYWORD PRINCIPAL: Use "${termoBase}" em <strong>negrito</strong> de 5 a 7 vezes ao longo do texto.
5. LOCALIZAÇÃO: Mencione "${local}" e variações (bairro, região, cidade) em pelo menos 6 a 8 pontos do texto — não só no CTA final.
6. VARIAÇÕES DE CAUDA LONGA: Use termos como "preço de ${termoBase}", "empresa de ${termoBase}", "${termoBase} perto de mim", "${termoBase} urgente 24h", "orçamento ${termoBase}".

REGRAS DE CONTEÚDO:
- Foque 100% no problema real, nas causas, no passo-a-passo da solução e em por que o leitor NÃO deve tentar fazer sozinho.
- Proibido clichês de IA: "certamente", "em suma", "é importante ressaltar", "no mundo de hoje", "além disso".
- Escreva em HTML semântico limpo: <h2>, <h3>, <p>, <ul>, <li>, <strong> (nunca <h1>, nunca Markdown).
- Seja técnico mas acessível — o leitor não é especialista, é cliente desesperado com um problema.`;

          const userPrompt = `Escreva um artigo completo (800 a 1100 palavras) sobre: "${termoBase}"

Empresa: ${nome}
Nicho: ${nicho}
Região de atendimento: ${local}

FORMATO DA RESPOSTA:
Primeira linha: escreva SOMENTE o título (sem prefixo TITULO:, sem aspas, sem colchetes). O título DEVE conter: "${termoBase}" + "${local}" + termo de intenção (quanto custa / como resolver / urgente / preço / 24h).
Segunda linha: deixe em branco.
Terceira linha em diante: conteúdo HTML direto.

ESTRUTURA OBRIGATÓRIA (cada H2 deve conter termo de busca + local):
- Introdução: primeira frase com "${termoBase}" + "${local}" + urgência do problema.
- <h2>O que causa ${termoBase} em ${local} e como identificar os sinais</h2>
- <h2>Como é feito o ${termoBase} profissional passo a passo</h2>
- <h2>Por que não tentar ${termoBase} sozinho — riscos e custos</h2>
- <h2>Quanto custa ${termoBase} em ${local}? Orçamento sem compromisso</h2>
- <h2>Perguntas Frequentes sobre ${termoBase}</h2> (3 FAQs)
- <h2>${nome}: ${termoBase} Urgente 24h em ${local}</h2> (CTA WhatsApp)

DISTRIBUIÇÃO DA KEYWORD "${termoBase}" no texto:
- Título: 1x
- Primeira frase: 1x
- Cada H2: 1x (6 H2s = 6 menções)
- Corpo do texto: 3 a 5 vezes em <strong>negrito</r
- Total esperado: 10 a 13 menções da keyword principal no artigo inteiro.

DISTRIBUIÇÃO DA LOCALIZAÇÃO "${local}" (mínimo 8 menções):
- Título: 1x
- Introdução: 1x
- Pelo menos 1x em cada H2
- CTA final: 1x
- Corpo do texto: 2 a 3 vezes adicionais`;

          try {
            console.log(`[AI] Gerando post para "${nome}" (ID ${clientId}) | Keyword: "${termoBase}"`);
            const resposta = await chamarIA([
              { role: 'user', content: systemPrompt + '\n\n' + userPrompt }
            ]);

            // Extrai título — busca múltiplos padrões robustos
            let titulo = '';
            let conteudo = resposta;

            // Padrão 1: resposta começa com o título na primeira linha (formato novo)
            const lines = resposta.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length > 0) {
              const firstLine = lines[0];
              // Se NÃO é HTML e NÃO é label tipo TITULO: / title: / headline:
              const isLabel = /^(t[íi]tulo|title|headline|titulo)[:\s*#]+/i.test(firstLine);
              const isHtml = /^<\w/.test(firstLine);
              if (!isLabel && !isHtml && firstLine.length >= 20 && firstLine.length <= 150) {
                titulo = firstLine.replace(/[*_~`#]+/g, '').replace(/^["'«»“”`]+|["'«»“”`]+$/g, '').trim();
              }
            }

            // Padrão 2: formato label TITULO: <texto>
            if (!titulo) {
              const matchLabel = resposta.match(/(?:t[íi]tulo|title|headline|titulo)\s*:\s*([^\r\n<]+)/i);
              if (matchLabel && matchLabel[1]) {
                titulo = matchLabel[1].replace(/[*_~`#\[\]]+/g, '').replace(/^["'«»“”`]+|["'«»“”`]+$/g, '').trim();
              }
            }

            // Padrão 3: primeira linha com mais de 20 chars e que NÃO é HTML puro
            if (!titulo) {
              for (const line of lines) {
                const clean = line.replace(/<\/?[^>]+(>|$)/g, '').replace(/^[*\-•#\s]+/, '').trim();
                if (clean.length >= 20 && clean.length <= 150 && !clean.includes('|') && !/^<h/i.test(line)) {
                  titulo = clean.replace(/[*_~`#]+/g, '').trim();
                  break;
                }
              }
            }

            // Fallback: se título não faz sentido, gera um baseado no termo
            if (!titulo || titulo.toLowerCase() === termoBase.toLowerCase() || titulo.length < 15) {
              const cap = termoBase.charAt(0).toUpperCase() + termoBase.slice(1);
              titulo = `${cap} em ${local}: Como Resolver Rápido com Especialistas`;
            }

            // Limpa o conteúdo HTML removendo marcações de título e cabeçalho desnecessárias
            conteudo = conteudo
              .replace(/<!DOCTYPE[^>]*>/gi, '')
              .replace(/<html[^>]*>/gi, '')
              .replace(/<\/html>/gi, '')
              .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
              .replace(/<body[^>]*>/gi, '')
              .replace(/<\/body>/gi, '')
              .replace(/^[*\-•#\s]*t[íi]tulo:[^\r\n]+\r?\n?/i, '')
              .replace(/<h1[^>]*>[\s\S]*?<\/h1>/gi, '')
              .replace(/^[*\-•#\s]*varia[çc][õo]es:[^\r\n]+\r?\n?/i, '')
              // Remove code fences de markdown ```html ... ``` que a IA às vezes embrulha
              .replace(/^```[a-zA-Z0-9]*\s*\r?\n?/i, '')
              .replace(/\r?\n?```\s*$/i, '')
              .trim();

            // Extrai variações
            let variacoes = [termoBase];
            const matchVar = resposta.match(/varia[çc][õo]es:\s*([^\r\n]+)/i);
            if (matchVar && matchVar[1]) {
              const parsed = matchVar[1].split('|').map(s => s.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
              if (parsed.length) variacoes = parsed;
            }

            // Busca imagem profissional contextualizada com marca d'água
            const termoBuscaImagem = titulo || `${termoBase} ${nicho}`.trim();
            const imagem = await buscarImagem(termoBuscaImagem, client.logo, nome, nicho, { clientId });

            // Slug amigável
            const slug = (titulo + '-' + Date.now().toString().slice(-4))
              .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
              .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
              .substring(0, 80);

            // Salva no banco
            db.run(
              `INSERT INTO blogs (client_id, title, slug, content, imagem_url, imagem_origem, status, published_at)
               VALUES (?, ?, ?, ?, ?, ?, 'publicado', CURRENT_TIMESTAMP)`,
              [clientId, titulo, slug, conteudo, imagem.url, imagem.origem || null],
              function(err3) {
                if (err3) return reject(err3);

                // Marca keyword como usada
                if (kw) {
                  db.run('UPDATE keywords SET usado_em = CURRENT_TIMESTAMP WHERE id = ?', [kw.id]);
                }

                console.log(`[AI] ✅ Post publicado com sucesso: "${titulo}" para ${nome}`);
                try {
                  const sitemapUrl = `http://localhost:1337/blog/${client.slug}/sitemap.xml`;
                  pingSearchEngines(sitemapUrl);
                } catch(ePing) {}
                resolve({ id: this.lastID, titulo, slug, imagem: imagem.url, client_id: clientId, client_name: nome });
              }
            );
          } catch(e) {
            console.error('[AI] ❌ Erro na geração:', e.message);
            reject(e);
          }
        }
      );
    });
  });
}

// ── AGENDADOR CRON ────────────────────────────────────────────────────────────
// Função utilitária para extrair hora e dia exatos de Brasília (America/Sao_Paulo)
function getSaoPauloTime() {
  // Usa .format() ao invés de .formatToParts() para evitar bug do Node.js no Linux
  // onde formatToParts retorna hour: '24' ao invés de '00' para meia-noite
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });

  // .format() retorna algo como "2026-08-29, 17:00:00" ou "2026-08-29, 24:00:00"
  const formatted = formatter.format(new Date());
  const match = formatted.match(/(\d{4})-(\d{2})-(\d{2})[\s,]+(\d{2}):(\d{2}):(\d{2})/);
  if (!match) {
    // Fallback seguro: usa toLocaleString
    const fallback = new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const fbMatch = fallback.match(/(\d{4})-(\d{2})-(\d{2})\s(\d{2}):(\d{2}):(\d{2})/);
    if (!fbMatch) {
      console.error('[CRON] FALHA GRAVE: não conseguiu obter hora de São Paulo');
      return { hhmm: '00:00', dow: 1, isoDate: '1970-01-01', hour: 0, minute: 0 };
    }
    const [, y, m, d, h, min] = fbMatch;
    // Normaliza '24' para '00' (bug conhecido do Intl no Linux)
    const safeHour = h === '24' ? '00' : h;
    const spDate = new Date(`${y}-${m}-${d}T${safeHour}:${min}:00-03:00`);
    const rawDow = spDate.getDay();
    const dow = rawDow === 0 ? 7 : rawDow;
    return { hhmm: `${safeHour}:${min}`, dow, isoDate: `${y}-${m}-${d}`, hour: parseInt(safeHour), minute: parseInt(min) };
  }

  let [, y, m, d, h, min] = match;
  // Normaliza '24' para '00' (bug conhecido do Intl.DateTimeFormat no Linux/Node.js)
  if (h === '24') h = '00';

  const hhmm = `${h}:${min}`;
  const spDate = new Date(`${y}-${m}-${d}T${h}:${min}:00-03:00`);
  const rawDow = spDate.getDay(); // 0=dom, 1=seg ... 6=sab
  const dow = rawDow === 0 ? 7 : rawDow; // 1=seg ... 7=dom

  return { hhmm, dow, isoDate: `${y}-${m}-${d}`, hour: parseInt(h), minute: parseInt(min) };
}

function parseHorarios(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map(h => {
      const p = String(h).split(':');
      return p.length === 2 ? `${String(p[0]).padStart(2, '0')}:${String(p[1]).padStart(2, '0')}` : String(h);
    });
  }
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed)) {
        return parsed.map(h => {
          const p = String(h).split(':');
          return p.length === 2 ? `${String(p[0]).padStart(2, '0')}:${String(p[1]).padStart(2, '0')}` : String(h);
        });
      }
    } catch(e) {}
    const matches = input.match(/\b\d{1,2}:\d{2}\b/g);
    if (matches) {
      return matches.map(h => {
        const p = h.split(':');
        return `${String(p[0]).padStart(2, '0')}:${String(p[1]).padStart(2, '0')}`;
      });
    }
  }
  return [];
}

function parseDias(input) {
  if (!input) return [1, 2, 3, 4, 5, 6, 7];
  if (Array.isArray(input)) return input.map(Number);
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed)) return parsed.map(Number);
    } catch(e) {}
    const matches = input.match(/\d+/g);
    if (matches) return matches.map(Number);
  }
  return [1, 2, 3, 4, 5, 6, 7];
}

// Roda a cada minuto com verificação exata e tolerância a atrasos
cron.schedule('* * * * *', () => {
  const { hhmm, dow, isoDate, hour, minute } = getSaoPauloTime();
  const now = new Date();

  console.log(`[CRON TICK] Brasília: ${hhmm} | Dia da semana: ${dow} | Data: ${isoDate}`);

  db.all('SELECT * FROM post_schedules WHERE ativo = 1', [], (err, schedules) => {
    if (err || !schedules || !schedules.length) return;

    for (const sched of schedules) {
      try {
        const horarios = parseHorarios(sched.horarios);
        const dias = parseDias(sched.dias_semana);

        // Verifica se hoje é um dos dias configurados
        if (!dias.includes(dow)) continue;

        // Verifica se o horário atual bate com o agendamento OU se estava previsto nos últimos 3 minutos
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
          // Agendamento global para todos os clientes
          db.all('SELECT id, name FROM clients', [], async (errC, allClients) => {
            if (errC || !allClients) return;
            for (const c of allClients) {
              try {
                await gerarPostAutomatico(c.id);
                await new Promise(r => setTimeout(r, 2000));
              } catch(e) {
                console.error(`[CRON ALL] Erro para ${c.name}:`, e.message);
              }
            }
          });
        } else {
          gerarPostAutomatico(sched.client_id)
            .then(r => console.log(`[CRON] ✅ Post publicado: "${r.titulo}" para ${r.client_name}`))
            .catch(e => console.error(`[CRON] ❌ Falha:`, e.message));
        }

      } catch(e) {
        console.error('[CRON ERROR]', e.message);
      }
    }
  });
});

// ── API: KEYWORDS ─────────────────────────────────────────────────────────────
app.get('/api/keywords/:clientId', requireAuth, (req, res) => {
  const cid = req.params.clientId;
  if (cid === 'ALL' || cid === 'TODOS' || cid === 'todos') {
    db.all('SELECT k.*, c.name as client_name FROM keywords k LEFT JOIN clients c ON c.id=k.client_id ORDER BY k.id DESC LIMIT 500', [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    });
  } else {
    db.all('SELECT * FROM keywords WHERE client_id = ? ORDER BY usado_em ASC NULLS FIRST, id DESC', [cid], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    });
  }
});

app.post('/api/keywords', requireAuth, (req, res) => {
  const { client_id, termo, variacao } = req.body;
  if (!client_id || !termo) return res.status(400).json({ error: 'client_id e termo são obrigatórios' });
  db.run('INSERT INTO keywords (client_id, termo, variacao) VALUES (?, ?, ?)', [client_id, termo.trim(), (variacao || '').trim() || null], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    db.get('SELECT * FROM keywords WHERE id = ?', [this.lastID], (e, row) => res.status(201).json(row));
  });
});

app.post('/api/keywords/batch', requireAuth, (req, res) => {
  const { client_id, keywords, variacao } = req.body;
  if (!client_id || (!Array.isArray(keywords) && typeof keywords !== 'string')) {
    return res.status(400).json({ error: 'client_id e lista de keywords são obrigatórios' });
  }

  let list = [];
  if (Array.isArray(keywords)) {
    list = keywords;
  } else if (typeof keywords === 'string') {
    list = keywords.split('\n').map(s => s.trim()).filter(Boolean);
  }

  if (!list.length) return res.status(400).json({ error: 'Nenhuma keyword válida recebida' });

  const isAll = (client_id === 'ALL' || client_id === 'TODOS' || client_id === 'todos');

  db.all(isAll ? 'SELECT id FROM clients' : 'SELECT id FROM clients WHERE id = ?', isAll ? [] : [client_id], (errC, clientRows) => {
    if (errC || !clientRows || !clientRows.length) {
      return res.status(404).json({ error: 'Nenhum cliente encontrado' });
    }

    const targetClientIds = clientRows.map(c => c.id);
    const linhas = [];

    targetClientIds.forEach(cid => {
      list.forEach(item => {
        let t = '', v = variacao || null;
        if (typeof item === 'string') {
          const parts = item.split('|');
          t = parts[0].trim();
          if (parts[1]) v = parts[1].trim();
        } else if (item && item.termo) {
          t = item.termo.trim();
          if (item.variacao) v = item.variacao.trim();
        }
        if (t) linhas.push([cid, t, v]);
      });
    });

    if (!linhas.length) return res.status(400).json({ error: 'Nenhuma keyword válida recebida' });

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      const stmt = db.prepare('INSERT INTO keywords (client_id, termo, variacao) VALUES (?, ?, ?)');
      let inserted = 0;
      let failMsg = null;
      linhas.forEach(row => {
        stmt.run(row[0], row[1], row[2], (err) => {
          if (err) failMsg = err.message;
          else inserted++;
        });
      });
      stmt.finalize();

      if (failMsg) {
        db.run('ROLLBACK');
        return res.status(500).json({ error: 'Falha ao salvar keywords: ' + failMsg });
      } else {
        db.run('COMMIT');
        return res.status(201).json({ success: true, count: inserted, clientsCount: targetClientIds.length });
      }
    });
  });
});

app.delete('/api/keywords/:id', requireAuth, (req, res) => {
  db.run('DELETE FROM keywords WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});


// ── ANALYTICS & RASTREAMENTO DE TRÁFEGO ───────────────────────────────────────
app.post('/api/analytics/track', (req, res) => {
  const { client_id, post_slug, action, referrer, origin_type, duration_seconds, city, region, device } = req.body;
  const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const ip = rawIp.split(',')[0].trim().replace(/^::ffff:/, '');
  const ip_version = (ip.includes(':') || ip === '::1') ? 'IPv6' : 'IPv4';

  const userAgent = req.headers['user-agent'] || '';
  let browser = 'Outro';
  if (userAgent.includes('Chrome')) browser = 'Chrome';
  else if (userAgent.includes('Safari')) browser = 'Safari';
  else if (userAgent.includes('Firefox')) browser = 'Firefox';
  else if (userAgent.includes('Edge')) browser = 'Edge';

  let os = 'Outro';
  if (userAgent.includes('Android')) os = 'Android';
  else if (userAgent.includes('iPhone') || userAgent.includes('iPad')) os = 'iOS';
  else if (userAgent.includes('Windows')) os = 'Windows';
  else if (userAgent.includes('Mac')) os = 'Mac';
  else if (userAgent.includes('Linux')) os = 'Linux';

  const detectedDevice = device || (/Mobile|Android|iPhone/i.test(userAgent) ? 'Mobile' : 'Desktop');

  // Detecta origem inteligente
  let finalOrigin = origin_type || 'Direto / Link';
  const ref = (referrer || '').toLowerCase();
  if (ref.includes('google.com') || ref.includes('google.com.br')) {
    finalOrigin = (ref.includes('gclid') || ref.includes('adurl')) ? 'Google Ads' : 'Google Orgânico';
  } else if (ref.includes('facebook.com') || ref.includes('instagram.com') || ref.includes('fbclid')) {
    finalOrigin = 'Meta / Instagram Ads';
  } else if (ref.length > 0 && !ref.includes(req.get('host'))) {
    finalOrigin = 'Referência / Outro Site';
  }

  db.run(
    `INSERT INTO analytics_events 
      (client_id, post_slug, action, origin_type, referrer, ip, ip_version, city, region, device, browser, os, duration_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [client_id || null, post_slug || null, action || 'pageview', finalOrigin, referrer || null, ip || 'Local', ip_version, city || 'Brasil', region || '', detectedDevice, browser, os, duration_seconds || 0],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, event_id: this.lastID });
    }
  );
});

// Consulta de Analytics com Filtros
app.get('/api/analytics', requireAuth, (req, res) => {
  const { client_id, origin_type, limit = 200 } = req.query;
  let whereJoined = [];
  let whereRaw = [];
  let params = [];

  if (client_id) {
    whereJoined.push('a.client_id = ?');
    whereRaw.push('client_id = ?');
    params.push(client_id);
  }
  if (origin_type && origin_type !== 'all') {
    whereJoined.push('a.origin_type = ?');
    whereRaw.push('origin_type = ?');
    params.push(origin_type);
  }

  const whereClauseJoined = whereJoined.length ? 'WHERE ' + whereJoined.join(' AND ') : '';
  const whereClauseRaw = whereRaw.length ? 'WHERE ' + whereRaw.join(' AND ') : '';
  const query = `
    SELECT a.*, c.name as client_name, c.slug as client_slug
    FROM analytics_events a
    LEFT JOIN clients c ON c.id = a.client_id
    ${whereClauseJoined}
    ORDER BY a.created_at DESC
    LIMIT ?
  `;
  const queryParams = [...params, parseInt(limit)];

  db.all(query, queryParams, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    // Estatísticas resumidas
    db.get(`
      SELECT 
        COUNT(*) as total_events,
        SUM(CASE WHEN origin_type = 'Google Orgânico' THEN 1 ELSE 0 END) as google_organico,
        SUM(CASE WHEN origin_type = 'Google Ads' THEN 1 ELSE 0 END) as google_ads,
        SUM(CASE WHEN action = 'click_cta_whatsapp' THEN 1 ELSE 0 END) as clicks_whatsapp,
        SUM(CASE WHEN action = 'read_post_35s' THEN 1 ELSE 0 END) as leituras_completas
      FROM analytics_events ${whereClauseRaw}
    `, params, (errS, stats) => {
      res.json({
        stats: stats || {},
        events: rows || []
      });
    });
  });
});

// Exportação em Planilha CSV / Excel
app.get('/api/analytics/export.csv', requireAuth, (req, res) => {
  const query = `
    SELECT a.created_at as "Data/Hora", c.name as "Cliente", a.origin_type as "Origem do Tráfego",
           a.action as "Ação Realizada", a.post_slug as "Artigo Lido", a.ip as "Endereço IP",
           a.ip_version as "Versão IP", a.city as "Cidade", a.device as "Dispositivo",
           a.browser as "Navegador", a.os as "Sistema Operacional", a.referrer as "URL de Origem"
    FROM analytics_events a
    LEFT JOIN clients c ON c.id = a.client_id
    ORDER BY a.created_at DESC
    LIMIT 2000
  `;

  db.all(query, [], (err, rows) => {
    if (err || !rows.length) {
      return res.status(404).send('Nenhum dado encontrado para exportação');
    }

    const headers = Object.keys(rows[0]).join(';');
    const lines = rows.map(r => Object.values(r).map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(';'));
    const csvContent = '\uFEFF' + [headers, ...lines].join('\r\n'); // BOM para abrir perfeito no Excel

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="relatorio_trafego_blog_${Date.now()}.csv"`);
    res.send(csvContent);
  });
});

// ── API: SCHEDULES ────────────────────────────────────────────────────────────
app.get('/api/schedules', requireAuth, (req, res) => {
  const cid = req.query.client_id;
  const q = cid ? 'SELECT * FROM post_schedules WHERE client_id = ?' : 'SELECT ps.*, c.name as client_name FROM post_schedules ps JOIN clients c ON c.id=ps.client_id ORDER BY ps.id DESC';
  const params = cid ? [cid] : [];
  db.all(q, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/schedules', requireAuth, (req, res) => {
  const { client_id, horarios, dias_semana, ativo, posts_por_dia } = req.body;
  if (!client_id && client_id !== 0) return res.status(400).json({ error: 'client_id obrigatório' });

  const rawHorarios = Array.isArray(horarios) ? horarios : JSON.parse(horarios || '["09:00"]');
  const normHorarios = rawHorarios.map(h => {
    const p = String(h).split(':');
    return p.length === 2 ? `${String(p[0]).padStart(2, '0')}:${String(p[1]).padStart(2, '0')}` : h;
  });

  const horariosStr = JSON.stringify(normHorarios);
  const diasStr = JSON.stringify(Array.isArray(dias_semana) ? dias_semana : JSON.parse(dias_semana || '[1,2,3,4,5,6,7]'));
  const isAll = (client_id === 'ALL' || client_id === 'TODOS' || client_id === 'todos' || client_id === 0 || client_id === '0');

  if (isAll) {
    db.all('SELECT id FROM clients', [], (errC, clients) => {
      if (errC || !clients || !clients.length) return res.status(404).json({ error: 'Nenhum cliente cadastrado' });
      clients.forEach(c => {
        db.get('SELECT id FROM post_schedules WHERE client_id = ?', [c.id], (e, exist) => {
          if (exist) {
            db.run('UPDATE post_schedules SET horarios=?, dias_semana=?, ativo=?, posts_por_dia=? WHERE client_id=?',
              [horariosStr, diasStr, ativo !== undefined ? (ativo ? 1 : 0) : 1, posts_por_dia || 1, c.id]);
          } else {
            db.run('INSERT INTO post_schedules (client_id, horarios, dias_semana, ativo, posts_por_dia) VALUES (?,?,?,?,?)',
              [c.id, horariosStr, diasStr, ativo !== undefined ? (ativo ? 1 : 0) : 1, posts_por_dia || 1]);
          }
        });
      });
      res.json({ success: true, count: clients.length, message: `Agendamento salvo para todos os ${clients.length} clientes!` });
    });
  } else {
    const targetCid = parseInt(client_id);
    db.get('SELECT id FROM post_schedules WHERE client_id = ?', [targetCid], (err, existing) => {
      if (existing) {
        db.run('UPDATE post_schedules SET horarios=?, dias_semana=?, ativo=?, posts_por_dia=? WHERE client_id=?',
          [horariosStr, diasStr, ativo !== undefined ? (ativo ? 1 : 0) : 1, posts_por_dia || 1, targetCid],
          (e) => { if (e) return res.status(500).json({ error: e.message }); res.json({ success: true, updated: true }); }
        );
      } else {
        db.run('INSERT INTO post_schedules (client_id, horarios, dias_semana, ativo, posts_por_dia) VALUES (?,?,?,?,?)',
          [targetCid, horariosStr, diasStr, ativo !== undefined ? (ativo ? 1 : 0) : 1, posts_por_dia || 1],
          function(e) { if (e) return res.status(500).json({ error: e.message }); res.json({ success: true, id: this.lastID }); }
        );
      }
    });
  }
});


app.delete('/api/schedules/:id', requireAuth, (req, res) => {
  db.run('DELETE FROM post_schedules WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ── API: GERAÇÃO MANUAL DE POST ───────────────────────────────────────────────
app.post('/api/gerar-post', requireAuth, async (req, res) => {
  const rawCid = req.body.client_id || req.body.clientId || req.body.body?.client_id || req.query.client_id;
  const isAll = (rawCid === 'ALL' || rawCid === 'TODOS' || rawCid === 'todos' || rawCid === 0 || rawCid === '0');
  const titulo_forca = req.body.titulo_forca || req.body.body?.titulo_forca || req.query.titulo_forca;

  if (isAll) {
    db.all('SELECT id, name FROM clients', [], async (err, clients) => {
      if (err || !clients || !clients.length) return res.status(404).json({ error: 'Nenhum cliente cadastrado' });
      res.json({ success: true, message: `Iniciando geração de posts para todos os ${clients.length} clientes! 🚀` });

      for (const c of clients) {
        try {
          console.log(`[BATCH MANUAL] Gerando post para ${c.name} (ID ${c.id})...`);
          if (titulo_forca) {
            await new Promise((resolve) => {
              db.run('INSERT INTO keywords (client_id, termo, variacao) VALUES (?, ?, NULL)', [c.id, titulo_forca], () => resolve());
            });
          }
          await gerarPostAutomatico(c.id);
          await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
          console.error(`[BATCH MANUAL] Erro para ${c.name}:`, e.message);
        }
      }
    });
    return;
  }

  if (!rawCid) return res.status(400).json({ error: 'client_id obrigatório' });
  const client_id = parseInt(rawCid);

  try {
    console.log(`[MANUAL GENERATE] Disparando geração manual para client_id=${client_id}`);
    if (titulo_forca) {
      await new Promise((resolve, reject) => {
        db.run('INSERT INTO keywords (client_id, termo, variacao) VALUES (?, ?, NULL)',
          [client_id, titulo_forca], (e) => e ? reject(e) : resolve());
      });
    }
    const result = await gerarPostAutomatico(client_id);
    console.log(`[MANUAL GENERATE] ✅ Post gerado com sucesso: "${result.titulo}"`);
    res.json({ success: true, ...result });
  } catch(e) {
    console.error(`[MANUAL GENERATE] ❌ Erro ao gerar post:`, e.message);
    res.status(500).json({ error: e.message });
  }
});


app.post('/api/gerar-post/batch', requireAuth, async (req, res) => {
  const { client_ids, count_per_client = 1 } = req.body;
  const ids = Array.isArray(client_ids) ? client_ids : [req.body.client_id].filter(Boolean);

  if (!ids.length) return res.status(400).json({ error: 'client_ids obrigatório (array de IDs de clientes)' });

  res.json({ success: true, message: `Geração em lote iniciada para ${ids.length} cliente(s)` });

  (async () => {
    for (const cid of ids) {
      for (let i = 0; i < count_per_client; i++) {
        try {
          await gerarPostAutomatico(cid);
          await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
          console.error(`[BATCH AI] Erro no cliente ${cid}:`, e.message);
        }
      }
    }
  })();
});

// ── API: BUSCA IMAGEM COM MARCA D'ÁGUA (teste isolado) ────────────────────────
app.get('/api/imagem', requireAuth, async (req, res) => {
  const q = req.query.q;
  const logo = req.query.logo;
  const nome = req.query.nome || req.query.clientName || '';
  const clientId = req.query.client_id ? parseInt(req.query.client_id) : null;
  if (!q) return res.status(400).json({ erro: 'Envie ?q=termo de busca' });
  try {
    const r = await buscarImagem(q, logo, nome, req.query.nicho || '', { clientId });
    res.json({ sucesso: true, ...r });
  } catch (e) {
    res.status(500).json({ sucesso: false, erro: e.message });
  }
});

// ── API: STATUS DO AGENDADOR ──────────────────────────────────────────────────
app.get('/api/scheduler-status', requireAuth, (req, res) => {
  db.all('SELECT ps.*, c.name as client_name FROM post_schedules ps JOIN clients c ON c.id=ps.client_id WHERE ps.ativo=1', [], (err, rows) => {
    res.json({
      running: true,
      timezone: 'America/Sao_Paulo',
      activeSchedules: rows || [],
      serverTime: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    });
  });
});

// ── API: ANÚNCIOS DO BLOG ─────────────────────────────────────────────────────
app.get('/api/clients/:id/ads', requireAuth, (req, res) => {
  db.all('SELECT * FROM client_ads WHERE client_id = ? ORDER BY posicao', [req.params.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.put('/api/clients/:id/ads', requireAuth, (req, res) => {
  const items = Array.isArray(req.body) ? req.body : (req.body.items || req.body.ads || []);
  const clientId = req.params.id;
  if (!items.length) return res.status(400).json({ error: 'Nenhum anúncio para salvar' });

  const stmt = db.prepare(`INSERT INTO client_ads (client_id, posicao, ativo, imagem_url, link_url)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(client_id, posicao) DO UPDATE SET
      ativo = excluded.ativo,
      imagem_url = excluded.imagem_url,
      link_url = excluded.link_url,
      updated_at = CURRENT_TIMESTAMP`);
  db.serialize(() => {
    items.forEach(it => {
      stmt.run(clientId, it.posicao, it.ativo ? 1 : 0, it.imagem_url || null, it.link_url || null, () => {});
    });
    stmt.finalize();
    res.json({ success: true, sucesso: true });
  });
});

// Rastreio de view (público — chamado pelo blog, não exige login)
app.post('/api/ads/view', (req, res) => {
  const { client_id, posicao } = req.body;
  if (!client_id || !posicao) return res.status(400).json({ error: 'client_id e posicao obrigatórios' });
  db.run(`INSERT INTO client_ads (client_id, posicao, views) VALUES (?, ?, 1)
    ON CONFLICT(client_id, posicao) DO UPDATE SET views = views + 1`,
    [client_id, posicao], (e) => {
      if (e) return res.status(500).json({ error: e.message });
      res.json({ success: true, sucesso: true });
    });
});

// Clique em anúncio (público) — incrementa contador e redireciona
app.get('/api/ads/click', (req, res) => {
  const { client_id, posicao, url } = req.query;
  if (!client_id || !posicao) return res.status(400).send('Parâmetros inválidos');
  db.run(`INSERT INTO client_ads (client_id, posicao, clicks) VALUES (?, ?, 1)
    ON CONFLICT(client_id, posicao) DO UPDATE SET clicks = clicks + 1`,
    [client_id, posicao], (e) => {
      const dest = (url && /^https?:/i.test(url)) ? url : '/';
      res.redirect(dest);
    });
});

// Upload de imagem de anúncio (base64 -> /uploads)
app.post('/api/ads/upload', requireAuth, (req, res) => {
  const { client_id, posicao, data } = req.body;
  if (!client_id || !posicao || !data || !data.startsWith('data:image')) {
    return res.status(400).json({ error: 'Envie client_id, posicao e a imagem em base64 (data:image/...)' });
  }
  const m = data.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'Formato de imagem inválido' });
  try {
    const ext = (m[1] || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const buf = Buffer.from(m[2], 'base64');
    const fn = `ad_${client_id}_${posicao}_${Date.now()}.${ext === 'png' ? 'png' : 'jpg'}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, fn), buf);
    res.json({ success: true, sucesso: true, url: `/uploads/${fn}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Helper: HTML do anúncio para injeção no blog
function buildAdHtml(ad, clientId, posicao, fallback) {
  if (!ad || !ad.ativo) return '';
  const link = (ad.link_url && /^https?:/i.test(ad.link_url)) ? ad.link_url : '#';
  const clickUrl = `/api/ads/click?client_id=${clientId}&posicao=${posicao}&url=${encodeURIComponent(link)}`;
  const cls = posicao === 'sidebar' ? 'ad-sidebar' : 'ad-horizontal';
  if (ad.imagem_url) {
    return `<div style="text-align:center;width:100%"><a href="${clickUrl}" class="custom-ad has-img ${cls}" target="_blank" rel="noopener"><img src="${ad.imagem_url}" alt="Publicidade" loading="lazy"></a></div>`;
  }
  return `<div style="text-align:center;width:100%"><a href="${clickUrl}" class="custom-ad ${cls}" target="_blank" rel="noopener">${fallback || 'Publicidade'}</a></div>`;
}

const PORT = process.env.PORT || 1337;
app.listen(PORT, () => console.log(`CRM rodando em http://localhost:${PORT}`));
