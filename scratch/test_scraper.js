const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

function identificarNicho(titulo, descricao) {
  const texto = (titulo + ' ' + descricao).toLowerCase();
  if (texto.includes('vazamento') || texto.includes('geofone') || texto.includes('encanador') || texto.includes('hidráulic') || texto.includes('infiltra'))
    return 'Caça Vazamento / Desentupidora';
  if (texto.includes('desentupidora') || texto.includes('desentupimento') || texto.includes('fossa') || texto.includes('esgoto'))
    return 'Caça Vazamento / Desentupidora';
  return 'Outro';
}

async function test() {
  const url = 'https://solucaodesentupidora.contrateagora.com/';
  console.log('Iniciando Puppeteer para:', url);
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
    if (designSystem.waNumber) {
      whatsapp = designSystem.waNumber;
    }
    if (!whatsapp) {
      const waLink = $('a[href*="wa.me"], a[href*="api.whatsapp.com"]').attr('href');
      if (waLink) {
        const m = waLink.match(/(\d{10,15})/);
        whatsapp = m ? m[1] : waLink;
      }
    }
    if (!whatsapp) {
      const match = $('body').text().match(/(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?9\d{4}[-\s]?\d{4}/g);
      if (match) whatsapp = match[0];
    }

    const footerHtml = $('footer').html() || $('[class*="footer"]').html() || null;
    const footerText = $('footer').text() || $('[class*="footer"]').text() || null;

    const titulo = $('title').text();
    const descricao = $('meta[name="description"]').attr('content') || '';
    const nicho = identificarNicho(titulo, descricao);

    let localizacao = null;
    const addrMeta = $('meta[name="geo.placename"], meta[property="business:contact_data:locality"]').attr('content');
    if (addrMeta) localizacao = addrMeta.trim();
    if (!localizacao) {
      const cobertura = (footerText || '') + ' ' + ($('.bairros-section, [class*="bairro"], [class*="cobertura"]').text() || '');
      const mCob = cobertura.match(/(?:Área de Cobertura|Atendemos|Cobertura|Área)[:\s]*([^\n.<]{5,60})/i);
      if (mCob) localizacao = mCob[1].replace(/\s+/g, ' ').trim();
    }
    if (!localizacao) {
      const mDesc = descricao.match(/\bem\s+([A-ZÁÉÍÓÚ][^.]{2,50})/);
      if (mDesc) localizacao = mDesc[1].replace(/\s+/g, ' ').trim();
    }
    if (!localizacao && footerText) {
      const m = footerText.match(/(Rua|Av\.|Avenida|CEP|Estado|Município)[\s\S]{10,80}/i);
      if (m) localizacao = m[0].replace(/\n/g, ' ').trim();
    }

    const data = {
      url, nicho,
      contato: { whatsapp: whatsapp || 'Não encontrado', localizacao: localizacao || 'Não encontrada' },
      design: {
        logo: logo || 'Não encontrado',
        fonte: designSystem.fonte,
        cssVars: designSystem.cssVars || {},
        cores: {
          headerBg: designSystem.headerBg,
          heroBg: designSystem.heroBg,
          primaryColor: designSystem.primaryColor,
          headingColor: designSystem.headingColor
        }
      },
      seo: { titulo, descricao },
      estrutura: { footerHtml: footerHtml ? footerHtml.trim() : 'Não encontrado' }
    };

    console.log('RESULTADO DA ANÁLISE:');
    console.log(JSON.stringify(data, null, 2));

  } catch (err) {
    console.error('ERRO:', err);
  } finally {
    await browser.close();
  }
}

test();
