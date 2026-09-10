
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('crm.db');
const puppeteer = require('puppeteer');

function rgbToHex(rgbStr) {
  if (!rgbStr || rgbStr === 'none') return null;
  if (rgbStr.startsWith('#')) return rgbStr;
  const m = rgbStr.match(/\d+/g);
  if (!m || m.length < 3) return null;
  const r = parseInt(m[0]).toString(16).padStart(2, '0');
  const g = parseInt(m[1]).toString(16).padStart(2, '0');
  const b = parseInt(m[2]).toString(16).padStart(2, '0');
  return '#' + r + g + b;
}

function isLightColor(hexStr) {
  if (!hexStr || !hexStr.startsWith('#')) return true;
  let hex = hexStr.slice(1);
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  const r = parseInt(hex.slice(0, 2), 16) || 0;
  const g = parseInt(hex.slice(2, 4), 16) || 0;
  const b = parseInt(hex.slice(4, 6), 16) || 0;
  return (r * 299 + g * 587 + b * 114) / 1000 > 155;
}

async function analyzeClient(client) {
  if (!client.website) return;
  console.log(`Analyzing [ID: ${client.id}] ${client.name} -> ${client.website}`);
  
  let browser = null;
  try {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto(client.website, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await new Promise(r => setTimeout(r, 1200));
    
    const res = await page.evaluate(() => {
      // 1. Header
      const header = document.querySelector('header, .main-header, [class*="header"], nav, .navbar');
      let headerBg = header ? window.getComputedStyle(header).backgroundColor : 'rgb(255, 255, 255)';
      if (headerBg === 'rgba(0, 0, 0, 0)' || headerBg === 'transparent') {
        const headerParent = header?.parentElement;
        headerBg = headerParent ? window.getComputedStyle(headerParent).backgroundColor : 'rgb(255, 255, 255)';
      }
      
      // 2. Hero & Brand Color
      const hero = document.querySelector('.hero-section, .hero, section:first-of-type, [class*="banner"], [class*="hero"]');
      let heroBg = hero ? window.getComputedStyle(hero).backgroundColor : null;
      if (heroBg === 'rgba(0, 0, 0, 0)' || heroBg === 'transparent') {
        heroBg = null;
      }
      
      // 3. CTA
      const ctaBtns = Array.from(document.querySelectorAll('a[href*="wa.me"], a[href*="whatsapp"], .btn-primary, .btn-secondary, [class*="cta"], button')).filter(el => {
        const t = el.textContent.toLowerCase();
        return t.includes('whatsapp') || t.includes('orçamento') || t.includes('atendimento') || t.includes('ligue') || t.includes('urgente');
      });
      
      let ctaBg = null;
      if (ctaBtns.length > 0) {
        for (const btn of ctaBtns) {
          const bg = window.getComputedStyle(btn).backgroundColor;
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
            ctaBg = bg;
            break;
          }
        }
      }
      
      // 4. Logo
      const logoImg = document.querySelector('header img, nav img, .logo img, a[class*="logo"] img, [class*="brand"] img, img[alt*="logo" i]');
      const logoSrc = logoImg ? logoImg.src : null;
      
      return { headerBg, heroBg, ctaBg, logoSrc };
    });
    
    await browser.close();
    
    let headerHex = rgbToHex(res.headerBg) || '#ffffff';
    let heroHex = rgbToHex(res.heroBg);
    let ctaHex = rgbToHex(res.ctaBg) || '#ffcc00';
    
    let corPrimaria = heroHex;
    if (!corPrimaria || corPrimaria === '#ffffff' || corPrimaria === '#000000') {
      corPrimaria = (!isLightColor(headerHex)) ? headerHex : (client.cor_primaria || '#08499a');
    }
    
    let corHeaderBg = isLightColor(headerHex) ? '#ffffff' : headerHex;
    let corTitulo = isLightColor(corPrimaria) ? '#0f172a' : corPrimaria;
    let corFoco = ctaHex;
    let logo = res.logoSrc || client.logo;
    
    console.log(`-> Results: Header: ${corHeaderBg} | Primaria: ${corPrimaria} | Foco: ${corFoco} | Logo: ${logo}`);
    
    await new Promise((resolve) => {
      db.run(
        `UPDATE clients SET cor_header_bg = ?, cor_primaria = ?, cor_foco = ?, cor_titulo = ?, logo = COALESCE(?, logo) WHERE id = ?`,
        [corHeaderBg, corPrimaria, corFoco, corTitulo, logo, client.id],
        function(err) {
          if (err) console.error('DB Update error:', err.message);
          else console.log(`✅ Updated client ${client.name} (ID ${client.id}) in DB!`);
          resolve();
        }
      );
    });
  } catch(e) {
    if (browser) await browser.close();
    console.error(`Failed analyzing client ${client.name}:`, e.message);
  }
}

async function runAll() {
  db.run("ALTER TABLE clients ADD COLUMN cor_header_bg TEXT", () => {});
  
  db.all('SELECT * FROM clients', [], async (err, clients) => {
    if (err || !clients) return;
    for (const c of clients) {
      await analyzeClient(c);
    }
    console.log('ALL CLIENTS RE-ANALYSIS COMPLETE!');
    process.exit(0);
  });
}

runAll();
