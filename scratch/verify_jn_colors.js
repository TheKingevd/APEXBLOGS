const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

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

function sanitizeColor(col, fallback) {
  if (!col || col === 'transparent' || col === 'rgba(0, 0, 0, 0)') return fallback;
  return col;
}

async function verify() {
  const url = 'https://jndesentupidoramundial.contrateagora.com/';
  console.log('Testando crawler com 3 cores para:', url);
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    const html = await page.content();
    const $ = cheerio.load(html);

    const designSystem = await page.evaluate(() => {
      const header = document.querySelector('header, .main-header, [class*="header"]');
      const headerBg = header ? window.getComputedStyle(header).backgroundColor : null;
      const heroSection = document.querySelector('.hero-section, .hero, section:first-of-type, [class*="banner"]');
      const heroBg = heroSection ? window.getComputedStyle(heroSection).backgroundColor : null;
      const btn = document.querySelector('.btn-primary-cta, .btn-header-cta, button, .btn, [role="button"]');
      const primaryColor = btn ? window.getComputedStyle(btn).backgroundColor : null;
      const h1 = document.querySelector('h1');
      const headingColor = h1 ? window.getComputedStyle(h1).color : null;
      return { headerBg, heroBg, primaryColor, headingColor };
    });

    const headerBgHex = rgbToHex(designSystem.headerBg);
    const heroBgHex = rgbToHex(designSystem.heroBg);
    const primaryColorHex = rgbToHex(designSystem.primaryColor);
    const headingColorHex = rgbToHex(designSystem.headingColor);

    let rawBg = sanitizeColor(headerBgHex, sanitizeColor(heroBgHex, '#ffffff'));
    let rawHero = sanitizeColor(heroBgHex, rawBg);
    let rawPrimary = sanitizeColor(primaryColorHex, '#6366f1');
    let rawHeading = sanitizeColor(headingColorHex, rawPrimary);

    let corFundo = rawBg;
    let corPrimaria = rawPrimary;
    let corFoco = rawPrimary;

    if (rawHero && rawHero !== '#ffffff' && rawHero !== '#000000' && rawHero !== rawBg) {
      corPrimaria = rawHero;
      corFundo = rawBg;
      corFoco = rawPrimary !== '#6366f1' ? rawPrimary : rawHeading;
    } else {
      corFundo = rawBg;
      corPrimaria = rawPrimary;
      corFoco = rawPrimary;
    }

    console.log('DADOS EXTRAÍDOS:');
    console.log({
      designSystem,
      coresMapeadas: {
        corFundo,
        corPrimaria,
        corFoco
      }
    });

  } catch (err) {
    console.error('ERRO:', err);
  } finally {
    await browser.close();
  }
}

verify();
