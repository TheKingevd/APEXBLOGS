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
  return 'Serviços Gerais';
}

async function verify() {
  const url = 'https://solucaodesentupidora.contrateagora.com/';
  console.log('Testando crawler otimizado para:', url);
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    const html = await page.content();
    const $ = cheerio.load(html);

    const designSystem = await page.evaluate(() => {
      const bodyFont = window.getComputedStyle(document.body).fontFamily;
      const cssVars = {};
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
      const header = document.querySelector('header, .main-header, [class*="header"]');
      const headerBg = header ? window.getComputedStyle(header).backgroundColor : null;
      const heroSection = document.querySelector('.hero-section, .hero, section:first-of-type, [class*="banner"]');
      const heroBg = heroSection ? window.getComputedStyle(heroSection).backgroundColor : null;
      const btn = document.querySelector('.btn-primary-cta, .btn-header-cta, button, .btn, [role="button"]');
      const primaryColor = btn ? window.getComputedStyle(btn).backgroundColor : null;
      const h1 = document.querySelector('h1');
      const headingColor = h1 ? window.getComputedStyle(h1).color : null;
      const logoImg = document.querySelector('header img, .main-header img, .header-logo-img, .logo img, [class*="logo"] img, nav img');
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
      return { fonte: bodyFont, cssVars, headerBg, heroBg, primaryColor, headingColor, logoSrc, waNumber };
    });

    const origin = new URL(url).origin;
    let logo = designSystem.logoSrc
      || $('header img, .main-header img, [class*="logo"] img').attr('src')
      || $('meta[property="og:image"]').attr('content')
      || $('link[rel="icon"], link[rel="shortcut icon"]').attr('href');
    if (logo && !logo.startsWith('http')) logo = new URL(logo, origin).href;

    let whatsapp = null;

    // 1. Links wa.me ou api.whatsapp
    const waLink = $('a[href*="wa.me"], a[href*="api.whatsapp.com"], a[href*="web.whatsapp.com"], a[href^="whatsapp://"]').attr('href');
    if (waLink) {
      const m = waLink.match(/(\d{10,15})/);
      if (m) whatsapp = m[1];
    }

    // 2. Links tel:
    if (!whatsapp) {
      $('a[href^="tel:"]').each((i, el) => {
        const href = $(el).attr('href');
        const digits = href.replace(/\D/g, '');
        if (digits.length >= 8 && digits.length <= 15) {
          whatsapp = digits;
          return false; // break
        }
      });
    }

    // 3. Do JS inline
    if (!whatsapp && designSystem.waNumber) {
      whatsapp = designSystem.waNumber;
    }

    // 4. Regex no texto limpo
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

    const headerBgHex = rgbToHex(designSystem.headerBg);
    const heroBgHex = rgbToHex(designSystem.heroBg);
    const primaryColorHex = rgbToHex(designSystem.primaryColor);
    const headingColorHex = rgbToHex(designSystem.headingColor);

    const vars = designSystem.cssVars || {};
    const corPrimariaRaw = vars['--secondary-color'] || vars['--action-color'] || designSystem.primaryColor || null;
    const corFundoRaw = designSystem.headerBg || vars['--primary-color'] || designSystem.heroBg || null;
    
    const corPrimaria = rgbToHex(corPrimariaRaw);
    const corFundo = rgbToHex(corFundoRaw);
    const corTitulo = '#ffffff';

    const data = {
      nicho: identificarNicho($('title').text(), $('meta[name="description"]').attr('content') || ''),
      contato: { whatsapp: whatsappFormatado, whatsappRaw: whatsapp },
      design: {
        logo: logo,
        fonte: designSystem.fonte ? designSystem.fonte.split(',')[0].replace(/['"]/g, '').trim() : 'Inter',
        cores: {
          corPrimaria,
          corFundo,
          corTitulo
        }
      }
    };

    console.log('RESULTADOS OBTIDOS:');
    console.log(JSON.stringify(data, null, 2));

  } catch (err) {
    console.error('ERRO:', err);
  } finally {
    await browser.close();
  }
}

verify();
